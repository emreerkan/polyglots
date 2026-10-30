import { GLOSSARY_POS, normaliseGlossaryValue } from '../../csv.js'
import type { GlossaryRow } from '../../types.js'
import {
  FIELDS, addRow, applyImport, createModel, currentRows, diffOf, duplicateRow, isChanged, problemsOf, revertRow,
  setCell, toggleDelete, visibleRows, type EditorModel, type EditorRow, type Field, type Filter, type Problem,
} from '../model.js'
import { readSidecar, sidecarKey, type SidecarRecord } from '../sidecar.js'
import type { EditorHost, LoadedGlossary } from './host.js'
import {
  FIELD_LABEL, changesHtml, chipsHtml, confirmHtml, countText, esc, panelHtml, reasonHtml, rowHtml, type RowState,
} from './render.js'

/**
 * The glossary editor: a spreadsheet with no edit state per row. Every cell
 * can be edited at any time and one Save (or Export) sends all of it, which is
 * what the GlotPress page this replaces does not do.
 *
 * The page owns the model and redraws from it, but never redraws the cell
 * being typed in: an edit is an input placed in the cell, and the model hears
 * of it only on commit. Everything else is drawn as strings and wired through
 * delegated listeners on the root, so a redraw of a few thousand rows attaches
 * nothing and leaks nothing.
 */
