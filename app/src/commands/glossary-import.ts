import { readFile } from 'node:fs/promises'
import type Database from 'better-sqlite3'
import { readGlossaryCsv } from '../glossary/csv.js'
import { problemLines } from '../glossary/editor/server.js'
import { openDb } from '../storage/db.js'
import { glossaryStamp, importGlossaryRows } from '../storage/glossary-edits.js'
import type { Locale } from '../types.js'
import { resolveLocale } from '../wporg/locales.js'

export interface ImportGlossaryOptions {
  file: string
  // The glossary to import into. Absent, the CSV's header names it.
  locale?: Locale
  db?: Database.Database
}

export interface ImportGlossaryResult {
  file: string
  locale: Locale
  replaced: number
  added: number
}

export const importedLine = (r: ImportGlossaryResult): string =>
  `Imported ${r.file}: ${r.replaced} terms replaced, ${r.added} added, as local edits for ${r.locale}. ` +
  'Discard them in polyglots glossary edit.'

/**
 * Loads a reviewed CSV (a project terminology) into the polyglots glossary as
 * local edits, the CSV's term winning; importGlossaryRows has the rule.
 *
 * The locale is the one asked for, else the header's. Not the configured one
 * before the header: a CSV says which language it holds, and importing a
 * German terminology into the Turkish glossary because that is the default
 * would put German into Turkish prompts. A locale named on the command line
 * still wins over the header, as it does in the editor, for the person who
 * means it (nl/formal, which GlotPress writes as plain nl).
 *
 * A CSV with any problem the editor would show is refused whole, with every
 * problem row named, before polyglots.db is opened. Importing the good rows
 * and skipping the rest would replace a term's wp.org rows with a partial set.
 */
export async function importGlossaryCsv(opts: ImportGlossaryOptions): Promise<ImportGlossaryResult> {
  const { file } = opts
  const csv = readGlossaryCsv(await readFile(file, 'utf8'))
  const problems = problemLines(csv.rows)
  if (problems.length > 0) {
    throw new Error(
      `${file} has problems, so nothing was imported. Rows are counted from the first one after the header:\n` +
        problems.map((line) => `  ${line}`).join('\n'),
    )
  }
  const locale = opts.locale ?? resolveLocale(csv.headerLocale)?.id
  if (locale === undefined) {
    throw new Error(`The header of ${file} names "${csv.headerLocale}", which is not a wp.org locale. Name one with --locale.`)
  }
  const db = opts.db ?? openDb()
  try {
    const counts = importGlossaryRows(db, locale, csv.rows, glossaryStamp(db, locale))
    return { file, locale, ...counts }
  } finally {
    if (opts.db === undefined) db.close()
  }
}
