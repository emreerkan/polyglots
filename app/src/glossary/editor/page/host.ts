import type { EffectiveRow, GlossaryRow } from '../../types.js'
import type { EditorModel } from '../model.js'

/**
 * What the editor is opened on. `rows` are effective rows in polyglots mode
 * (db) and plain rows for a CSV; `stamp` is the freshness token a db save
 * hands back, so a page loaded before a sync cannot overwrite it. `sidecar`
 * is the raw analysis JSON, read by readSidecar on the page rather than by the
 * host, so the local server and the website show the same notice for a bad one.
 */
export interface LoadedGlossary {
  mode: 'db' | 'csv'
  locale: string
  headerLocale?: string
  notice?: string
  file?: string
  rows: Array<EffectiveRow | GlossaryRow>
  stamp?: string
  sidecar?: unknown
}

export type SaveResult = { ok: true; stamp?: string } | { ok: false; reason: 'stale' | 'problems' | 'error'; message: string }

/**
 * Everything the page needs from where it runs. The local server and the
 * website differ only here: one loads and saves over fetch, the other reads
 * dropped files and downloads an export. Optional members are features a host
 * may not have; the page shows the matching control only when it is present.
 */
export interface EditorHost {
  load(): Promise<LoadedGlossary>
  save(m: EditorModel, stamp?: string): Promise<SaveResult>
  discard?(stamp: string): Promise<SaveResult>
  saveLabel: 'Save' | 'Export'
  openFile?(): Promise<LoadedGlossary | undefined>
  openSidecar?(): Promise<unknown>
  persist?(m: EditorModel): void
  close?(): void
}
