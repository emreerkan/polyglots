import type { GlossaryEntry, Locale } from '../types.js'
import type { GlossaryRow } from './types.js'

export type { GlossaryRow }

/**
 * Parts of speech GlotPress offers, in the order its own form lists them. The
 * editor's dropdown reads this, so the order is the order users see.
 */
export const GLOSSARY_POS = [
  'noun',
  'verb',
  'adjective',
  'adverb',
  'interjection',
  'conjunction',
  'preposition',
  'pronoun',
  'expression',
  'abbreviation',
] as const

export type GlossaryPos = (typeof GLOSSARY_POS)[number]

/**
 * This module is loaded by the editor page in the browser, so it imports
 * nothing from node:* and only types from the rest of the app.
 */
export class GlossaryCsvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GlossaryCsvError'
  }
}

export const normaliseGlossaryValue = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * A row as the editor would hold it had each cell been typed: every field
 * trimmed and its runs of whitespace collapsed. The reader keeps a CSV's cells
 * as written, so an export round-trips byte for byte; anything that writes
 * rows into the glossary runs them through this first, or a whitespace-only
 * term passes as present and a padded one sits beside the wp.org row it was
 * meant to replace.
 */
export const normaliseGlossaryRow = (r: GlossaryRow): GlossaryRow => ({
  term: normaliseGlossaryValue(r.term),
  pos: normaliseGlossaryValue(r.pos),
  translation: normaliseGlossaryValue(r.translation),
  notes: normaliseGlossaryValue(r.notes),
})

/**
 * The records of an RFC 4180 file: quoted fields may hold commas, line breaks
 * and doubled quotes. Small enough to keep rather than add a dependency for
 * one four-column file.
 */
export function csvRecords(text: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c !== '"') field += c
      else if (text[i + 1] === '"') {
        field += '"'
        i++
      } else quoted = false
    } else if (c === '"') quoted = true
    else if (c === ',') {
      record.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      record.push(field)
      records.push(record)
      record = []
      field = ''
    } else field += c
  }
  if (field !== '' || record.length > 0) {
    record.push(field)
    records.push(record)
  }
  return records
}

/**
 * A glossary export read for editing. Unlike parseGlossaryCsv, which feeds
 * the translator and so drops rows it cannot use and collapses whitespace,
 * this keeps every row, empty fields included, and every value as written: an
 * editor that silently dropped a half-finished row, or tidied a value the user
 * did not touch, would change a file behind their back on save.
 *
 * The locale column's name is returned because it is the only place the file
 * says which glossary it is, and writing it back must reproduce it. A first
 * header cell other than "en" means this is not an export (a login page that
 * answered 200, or someone else's CSV), so it throws rather than returning no
 * rows that a save would then treat as an emptied glossary.
 */
export function readGlossaryCsv(text: string): { headerLocale: string; rows: GlossaryRow[] } {
  const [header, ...records] = csvRecords(text.replace(/^﻿/, ''))
  if (!header || normaliseGlossaryValue(header[0] ?? '').toLowerCase() !== 'en') {
    throw new GlossaryCsvError('Not a glossary export: the first column must be "en".')
  }
  const rows: GlossaryRow[] = []
  for (const r of records) {
    // A blank line comes back as a single empty cell. It is not a row.
    if (r.length === 1 && r[0] === '') continue
    rows.push({ term: r[0] ?? '', translation: r[1] ?? '', pos: r[2] ?? '', notes: r[3] ?? '' })
  }
  return { headerLocale: normaliseGlossaryValue(header[1] ?? ''), rows }
}

// Quote only when RFC 4180 requires it, so an untouched row writes the same
// bytes GlotPress would and a diff of the file shows only real edits.
const field = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value

/** The inverse of readGlossaryCsv: LF line ends, no BOM, header en,<locale>,pos,description. */
export function formatGlossaryCsv(rows: GlossaryRow[], headerLocale: string): string {
  const lines = [`en,${field(headerLocale)},pos,description`]
  for (const r of rows) lines.push([r.term, r.translation, r.pos, r.notes].map(field).join(','))
  return lines.join('\n') + '\n'
}

export function rowToEntry(row: GlossaryRow, locale: Locale): GlossaryEntry {
  const entry: GlossaryEntry = { locale, sourceTerm: row.term, translation: row.translation }
  if (row.pos) entry.partOfSpeech = row.pos
  if (row.notes) entry.notes = row.notes
  return entry
}

export function entryToRow(e: GlossaryEntry): GlossaryRow {
  return { term: e.sourceTerm, pos: e.partOfSpeech ?? '', translation: e.translation, notes: e.notes ?? '' }
}
