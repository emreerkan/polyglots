import type { GlossaryDiff, GlossaryRow } from '../../types.js'
import { FIELDS, type EditorModel, type EditorRow, type Field, type Problem } from '../model.js'
import type { EditorSettings, SortKey } from '../settings.js'
import type { SidecarRecord } from '../sidecar.js'

/**
 * The editor's markup as strings, with no state and no listeners: editor.ts
 * owns both and decides when each piece is redrawn. Strings rather than
 * createElement because a few thousand rows drawn through innerHTML is one
 * parse, where the same rows built node by node is the slow path.
 */

export const FIELD_LABEL: Record<Field, string> = {
  term: 'Term',
  pos: 'Part of speech',
  translation: 'Translation',
  notes: 'Comment',
}

const PROBLEM_LABEL: Record<Problem, string> = {
  'empty-term': 'empty term',
  'empty-translation': 'empty translation',
  'bad-pos': 'not a GlotPress part of speech',
  duplicate: 'duplicate row',
}

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** How a row stands against what was loaded: drives its marks and its row action. */
export interface RowState {
  changed: boolean
  added: boolean
  /** A local edit already saved in polyglots.db (db mode only). */
  local: boolean
  canRevert: boolean
  /** The cells to tint as changed; empty unless the settings ask for it. */
  changedFields: Field[]
}

export function rowHtml(row: EditorRow, state: RowState, problems: Problem[] | undefined, cursor: Field | undefined): string {
  const has = (p: Problem): boolean => problems?.includes(p) ?? false
  const termMark = state.added ? ' ge-added' : state.changed ? ' ge-changed' : state.local ? ' ge-local' : ''
  const td = (field: Field, cls: string, inner: string, title = ''): string =>
    `<td data-field="${field}" tabindex="${cursor === field ? 0 : -1}" class="ge-cell ge-${field}${cls}${state.changedFields.includes(field) ? ' ge-cell-changed' : ''}"` +
    `${title ? ` title="${esc(title)}"` : ''}>${inner}</td>`
  const warn = (text: string): string => `<span class="ge-warn">${text}</span>`

  const term = (row.term ? esc(row.term) : has('empty-term') ? warn('empty term') : '') +
    (has('duplicate') ? ' <span class="ge-tag">duplicate</span>' : '')
  const pos = has('bad-pos') ? warn(esc(row.pos)) : esc(row.pos)
  const translation = row.translation ? esc(row.translation) : has('empty-translation') ? warn('empty translation') : ''

  // The row's own undo, beside it: a struck-through row is restored where it
  // is, which is why a delete stays visible until the save.
  const action = row.deleted
    ? '<button type="button" tabindex="-1" class="ge-link" data-action="row-restore">Restore</button>'
    : state.canRevert
      ? '<button type="button" tabindex="-1" class="ge-link" data-action="row-revert">Revert</button>'
      : ''

  return (
    `<tr data-id="${row.id}"${row.deleted ? ' class="ge-deleted"' : ''}>` +
    td('term', termMark, term, problems ? problems.map((p) => PROBLEM_LABEL[p]).join(', ') : '') +
    td('pos', '', pos, has('bad-pos') ? PROBLEM_LABEL['bad-pos'] : '') +
    td('translation', '', translation) +
    td('notes', '', esc(row.notes)) +
    `<td class="ge-acts">${action}</td></tr>`
  )
}

export function countText(diff: GlossaryDiff): string {
  const parts = [`${diff.changed.length} changed`, `${diff.added.length} added`]
  if (diff.deleted.length > 0) parts.push(`${diff.deleted.length} deleted`)
  return parts.join(' · ')
}

export interface ChipState {
  pos: string[]
  activePos: string | undefined
  problems: number
  problemsOn: boolean
  local: boolean | undefined
  /** What the local filter's chip says: local edits in polyglots mode, changed for a CSV. */
  localLabel: string
  contested: number | undefined
  contestedOn: boolean
}

