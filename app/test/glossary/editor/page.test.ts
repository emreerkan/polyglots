// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GLOSSARY_POS } from '../../../src/glossary/csv.js'
import { createModel, currentRows, diffOf, setCell, type EditorModel } from '../../../src/glossary/editor/model.js'
import { mountEditor } from '../../../src/glossary/editor/page/editor.js'
import type { EditorHost, LoadedGlossary, SaveResult } from '../../../src/glossary/editor/page/host.js'
import { localHost } from '../../../src/glossary/editor/page/local-host.js'
import { DEFAULT_SETTINGS, type EditorSettings } from '../../../src/glossary/editor/settings.js'
import type { EffectiveRow } from '../../../src/glossary/types.js'

const eff = (term: string, translation: string, pos = 'noun', origin: EffectiveRow['origin'] = 'wporg', notes = ''): EffectiveRow => ({
  term, pos, translation, notes, origin,
})

const ROWS: EffectiveRow[] = [
  eff('course', 'kurs'),
  eff('quiz', 'sınav', 'noun', 'changed', 'Not "test".'),
  eff('lesson', 'ders'),
  eff('post', 'yazı'),
  eff('post', 'yayımla', 'verb'),
]

interface FakeHost extends EditorHost {
  saves: Array<{ m: EditorModel; stamp: string | undefined }>
  discards: string[]
}

function fakeHost(loaded: Partial<LoadedGlossary> = {}, over: Partial<EditorHost> = {}): FakeHost {
  const host: FakeHost = {
    saves: [],
    discards: [],
    saveLabel: 'Save',
    load: async () => ({ mode: 'db', locale: 'tr', rows: ROWS, stamp: 's1', ...loaded }),
    save: async (m, stamp) => {
      host.saves.push({ m, stamp })
      return { ok: true, stamp: 's2' }
    },
    discard: async (stamp) => {
      host.discards.push(stamp)
      return { ok: true }
    },
    ...over,
  }
  return host
}

let root: HTMLElement

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  root = document.getElementById('root')!
})

afterEach(() => {
  vi.restoreAllMocks()
})

const flush = () => new Promise((r) => setTimeout(r, 0))
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
const cell = (id: number, field: string) => root.querySelector<HTMLElement>(`tr[data-id="${id}"] td[data-field="${field}"]`)!
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))
const byText = (text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => norm(b.textContent).startsWith(text))!
const count = () => norm(root.querySelector('.ge-count')?.textContent)
const visibleTerms = () => [...root.querySelectorAll('tbody tr td[data-field="term"]')].map((td) => norm(td.textContent))

/** Focus a cell, press Enter to edit it, type a value and press Enter. */
function edit(id: number, field: string, value: string): void {
  const td = cell(id, field)
  td.focus()
  key(td, 'Enter')
  const input = td.querySelector('input')!
  input.value = value
  key(input, 'Enter')
}

