import { rowChanged, type EditorRow } from './model.js'

/**
 * The editor's own preferences: how the table is shown and how the keys
 * behave, never what is saved. Sort is display only, on purpose: a CSV
 * exported in sorted order would come back to GlotPress as a diff of every
 * row for an edit of one, and a reviewer reading that import could not find
 * the change. Browser safe, like model.ts, since the page bundles it.
 */

export type SortKey = 'file' | 'term-asc' | 'term-desc' | 'translation-asc' | 'translation-desc' | 'pos' | 'changed'
export const SORT_KEYS: readonly SortKey[] = ['file', 'term-asc', 'term-desc', 'translation-asc', 'translation-desc', 'pos', 'changed']

/** The filter a page opens with. `edits` is every row not as wp.org has it: local edits, and changes not saved yet. */
export type StartFilter = 'none' | 'problems' | 'edits'

export interface EditorSettings {
  sort: SortKey
  startFilter: StartFilter
  /** Long text wraps onto more lines; false cuts it at the cell's edge. */
  wrap: boolean
  density: 'comfortable' | 'compact'
  /** The columns that can be hidden. Term and translation are the row, so they always show. */
  columns: { pos: boolean; notes: boolean }
  searchIn: 'all' | 'term'
  wholeWord: boolean
  /** Where Enter goes after it commits an edit. */
  enterMoves: 'down' | 'stay'
  /** Tab out of the last cell of the table adds a row and opens it. */
  tabAddsRow: boolean
  /** Tint each cell whose value differs from what was opened, not only the row's edge. */
  markCells: boolean
}

export const DEFAULT_SETTINGS: EditorSettings = {
  sort: 'file',
  startFilter: 'none',
  wrap: true,
  density: 'comfortable',
  columns: { pos: true, notes: true },
  searchIn: 'all',
  wholeWord: false,
  enterMoves: 'down',
  tabAddsRow: false,
  markCells: true,
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

/**
 * Whatever storage held, as settings. Unlike the kept work, which is dropped
 * whole when one row is odd, settings are repaired key by key: a bad value
 * costs one preference, and a newer page's keys read by an older one fall back
 * to what that page knows. Only the known keys come back, so a save writes no
 * junk forward.
 */
export function readSettings(raw: unknown): EditorSettings {
  const v = isObject(raw) ? raw : {}
  const d = DEFAULT_SETTINGS
  const cols = isObject(v.columns) ? v.columns : {}
  return {
    sort: oneOf(v.sort, SORT_KEYS, d.sort),
    startFilter: oneOf(v.startFilter, ['none', 'problems', 'edits'], d.startFilter),
    wrap: bool(v.wrap, d.wrap),
    density: oneOf(v.density, ['comfortable', 'compact'], d.density),
    columns: { pos: bool(cols.pos, d.columns.pos), notes: bool(cols.notes, d.columns.notes) },
    searchIn: oneOf(v.searchIn, ['all', 'term'], d.searchIn),
    wholeWord: bool(v.wholeWord, d.wholeWord),
    enterMoves: oneOf(v.enterMoves, ['down', 'stay'], d.enterMoves),
    tabAddsRow: bool(v.tabAddsRow, d.tabAddsRow),
    markCells: bool(v.markCells, d.markCells),
  }
}

/**
 * A collator for the glossary's locale. A plain sort puts ç after z and every
 * capital before every lower-case letter; Turkish also orders ı before i, which
 * no locale-blind compare gets right. Numeric, so "item 9" comes before
 * "item 10". The locale arrives as a GlotPress slug (tr, pt-br, pt/ao90), which
 * is close enough to a BCP 47 tag once the variant is cut; one Intl does not
 * know gets the default collation rather than a throw.
 */
export function collatorFor(locale: string): Intl.Collator {
  const tag = locale.split('/')[0]!.replace(/_/g, '-')
  const opts: Intl.CollatorOptions = { sensitivity: 'base', numeric: true }
  try {
    if (Intl.Collator.supportedLocalesOf(tag).length > 0) return new Intl.Collator(tag, opts)
  } catch {
    // An invalid tag throws a RangeError; the default collation below serves.
  }
  return new Intl.Collator(undefined, opts)
}

// Every row not as wp.org has it: what the "changed first" sort lifts.
const isEdit = (r: EditorRow): boolean => r.origin !== 'wporg' || rowChanged(r)

/**
 * The rows in display order, as a new array. Ties keep the file order, since
 * Array.prototype.sort is stable, so a sort by part of speech still reads as
 * the file within each group. An empty value goes last whichever way the
 * column runs: a row with no translation yet is one to find at the end, not
 * a block of blanks at the top of a descending sort.
 */
export function sortRows(rows: readonly EditorRow[], key: SortKey, collator: Intl.Collator): EditorRow[] {
  const out = [...rows]
  if (key === 'file') return out
  if (key === 'changed') return out.sort((a, b) => Number(isEdit(b)) - Number(isEdit(a)))
  if (key === 'pos') return out.sort((a, b) => collator.compare(a.pos, b.pos) || collator.compare(a.term, b.term))
  const field = key.startsWith('term') ? 'term' : 'translation'
  const dir = key.endsWith('desc') ? -1 : 1
  return out.sort((a, b) => {
    const x = a[field]
    const y = b[field]
    if (x === '' || y === '') return Number(x === '') - Number(y === '')
    return dir * collator.compare(x, y)
  })
}

/** What a click on a column's header sorts by next: ascending, descending, then the file order again. */
export function nextHeaderSort(current: SortKey, column: 'term' | 'translation'): SortKey {
  if (current === `${column}-asc`) return `${column}-desc`
  if (current === `${column}-desc`) return 'file'
  return `${column}-asc`
}

// Lives beside visibleRows, which uses it; exported here with the other search settings.
export { textMatches } from './model.js'
