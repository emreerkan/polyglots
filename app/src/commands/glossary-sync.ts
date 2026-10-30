import type Database from 'better-sqlite3'
import type { GlossaryEntry, Locale } from '../types.js'
import { openDb, replaceGlossary } from '../storage/index.js'
import { countGlossaryEdits, type RemovedEdit } from '../storage/glossary-edits.js'
import { fetchGlossary, type FetchPage } from '../wporg/glossary.js'

export type { RemovedEdit } from '../storage/glossary-edits.js'

export interface SyncGlossaryOptions {
  locale: Locale
  db?: Database.Database
  fetch?: FetchPage
}

export interface SyncGlossaryResult {
  entries: number
  /** Local edits still in place after the sync. */
  kept: number
  /** Local edits the sync removed because wp.org changed what they were made against. */
  removed: RemovedEdit[]
}

type Stored = Pick<SyncGlossaryResult, 'kept' | 'removed'>

function write(db: Database.Database, locale: Locale, entries: GlossaryEntry[]): Stored {
  const removed = replaceGlossary(db, locale, entries)
  return { kept: countGlossaryEdits(db, locale), removed }
}

function store(locale: Locale, entries: GlossaryEntry[], injected?: Database.Database): Stored {
  if (injected) return write(injected, locale, entries)
  const db = openDb()
  try {
    return write(db, locale, entries)
  } finally {
    db.close()
  }
}

export async function syncGlossary(opts: SyncGlossaryOptions): Promise<SyncGlossaryResult> {
  const entries = await fetchGlossary(opts.locale, opts.fetch)
  if (entries.length === 0) {
    throw new Error(`No glossary entries found for locale "${opts.locale}"; existing cache left untouched`)
  }
  return { entries: entries.length, ...store(opts.locale, entries, opts.db) }
}

/** The sync's one-line summary, shared by the CLI and the TUI so the two say the same thing. */
export function syncedLine(result: SyncGlossaryResult, locale: Locale): string {
  const edits = result.kept === 1 ? 'local edit' : 'local edits'
  return `Synced ${result.entries} glossary entries for ${locale}; kept ${result.kept} ${edits}.`
}

/**
 * One removed edit, local version against wp.org's. A delete has no local
 * translation, so it reads as "deleted"; wp.org lists every translation the
 * term and part of speech now have. When wp.org dropped the term the list is
 * empty, and an empty list printed as is leaves the line ending on "wp.org: ",
 * which reads as output cut short; "(none)" says the term is gone. GlotPress
 * exports plenty of rows with no part of speech, and "post ()" reads as a
 * formatting slip, so an empty one is left out rather than bracketed.
 */
export function removedEditLine(r: RemovedEdit): string {
  const local = r.local?.translation ?? 'deleted'
  const name = r.pos === '' ? r.term : `${r.term} (${r.pos})`
  const wporg = r.wporg.length === 0 ? '(none)' : r.wporg.map((w) => w.translation).join(', ')
  return `removed local edit: ${name}: ${local} → wp.org: ${wporg}`
}
