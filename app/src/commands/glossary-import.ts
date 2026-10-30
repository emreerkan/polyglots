import { readFile } from 'node:fs/promises'
import type Database from 'better-sqlite3'
import { normaliseGlossaryRow, readGlossaryCsv } from '../glossary/csv.js'
import { problemLines } from '../glossary/editor/server.js'
import { openDb } from '../storage/db.js'
import { glossaryStamp, importGlossaryRows } from '../storage/glossary-edits.js'
import type { Locale } from '../types.js'
import { resolveLocale, splitLocale } from '../wporg/locales.js'

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
  // Set when --locale overrode a header that names another locale.
  notice?: string
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
 * means it, and as there the mismatch is said rather than kept quiet: it more
 * often means the wrong file or the wrong flag. Only a different slug is a
 * mismatch, since GlotPress writes nl/formal's export as plain nl.
 *
 * A CSV with any problem the editor would show is refused whole, with every
 * problem row named, before polyglots.db is opened. Importing the good rows
 * and skipping the rest would replace a term's wp.org rows with a partial set.
 */
export async function importGlossaryCsv(opts: ImportGlossaryOptions): Promise<ImportGlossaryResult> {
  const { file } = opts
  const csv = readGlossaryCsv(await readFile(file, 'utf8'))
  // Normalised before the problems are looked for, so a cell of spaces is
  // refused as empty rather than imported as a term nobody can match.
  const rows = csv.rows.map(normaliseGlossaryRow)
  const problems = problemLines(rows)
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
  const header = resolveLocale(csv.headerLocale)
  const notice =
    opts.locale !== undefined && header?.slug !== splitLocale(opts.locale).slug
      ? `The file's header says "${csv.headerLocale}", but the import uses ${opts.locale} as asked.`
      : undefined
  const db = opts.db ?? openDb()
  try {
    // The stamp is read inside the import's transaction, not before it. Read
    // outside, a sync landing between the two would fail the import with the
    // editor's "since this page was opened; reload", which means nothing to
    // a command that has no page. Inside, nothing can come between them.
    const counts = db.transaction(() => importGlossaryRows(db, locale, rows, glossaryStamp(db, locale)))()
    return { file, locale, ...counts, ...(notice === undefined ? {} : { notice }) }
  } finally {
    if (opts.db === undefined) db.close()
  }
}
