import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type Database from 'better-sqlite3'
import type { GlossaryEntry, Locale } from '../types.js'
import { effectiveEntries, openDb } from '../storage/index.js'

export type CsvDelimiter = ';' | ','

export interface ExportGlossaryOptions {
  locale: Locale
  file?: string
  delimiter?: CsvDelimiter
  db?: Database.Database
}

export interface ExportGlossaryResult {
  entries: number
  csv: string
  file?: string
}

// Poedit reads the file through a GUI importer, so it is written UTF-8 with a BOM: the
// header row absorbs the BOM if the importer does not strip it, and Turkish characters
// can never be sniffed as Latin-1.
const BOM = '﻿'

function field(value: string, delimiter: CsvDelimiter): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return /["\n\r,;]/.test(clean) ? `"${clean.replace(/"/g, '""')}"` : clean
}

function notesFor(entry: GlossaryEntry): string {
  const pos = entry.partOfSpeech?.trim()
  const note = entry.notes?.trim()
  if (pos && note) return `[${pos}] ${note}`
  return pos ? `[${pos}]` : (note ?? '')
}

function toCsv(entries: GlossaryEntry[], delimiter: CsvDelimiter): string {
  const rows = [['Term', 'Translation', 'Notes'].join(delimiter)]
  for (const entry of entries) {
    const term = entry.sourceTerm.trim()
    const translation = entry.translation.trim()
    if (!term || !translation) continue
    rows.push([field(term, delimiter), field(translation, delimiter), field(notesFor(entry), delimiter)].join(delimiter))
  }
  return `${BOM}${rows.join('\n')}\n`
}

function read(locale: Locale, injected?: Database.Database): GlossaryEntry[] {
  if (injected) return effectiveEntries(injected, locale)
  const db = openDb()
  try {
    return effectiveEntries(db, locale)
  } finally {
    db.close()
  }
}

export async function exportGlossary(opts: ExportGlossaryOptions): Promise<ExportGlossaryResult> {
  const entries = read(opts.locale, opts.db)
  if (entries.length === 0) {
    throw new Error(`No cached glossary for locale "${opts.locale}"; run: polyglots glossary sync --locale ${opts.locale}`)
  }

  const csv = toCsv(entries, opts.delimiter ?? ';')
  if (!opts.file) return { entries: entries.length, csv }

  await mkdir(dirname(opts.file), { recursive: true })
  await writeFile(opts.file, csv, 'utf8')
  return { entries: entries.length, csv, file: opts.file }
}
