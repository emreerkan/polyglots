import { GlossaryCsvError, formatGlossaryCsv, readGlossaryCsv } from '../../../../app/src/glossary/csv.js'
import { currentRows, type EditorModel, type EditorRow } from '../../../../app/src/glossary/editor/model.js'
import type { EditorHost, LoadedGlossary } from '../../../../app/src/glossary/editor/page/host.js'
import type { EffectiveRow, GlossaryRow } from '../../../../app/src/glossary/types.js'
import { resolveLocale } from '../../../../app/src/wporg/locales.js'

/**
 * The editor's host on the website: no server, so a file is read from the
 * person's disk, saving is a download, and work in progress waits in
 * localStorage. Nothing here touches the DOM or the network; everything that
 * does comes in through WebEnv, so the host runs under node:test with fakes.
 *
 * Only a CSV can be edited here. The website has no polyglots database, so
 * there is no db mode, no discard and no import: opening a file is the import.
 */

export const STORAGE_KEY = 'polyglots-glossary-editor'

/**
 * The work kept between visits: the whole table, not just its current values.
 * Each row carries the value it was opened with, and the change list is
 * computed against that, so keeping only the current values would turn every
 * edit made before the tab closed into part of the original, and the list a
 * reviewer checks before importing would silently come back shorter.
 */
export interface Saved {
  locale: string
  file?: string
  model: EditorModel
}

/** What the person chose on the start screen. */
export type Start =
  | { kind: 'saved' }
  | { kind: 'new'; locale: string }
  | { kind: 'file'; name: string; text: string }

export interface WebEnv {
  /** Undefined when the browser refuses storage at all; the page works without it. */
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined
  /** Shows the start screen and resolves with the choice. `saved` is offered as "continue". */
  start(saved: Saved | undefined): Promise<Start>
  download(name: string, text: string): void
  /** A file picked from disk, or undefined when the picker was cancelled. */
  pick(accept: string): Promise<{ name: string; text: string } | undefined>
  /**
   * The locale of an opened file whose header names none, or one wp.org does
   * not list, asked with the picker New uses. Undefined when the person
   * declines, and the file is then not opened.
   */
  askLocale(file: string, header: string): Promise<string | undefined>
}

/** The glossary export GlotPress offers for a locale, the file a person starts from. */
export const exportUrl = (slug: string): string => `https://translate.wordpress.org/locale/${slug}/default/glossary/-export/`

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const ORIGINS = ['wporg', 'changed', 'added']

function plainRow(v: unknown): GlossaryRow | undefined {
  if (!isObject(v)) return undefined
  const { term, pos, translation, notes } = v
  if (typeof term !== 'string' || typeof pos !== 'string' || typeof translation !== 'string' || typeof notes !== 'string') return undefined
  return { term, pos, translation, notes }
}

function effectiveRow(v: unknown): EffectiveRow | undefined {
  const row = plainRow(v)
  if (!row || !isObject(v) || typeof v.origin !== 'string' || !ORIGINS.includes(v.origin)) return undefined
  const origin = v.origin as EffectiveRow['origin']
  if (v.base === undefined) return { ...row, origin }
  const base = plainRow(v.base)
  return base ? { ...row, origin, base } : undefined
}

function editorRow(v: unknown): EditorRow | undefined {
  const row = plainRow(v)
  if (!row || !isObject(v) || typeof v.id !== 'number' || !Number.isInteger(v.id) || typeof v.deleted !== 'boolean') return undefined
  if (typeof v.origin !== 'string' || ![...ORIGINS, 'new'].includes(v.origin)) return undefined
  const out: EditorRow = { ...row, id: v.id, origin: v.origin as EditorRow['origin'], deleted: v.deleted }
  if (v.base !== undefined) {
    const base = plainRow(v.base)
    if (!base) return undefined
    out.base = base
  }
  if (v.loaded !== undefined) {
    const loaded = effectiveRow(v.loaded)
    if (!loaded) return undefined
    out.loaded = loaded
  }
  return out
}

/**
 * What storage held, or undefined when it is not work this page wrote. The
 * value can be anything an older version of the page or a hand edit left, so
 * it is checked whole: a table with one odd row is dropped rather than
 * repaired, because a repaired row would be exported as if the person typed it.
 */