export function chipsHtml(c: ChipState): string {
  const chip = (id: string, label: string, on: boolean): string =>
    `<button type="button" class="ge-chip${on ? ' on' : ''}" aria-pressed="${on}" data-action="chip" data-chip="${esc(id)}">${esc(label)}</button>`
  const none = c.activePos === undefined && !c.problemsOn && !c.local && !c.contestedOn
  const out = [chip('all', 'all', none)]
  for (const p of c.pos) out.push(chip(`pos:${p}`, p, c.activePos === p))
  // The problems chip stays while it is on, so filtering down to the last
  // problem and fixing it does not take away the control that undoes the filter.
  if (c.problems > 0 || c.problemsOn) out.push(chip('problems', `problems ${c.problems}`, c.problemsOn))
  if (c.local !== undefined) out.push(chip('local', c.localLabel, c.local))
  if (c.contested !== undefined) out.push(chip('contested', `contested ${c.contested}`, c.contestedOn))
  return out.join('')
}

/** Why Save or Export is refused, naming the rows, the way the spec asks. */
export function reasonHtml(m: EditorModel, problems: Map<number, Problem[]>): string {
  if (problems.size === 0) return ''
  const named = [...problems].slice(0, 3).map(([id, ps]) => {
    const row = m.rows.find((r) => r.id === id)
    const name = row?.term ? `“${esc(row.term)}”` : `row ${m.rows.findIndex((r) => r.id === id) + 1}`
    return `${name} (${ps.map((p) => PROBLEM_LABEL[p]).join(', ')})`
  })
  const more = problems.size > 3 ? `, and ${problems.size - 3} more` : ''
  return `<button type="button" class="ge-link ge-warn" data-action="show-problems">Fix ${plural(problems.size, 'row')} first</button>: ${named.join(', ')}${more}`
}

const shown = (v: string): string => (v === '' ? '<span class="ge-muted">(empty)</span>' : esc(v))
const rowLine = (r: GlossaryRow): string =>
  `<b>${shown(r.term)}</b>${r.pos ? ` · ${esc(r.pos)}` : ''}: ${shown(r.translation)}${r.notes ? ` <span class="ge-muted">— ${esc(r.notes)}</span>` : ''}`

export function changesHtml(diff: GlossaryDiff): string {
  const section = (title: string, items: string[]): string =>
    items.length === 0 ? '' : `<section><h3>${title} (${items.length})</h3><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul></section>`
  const changed = diff.changed.map(({ from, to }) => {
    const fields = FIELDS.filter((f) => from[f] !== to[f])
      .map((f) => `<li>${FIELD_LABEL[f]}: ${shown(from[f])} → ${shown(to[f])}</li>`)
      .join('')
    return `<b>${esc(from.term)}</b>${from.pos ? ` · ${esc(from.pos)}` : ''}<ul class="ge-fields">${fields}</ul>`
  })
  const body =
    section('Added', diff.added.map(rowLine)) + section('Changed', changed) + section('Deleted', diff.deleted.map(rowLine))
  return (
    `<div class="ge-dialog" role="dialog" aria-modal="true" aria-labelledby="ge-changes-title" tabindex="-1">` +
    `<h2 id="ge-changes-title">Changes</h2>${body || '<p class="ge-muted">No changes.</p>'}` +
    `<div class="ge-dialog-actions"><button type="button" class="ge-btn" data-action="close-dialog">Close</button></div></div>`
  )
}

export function confirmHtml(title: string, text: string, yes: string, yesAction: string): string {
  return (
    `<div class="ge-dialog ge-small" role="alertdialog" aria-modal="true" aria-labelledby="ge-confirm-title" aria-describedby="ge-confirm-text" tabindex="-1">` +
    `<h2 id="ge-confirm-title">${esc(title)}</h2><p id="ge-confirm-text">${esc(text)}</p>` +
    `<div class="ge-dialog-actions"><button type="button" class="ge-btn ge-ghost" data-action="close-dialog">Keep editing</button>` +
    `<button type="button" class="ge-btn ge-danger" data-action="${yesAction}">${esc(yes)}</button></div></div>`
  )
}

