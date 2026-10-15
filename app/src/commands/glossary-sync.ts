import type Database from 'better-sqlite3'
import type { GlossaryEntry, Locale } from '../types.js'
import { openDb, replaceGlossary } from '../storage/index.js'
import { fetchGlossary, type FetchPage } from '../wporg/glossary.js'

export interface SyncGlossaryOptions {
  locale: Locale
  db?: Database.Database
  fetch?: FetchPage
}

export interface SyncGlossaryResult {
  entries: number
}

function store(locale: Locale, entries: GlossaryEntry[], injected?: Database.Database): void {
  if (injected) {
    replaceGlossary(injected, locale, entries)
    return
  }
  const db = openDb()
  try {
    replaceGlossary(db, locale, entries)
  } finally {
    db.close()
  }
}

export async function syncGlossary(opts: SyncGlossaryOptions): Promise<SyncGlossaryResult> {
  const entries = await fetchGlossary(opts.locale, opts.fetch)
  if (entries.length === 0) {
    throw new Error(`No glossary entries found for locale "${opts.locale}"; existing cache left untouched`)
  }
  store(opts.locale, entries, opts.db)
  return { entries: entries.length }
}
