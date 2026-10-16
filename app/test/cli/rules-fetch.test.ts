import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../../src/cli.js'
import { localeRulesFile } from '../../src/rules/load.js'
import { bytes, serve, type TestServer } from '../data/server.js'

const fixture = fileURLToPath(new URL('../fixtures/locale/tr_TR.yaml', import.meta.url))
const sha512 = (b: Buffer | string) => createHash('sha512').update(b).digest('hex')

function sink(isTTY = false) {
  return { isTTY, text: '', write(chunk: string) { this.text += chunk; return true } }
}

// Without `answer`, neither end is a terminal; with it, both are, and the
// confirmation reads `answer`.
async function run(argv: string[], answer?: string) {
  const stdout = sink()
  const stderr = sink(answer !== undefined)
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean }
  if (answer !== undefined) stdin.isTTY = true
  stdin.end(answer === undefined ? undefined : `${answer}\n`)
  const code = await main(argv, { env: {}, streams: { stdin, stdout, stderr } })
  return { code, stdout: stdout.text, stderr: stderr.text }
}

let home: string
let server: TestServer | undefined
let served: Buffer

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyglots-cli-rules-fetch-'))
  vi.stubEnv('POLYGLOTS_HOME', home)
  await mkdir(join(home, 'config'), { recursive: true })
  await writeFile(join(home, 'config', 'config.json'), JSON.stringify({ defaultLocale: 'tr' }))
  served = await readFile(fixture)
  const file = '/locales/tr_TR/rules.yaml'
  server = await serve({
    '/index.json': (req, res) => {
      const entry = {
        locale: 'tr_TR',
        slug: 'tr',
        url: server!.url(file),
        sha512: sha512(served),
        schema: 2,
        minPolyglots: '0.1.0',
        status: 'maintained',
        maintainers: ['emreerkan'],
      }
      bytes(JSON.stringify({ schema: 1, generated: '2026-10-16T00:00:00Z', tm: [], rules: [entry] }))(req, res)
    },
    [file]: (req, res) => bytes(served)(req, res),
  })
  vi.stubEnv('POLYGLOTS_DATA_URL', server.url('/index.json'))
})

afterEach(async () => {
  await server?.close()
  server = undefined
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

async function writeLocal(text: string) {
  const path = localeRulesFile('tr')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
  return path
}

describe('rules fetch', () => {
  it('writes a new file without asking, after the summary, then describes it', async () => {
    const r = await run(['rules', 'fetch'])
    expect(r.code).toBe(0)
    expect(await readFile(localeRulesFile('tr'))).toEqual(served)
    expect(r.stdout).toContain('capitalization changed:')
    expect(r.stdout).toContain('status: maintained · maintainers (wordpress.org): emreerkan')
    expect(r.stdout).toContain(`Wrote ${localeRulesFile('tr')}.`)
  })

  it('says so and writes nothing when the local file is already the published one', async () => {
    const path = await writeLocal(served.toString('utf8'))
    const r = await run(['rules', 'fetch', 'tr'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`${path} is already the published file.`)
    expect(r.stdout).not.toContain('changed:')
  })

  it('refuses to replace a different file without a terminal and without --yes', async () => {
    const path = await writeLocal('guidance: mine\n')
    const r = await run(['rules', 'fetch', 'tr'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('rules fetch needs --yes to replace a file when stdin or stderr is not a terminal')
    expect(await readFile(path, 'utf8')).toBe('guidance: mine\n')
  })

  it('replaces a different file with --yes', async () => {
    await writeLocal('guidance: mine\n')
    const r = await run(['rules', 'fetch', 'tr', '--yes'])
    expect(r.code).toBe(0)
    expect(await readFile(localeRulesFile('tr'))).toEqual(served)
  })

  it('asks on a terminal, and keeps the file on no', async () => {
    const path = await writeLocal('guidance: mine\n')
    const r = await run(['rules', 'fetch', 'tr'], 'n')
    expect(r.code).toBe(0)
    expect(r.stderr).toContain(`This replaces ${path}. Continue? [y/N]`)
    expect(r.stderr).toContain('Kept.')
    expect(await readFile(path, 'utf8')).toBe('guidance: mine\n')
  })

  it('asks on a terminal, and replaces the file on yes', async () => {
    await writeLocal('guidance: mine\n')
    const r = await run(['rules', 'fetch', 'tr'], 'y')
    expect(r.code).toBe(0)
    expect(await readFile(localeRulesFile('tr'))).toEqual(served)
  })

  it('exits 1 on a refusal and writes nothing', async () => {
    const r = await run(['rules', 'fetch', 'de'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('No polyglots-data entry for de. Available: tr')
    expect(existsSync(localeRulesFile('de'))).toBe(false)
  })
})