/**
 * The evidence for the focused row: where it came from in polyglots mode, its
 * problems, and the analysis sidecar's record when one is loaded. Read-only.
 */
export function panelHtml(
  row: EditorRow | undefined,
  mode: 'db' | 'csv',
  state: RowState | undefined,
  problems: Problem[] | undefined,
  record: SidecarRecord | undefined,
  hasSidecar: boolean,
): string {
  if (!row) return '<p class="ge-muted">No row in focus.</p>'
  const out: string[] = []
  const tag = record?.confidence === 'contested' ? ' <span class="ge-tag">contested</span>' : ''
  out.push(`<h4>${shown(row.term)}${row.pos ? ` · ${esc(row.pos)}` : ''}${tag}</h4>`)
  if (mode === 'db') out.push(`<p>${originText(row, state)}</p>`)
  else if (row.origin === 'new') out.push('<p>New on this page, not saved yet.</p>')
  if (problems) out.push(`<p class="ge-warn">${problems.map((p) => PROBLEM_LABEL[p]).join(', ')}</p>`)

  if (record) {
    const list = (title: string, items: string[]): void => {
      if (items.length > 0) out.push(`<h4>${title}</h4><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`)
    }
    if (record.proposed) out.push(`<h4>Proposed</h4><p>${esc(record.proposed)}</p>`)
    const files = Object.entries(record.occurrences)
    const total = files.reduce((n, [, c]) => n + c, 0)
    if (files.length > 0) {
      out.push(`<h4>Occurrences</h4><p>${plural(total, 'time')}</p>`)
      list('By file', files.map(([f, c]) => `${esc(f)}: ${c}`))
    }
    list('Now in the approved strings', record.currentRenderings.map((r) => `${esc(r.text)} ×${r.count}`))
    list('Glossary', record.glossary.map((g) => `${esc(g.tr)}${g.pos ? ` (${esc(g.pos)})` : ''}${g.description ? ` — ${esc(g.description)}` : ''}`))
    list('Other plugins', record.otherPlugins.map((p) => `${esc(p.project)}: ${esc(p.tr)}`))
    list('Translation memory', record.tm.map((t) => `${esc(t.en)} → ${esc(t.tr)}`))
    list('Examples', record.examples.map(esc))
    if (record.reason) out.push(`<h4>Reason</h4><p>${esc(record.reason)}</p>`)
  } else if (hasSidecar) {
    out.push('<p class="ge-muted">No analysis for this row.</p>')
  }
  return out.join('')
}

function originText(row: EditorRow, state: RowState | undefined): string {
  const unsaved = state?.changed && !row.deleted ? ' Changed on this page, not saved yet.' : ''
  if (row.origin === 'new') return 'New on this page, not saved yet.'
  if (row.deleted) return 'Deleted on this page; saving removes it.'
  if (row.origin === 'added') return `A local addition, not in the wp.org glossary.${unsaved}`
  if (row.origin === 'changed') {
    const base = row.loaded?.base
    const was = base ? ` The wp.org row: ${shown(base.translation)}${base.pos ? ` (${esc(base.pos)})` : ''}.` : ''
    return `A local edit of a wp.org row.${was}${unsaved}`
  }
  return `A wp.org row.${unsaved}`
}

/**
 * The header cells. Term and Translation sort on a click, through a button so
 * the keyboard reaches it; aria-sort says which way the table runs, and is
 * absent in the file order, which is no sort at all.
 */
