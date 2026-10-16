import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { planTmFetch, runTmFetch, type TmFetchProgress } from '../../src/commands/tm-fetch.js'
import { dataClient } from '../../src/data/download.js'
import { DataError } from '../../src/data/manifest.js'
import { dataDir, dbFile } from '../../src/paths.js'
import { openDb } from '../../src/storage/db.js'
import { upsertTm } from '../../src/storage/tm.js'
import { bytes, serve, type TestServer } from '../data/server.js'

const fixtureDir = fileURLToPath(new URL('../fixtures/data/', import.meta.url))
const sha512 = (b: Buffer) => createHash('sha512').update(b).digest('hex')

let home: string
let server: TestServer | undefined
let db: Database.Database

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyglots-tm-fetch-'))
  vi.stubEnv('POLYGLOTS_HOME', home)
  db = openDb(dbFile())
})

afterEach(async () => {
  db.close()
  await server?.close()
  server = undefined
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

// The fixture manifest's tr entry, its url pointed at the local server and
// `patch` laid over it, so each refusal is one field from the happy path.
async function publish(patch: Record<string, unknown> = {}, gz?: Buffer) {
  const index = JSON.parse(await readFile(join(fixtureDir, 'index.json'), 'utf8')) as { tm: Record<string, unknown>[] }
  const body = gz ?? (await readFile(join(fixtureDir, 'tr_TR.tmx.gz')))
  const file = '/2026-10-16/tr_TR.tmx.gz'
  server = await serve({
    '/index.json': (req, res) => {
      const entry = { ...index.tm[0], url: server!.url(file), ...patch }
      bytes(JSON.stringify({ ...index, tm: [entry] }))(req, res)
    },
    [file]: (req, res) => bytes(body)(req, res),
  })
  vi.stubEnv('POLYGLOTS_DATA_URL', server.url('/index.json'))
}

// A served TMX of the caller's own units, with a manifest entry that
// describes it truthfully.
async function publishTmx(units: string) {
  const xml = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><tmx version="1.4"><header srclang="en"/><body>${units}</body></tmx>`)
  const gz = gzipSync(xml)
  await publish({ bytes: gz.length, bytesUncompressed: xml.length, sha512: sha512(gz), units: 2 }, gz)
}

const count = (where = '1 = 1') => (db.prepare(`SELECT COUNT(*) n FROM tm WHERE ${where}`).get() as { n: number }).n
const leftovers = async () => (await readdir(dataDir())).filter((name) => name.startsWith('.polyglots-data-'))

describe('tm fetch', () => {
  it('imports under the slug, never the WP code', async () => {
    await publish()
    const r = await runTmFetch(await planTmFetch('tr', dataClient, db), dataClient, { db })
    expect(r.units).toBe(1002)
    expect(r.added).toBe(1002)
    expect(r.present).toBe(0)
    expect(r.projects).toBe(4)
    expect(db.prepare("SELECT COUNT(*) n FROM tm WHERE locale='tr'").get()).toEqual({ n: r.added })
    expect(db.prepare("SELECT COUNT(*) n FROM tm WHERE locale='tr-tr' OR locale='tr_TR'").get()).toEqual({ n: 0 })
    expect(count("context = 'theme'")).toBeGreaterThan(0)
    expect(await leftovers()).toEqual([])
  })

  it('takes the first x-project, and gives a unit without one the project polyglots-data', async () => {
    await publishTmx(
      '<tu><tuv xml:lang="en"><seg>Bare</seg></tuv><tuv xml:lang="tr-TR"><seg>Çıplak</seg></tuv></tu>' +
        '<tu><prop type="x-project">wp/dev</prop><prop type="x-project">woo</prop><tuv xml:lang="en"><seg>Two</seg></tuv><tuv xml:lang="tr-TR"><seg>İki</seg></tuv></tu>',
    )
    await runTmFetch(await planTmFetch('tr', dataClient, db), dataClient, { db })
    expect(db.prepare('SELECT source, project FROM tm ORDER BY source').all()).toEqual([
      { source: 'Bare', project: 'polyglots-data' },
      { source: 'Two', project: 'wp/dev' },
    ])
  })

  it('adds nothing on a second fetch', async () => {
    await publish()
    const r1 = await runTmFetch(await planTmFetch('tr', dataClient, db), dataClient, { db })
    const r2 = await runTmFetch(await planTmFetch('tr', dataClient, db), dataClient, { db })
    expect(r2.added).toBe(0)
    expect(r2.present).toBe(r1.units)
    expect(count()).toBe(r1.added)
  })

  it('stamps new rows with the build time, and leaves a user row as it was', async () => {
    await publish()
    upsertTm(db, [{ source: '#%d', target: '#%d', locale: 'tr', project: 'mine' }])
    const mine = db.prepare("SELECT project, updated_at FROM tm WHERE source = '#%d'").get()
    const plan = await planTmFetch('tr', dataClient, db)
    const r = await runTmFetch(plan, dataClient, { db })
    expect(r.present).toBe(1)
    expect(db.prepare("SELECT project, updated_at FROM tm WHERE source = '#%d'").get()).toEqual(mine)
    expect(db.prepare("SELECT DISTINCT updated_at FROM tm WHERE project != 'mine'").all()).toEqual([{ updated_at: plan.entry.built }])
  })

  it('reports downloading, then importing chunk by chunk', async () => {
    await publish()
    const events: TmFetchProgress[] = []
    await runTmFetch(await planTmFetch('tr', dataClient, db), dataClient, { db, onProgress: (e) => events.push(e) })
    expect(events[0]).toEqual({ phase: 'downloading' })
    expect(events.at(-1)).toEqual({ phase: 'importing', done: 1002, total: 1002 })
  })

  it.each([
    ['ceiling', { bytesUncompressed: 300 * 1024 * 1024 }, 'more than 200 MiB'],
    ['download size', { bytes: 100 }, 'larger than'],
    ['hash', { sha512: '0'.repeat(128) }, 'does not match the sha512'],
    ['gunzip size', { bytesUncompressed: 1000 }, 'larger than the manifest says'],
    ['manifest schema', { __schema: 2 }, 'the polyglots-data manifest is schema 2'],
    ['missing entry', { slug: 'de', locale: 'de_DE' }, 'No polyglots-data entry for tr'],
  ])('refuses on %s, database unchanged, no temp file', async (_name, patch, message) => {
    if ('__schema' in patch) {
      server = await serve({ '/index.json': bytes(JSON.stringify({ schema: 2, generated: 'x', tm: [], rules: [] })) })
      vi.stubEnv('POLYGLOTS_DATA_URL', server.url('/index.json'))
    } else {
      await publish(patch)
    }
    upsertTm(db, [{ source: 'Save', target: 'Kaydet', locale: 'tr' }])
    const before = db.prepare('SELECT * FROM tm').all()
    const attempt = planTmFetch('tr', dataClient, db).then((plan) => runTmFetch(plan, dataClient, { db }))
    await expect(attempt).rejects.toThrow(DataError)
    await expect(attempt).rejects.toThrow(message)
    expect(db.prepare('SELECT * FROM tm').all()).toEqual(before)
    expect(await leftovers().catch(() => [])).toEqual([])
  })

  it('says how many strings the memory already holds', async () => {
    await publish()
    upsertTm(db, [{ source: 'Save', target: 'Kaydet', locale: 'tr' }])
    const plan = await planTmFetch('tr', dataClient, db)
    expect(plan.summary.join('\n')).toContain('You already have 1 string for tr')
    expect(plan.summary.join('\n')).toContain('never changes or deletes your rows')
  })

  it('reads the count from the database file when no handle is given', async () => {
    await publish()
    upsertTm(db, [{ source: 'Save', target: 'Kaydet', locale: 'tr' }])
    expect((await planTmFetch('tr', dataClient)).existing).toBe(1)
  })

  it('summarises the entry before anything is downloaded', async () => {
    await publish()
    const plan = await planTmFetch('tr', dataClient, db)
    expect(plan.summary).toEqual([
      'Turkish (tr): 1,002 strings, 26.5 KiB download, built 2026-10-16',
      '4 projects, 1 not refreshed in this build (oldest 2026-10-09)',
      'Your memory has no tr strings yet.',
    ])
    expect(server!.requests.map((r) => r.path)).toEqual(['/index.json'])
  })
})
