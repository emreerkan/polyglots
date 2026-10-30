import type Database from 'better-sqlite3'
import type { GlossaryEntry, Locale } from '../types.js'
import type { EffectiveRow, GlossaryDiff, GlossaryRow } from '../glossary/types.js'
import { entryToRow, rowToEntry } from '../glossary/csv.js'
import { importDiff } from '../glossary/import.js'
import { allGlossary } from './glossary.js'

export type { EffectiveRow, GlossaryDiff, GlossaryRow, RowOrigin } from '../glossary/types.js'

interface EditRow {
  id: number
  kind: string
  base_term: string | null
  base_pos: string | null
  base_translation: string | null
  base_notes: string | null
  term: string | null
  pos: string | null
  translation: string | null
  notes: string | null
  base_snapshot: string | null
}

const key = (r: GlossaryRow): string => JSON.stringify([r.term, r.pos, r.translation, r.notes])

// NULL and '' both read as empty: the writer below stores '', and a NULL is
// what a delete leaves in the row columns and an add in the base columns.
const editRow = (e: EditRow): GlossaryRow => ({
  term: e.term ?? '',
  pos: e.pos ?? '',
  translation: e.translation ?? '',
  notes: e.notes ?? '',
})
const editBase = (e: EditRow): GlossaryRow => ({
  term: e.base_term ?? '',
  pos: e.base_pos ?? '',
  translation: e.base_translation ?? '',
  notes: e.base_notes ?? '',
})
const plain = (r: GlossaryRow): GlossaryRow => ({ term: r.term, pos: r.pos, translation: r.translation, notes: r.notes })

const selectEdits = `SELECT id, kind, base_term, base_pos, base_translation, base_notes, term, pos, translation, notes,
  base_snapshot FROM glossary_edits WHERE locale = ? ORDER BY id`

/**
 * The wp.org rows an add stands beside: same term under JS case folding, same
 * part of speech exactly. The save writes an add's snapshot with this and the
 * sync compares against it with this, and the two must never disagree: a
 * sync that folded case differently from the save would see every add of a
 * capitalised term as changed and remove it at the first sync.
 */
function besideAdd(wporg: GlossaryRow[], r: GlossaryRow): GlossaryRow[] {
  const term = r.term.toLowerCase()
  return wporg.filter((w) => w.term.toLowerCase() === term && w.pos === r.pos)
}