export function headHtml(sort: SortKey): string {
  const cells = FIELDS.map((f) => {
    if (f !== 'term' && f !== 'translation') return `<th scope="col" class="ge-${f}">${FIELD_LABEL[f]}</th>`
    const dir = sort === `${f}-asc` ? 'ascending' : sort === `${f}-desc` ? 'descending' : undefined
    return (
      `<th scope="col" class="ge-${f}"${dir ? ` aria-sort="${dir}"` : ''}>` +
      `<button type="button" class="ge-sort" data-action="sort" data-column="${f}" title="Sort by ${FIELD_LABEL[f].toLowerCase()}">${FIELD_LABEL[f]}</button></th>`
    )
  })
  return `<tr>${cells.join('')}<th class="ge-acts"><span class="ge-sr">Row actions</span></th></tr>`
}

const SORT_LABEL: Record<SortKey, string> = {
  file: 'File order',
  'term-asc': 'Term, A to Z',
  'term-desc': 'Term, Z to A',
  'translation-asc': 'Translation, A to Z',
  'translation-desc': 'Translation, Z to A',
  pos: 'Part of speech',
  changed: 'Changed rows first',
}

/**
 * The settings dialog. Every control carries data-setting with the key it
 * sets (a dot for a nested one), and a change applies at once: there is no
 * Apply, so what the person sees is what is kept. A div, not a form, so Enter
 * in a field cannot submit and reload the page under unsaved work.
 */
export function settingsHtml(s: EditorSettings, mode: 'db' | 'csv', saveLabel: 'Save' | 'Export'): string {
  const select = (key: string, label: string, value: string, options: Array<[string, string]>): string =>
    `<label class="ge-field"><span>${label}</span><select data-setting="${key}">` +
    options.map(([v, l]) => `<option value="${v}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('') +
    '</select></label>'
  const check = (key: string, label: string, on: boolean): string =>
    `<label class="ge-check"><input type="checkbox" data-setting="${key}"${on ? ' checked' : ''}> ${label}</label>`
  const group = (legend: string, body: string): string => `<fieldset><legend>${legend}</legend>${body}</fieldset>`
  return (
    `<div class="ge-dialog ge-small ge-settings" role="dialog" aria-modal="true" aria-labelledby="ge-settings-title" tabindex="-1">` +
    `<h2 id="ge-settings-title">Settings</h2>` +
    group(
      'Rows',
      select('sort', 'Sort', s.sort, Object.entries(SORT_LABEL) as Array<[string, string]>) +
        select('startFilter', 'Show when opened', s.startFilter, [
          ['none', 'All rows'],
          ['problems', 'Rows with problems'],
          ['edits', mode === 'db' ? 'Local edits and changes' : 'Changed rows'],
        ]),
    ) +
    group(
      'Display',
      check('wrap', 'Wrap long text', s.wrap) +
        select('density', 'Row height', s.density, [['comfortable', 'Comfortable'], ['compact', 'Compact']]) +
        check('columns.pos', `Show ${FIELD_LABEL.pos}`, s.columns.pos) +
        check('columns.notes', `Show ${FIELD_LABEL.notes}`, s.columns.notes) +
        check('markCells', 'Tint each changed cell', s.markCells),
    ) +
    group(
      'Search',
      select('searchIn', 'Search in', s.searchIn, [['all', 'Term, translation and comment'], ['term', 'Term only']]) +
        check('wholeWord', 'Whole words only', s.wholeWord),
    ) +
    group(
      'Keys',
      select('enterMoves', 'After Enter saves a cell', s.enterMoves, [['down', 'Move down'], ['stay', 'Stay on the cell']]) +
        check('tabAddsRow', 'Tab on the last cell adds a row', s.tabAddsRow),
    ) +
    `<p class="ge-muted">Sorting changes only what you see. ${saveLabel} keeps the glossary's own order.</p>` +
    `<div class="ge-dialog-actions"><button type="button" class="ge-btn" data-action="close-dialog">Done</button></div></div>`
  )
}
