import { GLOSSARY_POS, normaliseGlossaryRow, normaliseGlossaryValue } from '../csv.js'
import { importDiff } from '../import.js'
import type { EffectiveRow, GlossaryDiff, GlossaryRow, RowOrigin } from '../types.js'
import { sidecarKey, type SidecarRecord } from './sidecar.js'

/**
 * The editor's table as plain data, with no DOM and no storage, so the page,
 * the tests and the save path share one definition of "what changed". Browser
 * safe: nothing here may import node:* or the storage layer.
 */

export type Field = 'term' | 'pos' | 'translation' | 'notes'
// In column order: the page draws its cells from this list.
export const FIELDS: Field[] = ['term', 'pos', 'translation', 'notes']

export interface EditorRow extends GlossaryRow {
  id: number
  origin: RowOrigin | 'new'
  base?: GlossaryRow
  deleted: boolean
  /**
   * The row exactly as the page loaded it, origin and base included. A save
   * must send this, not the edited values: the store finds the existing local
   * edit by the loaded row's content. Absent on rows made in this session.
   */
  loaded?: EffectiveRow
}

export interface EditorModel {
  mode: 'db' | 'csv'
  rows: EditorRow[]
}

export type Problem = 'empty-term' | 'empty-translation' | 'bad-pos' | 'duplicate'

export interface Filter {
  query: string
  pos?: string
  problems?: boolean
  local?: boolean
  contested?: boolean
  /** Which fields the query is looked for in; all of them unless the settings say the term alone. */
  searchIn?: 'all' | 'term'
  wholeWord?: boolean
}

const plain = (r: GlossaryRow): GlossaryRow => ({ term: r.term, pos: r.pos, translation: r.translation, notes: r.notes })
const sameValues = (a: GlossaryRow, b: GlossaryRow): boolean => FIELDS.every((f) => a[f] === b[f])

// Ids are never reused within a model: the next one is above every id present,
// so a removed row's id cannot come back and point a stale handle at a new row.
const nextId = (m: EditorModel): number => m.rows.reduce((max, r) => Math.max(max, r.id), 0) + 1

function find(m: EditorModel, id: number): EditorRow {
  const row = m.rows.find((r) => r.id === id)
  if (!row) throw new Error(`No editor row ${id}`)
  return row
}

export function createModel(rows: Array<EffectiveRow | GlossaryRow>, mode: 'db' | 'csv'): EditorModel {
  const m: EditorModel = { mode, rows: [] }
  rows.forEach((r, i) => {
    // A CSV row has no origin; "as loaded" is what wporg means to the diff.
    const origin: RowOrigin = 'origin' in r ? r.origin : 'wporg'
    const loaded: EffectiveRow = {
      ...plain(r),
      origin,
      ...('base' in r && r.base ? { base: plain(r.base) } : {}),
    }
    m.rows.push({ ...plain(r), id: i + 1, origin, ...(loaded.base ? { base: loaded.base } : {}), deleted: false, loaded })
  })
  return m
}

export function setCell(m: EditorModel, id: number, field: Field, value: string): void {
  find(m, id)[field] = normaliseGlossaryValue(value)
}

function insert(m: EditorModel, row: Omit<EditorRow, 'id'>, afterId?: number): number {
  const id = nextId(m)
  // An unknown afterId appends, the same as none.
  const idx = afterId === undefined ? -1 : m.rows.findIndex((r) => r.id === afterId)
  m.rows.splice(idx === -1 ? m.rows.length : idx + 1, 0, { ...row, id })
  return id
}

export function addRow(m: EditorModel, afterId?: number): number {
  return insert(m, { term: '', pos: '', translation: '', notes: '', origin: 'new', deleted: false }, afterId)
}

export function duplicateRow(m: EditorModel, id: number): number {
  const src = find(m, id)
  return insert(m, { ...plain(src), origin: 'new', deleted: false }, id)
}

export function toggleDelete(m: EditorModel, id: number): void {
  const row = find(m, id)
  row.deleted = !row.deleted
}

/**
 * Undo this row's unsaved state. A local change goes back to the wp.org row it
 * replaced, which is what a person pressing revert on a changed row means; the
 * row then differs from what was loaded, so a save still drops the local edit.
 * Any other loaded row goes back to its loaded values. A new row has nothing
 * to go back to and is removed.
 */
export function revertRow(m: EditorModel, id: number): void {
  const row = find(m, id)
  if (!row.loaded) {
    m.rows.splice(m.rows.indexOf(row), 1)
    return
  }
  const target = row.loaded.origin === 'changed' && row.loaded.base ? row.loaded.base : row.loaded
  for (const f of FIELDS) row[f] = target[f]
  row.deleted = false
}

/**
 * Whether a row differs from what the page loaded: made in this session,
 * deleted, or edited. Read from the row alone, since the page asks it of
 * every row on every redraw, and looking each one up by id made a redraw of a
 * few thousand rows quadratic.
 */
export function rowChanged(row: EditorRow): boolean {
  if (!row.loaded) return true
  return row.deleted || !sameValues(row, row.loaded)
}

export function isChanged(m: EditorModel, id: number): boolean {
  return rowChanged(find(m, id))
}

export function diffOf(m: EditorModel): GlossaryDiff {
  const diff: GlossaryDiff = { added: [], changed: [], deleted: [] }
  for (const row of m.rows) {
    if (!row.loaded) {
      if (!row.deleted) diff.added.push(plain(row))
    } else if (row.deleted) {
      diff.deleted.push(row.loaded)
    } else if (!sameValues(row, row.loaded)) {
      diff.changed.push({ from: row.loaded, to: plain(row) })
    }
  }
  return diff
}

