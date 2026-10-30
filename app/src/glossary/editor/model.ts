import { GLOSSARY_POS, normaliseGlossaryValue } from '../csv.js'
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

export function isChanged(m: EditorModel, id: number): boolean {
  const row = find(m, id)
  if (!row.loaded) return true
  return row.deleted || !sameValues(row, row.loaded)
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
  const out = new Map<number, Problem[]>()
  const add = (id: number, p: Problem): void => {
    const list = out.get(id)
    if (list) list.push(p)
    else out.set(id, [p])
  }
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
  for (const group of seen.values()) if (group.length > 1) for (const r of group) add(r.id, 'duplicate')
  return out
}

export function visibleRows(m: EditorModel, f: Filter, sidecar?: Map<string, SidecarRecord>): EditorRow[] {
  const q = f.query.trim().toLowerCase()
  const problems = f.problems ? problemsOf(m) : undefined
  return m.rows.filter((r) => {
    if (q && ![r.term, r.translation, r.notes].some((v) => v.toLowerCase().includes(q))) return false
    if (f.pos !== undefined && f.pos !== '' && r.pos !== f.pos) return false
    if (problems && !problems.has(r.id)) return false
    if (f.local && !(r.origin !== 'wporg' || isChanged(m, r.id))) return false
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
  const diff = importDiff([...asEffective.keys()], rows)
  for (const gone of diff.deleted) asEffective.get(gone)!.deleted = true
  for (const r of diff.added) insert(m, { ...plain(r), origin: 'new', deleted: false })
}
