import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { dbFile } from '../paths.js'

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS tm (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  locale TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  project TEXT,
  updated_at TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  UNIQUE (source, locale, context, target)
);

CREATE VIRTUAL TABLE IF NOT EXISTS tm_fts USING fts5(
  source,
  content='tm',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS tm_ai AFTER INSERT ON tm BEGIN
  INSERT INTO tm_fts(rowid, source) VALUES (new.id, new.source);
END;

CREATE TRIGGER IF NOT EXISTS tm_ad AFTER DELETE ON tm BEGIN
  INSERT INTO tm_fts(tm_fts, rowid, source) VALUES ('delete', old.id, old.source);
END;

CREATE TRIGGER IF NOT EXISTS tm_au AFTER UPDATE OF source ON tm BEGIN
  INSERT INTO tm_fts(tm_fts, rowid, source) VALUES ('delete', old.id, old.source);
  INSERT INTO tm_fts(rowid, source) VALUES (new.id, new.source);
END;

CREATE TABLE IF NOT EXISTS glossary (
  id INTEGER PRIMARY KEY,
  locale TEXT NOT NULL,
  source_term TEXT NOT NULL,
  translation TEXT NOT NULL,
  part_of_speech TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS glossary_locale_term ON glossary (locale, source_term COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS consistency_cache (
  source_text TEXT NOT NULL,
  locale TEXT NOT NULL,
  scope TEXT NOT NULL,
  results_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (source_text, locale, scope)
);

CREATE TABLE IF NOT EXISTS glossary_edits (
  id INTEGER PRIMARY KEY,
  locale TEXT NOT NULL,
  kind TEXT NOT NULL,
  base_term TEXT, base_pos TEXT, base_translation TEXT, base_notes TEXT,
  term TEXT, pos TEXT, translation TEXT, notes TEXT,
  base_snapshot TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS glossary_edits_locale ON glossary_edits (locale);
`

// Rows cached before `scope` existed hold unfiltered all-project results under what is now
// the core-scoped key. The cache is disposable, so drop it rather than migrate the rows.
function dropPreScopeCache(db: Database.Database): void {
  const columns = db.pragma('table_info(consistency_cache)') as Array<{ name: string }>
  if (columns.length > 0 && !columns.some(c => c.name === 'scope')) {
    db.exec('DROP TABLE consistency_cache;')
  }
}

/**
 * Rebuilds a `tm` written before the memory kept alternatives.
 *
 * Its unique constraint covers only source, locale and context, so a second
 * approved wording for a source could not be stored and an import overwrote
 * whatever was there. SQLite cannot drop a constraint, so the table is rebuilt
 * with the rows carried over, and the full text index is rebuilt after it
 * because it is content-backed by the table that was just replaced. The
 * triggers go with the old table and are recreated by the migrations below.
 */
function needsWidening(db: Database.Database): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tm'").get() as
    | { sql: string }
    | undefined
  return row !== undefined && /UNIQUE\s*\(\s*source\s*,\s*locale\s*,\s*context\s*\)/i.test(row.sql)
}

function widenTmUniqueness(db: Database.Database): void {
  db.exec(`
    BEGIN;
    CREATE TABLE tm_widened (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      locale TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '',
      project TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE (source, locale, context, target)
    );
    INSERT INTO tm_widened (id, source, target, locale, context, project, updated_at)
      SELECT id, source, target, locale, context, project, updated_at FROM tm;
    DROP TABLE tm;
    ALTER TABLE tm_widened RENAME TO tm;
    COMMIT;
  `)
}

/**
 * Gives a memory written before long-text weight its weight column, every row
 * normal.
 *
 * Additive only, unlike the widening above: polyglots.db holds months of
 * imports and cannot be regenerated, so no row is copied or rewritten, and
 * ADD COLUMN with a constant default fills the old rows without touching them.
 * An older build still running against the same file keeps working, because
 * every insert it makes names its columns and the new one has a default.
 * Checked through table_info rather than caught from a failed ALTER, so a
 * second open is a read and nothing else.
 */
function ensureTmWeight(db: Database.Database): void {
  const columns = db.pragma('table_info(tm)') as Array<{ name: string }>
  if (!columns.some((c) => c.name === 'weight')) {
    db.exec('ALTER TABLE tm ADD COLUMN weight INTEGER NOT NULL DEFAULT 1;')
  }
}

export function openDb(path: string = dbFile()): Database.Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  dropPreScopeCache(db)
  const widened = needsWidening(db)
  if (widened) widenTmUniqueness(db)
  db.exec(MIGRATIONS)
  // After the widening, whose rebuilt table has no weight, and after
  // MIGRATIONS, which is a no-op on a table that already exists.
  ensureTmWeight(db)
  // After the triggers exist again, so the index and the table agree.
  if (widened) db.exec("INSERT INTO tm_fts(tm_fts) VALUES('rebuild');")
  return db
}
