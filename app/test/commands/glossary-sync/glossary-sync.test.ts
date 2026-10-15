import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import { syncGlossary } from '../../../src/commands/glossary-sync.js'
import { dataDir, dbFile } from '../../../src/paths.js'
import { lookupGlossary, openDb, replaceGlossary } from '../../../src/storage/index.js'
import { glossarySyncTimes } from '../../../src/storage/glossary.js'
import { glossaryExportUrl, glossaryUrl } from '../../../src/wporg/glossary.js'

type Storage = typeof import('../../../src/storage/index.js')

vi.mock('../../../src/storage/index.js', async (importOriginal) => {
  const actual = await importOriginal<Storage>()
  return { ...actual, openDb: vi.fn(actual.openDb), replaceGlossary: vi.fn(actual.replaceGlossary) }
})

const fixture = readFileSync(
  fileURLToPath(new URL('../../fixtures/wporg/glossary-tr.csv', import.meta.url)),
  'utf8',
)

const fixtureFetch = async (url: string): Promise<string> => {
  if (!url.startsWith(glossaryUrl('tr'))) throw new Error(`unexpected url ${url}`)
  return fixture
}

const failingFetch = async (): Promise<string> => {
  throw new Error('network down')
}

const countRows = (db: Database.Database, locale: string): number =>
  (db.prepare('SELECT count(*) AS n FROM glossary WHERE locale = ?').get(locale) as { n: number }).n

const openedHandles = (): Database.Database[] =>
  vi.mocked(openDb).mock.results.map((r) => r.value as Database.Database)

