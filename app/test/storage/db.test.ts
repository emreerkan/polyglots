import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DatabaseCtor from 'better-sqlite3'
import { openDb } from '../../src/storage/db.js'
import { upsertTm, findExactTm } from '../../src/storage/tm.js'

describe('openDb', () => {
  let home: string
  const original = process.env.POLYGLOTS_HOME

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'polyglots-db-'))
  })

  afterEach(async () => {
    if (original === undefined) delete process.env.POLYGLOTS_HOME
    else process.env.POLYGLOTS_HOME = original
    await rm(home, { recursive: true, force: true })
  })

  it('creates the parent directory and all tables', async () => {
    const path = join(home, 'nested', 'deeper', 'polyglots.db')
    const db = openDb(path)
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name)
    expect(names).toEqual(expect.arrayContaining(['tm', 'glossary', 'consistency_cache', 'tm_fts']))
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    db.close()
    expect((await stat(path)).isFile()).toBe(true)
  })

  it('defaults to dbFile() under POLYGLOTS_HOME', async () => {
    process.env.POLYGLOTS_HOME = home
    const db = openDb()
    db.close()
    expect((await stat(join(home, 'data', 'polyglots.db'))).isFile()).toBe(true)
  })

  it('migrations are idempotent across reopen and keep data', () => {
    const path = join(home, 'polyglots.db')
    const first = openDb(path)
    upsertTm(first, [{ source: 'Save changes', target: 'Değişiklikleri kaydet', locale: 'tr' }])
    first.close()

    const second = openDb(path)
    expect(findExactTm(second, 'Save changes', 'tr')?.target).toBe('Değişiklikleri kaydet')
    const count = second.prepare('SELECT count(*) AS n FROM tm').get() as { n: number }
    expect(count.n).toBe(1)
    second.close()
  })

  /**
   * polyglots.db holds months of TMX imports and cannot be regenerated, so the
   * column that ranks long-text strings lower must arrive without a row lost
   * or rewritten. The table here is the shape every database had before it.
   */
  describe('the weight column', () => {
    function oldShape(path: string): void {
      const raw = new DatabaseCtor(path)
      raw.exec(`
        CREATE TABLE tm (
          id INTEGER PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL, locale TEXT NOT NULL,
          context TEXT NOT NULL DEFAULT '', project TEXT, updated_at TEXT NOT NULL,
          UNIQUE (source, locale, context, target)
        );
        INSERT INTO tm (source, target, locale, context, project, updated_at) VALUES
          ('Save', 'Kaydet', 'tr', '', 'core', '2020-01-01T00:00:00.000Z'),
          ('Edit', 'Düzenle', 'tr', '', NULL, '2020-01-01T00:00:00.000Z'),
          ('Post', 'Gönder', 'tr', 'verb', 'core', '2020-01-01T00:00:00.000Z');
      `)
      raw.close()
    }

    it('adds the weight column to an existing memory and keeps every row', () => {
      const path = join(home, 'old.db')
      oldShape(path)
      const db = openDb(path)
      try {
        expect(db.prepare('SELECT COUNT(*) n FROM tm').get()).toEqual({ n: 3 })
        expect(db.prepare('SELECT weight FROM tm').all()).toEqual([{ weight: 1 }, { weight: 1 }, { weight: 1 }])
        expect(findExactTm(db, 'Post', 'tr', 'verb')?.target).toBe('Gönder')
      } finally {
        db.close()
      }
    })

    it('opens twice without failing (the column is added once)', () => {
      const path = join(home, 'old.db')
      oldShape(path)
      openDb(path).close()
      const db = openDb(path)
      try {
        const columns = (db.pragma('table_info(tm)') as Array<{ name: string }>).filter((c) => c.name === 'weight')
        expect(columns).toHaveLength(1)
      } finally {
        db.close()
      }
    })

    it('gives a fresh database the column from the start', () => {
      const db = openDb(join(home, 'fresh.db'))
      try {
        const weight = (db.pragma('table_info(tm)') as Array<{ name: string; dflt_value: string; notnull: number }>).find(
          (c) => c.name === 'weight',
        )
        expect(weight).toMatchObject({ dflt_value: '1', notnull: 1 })
      } finally {
        db.close()
      }
    })

    // The widening rebuild copies a table that has no weight, so the column
    // has to be added after it, not before.
    it('adds it after widening a memory that held one translation per source', () => {
      const path = join(home, 'narrow.db')
      const raw = new DatabaseCtor(path)
      raw.exec(`
        CREATE TABLE tm (
          id INTEGER PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL, locale TEXT NOT NULL,
          context TEXT NOT NULL DEFAULT '', project TEXT, updated_at TEXT NOT NULL,
          UNIQUE (source, locale, context)
        );
        INSERT INTO tm (source, target, locale, context, project, updated_at)
        VALUES ('Save', 'Kaydet', 'tr', '', 'core', '2020-01-01T00:00:00.000Z');
      `)
      raw.close()
      const db = openDb(path)
      try {
        expect(db.prepare('SELECT source, weight FROM tm').all()).toEqual([{ source: 'Save', weight: 1 }])
      } finally {
        db.close()
      }
    })
  })
})
