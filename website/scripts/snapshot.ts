// Renders the site's terminal demos and command reference from app/src, and
// writes them to src/generated/ for Astro to read. Runs before every dev and
// build, and from the app's release script, so a change to the CLI's output
// shows up here (or fails here) before it ships.
//
// Run with the app's tsx: `npm run snapshot`. It needs app/node_modules and
// nothing from website/node_modules, so the release can run it without the
// site's dependencies installed.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
// Type-only, so erased: nothing from the app loads before the sandbox below.
import type { CliDeps } from '../../app/src/cli.js'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..', '..', 'app')
const outDir = join(here, '..', 'src', 'generated')

// Isolation before a single app module loads. HOME as well as POLYGLOTS_HOME:
// help text prints defaults from the config it finds, and provider code reads
// other tools' settings under the home directory. Without this the published
// help would show whatever the machine running the build has configured, and
// the demos could pick up its model names.
const sandbox = mkdtempSync(join(tmpdir(), 'polyglots-site-'))
process.env.HOME = join(sandbox, 'home')
process.env.POLYGLOTS_HOME = join(sandbox, 'polyglots')
mkdirSync(process.env.HOME, { recursive: true })
for (const key of ['NO_COLOR', 'FORCE_COLOR', 'POLYGLOTS_ASCII', 'POLYGLOTS_AGENT_BIN', 'POLYGLOTS_CLAUDE_BIN', 'DEEPL_API_KEY', 'OPENAI_API_KEY']) {
  delete process.env[key]
}
// The translate demo drafts with DeepL, and the CLI checks for a key before it
// starts. The draft itself is faked, so the key is never sent anywhere.
process.env.DEEPL_API_KEY = 'demo'
// The progress line's "done by" time is wall-clock; pinned so the page does
// not change with the hour it was built in.
process.env.TZ = 'UTC'
// The TUI paints through Ink, whose chalk decides once, when it loads,
// whether colour is on, from this process's own stdout. That is a terminal
// when the snapshot is run by hand and a pipe under a release script, so
// without this the TUI panels would be coloured or plain depending on who
// built the site. 1 is the sixteen colours the tokens use. The CLI demos are
// unaffected: main() is handed its env and decides colour from that.
process.env.FORCE_COLOR = '1'

const { main } = await import('../../app/src/cli.js')
const { ansiToHtml, ansiToText, Screen } = await import('./ansi.js')
const { SCENARIOS } = await import('./demos.js')
const { recordTui } = await import('./tui.js')
const { TUI_SCENARIOS } = await import('./tui-demos.js')
type Clock = import('./demos.js').Clock

// Every dependency main() can be handed, listed so that each one a scenario
// does not fake is replaced by a stub that throws. Without that, a command
// that grows a new call would run the real thing during a build: spawn
// claude, probe local model ports, hit translate.wordpress.org. The
// `satisfies` makes a member added to CliDeps fail this typecheck until it is
// listed here.
const INJECTABLE = {
  translate: true,
  importTmx: true,
  syncGlossary: true,
  exportGlossary: true,
  exportTm: true,
  reviewFile: true,
  splitPo: true,
  writeStats: true,
  serveStats: true,
  resolveProjects: true,
  fetchProjects: true,
  openEditor: true,
  runTui: true,
  discoverAgents: true,
  discoverModels: true,
  checkLocalModel: true,
  stopOwnRuns: true,
  raiseSignal: true,
  sendUsage: true,
  checkUpdate: true,
} satisfies Record<Exclude<keyof CliDeps, 'streams' | 'env'>, true>

function refuseUnfaked(what: string): CliDeps {
  const stubs: Record<string, unknown> = {}
  for (const name of Object.keys(INJECTABLE)) {
    stubs[name] = () => {
      throw new Error(`${what} called ${name}, which it does not fake. Fake it in scripts/demos.ts, or the build would run the real thing.`)
    }
  }
  return stubs as CliDeps
}

interface Frame {
  /** How long the panel holds this frame before the next, in ms. */
  hold: number
  html: string[]
}

interface Demo {
  command: string
  frames: Frame[]
  final: string[]
  text: string
  exitCode: number
}

const COLUMNS = 80
const START = Date.UTC(2026, 8, 14, 9, 30)

