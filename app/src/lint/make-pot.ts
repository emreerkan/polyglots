import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findOnPath } from '../agent/discover.js'
import { dataDir } from '../paths.js'
import { VERSION } from '../version.js'
import { LintNotStarted } from './errors.js'
import { WP_CLI } from './wp-cli-pin.js'

export interface WpCliPin {
  version: string
  url: string
  sha512: string
  size: number
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

// Everything make-pot touches outside this module, so the tests decide what
// is on PATH, what the network answers and where the phar is kept.
export interface MakePotIo {
  env: NodeJS.ProcessEnv
  which(cmd: string): string | undefined
  // cwd is the plugin or theme folder make-pot runs in.
  run(cmd: string, args: string[], cwd?: string): Promise<RunResult>
  fetch(url: string): Promise<Response>
  cacheDir: string
}

export interface MakePotOptions {
  dir: string
  out: string
  // Passed to make-pot as --domain, for a plugin without a Text Domain header
  // whose folder is not named after its slug.
  domain?: string
  // One line for stderr, said before anything slow or surprising: a download.
  notice(line: string): void
}

const ELSEWHERE = [
  'A .pot made elsewhere works too: polyglots lint languages/<slug>.pot',
  'For example, with Docker: npx wp-env run cli wp i18n make-pot . languages/<slug>.pot',
]

// Node refuses to spawn a .bat or .cmd directly since the fix for
// CVE-2024-27980, and wp on Windows is wp.bat. Through the shell, every part
// is quoted, because a path can hold spaces, and the whole line is one string:
// Node 24 deprecates an args array beside shell: true (DEP0190), and would
// print a warning on every run.
//
// cmd.exe still expands %NAME% inside quotes when such a variable exists, and
// nothing escapes it in a command line. So the plugin's own path is never on
// it: make-pot runs inside the folder on ".". What remains is the wp.bat path
// itself and the temporary .pot path.
export function spawnPlan(cmd: string, args: readonly string[], platform: NodeJS.Platform): { file: string; args: string[]; shell: boolean } {
  if (platform !== 'win32' || !/\.(bat|cmd)$/i.test(cmd)) return { file: cmd, args: [...args], shell: false }
  const quote = (s: string): string => `"${s.replace(/"/g, '""')}"`
  return { file: [cmd, ...args].map(quote).join(' '), args: [], shell: true }
}

function runCommand(cmd: string, args: string[], cwd?: string): Promise<RunResult> {
  const plan = spawnPlan(cmd, args, process.platform)
  return new Promise((resolve, reject) => {
    const child = spawn(plan.file, plan.args, {
      shell: plan.shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(cwd === undefined ? {} : { cwd }),
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

// On Windows a command is a file with a PATHEXT extension. findOnPath tries
// the bare name first, which picks Composer's vendor\\bin\\wp, a sh proxy that
// cannot be spawned, over the wp.bat beside it.
export function findCommand(cmd: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'win32' || /\.[^\\/.]+$/.test(cmd)) return findOnPath(cmd, env, platform)
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const isFile = (path: string): boolean => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  }
  if (cmd.includes('\\') || cmd.includes('/')) return exts.map((ext) => cmd + ext).find(isFile)
  for (const dir of (env.PATH ?? '').split(';')) {
    if (!dir) continue
    const found = exts.map((ext) => join(dir, cmd + ext)).find(isFile)
    if (found) return found
  }
  return undefined
}

export function defaultIo(): MakePotIo {
  return {
    env: process.env,
    which: (cmd) => findCommand(cmd, process.env),
    run: runCommand,
    // The whole download, body included: a stalled connection would
    // otherwise hold a CI job until the runner's own limit, hours later.
    fetch: (url) =>
      fetch(url, {
        headers: { 'User-Agent': `polyglots/${VERSION} (+https://github.com/emreerkan/polyglots)` },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      }),
    cacheDir: join(dataDir(), 'wp-cli'),
  }
}

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000

const downloadError = (err: unknown): string =>
  err instanceof Error && err.name === 'TimeoutError' ? 'timed out after 5 minutes' : err instanceof Error ? err.message : String(err)

const sha512 = (bytes: Uint8Array): string => createHash('sha512').update(bytes).digest('hex')

// Checked before every use, not only after the download: a file in a data
// folder can be truncated by a full disk or replaced by anything else that
// writes there, and it is about to be run.
async function keptPharMatches(phar: string, pin: WpCliPin): Promise<boolean> {
  let bytes: Buffer
  try {
    bytes = await readFile(phar)
  } catch {
    return false
  }
  if (sha512(bytes) === pin.sha512) return true
  await rm(phar, { force: true })
  return false
}

async function downloadPhar(io: MakePotIo, pin: WpCliPin, phar: string, notice: (line: string) => void): Promise<void> {
  const mb = (pin.size / 1_000_000).toFixed(1)
  notice(`No wp command found: downloading WP-CLI ${pin.version} (${mb} MB) from github.com/wp-cli/wp-cli, kept in ${io.cacheDir} for next time.`)
  let res: Response
  try {
    res = await io.fetch(pin.url)
  } catch (err) {
    throw new LintNotStarted(`Could not download WP-CLI ${pin.version}: ${downloadError(err)}`, [
      'Connect once to download it, or install WP-CLI: https://wp-cli.org',
      ...ELSEWHERE,
    ])
  }
  if (!res.ok) throw new LintNotStarted(`Could not download WP-CLI ${pin.version}: ${pin.url} answered ${res.status}`, ELSEWHERE)
  // Hashed in memory before anything is written, so a phar that does not
  // match never reaches the disk, then written under a temporary name and
  // renamed, so a crash part way leaves no half-written phar under the real
  // name.
  let bytes: Buffer
  try {
    bytes = Buffer.from(await res.arrayBuffer())
  } catch (err) {
    throw new LintNotStarted(`Could not download WP-CLI ${pin.version}: ${downloadError(err)}`, ELSEWHERE)
  }
  const got = sha512(bytes)
  if (got !== pin.sha512) {
    throw new LintNotStarted(`The downloaded WP-CLI ${pin.version} does not match the pinned SHA-512, so it was not kept.`, [
      `expected ${pin.sha512}`,
      `got      ${got}`,
    ])
  }
  // A name of its own per download, so two runs at once never write into one
  // temporary file. If the rename fails, another run may have put the same
  // phar in place first (on Windows, a phar another run has open cannot be
  // replaced); a kept phar that verifies is as good as this one.
  const tmp = `${phar}.${randomUUID()}.tmp`
  try {
    await mkdir(io.cacheDir, { recursive: true })
    await writeFile(tmp, bytes)
    await rename(tmp, phar)
  } catch (err) {
    await rm(tmp, { force: true })
    if (await keptPharMatches(phar, pin)) return
    throw new LintNotStarted(`Could not keep WP-CLI in ${io.cacheDir}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * The command that runs WP-CLI: POLYGLOTS_WP_BIN, else wp on PATH, else the
 * pinned phar under php, downloaded on first use. PHP is checked before the
 * download, since without it the phar cannot run.
 */
export async function findWp(io: MakePotIo, notice: (line: string) => void, pin: WpCliPin = WP_CLI): Promise<{ cmd: string; args: string[] }> {
  const override = io.env.POLYGLOTS_WP_BIN
  // A bare name goes through the same lookup as wp, so wp-custom finds
  // wp-custom.bat on Windows; a path, or a name not found, is run as given.
  if (override) return { cmd: io.which(override) ?? override, args: [] }
  const wp = io.which('wp')
  if (wp) return { cmd: wp, args: [] }
  const php = io.which('php')
  if (!php) {
    throw new LintNotStarted('No wp command and no PHP found, so the .pot cannot be made.', [
      'Install PHP, and polyglots downloads WP-CLI itself; or install WP-CLI: https://wp-cli.org',
      ...ELSEWHERE,
    ])
  }
  const phar = join(io.cacheDir, `wp-cli-${pin.version}.phar`)
  if (!(await keptPharMatches(phar, pin))) await downloadPhar(io, pin, phar, notice)
  return { cmd: php, args: [phar] }
}

// --skip-audit: make-pot's own audit warns about missing translators comments
// and unordered placeholders, which the rules report too, in other words.
export async function makePot(opts: MakePotOptions, io: MakePotIo = defaultIo(), pin: WpCliPin = WP_CLI): Promise<void> {
  const wp = await findWp(io, opts.notice, pin)
  let result: RunResult
  try {
    // Run inside the folder on ".", which keeps the plugin's path off a
    // Windows command line (see spawnPlan); the references come out the same.
    const domain = opts.domain === undefined ? [] : [`--domain=${opts.domain}`]
    result = await io.run(wp.cmd, [...wp.args, 'i18n', 'make-pot', '.', opts.out, '--skip-audit', ...domain], opts.dir)
  } catch (err) {
    throw new LintNotStarted(`Could not run ${wp.cmd}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const stderr = result.stderr.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (result.code !== 0) throw new LintNotStarted(`wp i18n make-pot failed with exit code ${result.code}, so the lint did not start.`, stderr)
  try {
    await access(opts.out)
  } catch {
    throw new LintNotStarted('wp i18n make-pot wrote no .pot, so the lint did not start.', stderr)
  }
}
