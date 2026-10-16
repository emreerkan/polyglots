import type Database from 'better-sqlite3'
import type { Locale, TmEntry, TmMatch } from '../types.js'

interface TmRow {
  source: string
  target: string
  locale: string
  context: string
  project: string | null
}

function toEntry(row: TmRow): TmEntry {
  const entry: TmEntry = { source: row.source, target: row.target, locale: row.locale }
  if (row.context !== '') entry.context = row.context
  if (row.project !== null) entry.project = row.project
  return entry
}

export function upsertTm(db: Database.Database, entries: TmEntry[]): number {
  if (entries.length === 0) return 0
  const stmt = db.prepare(`
    INSERT INTO tm (source, target, locale, context, project, updated_at)
    VALUES (@source, @target, @locale, @context, @project, @updatedAt)
    ON CONFLICT (source, locale, context, target) DO UPDATE SET
      project = excluded.project,
      updated_at = excluded.updated_at
  `)
  const updatedAt = new Date().toISOString()
  const run = db.transaction((batch: TmEntry[]) => {
    for (const e of batch) {
      stmt.run({
        source: e.source,
        target: e.target,
        locale: e.locale,
        context: e.context ?? '',
        project: e.project ?? null,
        updatedAt,
      })
    }
    return batch.length
  })
  return run(entries)
}

/**
 * Adds the rows the memory does not hold yet and leaves every other row as it
 * is: project, updated_at, everything. The insert-only counterpart of
 * upsertTm, for tm fetch.
 *
 * A row the person already has may be one they imported and tagged
 * themselves, and the vault re-tagging or re-dating it would quietly change
 * which alternative findMemory puts first. So a match is skipped, never
 * refreshed. New rows take `updatedAt` from the caller rather than now: the
 * build time of the vault, so a vault wording does not outrank the person's
 * own alternatives merely because it arrived later.
 *
 * One transaction per chunk rather than one for the lot, so a review writing
 * to the same database waits for one chunk at most, inside SQLite's busy
 * timeout, instead of for the whole import.
 */
export function insertTmIfAbsent(
  db: Database.Database,
  entries: TmEntry[],
  updatedAt: string,
  chunk = 5000,
): { added: number; present: number } {
  const stmt = db.prepare(`
    INSERT INTO tm (source, target, locale, context, project, updated_at)
    VALUES (@source, @target, @locale, @context, @project, @updatedAt)
    ON CONFLICT (source, locale, context, target) DO NOTHING
  `)
  const run = db.transaction((batch: TmEntry[]) => {
    let added = 0
    for (const e of batch) {
      added += stmt.run({
        source: e.source,
        target: e.target,
        locale: e.locale,
        context: e.context ?? '',
        project: e.project ?? null,
        updatedAt,
      }).changes
    }
    return added
  })
  let added = 0
  for (let i = 0; i < entries.length; i += chunk) added += run(entries.slice(i, i + chunk))
  return { added, present: entries.length - added }
}

/**
 * Every translation the locale approved for this exact source, most recently
 * updated first.
 *
 * The memory holds alternatives rather than one answer per source. A real
 * export had 6,480 sources with more than one approved wording, most of them
 * synonyms nobody should have to choose between, and collapsing them made
 * whichever came last in a file the one that speaks for the source.
 *
 * A context's alternatives are its own: they are never mixed with the
 * context-less ones, because a msgctxt exists exactly where a source means
 * different things. The fallback to the context-less rows when the scoped
 * context holds nothing is unchanged, and callers that act without a model
 * still have to know which of the two they got.
 */
export function findMemory(db: Database.Database, source: string, locale: Locale, context?: string): TmEntry[] {
  const stmt = db.prepare<[string, string, string], TmRow>(
    `SELECT source, target, locale, context, project FROM tm
     WHERE source = ? AND locale = ? AND context = ?
     ORDER BY updated_at DESC, id DESC`,
  )
  if (context) {
    const scoped = stmt.all(source, locale, context)
    if (scoped.length > 0) return scoped.map(toEntry)
  }
  return stmt.all(source, locale, '').map(toEntry)
}

/**
 * The one alternative to use where only one will do, such as filling an
 * untranslated entry on a translate run. The most recently updated wins, which
 * is a choice rather than a verdict: see `findMemory` for why there can be
 * several, and mark the result for a human when it came from a source that has
 * more than one.
 */
export function findExactTm(
  db: Database.Database,
  source: string,
  locale: Locale,
  context?: string,
): TmEntry | undefined {
  return findMemory(db, source, locale, context)[0]
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
}

function overlapScore(query: string[], source: string[]): number {
  const q = new Set(query)
  const s = new Set(source)
  let shared = 0
  for (const t of q) if (s.has(t)) shared++
  const union = q.size + s.size - shared
  if (union === 0) return 0
  return Math.min(0.99, Math.max(0.01, shared / union))
}

export function searchTm(db: Database.Database, text: string, locale: Locale, limit = 5): TmMatch[] {
  const queryTokens = tokens(text)
  if (queryTokens.length === 0 || limit <= 0) return []
  const match = queryTokens.map((t) => `"${t}"`).join(' OR ')
  const rows = db
    .prepare<[string, string, number], TmRow>(
      `SELECT tm.source, tm.target, tm.locale, tm.context, tm.project
       FROM tm_fts
       JOIN tm ON tm.id = tm_fts.rowid
       WHERE tm_fts MATCH ? AND tm.locale = ?
       ORDER BY bm25(tm_fts)
       LIMIT ?`,
    )
    .all(match, locale, limit)
  const normalized = text.trim().toLowerCase()
  return rows
    .map((row) => ({
      ...toEntry(row),
      score: row.source.trim().toLowerCase() === normalized ? 1 : overlapScore(queryTokens, tokens(row.source)),
    }))
    .sort((a, b) => b.score - a.score)
}
