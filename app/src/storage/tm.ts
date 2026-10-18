import type Database from 'better-sqlite3'
import type { Locale, TmEntry, TmMatch } from '../types.js'

interface TmRow {
  source: string
  target: string
  locale: string
  context: string
  project: string | null
  weight: number
}

// 1 is normal and 0 low, stored as a number so that ORDER BY weight DESC puts
// normal rows first without a CASE, and so a later finer weight has room.
const weightOf = (e: TmEntry): number => (e.weight === 'low' ? 0 : 1)

function toEntry(row: TmRow): TmEntry {
  const entry: TmEntry = { source: row.source, target: row.target, locale: row.locale }
  if (row.context !== '') entry.context = row.context
  if (row.project !== null) entry.project = row.project
  if (row.weight === 0) entry.weight = 'low'
  return entry
}

export function upsertTm(db: Database.Database, entries: TmEntry[]): number {
  if (entries.length === 0) return 0
  const stmt = db.prepare(`
    INSERT INTO tm (source, target, locale, context, project, updated_at, weight)
    VALUES (@source, @target, @locale, @context, @project, @updatedAt, @weight)
    ON CONFLICT (source, locale, context, target) DO UPDATE SET
      project = excluded.project,
      updated_at = excluded.updated_at,
      weight = excluded.weight
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
        weight: weightOf(e),
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
 * The weight is written for a new row and, like everything else, left alone
 * on a row already present: a vault that later re-marks a string does not
 * re-rank what the person holds. Re-weighting is deliberately out of scope.
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
    INSERT INTO tm (source, target, locale, context, project, updated_at, weight)
    VALUES (@source, @target, @locale, @context, @project, @updatedAt, @weight)
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
        weight: weightOf(e),
      }).changes
    }
    return added
  })
  let added = 0
  for (let i = 0; i < entries.length; i += chunk) added += run(entries.slice(i, i + chunk))
  return { added, present: entries.length - added }
}

/**
 * Every translation the locale approved for this exact source: rows of normal
 * weight first, then long-text ones, each most recently updated first.
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
 *
 * Weight is the first key, not a tiebreak, so a readme wording imported later
 * never outranks an interface wording imported earlier. Recency decides only
 * among rows of the same weight. The low rows are still returned: a source
 * known only from a readme is better known than not at all.
 */
export function findMemory(db: Database.Database, source: string, locale: Locale, context?: string): TmEntry[] {
  const stmt = db.prepare<[string, string, string], TmRow>(
    `SELECT source, target, locale, context, project, weight FROM tm
     WHERE source = ? AND locale = ? AND context = ?
     ORDER BY weight DESC, updated_at DESC, id DESC`,
  )
  if (context) {
    const scoped = stmt.all(source, locale, context)
    if (scoped.length > 0) return scoped.map(toEntry)
  }
  return stmt.all(source, locale, '').map(toEntry)
}

/**
 * The rows whose source is this one in other capitals ("Social Icons" for
 * "Social icons"), in findMemory's order and under its context rule. The
 * exact rows are left out: findMemory has already answered for them.
 *
 * Only a fallback, asked when none of the exact wordings uses the glossary
 * term. No index serves a case-blind match on `source`, and one is
 * deliberately not added: the database holding the memory cannot be
 * regenerated, and its schema is not changed to speed up a fallback. A plain
 * scan read every locale's rows, about 25 ms on a real 356,000-row memory,
 * synchronously and so with the TUI frozen, and a long file can ask hundreds
 * of times. The full-text index the memory already keeps for search, which
 * the tm triggers hold in step with every insert, update and delete, narrows
 * the rows to those holding the source's words as a phrase first; it folds
 * case itself, so a case variant is never narrowed away. The comparison that
 * decides is still the NOCASE one. A source with no words, or one the index
 * cannot parse, falls back to the scan.
 *
 * NOCASE folds ASCII letters only, so "Ä" and "ä" still differ. The sources
 * are English, where that covers what matters, and a fold that also matched
 * what it should not would put a stranger's wording in the file.
 *
 * Prepared per call, as findMemory and searchTm are: the file keeps no
 * statement cache, and a fallback this rare does not earn the first one.
 */
export function findMemoryIgnoringCase(db: Database.Database, source: string, locale: Locale, context?: string): TmEntry[] {
  const words = tokens(source)
  // One quoted phrase of the source's words. tokens() keeps letters and
  // digits only, so no quote can reach the query to need doubling.
  const phrase = words.length > 0 ? `"${words.join(' ')}"` : undefined
  const indexed = db.prepare<[string, string, string, string, string], TmRow>(
    `SELECT t.source, t.target, t.locale, t.context, t.project, t.weight
     FROM tm_fts f JOIN tm t ON t.id = f.rowid
     WHERE tm_fts MATCH ? AND t.source = ? COLLATE NOCASE AND t.source <> ? AND t.locale = ? AND t.context = ?
     ORDER BY t.weight DESC, t.updated_at DESC, t.id DESC`,
  )
  const scan = db.prepare<[string, string, string, string], TmRow>(
    `SELECT source, target, locale, context, project, weight FROM tm
     WHERE source = ? COLLATE NOCASE AND source <> ? AND locale = ? AND context = ?
     ORDER BY weight DESC, updated_at DESC, id DESC`,
  )
  const rows = (ctx: string): TmRow[] => {
    if (phrase !== undefined) {
      try {
        return indexed.all(phrase, source, source, locale, ctx)
      } catch {
        // An FTS syntax the tokenizer and tokens() disagree on: the scan is
        // slower but cannot be wrong.
      }
    }
    return scan.all(source, source, locale, ctx)
  }
  if (context) {
    const scoped = rows(context)
    if (scoped.length > 0) return scoped.map(toEntry)
  }
  return rows('').map(toEntry)
}

/**
 * The one alternative to use where only one will do, such as filling an
 * untranslated entry on a translate run. A row of normal weight beats a
 * long-text one, then the most recently updated wins, which is a choice rather
 * than a verdict: see `findMemory` for why there can be several, and mark the
 * result for a human when it came from a source that has more than one.
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
      `SELECT tm.source, tm.target, tm.locale, tm.context, tm.project, tm.weight
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
    // Weight only breaks a tie: a closer long-text match is still the more
    // useful hint than a distant one chosen for an interface.
    .sort((a, b) => b.score - a.score || weightOf(b) - weightOf(a))
}
