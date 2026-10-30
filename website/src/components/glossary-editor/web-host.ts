import { GlossaryCsvError, formatGlossaryCsv, readGlossaryCsv } from '../../../../app/src/glossary/csv.js'
import { currentRows, type EditorModel } from '../../../../app/src/glossary/editor/model.js'
import type { EditorHost, LoadedGlossary } from '../../../../app/src/glossary/editor/page/host.js'
import type { GlossaryRow } from '../../../../app/src/glossary/types.js'

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

/** The work kept between visits: the table as it stood, and which file it came from. */
export interface Saved {
  locale: string
  file?: string
  rows: GlossaryRow[]
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
}

/** The glossary export GlotPress offers for a locale, the file a person starts from. */
export const exportUrl = (slug: string): string => `https://translate.wordpress.org/locale/${slug}/default/glossary/-export/`

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * What storage held, or undefined when it is not work this page wrote. The
 * value can be anything an older version of the page or a hand edit left, so
 * it is checked whole: a table with one odd row is dropped rather than
 * repaired, because a repaired row would be exported as if the person typed it.
 */
export function restoreSaved(raw: unknown): Saved | undefined {
  if (!isObject(raw) || typeof raw.locale !== 'string' || !Array.isArray(raw.rows)) return undefined
  const rows: GlossaryRow[] = []
  for (const r of raw.rows) {
    if (!isObject(r)) return undefined
    const { term, pos, translation, notes } = r
    if (typeof term !== 'string' || typeof pos !== 'string' || typeof translation !== 'string' || typeof notes !== 'string') return undefined
    rows.push({ term, pos, translation, notes })
  }
  return { locale: raw.locale, ...(typeof raw.file === 'string' ? { file: raw.file } : {}), rows }
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

export function webHost(env: WebEnv): EditorHost {
  let locale = ''
  let file: string | undefined
  // The CSV last exported. persist() runs after the editor rebases on a save,
  // and without this it would store the work that was just exported, so the
  // next visit would offer to continue something already delivered.
  let exported: string | undefined

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
        locale = read.headerLocale
        file = choice.name
        return { mode: 'csv', locale, headerLocale: locale, file, rows: read.rows }
      }
      const saved = readStored(env.storage)
      if (!saved) throw new GlossaryCsvError('The saved work is no longer there.')
      locale = saved.locale
      file = saved.file
      return { mode: 'csv', locale, headerLocale: locale, ...(file === undefined ? {} : { file }), rows: saved.rows }
    },

    async save(m) {
      const text = csvOf(m)
      env.download(file ?? `glossary-${locale || 'new'}.csv`, text)
      exported = text
      try {
        env.storage?.removeItem(STORAGE_KEY)
      } catch {
        // Storage is a convenience; a refusal changes nothing the person sees.
      }
      return { ok: true }
    },

    async openSidecar() {
      const picked = await env.pick('.json,application/json')
      return picked ? JSON.parse(picked.text) : undefined
    },

    persist(m) {
      if (!env.storage) return
      try {
        // An empty new table is not work worth offering to continue.
        if (csvOf(m) === exported || (file === undefined && currentRows(m).length === 0)) {
          env.storage.removeItem(STORAGE_KEY)
          return
        }
        const saved: Saved = { locale, ...(file === undefined ? {} : { file }), rows: currentRows(m) }
        env.storage.setItem(STORAGE_KEY, JSON.stringify(saved))
      } catch {
        // Private window or storage blocked: only a reload loses the work.
      }
    },
  }
}