describe('mountEditor', () => {
  it('mounts from a restored model, keeping its edits against the as-opened values, and drops it after a save', async () => {
    const restored = createModel([eff('course', 'kurs'), eff('lesson', 'ders')], 'csv')
    setCell(restored, restored.rows[0]!.id, 'translation', 'ders kitabı')
    const host = fakeHost({ mode: 'csv', rows: currentRows(restored), model: restored }, { saveLabel: 'Export' })
    delete host.discard
    const { model } = await mountEditor(root, host)
    expect(diffOf(model()).changed.map((c) => [c.from.translation, c.to.translation])).toEqual([['kurs', 'ders kitabı']])
    byText('Export').click()
    await flush()
    expect(diffOf(model()).changed).toEqual([])
  })

  it('shows the warning a host returns when the work cannot be kept', async () => {
    const warn = 'Not kept.'
    const host = fakeHost({ mode: 'csv', rows: [eff('a', 'b')] }, { persist: () => warn })
    await mountEditor(root, host)
    edit(1, 'translation', 'x')
    expect((root.querySelector('.ge-notice') as HTMLElement).textContent).toBe('Not kept.')
  })

  it('draws the columns in order, with the part of speech as a select of the GlotPress values', async () => {
    await mountEditor(root, fakeHost())
    const heads = [...root.querySelectorAll('thead th')].map((th) => norm(th.textContent)).slice(0, 4)
    expect(heads).toEqual(['Term', 'Part of speech', 'Translation', 'Comment'])
    expect(visibleTerms()).toEqual(['course', 'quiz', 'lesson', 'post', 'post'])

    const pos = cell(1, 'pos')
    pos.focus()
    key(pos, 'Enter')
    const options = [...pos.querySelectorAll('option')].map((o) => o.value)
    expect(options).toEqual(['', ...GLOSSARY_POS])
    expect(pos.querySelector('select')!.value).toBe('noun')
  })

  it('commits a cell on Enter, marks the row changed and moves down', async () => {
    const ed = await mountEditor(root, fakeHost())
    expect(count()).toBe('0 changed · 0 added')
    edit(1, 'translation', 'eğitim')
    expect(norm(cell(1, 'translation').textContent)).toBe('eğitim')
    expect(cell(1, 'term').classList.contains('ge-changed')).toBe(true)
    expect(count()).toBe('1 changed · 0 added')
    expect(document.activeElement).toBe(cell(2, 'translation'))
    expect(diffOf(ed.model()).changed).toHaveLength(1)
  })

  it('cancels a cell edit on Escape', async () => {
    await mountEditor(root, fakeHost())
    const td = cell(1, 'translation')
    td.focus()
    key(td, 'Enter')
    const input = td.querySelector('input')!
    input.value = 'eğitim'
    key(input, 'Escape')
    expect(cell(1, 'translation').querySelector('input')).toBeNull()
    expect(norm(cell(1, 'translation').textContent)).toBe('kurs')
    expect(count()).toBe('0 changed · 0 added')
    expect(document.activeElement).toBe(cell(1, 'translation'))
  })

  it('keeps what was typed when another cell of the same row is clicked, and lands there', async () => {
    await mountEditor(root, fakeHost())
    const td = cell(1, 'translation')
    td.focus()
    key(td, 'Enter')
    td.querySelector('input')!.value = 'eğitim'
    cell(1, 'notes').focus()
    expect(norm(cell(1, 'translation').textContent)).toBe('eğitim')
    expect(document.activeElement).toBe(cell(1, 'notes'))
    expect(count()).toBe('1 changed · 0 added')
  })

  it('starts editing on a printable key, replacing the value with it', async () => {
    await mountEditor(root, fakeHost())
    const td = cell(3, 'notes')
    td.focus()
    key(td, 'x')
    expect(td.querySelector('input')!.value).toBe('x')
  })

  it('moves focus between cells with the arrow keys and Tab', async () => {
    await mountEditor(root, fakeHost())
    const td = cell(1, 'term')
    td.focus()
    key(td, 'ArrowRight')
    expect(document.activeElement).toBe(cell(1, 'pos'))
    key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement).toBe(cell(2, 'pos'))
    key(document.activeElement!, 'Tab')
    expect(document.activeElement).toBe(cell(2, 'translation'))
    key(document.activeElement!, 'Tab', { shiftKey: true })
    key(document.activeElement!, 'ArrowLeft')
    expect(document.activeElement).toBe(cell(2, 'term'))
  })

  // Tab from an open cell is how a row gets filled in one pass, so the next
  // cell opens too; from a cell that is only in focus, Tab only moves.
  it('commits on Tab from an open cell and opens the next one, wrapping to the next row', async () => {
    await mountEditor(root, fakeHost())
    const td = cell(1, 'term')
    td.focus()
    key(td, 'Enter')
    const input = td.querySelector('input')!
    input.value = 'courses'
    key(input, 'Tab')
    expect(norm(cell(1, 'term').textContent)).toBe('courses')
    const select = cell(1, 'pos').querySelector('select')!
    expect(document.activeElement).toBe(select)
    key(select, 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe(cell(1, 'term').querySelector('input'))
    key(document.activeElement!, 'Escape')
    const notes = cell(1, 'notes')
    notes.focus()
    key(notes, 'Enter')
    key(notes.querySelector('input')!, 'Tab')
    expect(document.activeElement).toBe(cell(2, 'term').querySelector('input'))
  })

  it('disables Save while a problem remains, and says how many', async () => {
    await mountEditor(root, fakeHost())
    edit(1, 'translation', '')
    const save = byText('Save')
    expect(save.disabled).toBe(true)
    expect(norm(root.querySelector('.ge-reason')?.textContent)).toContain('Fix 1 row first: “course” (empty translation)')
    expect(norm(cell(1, 'translation').textContent)).toBe('empty translation')
    expect(byText('problems 1')).toBeDefined()
  })

  it('filters as the search is typed, over term, translation and comment', async () => {
    await mountEditor(root, fakeHost())
    const search = root.querySelector<HTMLInputElement>('input[type="search"]')!
    search.value = 'sın'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    expect(visibleTerms()).toEqual(['quiz'])
    search.value = 'test'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    expect(visibleTerms()).toEqual(['quiz'])
  })

  it('filters by a part of speech chip, and all clears it', async () => {
    await mountEditor(root, fakeHost())
    byText('verb').click()
    expect(visibleTerms()).toEqual(['post'])
    byText('all').click()
    expect(visibleTerms()).toHaveLength(5)
  })

  it('lists added, changed and deleted rows in Changes', async () => {
    await mountEditor(root, fakeHost())
    edit(1, 'translation', 'eğitim')
    cell(3, 'term').focus()
    byText('Delete').click()
    expect(root.querySelector('tr[data-id="3"]')!.classList.contains('ge-deleted')).toBe(true)
    byText('Add row').click()
    expect(count()).toBe('1 changed · 1 added · 1 deleted')
    byText('Changes').click()
    const dialog = root.querySelector('[role="dialog"]')!
    const text = norm(dialog.textContent)
    expect(text).toContain('kurs → eğitim')
    expect(text).toContain('lesson')
    expect(text).toMatch(/Added/)
    key(dialog, 'Escape')
    expect(root.querySelector('[role="dialog"]')).toBeNull()
  })

  it('saves through the host with the stamp it loaded', async () => {
    const host = fakeHost()
    await mountEditor(root, host)
    edit(1, 'translation', 'eğitim')
    byText('Save').click()
    await flush()
    expect(host.saves).toHaveLength(1)
    expect(host.saves[0]!.stamp).toBe('s1')
    expect(diffOf(host.saves[0]!.m).changed[0]!.to.translation).toBe('eğitim')
  })

  it('refuses edits, row operations and discard while a save is in flight, so none is lost', async () => {
    for (const mode of ['csv', 'db'] as const) {
      document.body.innerHTML = '<div id="root"></div>'
      root = document.getElementById('root')!
      let finish!: (r: SaveResult) => void
      const host = fakeHost(mode === 'csv' ? { mode, rows: ROWS.map(({ origin: _o, ...r }) => r), stamp: undefined } : {}, {
        save: () => new Promise<SaveResult>((r) => { finish = r }),
      })
      await mountEditor(root, host)
      edit(1, 'translation', 'eğitim')
      byText('Save').click()
      const td = cell(3, 'translation')
      td.focus()
      key(td, 'Enter')
      expect(td.querySelector('input')).toBeNull()
      key(td, 'x')
      expect(td.querySelector('input')).toBeNull()
      byText('Add row').click()
      byText('Delete row').click()
      expect(count()).toBe('1 changed · 0 added')
      if (mode === 'db') {
        byText('Discard all local edits').click()
        expect(root.querySelector('[role="alertdialog"]')).toBeNull()
        expect(host.discards).toEqual([])
      }
      finish({ ok: true })
      await flush()
      await flush()
      const after = cell(3, 'translation')
      after.focus()
      key(after, 'Enter')
      expect(after.querySelector('input')).not.toBeNull()
    }
  })

  it('keeps a toolbar control in place when focusing it ends an edit, so the click lands', async () => {
    await mountEditor(root, fakeHost())
    const td = cell(1, 'translation')
    td.focus()
    key(td, 'Enter')
    td.querySelector('input')!.value = 'eğitim'
    const verb = byText('verb')
    verb.focus()
    expect(count()).toBe('1 changed · 0 added')
    expect(verb.isConnected).toBe(true)
    verb.click()
    expect(visibleTerms()).toEqual(['post'])

    byText('all').click()
    const again = cell(2, 'translation')
    again.focus()
    key(again, 'Enter')
    again.querySelector('input')!.value = ''
    const discard = byText('Discard all local edits')
    discard.focus()
    expect(discard.isConnected).toBe(true)
    discard.click()
    expect(root.querySelector('[role="alertdialog"]')).not.toBeNull()
  })

  it('stops warning on leaving once the editor is closed', async () => {
    const host = fakeHost({}, { close: vi.fn() })
    await mountEditor(root, host)
    edit(1, 'translation', 'eğitim')
    byText('Close').click()
    byText('Close without saving').click()
    expect(host.close).toHaveBeenCalled()
    const ev = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
  })

  it('shows the reload message when the save is stale', async () => {
    const host = fakeHost({}, {
      save: async (): Promise<SaveResult> => ({ ok: false, reason: 'stale', message: 'The glossary changed on disk.' }),
    })
    await mountEditor(root, host)
    edit(1, 'translation', 'eğitim')
    byText('Save').click()
    await flush()
    const status = norm(root.querySelector('.ge-status')?.textContent)
    expect(status).toContain('The glossary changed on disk.')
    expect(status).toMatch(/Reload/)
    expect(count()).toBe('1 changed · 0 added')
  })

  it('asks before discarding the local edits, naming the count, then calls the host', async () => {
    const host = fakeHost()
    await mountEditor(root, host)
    byText('Discard all local edits').click()
    expect(host.discards).toEqual([])
    const dialog = root.querySelector('[role="alertdialog"]')!
    expect(norm(dialog.textContent)).toContain('1 local edit')
    byText('Discard 1').click()
    await flush()
    expect(host.discards).toEqual(['s1'])
  })

  // A local delete of a wp.org row is an edit too, but leaves no row on the
  // page to count: the server's count is the one Discard removes.
  it('names the count the server gives, which includes deletes the rows cannot show', async () => {
    const host = fakeHost({ rows: ROWS.map((r) => ({ ...r, origin: 'wporg' as const })), localEdits: 3 })
    await mountEditor(root, host)
    byText('Discard all local edits').click()
    const dialog = root.querySelector('[role="alertdialog"]')!
    expect(norm(dialog.textContent)).toContain('3 local edits')
  })

  // Editing makes no requests, and the server stops after its idle time with
  // none; the ping is what keeps a long edit's Save from finding it gone.
  it('pings the host every five minutes while open, and stops once closed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const ping = vi.fn()
      const host = fakeHost({}, { ping, close: () => {} })
      await mountEditor(root, host)
      vi.advanceTimersByTime(5 * 60_000 - 1)
      expect(ping).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(ping).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(5 * 60_000)
      expect(ping).toHaveBeenCalledTimes(2)
      byText('Close').click()
      vi.advanceTimersByTime(15 * 60_000)
      expect(ping).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers no discard or local edits chip for a CSV', async () => {
    await mountEditor(root, fakeHost({ mode: 'csv', rows: ROWS.map(({ origin: _o, ...r }) => r), stamp: undefined }))
    expect(byText('Discard all local edits')).toBeUndefined()
    expect(byText('local edits')).toBeUndefined()
  })

  it('warns before leaving while changes are unsaved', async () => {
    await mountEditor(root, fakeHost())
    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)
    edit(1, 'translation', 'eğitim')
    const dirty = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirty)
    expect(dirty.defaultPrevented).toBe(true)
  })

  // The analysis is the maintainer's own tool, so nothing on the page offers
  // it: it arrives only as a polyglots:analysis event on the root, which the
  // console snippet in ~/Downloads dispatches.
  const ANALYSIS = {
    version: 1,
    rows: [{ en: 'quiz', pos: 'noun', proposed: 'sınav', confidence: 'contested', occurrences: { 'a.po': 3 },
      currentRenderings: [{ text: 'test', count: 80 }], glossary: [], otherPlugins: [{ project: 'tutor', tr: 'sınav' }],
      tm: [], examples: ['Start Quiz'], reason: '' }],
  }
  const sendAnalysis = (detail: unknown) => root.dispatchEvent(new CustomEvent('polyglots:analysis', { detail }))

  it('offers no analysis control of its own', async () => {
    await mountEditor(root, fakeHost({ mode: 'csv' }))
    expect(root.querySelector('[data-action="sidecar"]')).toBeNull()
    expect(root.textContent).not.toContain('Open analysis')
  })

  it('shows an analysis sent as an event in the evidence panel, with a contested chip', async () => {
    await mountEditor(root, fakeHost())
    sendAnalysis(ANALYSIS)
    cell(2, 'translation').focus()
    const panel = norm(root.querySelector('.ge-panel')?.textContent)
    expect(panel).toContain('contested')
    expect(panel).toContain('test ×80')
    expect(panel).toContain('tutor: sınav')
    expect(panel).toMatch(/local edit/i)
    byText('contested 1').click()
    expect(visibleTerms()).toEqual(['quiz'])
  })

  it('keeps the analysis across the reload a save makes, and words a bad one as a notice', async () => {
    await mountEditor(root, fakeHost())
    sendAnalysis(ANALYSIS)
    edit(1, 'translation', 'eğitim')
    byText('Save').click()
    await flush()
    await flush()
    expect(byText('contested 1')).toBeDefined()
    sendAnalysis({ version: 2, rows: [] })
    expect(norm(root.querySelector('.ge-notice')?.textContent)).toContain('The analysis file was not loaded')
  })

  it('shows an imported CSV as unsaved edits', async () => {
    const host = fakeHost({}, {
      openFile: async () => ({ mode: 'csv', locale: 'tr', rows: [{ term: 'lesson', pos: 'noun', translation: 'konu', notes: '' }] }),
    })
    await mountEditor(root, host)
    byText('Import CSV').click()
    await flush()
    expect(count()).toBe('0 changed · 1 added · 1 deleted')
  })

  it('offers Import CSV on the local server\'s page in db mode, and an import marks the rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ mode: 'db', locale: 'tr', rows: ROWS, stamp: 's1' }), { status: 200 })))
    const host = localHost('http://127.0.0.1:4100/tok/', async () => ({
      name: 'terms.csv',
      text: 'en,tr,pos,description\nlesson,konu,noun,\n',
    }))
    try {
      await mountEditor(root, host)
      byText('Import CSV').click()
      await new Promise((r) => setTimeout(r, 10))
      expect(count()).toBe('0 changed · 1 added · 1 deleted')
      expect(root.querySelector('tbody tr.ge-deleted td[data-field="translation"]')?.textContent).toBe('ders')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // wp.org's own glossary has case-only twins. Saving an unrelated edit must
  // not wait on rows the person never touched.
  it('shows untouched wp.org duplicates in db mode without holding back a save', async () => {
    const host = fakeHost({ rows: [eff('Post', 'yazı'), eff('post', 'yazı'), eff('course', 'kurs')] })
    await mountEditor(root, host)
    edit(3, 'translation', 'eğitim')
    expect(byText('problems 2')).toBeDefined()
    expect(byText('Save').disabled).toBe(false)
    expect(root.querySelector<HTMLElement>('.ge-reason')!.hidden).toBe(true)
    edit(2, 'notes', 'a note')
    expect(byText('Save').disabled).toBe(true)
    expect(norm(root.querySelector('.ge-reason')?.textContent)).toContain('Fix 2 rows first')
  })

  it('holds back an export over duplicates in a CSV, touched or not', async () => {
    const host = fakeHost({ mode: 'csv', rows: [eff('Post', 'yazı'), eff('post', 'yazı')] }, { saveLabel: 'Export' })
    delete host.discard
    await mountEditor(root, host)
    expect(byText('Export').disabled).toBe(true)
  })

  describe('settings', () => {
    /** A host that keeps settings, starting from `initial`, and records each save. */
    function withSettings(initial: Partial<EditorSettings> | undefined, loaded: Partial<LoadedGlossary> = {}) {
      const saved: EditorSettings[] = []
      const host = fakeHost(loaded, {
        settings: {
          load: async () => (initial === undefined ? undefined : { ...DEFAULT_SETTINGS, ...initial }),
          save: async (s) => {
            saved.push(s)
          },
        },
      })
      return { host, saved }
    }
    const header = (text: string) =>
      [...root.querySelectorAll<HTMLElement>('thead th')].find((th) => norm(th.textContent).startsWith(text))!
    const openSettings = () => {
      byText('Settings').click()
      return root.querySelector<HTMLElement>('.ge-dialog')!
    }
    const choose = (dialog: HTMLElement, name: string, value: string | boolean) => {
      const el = dialog.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-setting="${name}"]`)!
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = value as boolean
      else el.value = String(value)
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }

    it('opens with the defaults when the host keeps no settings, or loading them fails', async () => {
      await mountEditor(root, fakeHost({}, { settings: { load: async () => Promise.reject(new Error('gone')), save: async () => {} } }))
      expect(visibleTerms()).toEqual(['course', 'quiz', 'lesson', 'post', 'post'])
      document.body.innerHTML = '<div id="root"></div>'
      root = document.getElementById('root')!
      await mountEditor(root, fakeHost())
      expect(visibleTerms()).toEqual(['course', 'quiz', 'lesson', 'post', 'post'])
      expect(byText('Settings')).toBeDefined()
    })

    it('sorts on a click of the Term header, ascending, descending, then the file order, saving each choice', async () => {
      const { host, saved } = withSettings({})
      const ed = await mountEditor(root, host)
      header('Term').querySelector('button')!.click()
      expect(visibleTerms()).toEqual(['course', 'lesson', 'post', 'post', 'quiz'])
      expect(header('Term').getAttribute('aria-sort')).toBe('ascending')
      header('Term').querySelector('button')!.click()
      expect(visibleTerms()).toEqual(['quiz', 'post', 'post', 'lesson', 'course'])
      expect(header('Term').getAttribute('aria-sort')).toBe('descending')
      header('Term').querySelector('button')!.click()
      expect(visibleTerms()).toEqual(['course', 'quiz', 'lesson', 'post', 'post'])
      expect(header('Term').hasAttribute('aria-sort')).toBe(false)
      expect(saved.map((s) => s.sort)).toEqual(['term-asc', 'term-desc', 'file'])
      // Display only: the model, and so the export, keeps the file order.
      header('Translation').querySelector('button')!.click()
      expect(ed.model().rows.map((r) => r.term)).toEqual(['course', 'quiz', 'lesson', 'post', 'post'])
    })

    it('keeps an edited row in place under a sort until the next sort', async () => {
      await mountEditor(root, withSettings({ sort: 'term-asc' }).host)
      expect(visibleTerms()).toEqual(['course', 'lesson', 'post', 'post', 'quiz'])
      edit(1, 'term', 'zebra')
      expect(visibleTerms()).toEqual(['zebra', 'lesson', 'post', 'post', 'quiz'])
    })

    it('opens with the saved start filter, density, wrap and hidden columns', async () => {
      const { host } = withSettings({ startFilter: 'edits', density: 'compact', wrap: false, columns: { pos: false, notes: true } })
      await mountEditor(root, host)
      expect(visibleTerms()).toEqual(['quiz'])
      const ge = root.querySelector('.ge')!
      expect(ge.classList.contains('ge-compact')).toBe(true)
      expect(ge.classList.contains('ge-nowrap')).toBe(true)
      expect(ge.classList.contains('ge-hide-pos')).toBe(true)
      expect(ge.classList.contains('ge-hide-notes')).toBe(false)
    })

    it('opens on the problems when the start filter says so', async () => {
      await mountEditor(root, withSettings({ startFilter: 'problems' }, { rows: [eff('a', ''), eff('b', 'x')] }).host)
      expect(visibleTerms()).toEqual(['a'])
    })

    it('offers a changed chip for a CSV, which the edits start filter turns on', async () => {
      const rows = [eff('a', 'x'), eff('b', 'y')].map(({ origin: _o, ...r }) => r)
      await mountEditor(root, withSettings({ startFilter: 'edits' }, { mode: 'csv', rows }).host)
      expect(visibleTerms()).toEqual([])
      byText('changed').click()
      expect(visibleTerms()).toEqual(['a', 'b'])
    })

    it('changes a setting in the dialog, saves it and redraws at once', async () => {
      const { host, saved } = withSettings({})
      await mountEditor(root, host)
      const dialog = openSettings()
      expect(dialog.getAttribute('role')).toBe('dialog')
      expect(norm(dialog.textContent)).toContain('Save keeps the glossary\'s own order.')
      choose(dialog, 'sort', 'translation-asc')
      expect(visibleTerms()).toEqual(['lesson', 'course', 'quiz', 'post', 'post'])
      choose(dialog, 'density', 'compact')
      expect(root.querySelector('.ge')!.classList.contains('ge-compact')).toBe(true)
      choose(dialog, 'columns.notes', false)
      expect(root.querySelector('.ge')!.classList.contains('ge-hide-notes')).toBe(true)
      expect(saved.at(-1)).toMatchObject({ sort: 'translation-asc', density: 'compact', columns: { pos: true, notes: false } })
      key(dialog, 'Escape')
      expect(root.querySelector('.ge-dialog')).toBeNull()
    })

    it('names the host\'s own save button in the dialog, Save for the CLI\'s CSV page', async () => {
      const rows = [eff('a', 'x')].map(({ origin: _o, ...r }) => r)
      await mountEditor(root, withSettings({}, { mode: 'csv', rows }).host)
      expect(norm(openSettings().textContent)).toContain('Save keeps the glossary\'s own order.')
    })

    it('searches the term alone, by whole word, when set', async () => {
      await mountEditor(root, withSettings({ searchIn: 'term', wholeWord: true }, { rows: [eff('post', 'yazı'), eff('repost', 'x', 'verb', 'wporg', 'a post')] }).host)
      const search = root.querySelector<HTMLInputElement>('.ge-search')!
      search.value = 'post'
      search.dispatchEvent(new Event('input'))
      expect(visibleTerms()).toEqual(['post'])
      expect(search.placeholder).toBe('Search term')
    })

    it('skips a hidden column when moving with the arrow keys and Tab', async () => {
      await mountEditor(root, withSettings({ columns: { pos: false, notes: false } }).host)
      const td = cell(1, 'term')
      td.focus()
      key(td, 'ArrowRight')
      expect(document.activeElement).toBe(cell(1, 'translation'))
      key(document.activeElement!, 'Tab')
      expect(document.activeElement).toBe(cell(2, 'term'))
      key(document.activeElement!, 'End')
      expect(document.activeElement).toBe(cell(2, 'translation'))
    })

    it('stays on the cell after Enter commits when set', async () => {
      await mountEditor(root, withSettings({ enterMoves: 'stay' }).host)
      edit(1, 'translation', 'eğitim')
      expect(document.activeElement).toBe(cell(1, 'translation'))
    })

    it('adds a row on Tab out of the last cell of the table when set, and opens its term', async () => {
      const { host } = withSettings({ tabAddsRow: true })
      const ed = await mountEditor(root, host)
      const last = cell(5, 'notes')
      last.focus()
      key(last, 'Enter')
      key(last.querySelector('input')!, 'Tab')
      expect(ed.model().rows).toHaveLength(6)
      const added = ed.model().rows[5]!
      expect(document.activeElement).toBe(cell(added.id, 'term').querySelector('input'))
    })

    it('leaves the table on Tab out of the last cell when not set', async () => {
      const ed = await mountEditor(root, withSettings({}).host)
      const last = cell(5, 'notes')
      last.focus()
      key(last, 'Enter')
      key(last.querySelector('input')!, 'Tab')
      expect(ed.model().rows).toHaveLength(5)
    })

    it('tints each changed cell when set, and only the row edge when not', async () => {
      await mountEditor(root, withSettings({}).host)
      edit(1, 'translation', 'eğitim')
      expect(cell(1, 'translation').classList.contains('ge-cell-changed')).toBe(true)
      expect(cell(1, 'notes').classList.contains('ge-cell-changed')).toBe(false)
      document.body.innerHTML = '<div id="root"></div>'
      root = document.getElementById('root')!
      await mountEditor(root, withSettings({ markCells: false }).host)
      edit(1, 'translation', 'eğitim')
      expect(cell(1, 'translation').classList.contains('ge-cell-changed')).toBe(false)
      expect(cell(1, 'term').classList.contains('ge-changed')).toBe(true)
    })

    it('says so when the host cannot keep a setting', async () => {
      await mountEditor(root, fakeHost({}, { settings: { load: async () => undefined, save: async () => 'Settings are not kept.' } }))
      header('Term').querySelector('button')!.click()
      await flush()
      expect(norm(root.querySelector('.ge-status')?.textContent)).toBe('Settings are not kept.')
    })
  })
})
