import type Database from 'better-sqlite3'
import type { GlossaryEntry, Locale } from '../types.js'

interface GlossaryRow {
  locale: string
  source_term: string
  translation: string
  part_of_speech: string | null
  notes: string | null
}

function toEntry(row: GlossaryRow): GlossaryEntry {
  const entry: GlossaryEntry = { locale: row.locale, sourceTerm: row.source_term, translation: row.translation }
  if (row.part_of_speech !== null) entry.partOfSpeech = row.part_of_speech
  if (row.notes !== null) entry.notes = row.notes
  return entry
}

export function replaceGlossary(db: Database.Database, locale: Locale, entries: GlossaryEntry[]): void {
  const del = db.prepare('DELETE FROM glossary WHERE locale = ?')
  const ins = db.prepare(`
    INSERT INTO glossary (locale, source_term, translation, part_of_speech, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const updatedAt = new Date().toISOString()
  db.transaction(() => {
    del.run(locale)
    for (const e of entries) {
      ins.run(locale, e.sourceTerm, e.translation, e.partOfSpeech ?? null, e.notes ?? null, updatedAt)
    }
  })()
}

export function allGlossary(db: Database.Database, locale: Locale): GlossaryEntry[] {
  return db
    .prepare<[string], GlossaryRow>(
      `SELECT locale, source_term, translation, part_of_speech, notes FROM glossary
       WHERE locale = ? ORDER BY source_term COLLATE NOCASE, part_of_speech, id`,
    )
    .all(locale)
    .map(toEntry)
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export function lookupGlossary(db: Database.Database, term: string, locale: Locale): GlossaryEntry[] {
  const trimmed = term.trim()
  if (trimmed.length === 0) return []
  const exact = db
    .prepare<[string, string], GlossaryRow>(
      `SELECT locale, source_term, translation, part_of_speech, notes FROM glossary
       WHERE locale = ? AND source_term = ? COLLATE NOCASE ORDER BY id`,
    )
    .all(locale, trimmed)
  const partial = db
    .prepare<[string, string, string], GlossaryRow>(
      `SELECT locale, source_term, translation, part_of_speech, notes FROM glossary
       WHERE locale = ? AND source_term LIKE ? ESCAPE '\\' AND source_term <> ? COLLATE NOCASE
       ORDER BY length(source_term), id`,
    )
    .all(locale, `%${escapeLike(trimmed)}%`, trimmed)
  return [...exact, ...partial].map(toEntry)
}

/**
 * When each locale's glossary was last synced, as epoch milliseconds. A sync
 * replaces every row of the locale with one timestamp, so the newest row is
 * the sync. The freshness check compares it with wp.org's Last-Modified, and
 * needs no table of its own in a database that cannot be regenerated.
 */
export function glossarySyncTimes(db: Database.Database): Array<{ locale: string; syncedAt: number }> {
  return db
    .prepare<[], { locale: string; synced: string }>('SELECT locale, max(updated_at) AS synced FROM glossary GROUP BY locale')
    .all()
    .map((r) => ({ locale: r.locale, syncedAt: Date.parse(r.synced) }))
    .filter((r) => Number.isFinite(r.syncedAt))
}
