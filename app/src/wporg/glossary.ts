import { splitLocale } from './locales.js'
import type { GlossaryEntry, Locale } from '../types.js'
import { fetchHtml } from './http.js'
import { csvRecords, normaliseGlossaryValue as clean } from '../glossary/csv.js'

const ORIGIN = 'https://translate.wordpress.org'

export type FetchPage = (url: string) => Promise<string>

export function glossaryUrl(locale: Locale): string {
  // A variant set has its own glossary: nl/formal differs from nl.
  const { slug, set } = splitLocale(locale)
  return `${ORIGIN}/locale/${encodeURIComponent(slug)}/${encodeURIComponent(set)}/glossary/`
}

/**
 * The glossary as GlotPress exports it: one CSV, with a Last-Modified header
 * the freshness check reads (src/glossary/freshness.ts).
 *
 * This replaced scraping the glossary's HTML pages. Both carried the same
 * entries when compared on the tr glossary, but the page markup is the site's
 * to change and an export format is not, and only the export says when the
 * glossary last changed. The trailing slash matters: without it wp.org answers
 * with a redirect.
 */
export function glossaryExportUrl(locale: Locale): string {
  return `${glossaryUrl(locale)}-export/`
}

/**
 * Every row of a glossary export as an entry, duplicates included.
 *
 * Columns are read by position: the header is en, then the locale's own code
 * (tr, nl, pt-br), then pos and description, so the second name is not a
 * constant to match. The first must be "en", which is what tells an export
 * from a login or error page that came back with a 200: that gives no
 * entries, and sync refuses to replace a glossary with none.
 */
export function parseGlossaryCsv(text: string, locale: Locale): GlossaryEntry[] {
  const [header, ...rows] = csvRecords(text.replace(/^﻿/, ''))
  if (!header || header.length < 3 || clean(header[0] ?? '').toLowerCase() !== 'en') return []

  const entries: GlossaryEntry[] = []
  for (const row of rows) {
    const sourceTerm = clean(row[0] ?? '')
    const translation = clean(row[1] ?? '')
    if (!sourceTerm || !translation) continue
    const partOfSpeech = clean(row[2] ?? '')
    const notes = clean(row[3] ?? '')
    const entry: GlossaryEntry = { locale, sourceTerm, translation }
    if (partOfSpeech) entry.partOfSpeech = partOfSpeech
    if (notes) entry.notes = notes
    entries.push(entry)
  }
  return entries
}

const identity = (e: GlossaryEntry): string =>
  JSON.stringify([e.locale, e.sourceTerm, e.partOfSpeech ?? '', e.translation])

export function dedupeGlossaryEntries(entries: GlossaryEntry[]): GlossaryEntry[] {
  const kept = new Map<string, GlossaryEntry>()
  for (const entry of entries) {
    const key = identity(entry)
    const existing = kept.get(key)
    if (!existing) {
      kept.set(key, { ...entry })
    } else if (!existing.notes && entry.notes) {
      existing.notes = entry.notes
    }
  }
  return [...kept.values()]
}

const fetchCsv: FetchPage = (url) => fetchHtml(url, 'text/csv')

export async function fetchGlossary(locale: Locale, fetch: FetchPage = fetchCsv): Promise<GlossaryEntry[]> {
  return dedupeGlossaryEntries(parseGlossaryCsv(await fetch(glossaryExportUrl(locale)), locale))
}
