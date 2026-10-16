import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../../src/cli.js'
import { download, type DataClient } from '../../src/data/download.js'
import { parseManifest } from '../../src/data/manifest.js'
import { dbFile } from '../../src/paths.js'
import { openDb } from '../../src/storage/db.js'
import { bytes, serve, type TestServer } from '../data/server.js'

const fixtureDir = fileURLToPath(new URL('../fixtures/data/', import.meta.url))

function sink(isTTY = false) {
  return { isTTY, text: '', write(chunk: string) { this.text += chunk; return true } }
}

let home: string
let server: TestServer
let client: DataClient & { download: ReturnType<typeof vi.fn> }

// The real download against a local server, wrapped in a spy, so a test can
// say both what was imported and that nothing was fetched before the answer.
async function run(argv: string[], answer?: string) {
  const stdout = sink()
  const stderr = sink(answer !== undefined)
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean }
  if (answer !== undefined) stdin.isTTY = true
  stdin.end(answer === undefined ? undefined : `${answer}\n`)
  const code = await main(argv, { env: {}, streams: { stdin, stdout, stderr }, dataClient: client })
  return { code, stdout: stdout.text, stderr: stderr.text }
}

const rows = () => {
  const db = openDb(dbFile())
  try {
    return (db.prepare("SELECT COUNT(*) n FROM tm WHERE locale = 'tr'").get() as { n: number }).n
  } finally {
    db.close()
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyglots-cli-tm-fetch-'))
  vi.stubEnv('POLYGLOTS_HOME', home)
  await mkdir(join(home, 'config'), { recursive: true })
  await writeFile(join(home, 'config', 'config.json'), JSON.stringify({ defaultLocale: 'tr' }))
  const gz = await readFile(join(fixtureDir, 'tr_TR.tmx.gz'))
  server = await serve({ '/tr_TR.tmx.gz': bytes(gz) })
  const index = JSON.parse(await readFile(join(fixtureDir, 'index.json'), 'utf8')) as { tm: Record<string, unknown>[] }
  index.tm[0]!.url = server.url('/tr_TR.tmx.gz')
  client = { manifest: async () => parseManifest(index), download: vi.fn(download) }
})

afterEach(async () => {
  await server.close()
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

describe('tm fetch', () => {
  it('refuses without a terminal and without --yes, before any download', async () => {
    const r = await run(['tm', 'fetch'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('tm fetch needs --yes when stdin or stderr is not a terminal')
    expect(r.stdout).toContain('Turkish (tr): 1,002 strings')
    expect(client.download).not.toHaveBeenCalled()
  })

  it('imports with --yes and says what it added', async () => {
    const r = await run(['tm', 'fetch', 'tr', '--yes'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/Imported 1,002 new strings \(0 already present\) from 4 projects in \d+\.\ds\./)
    expect(rows()).toBe(1002)
  })

  it('asks on a terminal, and a no downloads nothing', async () => {
    const r = await run(['tm', 'fetch'], 'n')
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('Download and import? [y/N]')
    expect(client.download).not.toHaveBeenCalled()
    expect(rows()).toBe(0)
  })

  it('imports on a yes', async () => {
    const r = await run(['tm', 'fetch'], 'y')
    expect(r.code).toBe(0)
    expect(rows()).toBe(1002)
  })

  it('exits 1 on a refusal', async () => {
    const r = await run(['tm', 'fetch', 'de', '--yes'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('No polyglots-data entry for de')
    expect(client.download).not.toHaveBeenCalled()
  })
})