export function currentRows(m: EditorModel): GlossaryRow[] {
  return m.rows.filter((r) => !r.deleted).map(plain)
}

export function problemsOf(m: EditorModel): Map<number, Problem[]> {
  return checkProblems(m).shown
}

/**
 * The problems that hold back a save, a subset of problemsOf. In polyglots
 * mode a duplicate counts only when one of its rows is the person's: a local
 * edit, or a row changed or made in this session. wp.org's glossary carries
 * case-only twins of its own ("Post" and "post", one translation), and
 * refusing every save until someone deletes rows the locale team owns would
 * make the editor unusable for a locale that has them. They are still shown.
 * A CSV is the person's whole file, so there every duplicate blocks, and so
 * does every other problem in both modes: those are rarely wp.org's, and a
 * row with no translation would reach the prompt as an empty answer.
 */
export function blockingProblems(m: EditorModel): Map<number, Problem[]> {
  return checkProblems(m).blocking
}

/** Both at once, for the page, which redraws from both after every change. */
export function checkProblems(m: EditorModel): { shown: Map<number, Problem[]>; blocking: Map<number, Problem[]> } {
  const shown = new Map<number, Problem[]>()
  const blocking = new Map<number, Problem[]>()
  const into = (out: Map<number, Problem[]>, id: number, p: Problem): void => {
    const list = out.get(id)
    if (list) list.push(p)
    else out.set(id, [p])
  }
  const add = (id: number, p: Problem, blocks = true): void => {
    into(shown, id, p)
    if (blocks) into(blocking, id, p)
  }
  const touched = (r: EditorRow): boolean => r.origin !== 'wporg' || rowChanged(r)
  const live = m.rows.filter((r) => !r.deleted)
  const seen = new Map<string, EditorRow[]>()
  for (const r of live) {
    if (r.term === '') add(r.id, 'empty-term')
    if (r.translation === '') add(r.id, 'empty-translation')
    // An empty part of speech is allowed: GlotPress exports plenty of them.
    if (r.pos !== '' && !(GLOSSARY_POS as readonly string[]).includes(r.pos)) add(r.id, 'bad-pos')
    const key = `${r.term.toLowerCase()}\u0000${r.pos}\u0000${r.translation}`
    const group = seen.get(key)
    if (group) group.push(r)
    else seen.set(key, [r])
  }
  for (const group of seen.values()) {
    if (group.length < 2) continue
    const blocks = m.mode === 'csv' || group.some(touched)
    for (const r of group) add(r.id, 'duplicate', blocks)
  }
  return { shown, blocking }
}

const WORD = /[\p{L}\p{N}\p{M}]/u

/**
 * Whether the search text is in a value, ignoring case. A whole-word match
 * needs no letter, digit or combining mark on either side, so Turkish ç or ş
 * counts as part of a word the way a and z do, which \b would not.
 */
export function textMatches(value: string, query: string, wholeWord: boolean): boolean {
  const v = value.toLowerCase()
  const q = query.toLowerCase()
  if (!wholeWord) return v.includes(q)
  for (let at = v.indexOf(q); at !== -1; at = v.indexOf(q, at + 1)) {
    const before = at > 0 ? v[at - 1]! : ''
    const after = v[at + q.length] ?? ''
    if (!WORD.test(before) && !WORD.test(after)) return true
  }
  return false
}

export function visibleRows(m: EditorModel, f: Filter, sidecar?: Map<string, SidecarRecord>): EditorRow[] {
  const q = f.query.trim()
  const whole = f.wholeWord ?? false
  const problems = f.problems ? problemsOf(m) : undefined
  return m.rows.filter((r) => {
    const fields = f.searchIn === 'term' ? [r.term] : [r.term, r.translation, r.notes]
    if (q && !fields.some((v) => textMatches(v, q, whole))) return false
    if (f.pos !== undefined && f.pos !== '' && r.pos !== f.pos) return false
    if (problems && !problems.has(r.id)) return false
    if (f.local && !(r.origin !== 'wporg' || rowChanged(r))) return false
    if (f.contested && sidecar?.get(sidecarKey(r.term, r.pos))?.confidence !== 'contested') return false
    return true
  })
}

/**
 * Show an imported CSV as unsaved edits. The rule for which rows go and which
 * come is importDiff's, shared with the store's own import so the page's
 * preview and the saved result cannot disagree. Rows that are only new here
 * are marked deleted too: diffOf skips a deleted new row, so nothing is sent.
 */
export function applyImport(m: EditorModel, rows: GlossaryRow[]): void {
  const live = m.rows.filter((r) => !r.deleted)
  const asEffective = new Map<EffectiveRow, EditorRow>()
  for (const r of live) {
    asEffective.set(
      { ...plain(r), origin: r.origin === 'new' ? 'added' : r.origin, ...(r.base ? { base: r.base } : {}) },
      r,
    )
  }
  // Normalised as setCell normalises a typed cell, so an imported row is held
  // to the same rules as one typed in, and a padded term finds its rows.
  const diff = importDiff([...asEffective.keys()], rows.map(normaliseGlossaryRow))
  for (const gone of diff.deleted) asEffective.get(gone)!.deleted = true
  for (const r of diff.added) insert(m, { ...plain(r), origin: 'new', deleted: false })
}