async function record(scenario: (typeof SCENARIOS)[number]): Promise<Demo> {
  const cwd = mkdtempSync(join(sandbox, `${scenario.name}-`))
  for (const file of scenario.files ?? []) writeFileSync(join(cwd, file), '')
  rmSync(join(process.env.POLYGLOTS_HOME!, 'config'), { recursive: true, force: true })
  if (scenario.config) {
    mkdirSync(join(process.env.POLYGLOTS_HOME!, 'config'), { recursive: true })
    writeFileSync(join(process.env.POLYGLOTS_HOME!, 'config', 'config.json'), JSON.stringify(scenario.config))
  }

  const screen = new Screen()
  const frames: Frame[] = []
  let now = START
  let linger = 400
  const clock: Clock = {
    advance(ms, hold) {
      now += ms
      linger = hold
    },
    now: () => now,
  }
  // One terminal for both streams, as the person sees it. Each write that
  // changes the screen becomes a frame, held for whatever the scenario said
  // the step it ended deserves.
  const write = (chunk: string): boolean => {
    screen.write(chunk)
    const html = screen.frame().map(ansiToHtml)
    const last = frames.at(-1)
    if (last && last.html.join('\n') === html.join('\n')) return true
    if (last) last.hold = Math.max(last.hold, 120)
    frames.push({ hold: linger, html })
    linger = 120
    return true
  }
  const tty = { isTTY: true, columns: COLUMNS, write }
  // Not a terminal: nothing to read keys from, and fetch reads a pasted list
  // from a stdin that is not one. Empty, so only the arguments count.
  const stdin = Object.assign(Readable.from([]), { isTTY: false })

  const realNow = Date.now
  const realLocaleTime = Date.prototype.toLocaleTimeString
  Date.now = () => now
  // `[]` means the build machine's locale; the page is English.
  Date.prototype.toLocaleTimeString = function (this: Date, _locales?: unknown, options?: Intl.DateTimeFormatOptions) {
    return realLocaleTime.call(this, 'en-GB', options)
  }
  const previousCwd = process.cwd()
  process.chdir(cwd)
  let exitCode: number
  try {
    exitCode = await main(scenario.argv, {
      ...refuseUnfaked(`The ${scenario.name} demo`),
      ...scenario.deps(clock),
      streams: { stdin, stdout: tty, stderr: tty },
      env: { LANG: 'en_US.UTF-8' },
    })
  } finally {
    process.chdir(previousCwd)
    Date.now = realNow
    Date.prototype.toLocaleTimeString = realLocaleTime
  }

  const lines = screen.frame()
  const text = lines.map(ansiToText).join('\n')
  // A field the CLI reads and the scenario did not set prints as `undefined`
  // or `NaN` rather than failing. On a public page that is worse than a
  // failed build, so it is one.
  if (/\bundefined\b|\bNaN\b/.test(text)) throw new Error(`The ${scenario.name} demo printed undefined or NaN:\n${text}`)
  if (exitCode !== 0) throw new Error(`The ${scenario.name} demo exited ${exitCode}:\n${text}`)
  return { command: `polyglots ${scenario.argv.join(' ')}`, frames, final: lines.map(ansiToHtml), text, exitCode }
}

// Help, captured through main() like any other run. Commander sizes help to
// process.stdout when it is a terminal, so that is pinned for the duration:
// a release run from an iTerm 200 columns wide must not reflow the page.
async function help(path: string[]): Promise<string> {
  let out = ''
  const sink = { isTTY: false, write: (chunk: string) => ((out += chunk), true) }
  const stdin = Object.assign(Readable.from([]), { isTTY: false })
  const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
  try {
    await main([...path, '--help'], { ...refuseUnfaked(`polyglots ${path.join(' ')} --help`), streams: { stdin, stdout: sink, stderr: sink }, env: { NO_COLOR: '1' } })
  } finally {
    if (tty) Object.defineProperty(process.stdout, 'isTTY', tty)
    else delete (process.stdout as { isTTY?: boolean }).isTTY
  }
  return out.trimEnd()
}

const subcommands = (text: string): string[] => {
  const section = text.split(/^Commands:$/m)[1]
  if (!section) return []
  return [...section.matchAll(/^ {2}([a-z][a-z-]*)\b/gm)].map((m) => m[1]!).filter((name) => name !== 'help')
}

interface HelpEntry {
  path: string[]
  text: string
}

async function commandReference(): Promise<HelpEntry[]> {
  const top = await help([])
  const entries: HelpEntry[] = [{ path: [], text: top }]
  for (const name of subcommands(top)) {
    const text = await help([name])
    entries.push({ path: [name], text })
    for (const sub of subcommands(text)) entries.push({ path: [name, sub], text: await help([name, sub]) })
  }
  return entries
}

// The TUI's wordmark (app/src/ui/wordmark.ts, from #14): four rows of
// quadrant blocks. Imported by a computed path so the snapshot typechecks and
// runs on a tree that does not have the module yet; the site then sets the
// plain name in the terminal font instead. WORDMARK_PLAIN is the string the
// TUI shows in ASCII mode, not a drawing, so it is not a fallback here.
async function wordmark(): Promise<string[] | null> {
  const path = join(appDir, 'src', 'ui', 'wordmark.ts')
  try {
    const mod = (await import(path)) as { WORDMARK?: unknown }
    const lines = mod.WORDMARK
    if (!Array.isArray(lines) || !lines.every((l) => typeof l === 'string')) return null
    return lines.map((l: string) => ansiToText(l).trimEnd())
  } catch {
    return null
  }
}

try {
  const demos: Record<string, Demo> = {}
  for (const scenario of SCENARIOS) demos[scenario.name] = await record(scenario)
  const tui: Record<string, Awaited<ReturnType<typeof recordTui>>> = {}
  for (const scenario of TUI_SCENARIOS) tui[scenario.name] = await recordTui(scenario)
  const version = (JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as { version: string }).version
  const snapshot = { version, wordmark: await wordmark(), demos, tui, help: await commandReference() }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'snapshot.json'), JSON.stringify(snapshot, null, 1) + '\n')
  console.log(
    `Wrote ${Object.keys(demos).length} demos, ${Object.keys(tui).length} TUI demos and ${snapshot.help.length} help pages to src/generated/snapshot.json`,
  )
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