export function restoreSaved(raw: unknown): Saved | undefined {
  if (!isObject(raw) || typeof raw.locale !== 'string' || !isObject(raw.model) || raw.model.mode !== 'csv' || !Array.isArray(raw.model.rows)) {
    return undefined
  }
  const rows: EditorRow[] = []
  const ids = new Set<number>()
  for (const r of raw.model.rows) {
    const row = editorRow(r)
    if (!row || ids.has(row.id)) return undefined
    ids.add(row.id)
    rows.push(row)
  }
  return { locale: raw.locale, ...(typeof raw.file === 'string' ? { file: raw.file } : {}), model: { mode: 'csv', rows } }
}

function readStored(storage: WebEnv['storage']): Saved | undefined {
  if (!storage) return undefined
  try {
    const text = storage.getItem(STORAGE_KEY)
    if (text === null) return undefined
    let saved: Saved | undefined
    try {
      saved = restoreSaved(JSON.parse(text))
    } catch {
      saved = undefined
    }
    // A value that cannot be used is removed, so the next visit does not offer
    // to continue from it again.
    if (!saved) storage.removeItem(STORAGE_KEY)
    return saved
  } catch {
    return undefined
  }
}

const NOT_KEPT = 'This browser is not keeping your work. Export before you close the tab.'

export function webHost(env: WebEnv): EditorHost {
  let locale = ''
  let file: string | undefined
  // The CSV last exported. persist() runs after the editor rebases on a save,
  // and without this it would store the work that was just exported, so the
  // next visit would offer to continue something already delivered.
  let exported: string | undefined
  let wrote = false

  const csvOf = (m: EditorModel): string => formatGlossaryCsv(currentRows(m), locale)

  return {
    saveLabel: 'Export',

    async load(): Promise<LoadedGlossary> {
      const choice = await env.start(readStored(env.storage))
      if (choice.kind === 'new') {
        locale = choice.locale
        file = undefined
        return { mode: 'csv', locale, headerLocale: locale, rows: [] }
      }
      if (choice.kind === 'file') {
        const read = readGlossaryCsv(choice.text)
        // The export writes the header back, so a header with no locale or an
        // unknown one would come out as "en,,pos,description" or as the same
        // unknown name, which neither GlotPress nor polyglots can import. A
        // header that resolves is kept as written, so the file round-trips.
        if (resolveLocale(read.headerLocale)) {
          locale = read.headerLocale
        } else {
          const asked = await env.askLocale(choice.name, read.headerLocale)
          if (asked === undefined) {
            throw new GlossaryCsvError(
              read.headerLocale === ''
                ? `${choice.name}'s header names no locale. Choose its locale to open it.`
                : `${choice.name}'s header names "${read.headerLocale}", which is not a wp.org locale. Choose its locale to open it.`,
            )
          }
          locale = asked
        }
        file = choice.name
        return { mode: 'csv', locale, headerLocale: locale, file, rows: read.rows }
      }
      const saved = readStored(env.storage)
      if (!saved) throw new GlossaryCsvError('The saved work is no longer there.')
      locale = saved.locale
      // Continuing makes this session the owner of the stored work, so its
      // export is what clears it.
      wrote = true
      file = saved.file
      return {
        mode: 'csv',
        locale,
        headerLocale: locale,
        ...(file === undefined ? {} : { file }),
        rows: currentRows(saved.model),
        model: saved.model,
      }
    },

    async save(m) {
      const text = csvOf(m)
      env.download(file ?? `glossary-${locale || 'new'}.csv`, text)
      exported = text
      // Only work this session wrote is cleared: someone who chose New or Open
      // while saved work was waiting, and exported before editing, has not
      // delivered that older work.
      if (wrote) {
        try {
          env.storage?.removeItem(STORAGE_KEY)
          wrote = false
        } catch {
          // Storage is a convenience; a refusal changes nothing the person sees.
        }
      }
      return { ok: true }
    },

    async openSidecar() {
      const picked = await env.pick('.json,application/json')
      return picked ? JSON.parse(picked.text) : undefined
    },

    // Runs on the person's first edit, not at load, so choosing New or Open
    // while saved work is offered leaves that work in place until something
    // is actually changed. The string it returns is the page's warning.
    persist(m) {
      if (!env.storage) return NOT_KEPT
      try {
        if (csvOf(m) === exported) {
          if (wrote) env.storage.removeItem(STORAGE_KEY)
          wrote = false
          return
        }
        const saved: Saved = { locale, ...(file === undefined ? {} : { file }), model: { mode: 'csv', rows: m.rows } }
        env.storage.setItem(STORAGE_KEY, JSON.stringify(saved))
        wrote = true
      } catch {
        // Private window, storage blocked or full: say so, since a closed tab
        // would otherwise lose the work without a word.
        return NOT_KEPT
      }
    },
  }
}