export async function mountEditor(root: HTMLElement, host: EditorHost): Promise<{ model(): EditorModel }> {
  const doc = root.ownerDocument
  const win = doc.defaultView
  root.innerHTML = '<div class="ge"><p class="ge-loading">Loading the glossary…</p></div>'

  let data: LoadedGlossary
  try {
    data = await host.load()
  } catch (e) {
    root.innerHTML = `<div class="ge"><p class="ge-status ge-error" role="alert">${esc(message(e))}</p></div>`
    throw e
  }

  let m = createModel([], 'csv')
  let stamp: string | undefined
  let sidecar: Map<string, SidecarRecord> | undefined
  let notice = ''
  let filter: Filter = { query: '' }
  // Ids in display order. Recomputed when the filter changes, not on every
  // edit: a row that stops matching the search while it is being fixed stays
  // put instead of vanishing under the person's cursor.
  let visible: number[] = []
  let cursor: { id: number; field: Field } | undefined
  let editing: { id: number; field: Field; control: HTMLInputElement | HTMLSelectElement } | undefined
  let problems = new Map<number, Problem[]>()
  let busy = false
  let closed = false
  let dialogReturn: HTMLElement | undefined

  root.innerHTML = `<div class="ge">
  <header class="ge-head"><h1 class="ge-title"></h1><span class="ge-file"></span></header>
  <div class="ge-bar">
    <input type="search" class="ge-search" placeholder="Search term, translation or comment" aria-label="Search term, translation or comment">
    <div class="ge-chips" role="group" aria-label="Filter rows"></div>
    <span class="ge-count" aria-live="polite"></span>
    <span class="ge-group">
      <button type="button" class="ge-btn ge-ghost" data-action="add" title="Add a row below the focused one (Ctrl+Enter)">Add row</button>
      <button type="button" class="ge-btn ge-ghost" data-action="duplicate" title="Duplicate the focused row (Ctrl+D)">Duplicate</button>
      <button type="button" class="ge-btn ge-ghost" data-action="delete" title="Delete or restore the focused row (Ctrl+Backspace)">Delete row</button>
    </span>
    <span class="ge-group ge-files"></span>
    <button type="button" class="ge-btn ge-ghost" data-action="changes">Changes</button>
    <button type="button" class="ge-btn ge-primary" data-action="save">${esc(host.saveLabel)}</button>
    ${host.close ? '<button type="button" class="ge-btn ge-ghost" data-action="close">Close</button>' : ''}
  </div>
  <p class="ge-reason"></p>
  <p class="ge-notice" hidden></p>
  <div class="ge-status" role="status"></div>
  <div class="ge-body">
    <div class="ge-scroll">
      <table class="ge-grid" role="grid" aria-label="Glossary">
        <thead><tr>${FIELDS.map((f) => `<th scope="col" class="ge-${f}">${FIELD_LABEL[f]}</th>`).join('')}<th class="ge-acts"><span class="ge-sr">Row actions</span></th></tr></thead>
        <tbody></tbody>
      </table>
      <p class="ge-empty" hidden>No rows match.</p>
    </div>
    <aside class="ge-panel" aria-label="Evidence for the focused row"></aside>
  </div>
  <p class="ge-legend">Left edge of the term: <span class="ge-key ge-key-changed"></span>changed <span class="ge-key ge-key-added"></span>added <span class="ge-key-local"><span class="ge-key"></span>saved local edit</span>. Struck through: deleted when saved.</p>
  <div class="ge-layer" hidden></div>
</div>`

  const $ = <T extends Element>(sel: string): T => root.querySelector<T>(sel)!
  const tbody = $<HTMLTableSectionElement>('tbody')
  const search = $<HTMLInputElement>('.ge-search')
  const layer = $<HTMLDivElement>('.ge-layer')
  const panel = $<HTMLElement>('.ge-panel')

  const row = (id: number): EditorRow | undefined => m.rows.find((r) => r.id === id)
  const tr = (id: number): HTMLTableRowElement | null => tbody.querySelector(`tr[data-id="${id}"]`)
  const cellEl = (id: number, field: Field): HTMLTableCellElement | null =>
    tbody.querySelector(`tr[data-id="${id}"] td[data-field="${field}"]`)
  const unsavedCount = (): number => {
    const d = diffOf(m)
    return d.added.length + d.changed.length + d.deleted.length
  }
  const dirty = (): boolean => unsavedCount() > 0
  // Rows that are already local edits in polyglots.db: what Discard removes.
  const localCount = (): number => m.rows.filter((r) => r.loaded && r.loaded.origin !== 'wporg').length

  function stateOf(r: EditorRow): RowState {
    const changed = isChanged(m, r.id)
    const target = r.loaded?.origin === 'changed' && r.loaded.base ? r.loaded.base : r.loaded
    const canRevert = !target || r.deleted || FIELDS.some((f) => r[f] !== target[f])
    return { changed: changed && r.origin !== 'new', added: r.origin === 'new', local: m.mode === 'db' && r.origin !== 'wporg' && r.origin !== 'new', canRevert }
  }

  function apply(next: LoadedGlossary): void {
    data = next
    m = createModel(next.rows, next.mode)
    stamp = next.stamp
    notice = next.notice ?? ''
    sidecar = undefined
    if (next.sidecar !== undefined) loadSidecar(next.sidecar)
    $<HTMLElement>('.ge-title').textContent =
      next.mode === 'db' ? `${next.locale} glossary, with your local edits` : `${next.locale} glossary`
    $<HTMLElement>('.ge-file').textContent = next.file ?? ''
    $<HTMLElement>('.ge-key-local').hidden = next.mode !== 'db'
    // Ids are per model, so a reload keeps the place by position instead: after
    // a save the person carries on from the row they were on.
    const at = cursor ? visible.indexOf(cursor.id) : 0
    const field = cursor?.field ?? 'term'
    visible = visibleRows(m, filter, sidecar).map((r) => r.id)
    const id = visible[Math.max(0, Math.min(at, visible.length - 1))]
    cursor = id === undefined ? undefined : { id, field }
    drawRows()
  }

  function loadSidecar(json: unknown): void {
    const read = readSidecar(json)
    if ('error' in read) {
      sidecar = undefined
      notice = [notice, `The analysis file was not loaded: ${read.error}`].filter(Boolean).join(' ')
    } else {
      sidecar = read.records
    }
  }

  // ---- drawing --------------------------------------------------------------

  function refilter(): void {
    visible = visibleRows(m, filter, sidecar).map((r) => r.id)
    drawRows()
  }

  function drawRows(): void {
    const hadFocus = tbody.contains(doc.activeElement)
    editing = undefined
    problems = problemsOf(m)
    if (!cursor || !visible.includes(cursor.id)) {
      const first = visible[0]
      cursor = first === undefined ? undefined : { id: first, field: cursor?.field ?? 'term' }
    }
    const byId = new Map(m.rows.map((r) => [r.id, r]))
    tbody.innerHTML = visible
      .map((id) => {
        const r = byId.get(id)!
        return rowHtml(r, stateOf(r), problems.get(id), cursor?.id === id ? cursor.field : undefined)
      })
      .join('')
    $<HTMLElement>('.ge-empty').hidden = visible.length > 0
    if (hadFocus && cursor) cellEl(cursor.id, cursor.field)?.focus()
    drawChrome()
  }

  /**
   * Redraw some rows, keeping their elements. The cells are updated in place
   * rather than the row replaced, because an edit ends on a focusout that is
   * often a click on another cell of the same row: a replaced row would leave
   * that click landing on a cell no longer in the document, and focus on the
   * body. Only a cell whose markup changed has its content reparsed.
   */
  function patchRows(ids: Iterable<number>, refocus = true): void {
    const hadFocus = refocus && tbody.contains(doc.activeElement)
    // A <tr> parsed anywhere but inside a tbody is dropped by the HTML parser.
    const holder = doc.createElement('tbody')
    for (const id of ids) {
      const el = tr(id)
      const r = row(id)
      if (!el || !r) continue
      holder.innerHTML = rowHtml(r, stateOf(r), problems.get(id), cursor?.id === id ? cursor.field : undefined)
      const fresh = holder.firstElementChild as HTMLTableRowElement
      el.className = fresh.className
      for (let i = 0; i < fresh.cells.length; i++) {
        const from = fresh.cells[i]!
        const to = el.cells[i]!
        to.className = from.className
        for (const name of ['title', 'tabindex']) {
          const v = from.getAttribute(name)
          if (v === null) to.removeAttribute(name)
          else to.setAttribute(name, v)
        }
        if (to.innerHTML !== from.innerHTML) to.innerHTML = from.innerHTML
      }
    }
    if (hadFocus && cursor) cellEl(cursor.id, cursor.field)?.focus()
  }

  /**
   * After any change to the model: the problems are recomputed over the whole
   * table, because a duplicate is a property of two rows, and every row whose
   * problems moved is redrawn along with the ones that changed.
   */
  function changed(ids: number[], refocus = true): void {
    const before = problems
    problems = problemsOf(m)
    const touched = new Set(ids)
    for (const id of new Set([...before.keys(), ...problems.keys()])) {
      if ((before.get(id) ?? []).join() !== (problems.get(id) ?? []).join()) touched.add(id)
    }
    patchRows(touched, refocus)
    drawChrome()
    host.persist?.(m)
  }

  function drawChrome(): void {
    const diff = diffOf(m)
    $<HTMLElement>('.ge-count').textContent = countText(diff)
    const live = m.rows.filter((r) => !r.deleted)
    $<HTMLElement>('.ge-chips').innerHTML = chipsHtml({
      pos: GLOSSARY_POS.filter((p) => live.some((r) => r.pos === p)),
      activePos: filter.pos,
      problems: problems.size,
      problemsOn: filter.problems ?? false,
      local: m.mode === 'db' ? (filter.local ?? false) : undefined,
      contested: sidecar
        ? live.filter((r) => sidecar!.get(sidecarKey(r.term, r.pos))?.confidence === 'contested').length
        : undefined,
      contestedOn: filter.contested ?? false,
    })

    const files: string[] = []
    if (m.mode === 'db' && host.openFile) files.push('<button type="button" class="ge-btn ge-ghost" data-action="import">Import CSV</button>')
    if (host.openSidecar) files.push('<button type="button" class="ge-btn ge-ghost" data-action="sidecar">Open analysis</button>')
    if (m.mode === 'db' && host.discard && stamp !== undefined && localCount() > 0) {
      files.push('<button type="button" class="ge-btn ge-ghost ge-danger-text" data-action="discard">Discard all local edits</button>')
    }
    $<HTMLElement>('.ge-files').innerHTML = files.join('')

    const save = $<HTMLButtonElement>('[data-action="save"]')
    const reason = $<HTMLElement>('.ge-reason')
    // Save with nothing to save is refused quietly; Export is not, since
    // exporting the file as opened is a reasonable thing to want.
    const nothing = host.saveLabel === 'Save' && diff.added.length + diff.changed.length + diff.deleted.length === 0
    save.disabled = busy || problems.size > 0 || nothing
    save.title = nothing ? 'No changes to save.' : ''
    reason.innerHTML = reasonHtml(m, problems)
    reason.hidden = problems.size === 0

    const n = $<HTMLElement>('.ge-notice')
    n.textContent = notice
    n.hidden = notice === ''

    drawPanel()
  }

  function drawPanel(): void {
    const show = m.mode === 'db' || sidecar !== undefined
    panel.hidden = !show
    $<HTMLElement>('.ge-body').classList.toggle('ge-no-panel', !show)
    if (!show) return
    const r = cursor ? row(cursor.id) : undefined
    panel.innerHTML = panelHtml(
      r,
      m.mode,
      r ? stateOf(r) : undefined,
      r ? problems.get(r.id) : undefined,
      r ? sidecar?.get(sidecarKey(r.term, r.pos)) : undefined,
      sidecar !== undefined,
    )
  }

  function setStatus(text: string, kind: 'info' | 'error' = 'info', extra = ''): void {
    const s = $<HTMLElement>('.ge-status')
    s.className = `ge-status${kind === 'error' ? ' ge-error' : ''}`
    s.innerHTML = text ? `${esc(text)}${extra}` : ''
  }

  // ---- focus and editing ----------------------------------------------------

  function focusCell(id: number, field: Field): void {
    const prev = cursor
    if (prev) cellEl(prev.id, prev.field)?.setAttribute('tabindex', '-1')
    cursor = { id, field }
    const td = cellEl(id, field)
    if (!td) return
    td.setAttribute('tabindex', '0')
    td.focus()
    td.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    if (prev?.id !== id) drawPanel()
  }

  /** The cell a move lands on, or undefined at the edge of the table. */
  function step(dRow: number, dField: number, wrap: boolean): { id: number; field: Field } | undefined {
    if (!cursor) return undefined
    let ri = visible.indexOf(cursor.id)
    let fi = FIELDS.indexOf(cursor.field) + dField
    if (wrap && fi >= FIELDS.length) [ri, fi] = [ri + 1, 0]
    if (wrap && fi < 0) [ri, fi] = [ri - 1, FIELDS.length - 1]
    ri += dRow
    if (ri < 0 || ri >= visible.length || fi < 0 || fi >= FIELDS.length) return undefined
    return { id: visible[ri]!, field: FIELDS[fi]! }
  }

  function startEdit(id: number, field: Field, typed?: string): void {
    const r = row(id)
    const td = cellEl(id, field)
    if (!r || !td || r.deleted) return
    let control: HTMLInputElement | HTMLSelectElement
    if (field === 'pos') {
      const select = doc.createElement('select')
      select.setAttribute('aria-label', FIELD_LABEL.pos)
      // A value outside the list stays selectable, so opening the cell does not
      // silently change it; the problem mark is what asks for a fix.
      const values: string[] = ['', ...GLOSSARY_POS]
      if (!values.includes(r.pos)) values.push(r.pos)
      select.innerHTML = values.map((v) => `<option value="${esc(v)}">${v === '' ? '(none)' : esc(v)}</option>`).join('')
      const match = typed ? values.find((v) => v.startsWith(typed.toLowerCase())) : undefined
      select.value = match ?? r.pos
      control = select
    } else {
      const input = doc.createElement('input')
      input.type = 'text'
      input.setAttribute('aria-label', FIELD_LABEL[field])
      input.value = typed ?? r[field]
      control = input
    }
    td.classList.add('ge-editing')
    td.textContent = ''
    td.append(control)
    editing = { id, field, control }
    control.focus()
    if (control instanceof HTMLInputElement) control.setSelectionRange(control.value.length, control.value.length)
  }

  /**
   * End the edit. Cleared before any DOM work, so the focusout it causes is a
   * no-op. `refocus` is false when the edit ends because focus is already on
   * its way somewhere else (a click on another cell or a button): taking it
   * back mid-transition would fight the browser for where it lands.
   */
  function finishEdit(commit: boolean, then?: { id: number; field: Field }, refocus = true): void {
    const e = editing
    if (!e) return
    editing = undefined
    const r = row(e.id)
    if (commit && r && normaliseGlossaryValue(e.control.value) !== r[e.field]) {
      setCell(m, e.id, e.field, e.control.value)
      changed([e.id], refocus)
    } else {
      patchRows([e.id], refocus)
    }
    if (!refocus) return
    const to = then ?? { id: e.id, field: e.field }
    focusCell(to.id, to.field)
  }

  // ---- row operations -------------------------------------------------------

  function insertVisible(id: number, after: number | undefined): void {
    const i = after === undefined ? -1 : visible.indexOf(after)
    visible.splice(i === -1 ? visible.length : i + 1, 0, id)
  }

  function addBelow(): void {
    const id = addRow(m, cursor?.id)
    insertVisible(id, cursor?.id)
    cursor = { id, field: 'term' }
    drawRows()
    host.persist?.(m)
    focusCell(id, 'term')
  }

  function duplicate(): void {
    if (!cursor) return
    const id = duplicateRow(m, cursor.id)
    insertVisible(id, cursor.id)
    // Same term, another part of speech is why rows get duplicated.
    cursor = { id, field: 'pos' }
    drawRows()
    host.persist?.(m)
    focusCell(id, 'pos')
  }

  function toggle(id: number): void {
    toggleDelete(m, id)
    changed([id])
    if (cursor?.id === id) drawPanel()
  }

  function revert(id: number): void {
    const r = row(id)
    if (!r) return
    revertRow(m, id)
    if (!row(id)) {
      const i = visible.indexOf(id)
      visible.splice(i, 1)
      if (cursor?.id === id) {
        const next = visible[Math.min(i, visible.length - 1)]
        cursor = next === undefined ? undefined : { id: next, field: cursor.field }
      }
      drawRows()
      host.persist?.(m)
      if (cursor) focusCell(cursor.id, cursor.field)
      return
    }
    changed([id])
    drawPanel()
  }

  // ---- dialogs --------------------------------------------------------------

  function openDialog(html: string): void {
    dialogReturn = (doc.activeElement as HTMLElement | null) ?? undefined
    layer.innerHTML = `<div class="ge-backdrop" data-action="close-dialog"></div>${html}`
    layer.hidden = false
    layer.querySelector<HTMLElement>('.ge-dialog')?.focus()
  }

  function closeDialog(): void {
    layer.innerHTML = ''
    layer.hidden = true
    dialogReturn?.focus()
    dialogReturn = undefined
  }

  // ---- host calls -----------------------------------------------------------

  async function reload(text = ''): Promise<void> {
    try {
      apply(await host.load())
      setStatus(text)
    } catch (e) {
      setStatus(message(e), 'error')
    }
  }

  async function save(): Promise<void> {
    if (busy || problems.size > 0) return
    busy = true
    drawChrome()
    setStatus(host.saveLabel === 'Save' ? 'Saving…' : 'Exporting…')
    try {
      const result = await host.save(m, stamp)
      if (result.ok) {
        if (result.stamp !== undefined) stamp = result.stamp
        busy = false
        if (m.mode === 'db') {
          // A save turns rows into local edits and back; only the store knows
          // the new origins, so the page reads them rather than guessing.
          await reload('Saved.')
        } else {
          rebase()
          setStatus(host.saveLabel === 'Save' ? 'Saved.' : 'Exported.')
        }
      } else if (result.reason === 'stale') {
        busy = false
        drawChrome()
        const n = unsavedCount()
        setStatus(
          `${result.message} Reload to see the current glossary; your edits on this page are not saved.`,
          'error',
          ` <button type="button" class="ge-link" data-action="reload">Reload, dropping ${n} unsaved ${n === 1 ? 'change' : 'changes'}</button>`,
        )
      } else {
        busy = false
        drawChrome()
        setStatus(result.message, 'error')
      }
    } catch (e) {
      busy = false
      drawChrome()
      setStatus(message(e), 'error')
    }
  }

  /** What was just written becomes what was loaded, so the page is clean again. */
  function rebase(): void {
    apply({ ...data, rows: currentRows(m), ...(stamp === undefined ? {} : { stamp }) })
    host.persist?.(m)
  }

  async function discard(): Promise<void> {
    closeDialog()
    if (!host.discard || stamp === undefined) return
    setStatus('Discarding…')
    try {
      const result = await host.discard(stamp)
      if (result.ok) await reload('Local edits discarded.')
      else setStatus(result.message, 'error')
    } catch (e) {
      setStatus(message(e), 'error')
    }
  }

  async function importCsv(): Promise<void> {
    if (!host.openFile) return
    try {
      const file = await host.openFile()
      if (!file) return
      const rows: GlossaryRow[] = file.rows.map((r) => ({ term: r.term, pos: r.pos, translation: r.translation, notes: r.notes }))
      applyImport(m, rows)
      if (file.notice) notice = file.notice
      refilter()
      host.persist?.(m)
      setStatus(`Imported ${rows.length} ${rows.length === 1 ? 'row' : 'rows'} as unsaved changes. Check Changes before saving.`)
    } catch (e) {
      setStatus(message(e), 'error')
    }
  }

  async function openSidecar(): Promise<void> {
    if (!host.openSidecar) return
    try {
      const json = await host.openSidecar()
      if (json === undefined) return
      notice = data.notice ?? ''
      loadSidecar(json)
      refilter()
    } catch (e) {
      setStatus(message(e), 'error')
    }
  }

  function close(): void {
    closeDialog()
    closed = true
    host.close?.()
    root.innerHTML = '<div class="ge"><p class="ge-loading">The editor is closed. You can close this tab.</p></div>'
  }

  // ---- listeners ------------------------------------------------------------

  root.addEventListener('click', (ev) => {
    const target = ev.target as Element
    const el = target.closest<HTMLElement>('[data-action]')
    if (!el || !root.contains(el)) return
    const rowId = Number(el.closest('tr')?.dataset.id)
    switch (el.dataset.action) {
      case 'chip': {
        const chip = el.dataset.chip ?? ''
        if (chip === 'all') filter = { query: filter.query }
        else if (chip.startsWith('pos:')) {
          const pos = chip.slice(4)
          const { pos: _drop, ...rest } = filter
          filter = filter.pos === pos ? rest : { ...rest, pos }
        } else if (chip === 'problems') filter = { ...filter, problems: !filter.problems }
        else if (chip === 'local') filter = { ...filter, local: !filter.local }
        else if (chip === 'contested') filter = { ...filter, contested: !filter.contested }
        refilter()
        break
      }
      case 'show-problems':
        filter = { ...filter, problems: true }
        refilter()
        break
      case 'add':
        addBelow()
        break
      case 'duplicate':
        duplicate()
        break
      case 'delete':
        if (cursor) toggle(cursor.id)
        break
      case 'row-restore':
        toggle(rowId)
        break
      case 'row-revert':
        revert(rowId)
        break
      case 'changes':
        openDialog(changesHtml(diffOf(m)))
        break
      case 'close-dialog':
        closeDialog()
        break
      case 'save':
        void save()
        break
      case 'reload':
        void reload()
        break
      case 'import':
        void importCsv()
        break
      case 'sidecar':
        void openSidecar()
        break
      case 'discard': {
        const n = localCount()
        const edits = `${n} local ${n === 1 ? 'edit' : 'edits'}`
        const unsaved = unsavedCount()
        openDialog(
          confirmHtml(
            `Discard ${edits}?`,
            `This removes ${edits} from polyglots' glossary for ${data.locale} and reloads the wp.org rows.` +
              (unsaved > 0 ? ` The ${unsaved} unsaved ${unsaved === 1 ? 'change' : 'changes'} on this page go too.` : ''),
            `Discard ${edits}`,
            'confirm-discard',
          ),
        )
        break
      }
      case 'confirm-discard':
        void discard()
        break
      case 'close':
        if (dirty()) {
          const n = unsavedCount()
          openDialog(
            confirmHtml('Close without saving?', `${n} unsaved ${n === 1 ? 'change is' : 'changes are'} lost.`, 'Close without saving', 'confirm-close'),
          )
        } else close()
        break
      case 'confirm-close':
        close()
        break
    }
  })

  root.addEventListener('dblclick', (ev) => {
    const td = (ev.target as Element).closest<HTMLElement>('td[data-field]')
    if (!td || editing) return
    const id = Number(td.closest('tr')?.dataset.id)
    startEdit(id, td.dataset.field as Field)
  })

  root.addEventListener('focusin', (ev) => {
    const td = ev.target as HTMLElement
    if (td.tagName !== 'TD' || !td.dataset.field) return
    const id = Number(td.closest('tr')?.dataset.id)
    const field = td.dataset.field as Field
    if (cursor?.id === id && cursor.field === field) return
    const prev = cursor
    if (prev) cellEl(prev.id, prev.field)?.setAttribute('tabindex', '-1')
    td.setAttribute('tabindex', '0')
    cursor = { id, field }
    if (prev?.id !== id) drawPanel()
  })

  // Leaving a cell any other way than a key, such as clicking elsewhere,
  // keeps what was typed: losing it would be the surprise. Focus is already
  // on its way to whatever was clicked, so the commit leaves it alone.
  root.addEventListener('focusout', (ev) => {
    if (editing && ev.target === editing.control) finishEdit(true, undefined, false)
  })

  search.addEventListener('input', () => {
    filter = { ...filter, query: search.value }
    refilter()
  })

  root.addEventListener('keydown', (ev) => {
    if (!layer.hidden) {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        closeDialog()
      }
      return
    }
    const target = ev.target as HTMLElement
    if (target === search) {
      if ((ev.key === 'ArrowDown' || ev.key === 'Enter') && cursor) {
        ev.preventDefault()
        focusCell(cursor.id, cursor.field)
      }
      return
    }
    if (editing && target === editing.control) {
      if (ev.isComposing) return
      if (ev.key === 'Enter') {
        ev.preventDefault()
        finishEdit(true, step(1, 0, false))
      } else if (ev.key === 'Escape') {
        ev.preventDefault()
        finishEdit(false)
      } else if (ev.key === 'Tab') {
        ev.preventDefault()
        finishEdit(true, step(0, ev.shiftKey ? -1 : 1, true))
      }
      return
    }
    if (target.tagName !== 'TD' || !target.dataset.field || !cursor) return
    const mod = ev.ctrlKey || ev.metaKey
    let to: { id: number; field: Field } | undefined
    switch (ev.key) {
      case 'ArrowUp': to = step(-1, 0, false); break
      case 'ArrowDown': to = step(1, 0, false); break
      case 'ArrowLeft': to = step(0, -1, false); break
      case 'ArrowRight': to = step(0, 1, false); break
      case 'Home': to = { id: cursor.id, field: FIELDS[0]! }; break
      case 'End': to = { id: cursor.id, field: FIELDS[FIELDS.length - 1]! }; break
      case 'Tab':
        to = step(0, ev.shiftKey ? -1 : 1, true)
        // At either end of the table Tab leaves it, so the grid is no trap.
        if (!to) return
        break
      case 'Enter':
      case 'F2':
        ev.preventDefault()
        if (mod) addBelow()
        else startEdit(cursor.id, cursor.field)
        return
      case 'Backspace':
      case 'Delete':
        ev.preventDefault()
        if (mod) toggle(cursor.id)
        else if (cursor.field !== 'pos') startEdit(cursor.id, cursor.field, '')
        return
      default:
        if (mod && ev.key.toLowerCase() === 'd') {
          ev.preventDefault()
          duplicate()
          return
        }
        // A printable key replaces the cell's value with itself, as a
        // spreadsheet does; Enter is the way to edit what is there.
        if (ev.key.length === 1 && !mod && !ev.altKey) {
          ev.preventDefault()
          startEdit(cursor.id, cursor.field, ev.key)
        }
        return
    }
    ev.preventDefault()
    if (to) focusCell(to.id, to.field)
  })

  // Unsaved changes warn on leaving. The check for a detached root lets a host
  // that unmounts the editor, or a test that replaces the document, leave no
  // listener behind that would keep warning about a page no longer shown.
  const onLeave = (ev: Event): void => {
    if (!root.isConnected || closed) {
      win?.removeEventListener('beforeunload', onLeave)
      return
    }
    if (dirty()) {
      ev.preventDefault()
      // Older Chromium shows the prompt only when returnValue is set.
      ;(ev as BeforeUnloadEvent).returnValue = ''
    }
  }
  win?.addEventListener('beforeunload', onLeave)

  apply(data)
  return { model: () => m }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
