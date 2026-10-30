import type Database from 'better-sqlite3'
import type { GlossaryEntry, Locale } from '../types.js'
import type { EffectiveRow, GlossaryRow } from '../glossary/types.js'
import { entryToRow, rowToEntry } from '../glossary/csv.js'
import { allGlossary } from './glossary.js'

export type { EffectiveRow, GlossaryRow, RowOrigin } from '../glossary/types.js'

interface EditRow {
  kind: string
  base_term: string | null
  base_pos: string | null
  base_translation: string | null
  base_notes: string | null
  term: string | null
  pos: string | null
  translation: string | null
  notes: string | null
}

const key = (r: GlossaryRow): string => JSON.stringify([r.term, r.pos, r.translation, r.notes])

/**
 * The setup screen reads a handle that cannot migrate, so a database last
 * opened by an older build has no edits table yet. That reads as no edits,
 * not as an error that would hide the wp.org rows too.
 */
function hasEditsTable(db: Database.Database): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'glossary_edits'").get() !== undefined
}

/**
 * The glossary every reader sees: the wp.org copy with the person's local
 * edits applied. The `glossary` table stays exactly what a sync wrote; edits
 * live beside it so a sync cannot erase them.
 *
 * A wp.org row is identified by its full content, because the export has no
 * ids and one term can have several rows. An edit whose base no longer exists
 * verbatim is skipped here rather than guessed at: the sync step that follows
 * a wp.org change decides what to do with it, and a reader must never apply an
 * edit to a row it was not made against. Two identical wp.org rows share one
 * identity, so an edit applies to the first and the twin stays as it was.
 */
export function effectiveGlossary(db: Database.Database, locale: Locale): EffectiveRow[] {
  const edits = !hasEditsTable(db)
    ? []
    : db
    .prepare<[string], EditRow>(
      `SELECT kind, base_term, base_pos, base_translation, base_notes, term, pos, translation, notes
       FROM glossary_edits WHERE locale = ? ORDER BY id`,
    )
    .all(locale)
  const changes = new Map<string, GlossaryRow>()
  const deletes = new Set<string>()
  const adds: GlossaryRow[] = []
  for (const e of edits) {
    const row: GlossaryRow = { term: e.term ?? '', pos: e.pos ?? '', translation: e.translation ?? '', notes: e.notes ?? '' }
    if (e.kind === 'add') {
      adds.push(row)
      continue
    }
    const base: GlossaryRow = {
      term: e.base_term ?? '',
      pos: e.base_pos ?? '',
      translation: e.base_translation ?? '',
      notes: e.base_notes ?? '',
    }
    if (e.kind === 'delete') deletes.add(key(base))
    else if (e.kind === 'change') changes.set(key(base), row)
  }
  const out: EffectiveRow[] = []
  for (const entry of allGlossary(db, locale)) {
    const base = entryToRow(entry)
    const k = key(base)
    if (deletes.has(k)) continue
    const changed = changes.get(k)
    out.push(changed ? { ...changed, origin: 'changed', base } : { ...base, origin: 'wporg' })
  }
  for (const row of adds) out.push({ ...row, origin: 'added' })
  return out
}

export function effectiveEntries(db: Database.Database, locale: Locale): GlossaryEntry[] {
  return effectiveGlossary(db, locale).map((r) => rowToEntry(r, locale))
}

/**
 * Same order as lookupGlossary: exact matches first, then terms that merely
 * contain the query, shortest term first. Done in memory because the edits
 * are not in the table the SQL there reads; a locale's glossary is a few
 * thousand rows. Case folding is JS's, wider than SQLite's ASCII-only NOCASE.
 */
export function lookupEffectiveGlossary(db: Database.Database, term: string, locale: Locale): GlossaryEntry[] {
  const needle = term.trim().toLowerCase()
  if (needle.length === 0) return []
  const rows = effectiveEntries(db, locale)
  const exact = rows.filter((e) => e.sourceTerm.toLowerCase() === needle)
  const partial = rows
    .filter((e) => e.sourceTerm.toLowerCase() !== needle && e.sourceTerm.toLowerCase().includes(needle))
    .sort((a, b) => a.sourceTerm.length - b.sourceTerm.length)
  return [...exact, ...partial]
}

/**
 * A change marker for the effective glossary of a locale: the edit count
 * catches a deletion that leaves the newest timestamp alone, and the two
 * maxima catch a sync and an edit.
 */
export function glossaryStamp(db: Database.Database, locale: Locale): string {
  const g = db
    .prepare<[string], { m: string | null }>('SELECT max(updated_at) AS m FROM glossary WHERE locale = ?')
    .get(locale)
  const e = db
    .prepare<[string], { n: number; m: string | null }>(
      'SELECT count(*) AS n, max(updated_at) AS m FROM glossary_edits WHERE locale = ?',
    )
    .get(locale)
  return `${e?.n ?? 0}|${g?.m ?? ''}|${e?.m ?? ''}`
}