/** The stored form of an add's snapshot: the translations beside it, sorted, as JSON. */
function addSnapshot(wporg: GlossaryRow[], r: GlossaryRow): string {
  return JSON.stringify(besideAdd(wporg, r).map((w) => w.translation).sort())
}

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
    : db.prepare<[string], EditRow>(selectEdits).all(locale)
  const changes = new Map<string, GlossaryRow>()
  const deletes = new Set<string>()
  const adds: GlossaryRow[] = []
  for (const e of edits) {
    const row = editRow(e)
    if (e.kind === 'add') {
      adds.push(row)
      continue
    }
    const base = editBase(e)
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

/** The page's view of the glossary is older than the store's: a sync or another save ran since it loaded. */
export class StaleGlossaryError extends Error {
  constructor(message = 'The glossary changed since this page was opened; reload.') {
    super(message)
    this.name = 'StaleGlossaryError'
  }
}

/**
 * Applies a page's diff as edits, in one transaction, and returns the stamp
 * the page should hold next.
 *
 * Every edit is resolved to a row id before anything is written. Resolving as
 * it went would let one entry of the diff find a row an earlier entry had just
 * written: change A to B and B to C, both added rows, and the second lookup
 * could land on the row that was A a moment ago.
 *
 * A base keeps at most one edit. The schema allows two, and the reader then
 * picks one silently, so a page that names a base that already has an edit
 * updates that edit instead of adding a second beside it.
 *
 * A diff that names a row the store does not have (an added row with no add
 * edit, a base that is not a wp.org row) is refused as stale rather than
 * skipped: it means the page and the store disagree, and saving the rest of
 * the diff would write half of what the person asked for.
 */
export function saveGlossaryEdits(
  db: Database.Database,
  locale: Locale,
  diff: GlossaryDiff,
  stamp: string,
  now: () => Date = () => new Date(),
): string {
  return db.transaction(() => {
    if (stamp !== glossaryStamp(db, locale)) throw new StaleGlossaryError()

    const wporg = allGlossary(db, locale).map(entryToRow)
    const wporgKeys = new Set(wporg.map(key))
    const edits = db.prepare<[string], EditRow>(selectEdits).all(locale)
    // Base key to the id of the edit on it. This save never writes a second
    // edit on a base, so the first by id is the only one.
    const byBase = new Map<string, number>()
    for (const e of edits) if (e.kind !== 'add' && !byBase.has(key(editBase(e)))) byBase.set(key(editBase(e)), e.id)
    const adds = edits.filter((e) => e.kind === 'add')
    const claimed = new Set<number>()

    // The first unclaimed add edit with this content. Twins are told apart
    // only by claiming: deleting both of two identical added rows removes both
    // edits, not the first one twice.
    const claimAdd = (r: GlossaryRow): EditRow => {
      const k = key(r)
      const e = adds.find((a) => !claimed.has(a.id) && key(editRow(a)) === k)
      if (!e) throw new StaleGlossaryError()
      claimed.add(e.id)
      return e
    }
    const baseOf = (r: EffectiveRow): GlossaryRow => {
      const base = r.origin === 'changed' ? r.base : plain(r)
      if (!base || !wporgKeys.has(key(base))) throw new StaleGlossaryError()
      return base
    }

    // A write is one of: put an edit on a base, remove an edit, set an add.
    type Write =
      | { op: 'base'; base: GlossaryRow; to: GlossaryRow | null }
      | { op: 'drop'; id: number }
      | { op: 'add'; id: number | null; to: GlossaryRow }
    const writes: Write[] = []
    for (const { from, to } of diff.changed) {
      if (from.origin === 'added') writes.push({ op: 'add', id: claimAdd(from).id, to: plain(to) })
      else writes.push({ op: 'base', base: baseOf(from), to: plain(to) })
    }
    for (const r of diff.deleted) {
      if (r.origin === 'added') writes.push({ op: 'drop', id: claimAdd(r).id })
      else writes.push({ op: 'base', base: baseOf(r), to: null })
    }
    for (const r of diff.added) writes.push({ op: 'add', id: null, to: plain(r) })

    const at = nextTimestamp(db, locale, now())
    const snapshot = (r: GlossaryRow): string => addSnapshot(wporg, r)
    const insert = db.prepare(
      `INSERT INTO glossary_edits (locale, kind, base_term, base_pos, base_translation, base_notes,
         term, pos, translation, notes, base_snapshot, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const update = db.prepare(
      'UPDATE glossary_edits SET kind = ?, term = ?, pos = ?, translation = ?, notes = ?, updated_at = ? WHERE id = ?',
    )
    const updateAdd = db.prepare(
      `UPDATE glossary_edits SET term = ?, pos = ?, translation = ?, notes = ?, base_snapshot = ?, updated_at = ?
       WHERE id = ?`,
    )
    const drop = db.prepare('DELETE FROM glossary_edits WHERE id = ?')
    const values = (r: GlossaryRow | null): Array<string | null> =>
      r ? [r.term, r.pos, r.translation, r.notes] : [null, null, null, null]

    for (const w of writes) {
      if (w.op === 'drop') {
        drop.run(w.id)
      } else if (w.op === 'add') {
        // The snapshot is of the wp.org rows of the add's term and part of
        // speech, so an edit that moves the add to another term or part of
        // speech takes a fresh one; otherwise the sync would compare it
        // against rows it was never made beside.
        if (w.id === null) insert.run(locale, 'add', ...values(null), ...values(w.to), snapshot(w.to), at, at)
        else updateAdd.run(...values(w.to), snapshot(w.to), at, w.id)
      } else {
        const k = key(w.base)
        const existing = byBase.get(k)
        if (w.to !== null && key(w.to) === k) {
          // Back to the wp.org row: no edit at all, not a change to itself.
          if (existing !== undefined) {
            drop.run(existing)
            byBase.delete(k)
          }
        } else if (existing !== undefined) {
          update.run(w.to === null ? 'delete' : 'change', ...values(w.to), at, existing)
        } else {
          const kind = w.to === null ? 'delete' : 'change'
          const id = insert.run(locale, kind, ...values(w.base), ...values(w.to), null, at, at).lastInsertRowid
          byBase.set(k, Number(id))
        }
      }
    }
    return glossaryStamp(db, locale)
  })()
}

/**
 * The stamp moves only if the newest updated_at does, or the count changes.
 * A save that updates an edit in the same millisecond as the last one (or
 * under a fixed test clock) would leave both alone and hand an older page a
 * stamp that still matches, so the time is pushed past the newest one.
 */
function nextTimestamp(db: Database.Database, locale: Locale, now: Date): string {
  const newest = db
    .prepare<[string], { m: string | null }>('SELECT max(updated_at) AS m FROM glossary_edits WHERE locale = ?')
    .get(locale)?.m
  const floor = newest ? Date.parse(newest) + 1 : -Infinity
  return new Date(Math.max(now.getTime(), floor)).toISOString()
}

/** Deletes every local edit of the locale, leaving the wp.org copy as the glossary. */
export function discardGlossaryEdits(db: Database.Database, locale: Locale): number {
  return db.prepare('DELETE FROM glossary_edits WHERE locale = ?').run(locale).changes
}

/**
 * Loads a reviewed CSV as local edits: the CSV's term wins. Counts are terms
 * replaced (a term the glossary already had any row of) and rows added, which
 * is what `glossary import` reports.
 */
export function importGlossaryRows(
  db: Database.Database,
  locale: Locale,
  rows: GlossaryRow[],
  stamp: string,
): { replaced: number; added: number } {
  return db.transaction(() => {
    const diff = importDiff(effectiveGlossary(db, locale), rows)
    saveGlossaryEdits(db, locale, diff, stamp)
    return { replaced: new Set(diff.deleted.map((r) => r.term.toLowerCase())).size, added: diff.added.length }
  })()
}

/**
 * A local edit a sync removed because wp.org changed what it was made against.
 * Term and part of speech are the base's for a change or delete and the row's
 * for an add; `local` is absent for a delete. `wporg` holds the rows of that
 * term and part of speech after the sync, empty when the term is gone.
 */
export interface RemovedEdit {
  kind: 'add' | 'change' | 'delete'
  term: string
  pos: string
  local?: GlossaryRow
  wporg: GlossaryRow[]
}

/**
 * Run by the sync inside its own transaction, after the new wp.org rows are
 * in: removes every edit the new copy invalidates and returns what it removed.
 *
 * A change or delete stays while its base is still a wp.org row verbatim;
 * otherwise the locale team touched the row and their version wins. An add has
 * no base, so it is held against the snapshot taken when it was made: while
 * the wp.org translations of its term and part of speech are the same set, the
 * add stays, because a second translation beside an existing one is a legal
 * edit and must not vanish at every sync. A NULL snapshot is read as none,
 * which is what a save would have written for a term wp.org did not have.
 */
export function reconcileGlossaryEdits(db: Database.Database, locale: Locale): RemovedEdit[] {
  if (!hasEditsTable(db)) return []
  const wporg = allGlossary(db, locale).map(entryToRow)
  const wporgKeys = new Set(wporg.map(key))
  const drop = db.prepare('DELETE FROM glossary_edits WHERE id = ?')
  const removed: RemovedEdit[] = []
  for (const e of db.prepare<[string], EditRow>(selectEdits).all(locale)) {
    const kind = e.kind === 'add' ? 'add' : e.kind === 'delete' ? 'delete' : 'change'
    const anchor = kind === 'add' ? editRow(e) : editBase(e)
    const kept = kind === 'add' ? addSnapshot(wporg, anchor) === (e.base_snapshot ?? '[]') : wporgKeys.has(key(anchor))
    if (kept) continue
    drop.run(e.id)
    removed.push({
      kind,
      term: anchor.term,
      pos: anchor.pos,
      ...(kind === 'delete' ? {} : { local: editRow(e) }),
      wporg: besideAdd(wporg, anchor),
    })
  }
  return removed
}

/** How many local edits a locale has, which a sync reports as kept. */
export function countGlossaryEdits(db: Database.Database, locale: Locale): number {
  if (!hasEditsTable(db)) return 0
  return db.prepare<[string], { n: number }>('SELECT count(*) AS n FROM glossary_edits WHERE locale = ?').get(locale)?.n ?? 0
}
