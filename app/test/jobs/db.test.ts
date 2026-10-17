import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openJobsDb } from '../../src/jobs/db.js'

async function tempDb(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'polyglots-jobs-'))
  return { path: join(dir, 'jobs.db'), cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe('openJobsDb', () => {
  it('creates every table', async () => {
    const { path, cleanup } = await tempDb()
    const db = openJobsDb(path)
    const names = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name)
    expect(names).toEqual(expect.arrayContaining(['run', 'audit_verdict', 'draft', 'draft_verdict', 'batch_failure']))
    db.close()
    await cleanup()
  })

  // Up to 0.32.0 every run wrote one row per string to an entry table and
  // deleted them when it ended. A build from then may still be mid-run on this
  // file, or hold it open for a batch, and its delete throws if the table is
  // gone. So a new database never gets the table and an old one keeps it.
  it('does not create the entry table, and leaves an older one in place', async () => {
    const fresh = await tempDb()
    const db = openJobsDb(fresh.path)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entry'").get()).toBeUndefined()
    db.close()
    await fresh.cleanup()

    const { path, cleanup } = await tempDb()
    const old = new Database(path)
    old.exec(`CREATE TABLE run (id INTEGER PRIMARY KEY, state TEXT NOT NULL, started_at INTEGER NOT NULL);
      CREATE TABLE entry (run_id INTEGER NOT NULL, key TEXT NOT NULL, ord INTEGER NOT NULL, PRIMARY KEY (run_id, key)) WITHOUT ROWID;
      INSERT INTO entry VALUES (1, 'a', 0);`)
    old.close()
    const reopened = openJobsDb(path)
    expect(reopened.prepare('SELECT count(*) AS n FROM entry').get()).toEqual({ n: 1 })
    reopened.close()
    await cleanup()
  })

  it('uses WAL, so a development build and a stable build can share it', async () => {
    const { path, cleanup } = await tempDb()
    const db = openJobsDb(path)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    db.close()
    await cleanup()
  })

  it('is idempotent, so opening an existing database does not throw', async () => {
    const { path, cleanup } = await tempDb()
    openJobsDb(path).close()
    expect(() => openJobsDb(path).close()).not.toThrow()
    await cleanup()
  })

  it('creates the directory when it does not exist', async () => {
    const { path, cleanup } = await tempDb()
    const nested = join(path, '..', 'deeper', 'jobs.db')
    expect(() => openJobsDb(nested).close()).not.toThrow()
    await cleanup()
  })
})