describe('syncGlossary', () => {
  let home: string
  let db: Database.Database
  const originalHome = process.env.POLYGLOTS_HOME

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'polyglots-glossary-sync-'))
    process.env.POLYGLOTS_HOME = home
    db = openDb(join(home, 'test.db'))
    vi.mocked(openDb).mockClear()
    vi.mocked(replaceGlossary).mockClear()
  })

  afterEach(async () => {
    db.close()
    for (const handle of openedHandles()) if (handle.open) handle.close()
    if (originalHome === undefined) delete process.env.POLYGLOTS_HOME
    else process.env.POLYGLOTS_HOME = originalHome
    await rm(home, { recursive: true, force: true })
  })

  it('stores the exported glossary and makes terms discoverable', async () => {
    const result = await syncGlossary({ locale: 'tr', db, fetch: fixtureFetch })

    expect(result.entries).toBeGreaterThan(400)
    expect(countRows(db, 'tr')).toBe(result.entries)
    expect(lookupGlossary(db, 'plugin', 'tr')[0]).toMatchObject({ sourceTerm: 'plugin', translation: 'eklenti' })
    expect(lookupGlossary(db, 'permalink', 'tr')[0]).toMatchObject({ translation: 'kalıcı bağlantı' })
  })

  // The freshness check reads the sync time from the rows, so a sync must
  // stamp them all with the moment it ran.
  it('records when each locale was synced', async () => {
    const before = Date.now()
    await syncGlossary({ locale: 'tr', db, fetch: fixtureFetch })
    const times = glossarySyncTimes(db)
    expect(times.map((t) => t.locale)).toEqual(['tr'])
    expect(times[0]!.syncedAt).toBeGreaterThanOrEqual(before)
    expect(times[0]!.syncedAt).toBeLessThanOrEqual(Date.now())
  })

  it('replaces stale rows of the synced locale on re-sync', async () => {
    replaceGlossary(db, 'tr', [{ locale: 'tr', sourceTerm: 'bogus-term', translation: 'bogus' }])
    expect(lookupGlossary(db, 'bogus-term', 'tr')).toHaveLength(1)

    await syncGlossary({ locale: 'tr', db, fetch: fixtureFetch })

    expect(lookupGlossary(db, 'bogus-term', 'tr')).toEqual([])
    expect(lookupGlossary(db, 'plugin', 'tr')).not.toHaveLength(0)
  })

  it('leaves other locales untouched', async () => {
    replaceGlossary(db, 'de', [{ locale: 'de', sourceTerm: 'plugin', translation: 'Plugin' }])

    await syncGlossary({ locale: 'tr', db, fetch: fixtureFetch })

    expect(lookupGlossary(db, 'plugin', 'de')).toEqual([{ locale: 'de', sourceTerm: 'plugin', translation: 'Plugin' }])
    expect(countRows(db, 'de')).toBe(1)
  })

  it('rejects when fetch throws and keeps previously stored rows', async () => {
    replaceGlossary(db, 'tr', [{ locale: 'tr', sourceTerm: 'keep-me', translation: 'sakla' }])
    vi.mocked(replaceGlossary).mockClear()

    await expect(syncGlossary({ locale: 'tr', db, fetch: failingFetch })).rejects.toThrow('network down')

    expect(replaceGlossary).not.toHaveBeenCalled()
    expect(lookupGlossary(db, 'keep-me', 'tr')).toHaveLength(1)
    expect(countRows(db, 'tr')).toBe(1)
  })

  it('rejects when the export yields no entries and keeps previously stored rows', async () => {
    replaceGlossary(db, 'tr', [{ locale: 'tr', sourceTerm: 'keep-me', translation: 'sakla' }])
    vi.mocked(replaceGlossary).mockClear()

    await expect(
      syncGlossary({ locale: 'tr', db, fetch: async () => '<html><body><p>nothing</p></body></html>' }),
    ).rejects.toThrow(/no glossary entries/i)

    expect(replaceGlossary).not.toHaveBeenCalled()
    expect(lookupGlossary(db, 'keep-me', 'tr')).toHaveLength(1)
    expect(countRows(db, 'tr')).toBe(1)
  })

  it('passes the locale through to the fetched url and stamps entries with it', async () => {
    const calls: string[] = []
    const fetchPage = async (url: string): Promise<string> => {
      calls.push(url)
      return fixture
    }

    const result = await syncGlossary({ locale: 'de', db, fetch: fetchPage })

    expect(calls).toEqual([glossaryExportUrl('de')])
    expect(result.entries).toBeGreaterThan(400)
    expect(lookupGlossary(db, 'plugin', 'de')[0]).toMatchObject({ locale: 'de', sourceTerm: 'plugin', translation: 'eklenti' })
    expect(countRows(db, 'tr')).toBe(0)
  })

  it('does not open a db of its own when one is injected', async () => {
    await syncGlossary({ locale: 'tr', db, fetch: fixtureFetch })

    expect(openDb).not.toHaveBeenCalled()
    expect(db.open).toBe(true)
    expect(existsSync(dbFile())).toBe(false)
  })

  it('opens its own db under POLYGLOTS_HOME when none is injected and closes it afterwards', async () => {
    expect(existsSync(dbFile())).toBe(false)

    const result = await syncGlossary({ locale: 'tr', fetch: fixtureFetch })

    expect(openDb).toHaveBeenCalledTimes(1)
    expect(vi.mocked(openDb).mock.calls[0]).toEqual([])
    const [handle] = openedHandles()
    expect(handle.name).toBe(dbFile())
    expect(handle.open).toBe(false)

    const own = openDb(dbFile())
    try {
      expect(countRows(own, 'tr')).toBe(result.entries)
    } finally {
      own.close()
    }
  })

  it('opens its own db only after the scrape produced entries', async () => {
    let dbOpenedDuringFetch: boolean | undefined
    const fetchPage = async (url: string): Promise<string> => {
      dbOpenedDuringFetch = vi.mocked(openDb).mock.calls.length > 0
      return fixtureFetch(url)
    }

    await syncGlossary({ locale: 'tr', fetch: fetchPage })

    expect(dbOpenedDuringFetch).toBe(false)
    expect(openDb).toHaveBeenCalledTimes(1)
  })

  it('never opens its own db when the fetch fails', async () => {
    await expect(syncGlossary({ locale: 'tr', fetch: failingFetch })).rejects.toThrow('network down')

    expect(openDb).not.toHaveBeenCalled()
    expect(existsSync(dbFile())).toBe(false)
    expect(existsSync(dataDir())).toBe(false)
  })

  it('never opens its own db when the scrape yields no entries', async () => {
    await expect(
      syncGlossary({ locale: 'tr', fetch: async () => '<html><body><p>nothing</p></body></html>' }),
    ).rejects.toThrow(/no glossary entries/i)

    expect(openDb).not.toHaveBeenCalled()
    expect(existsSync(dbFile())).toBe(false)
  })

  it('closes its own db when the write fails and rethrows the write error', async () => {
    vi.mocked(replaceGlossary).mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    await expect(syncGlossary({ locale: 'tr', fetch: fixtureFetch })).rejects.toThrow('disk full')

    expect(openDb).toHaveBeenCalledTimes(1)
    const [handle] = openedHandles()
    expect(handle.open).toBe(false)
  })

  it('leaves an injected db open when the write fails', async () => {
    vi.mocked(replaceGlossary).mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    await expect(syncGlossary({ locale: 'tr', db, fetch: fixtureFetch })).rejects.toThrow('disk full')

    expect(db.open).toBe(true)
  })
})
