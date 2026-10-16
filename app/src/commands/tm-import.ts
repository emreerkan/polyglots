import { readFile } from 'node:fs/promises'
import type Database from 'better-sqlite3'
import { openDb, upsertTm } from '../storage/index.js'
import { loadPo } from '../po/po-file.js'
import { decodeXml, loadTmx } from '../tmx/parse.js'
import { parseLocaleArg } from '../cli/args.js'
import type { Locale, TmEntry } from '../types.js'

export interface TmImportProgress {
  file: string
  entries: number
  upserted: number
}

export interface TmImportOptions {
  locale: Locale
  project?: string
  db?: Database.Database
  onProgress?: (e: TmImportProgress) => void
}

export interface TmImportResult {
  files: number
  entries: number
  upserted: number
}

export async function importTmx(files: string[], opts: TmImportOptions): Promise<TmImportResult> {
  // Resolved here, not only by the CLI, because every caller has to get it
  // right and the menu passes defaultLocale as it was typed. Review and
  // translate look the memory up by the wp.org id (tr, nl/formal), with =.
  // Lowercasing what was typed filed tr_TR under tr-tr, where no lookup goes:
  // the import reported success and the memory stayed empty. An unknown
  // locale is refused for the same reason, before a db is opened: rows under
  // a key nothing reads are worse than an error, in the one database that
  // cannot be regenerated.
  const locale = parseLocaleArg(opts.locale)
  const result: TmImportResult = { files: 0, entries: 0, upserted: 0 }
  if (files.length === 0) return result

  const ownsDb = opts.db === undefined
  const db = opts.db ?? openDb()
  try {
    for (const file of files) {
      const entries = await loadFile(file, locale, opts.project)
      const upserted = upsertTm(db, entries)
      result.files += 1
      result.entries += entries.length
      result.upserted += upserted
      opts.onProgress?.({ file, entries: entries.length, upserted })
    }
  } finally {
    if (ownsDb) db.close()
  }
  return result
}

/**
 * Reads a memory export, whichever of the two shapes it is.
 *
 * TMX is what PoEdit exports. A `.po` is what translate.wordpress.org exports,
 * and a locale team's approved work arrives that way: 66 project exports carry
 * 69,302 approved Turkish strings between them. Converting each one to TMX
 * first is a step with nothing to decide in it.
 *
 * Chosen by what the file holds rather than by its name, because an export
 * saved under the wrong extension is a likelier accident than a file that lies
 * about its own first bytes.
 */
async function loadEntries(file: string, targetLocale: Locale, project?: string): Promise<TmEntry[]> {
  const text = decodeXml(await readFile(file))
  if (text.includes('<tmx')) return loadTmx(file, { targetLocale, project })
  if (!/^msgid\s/m.test(text)) throw new Error('not a TMX or .po catalogue')
  return poEntries(file, targetLocale, project)
}

/**
 * The translated entries of a `.po`, as memory rows.
 *
 * Fuzzy and untranslated entries are left out: neither is approved, and the
 * memory's whole claim is that its rows are. An export filtered to current
 * strings carries neither, but a file saved from an editor will.
 *
 * A plural entry becomes two rows, one per source form, because the memory
 * holds one string per source and `translate` reads a plural back by looking up
 * each form separately. Only when the catalogue declares two forms, though.
 * With three, msgstr[1] is Russian's "few" and not the plural of the source,
 * and storing it as the translation of msgid_plural taught the memory a wrong
 * wording; with one, or with no header to say, there is no form that is the
 * plural. `translate` reads plurals back only for two forms, so this writes
 * exactly what can be read.
 */
async function poEntries(file: string, locale: Locale, project?: string): Promise<TmEntry[]> {
  const po = await loadPo(file)
  const rows: TmEntry[] = []
  const twoForms = po.declaredNplurals === 2
  for (const entry of po.auditEntries()) {
    if (entry.fuzzy) continue
    const forms = [
      { source: entry.msgid, target: entry.msgstr[0] },
      ...(entry.msgidPlural === undefined || !twoForms ? [] : [{ source: entry.msgidPlural, target: entry.msgstr[1] }]),
    ]
    for (const { source, target } of forms) {
      if (!target || target.trim() === '') continue
      rows.push({
        source,
        target,
        locale,
        ...(entry.msgctxt === undefined ? {} : { context: entry.msgctxt }),
        ...(project === undefined ? {} : { project }),
      })
    }
  }
  return rows
}

async function loadFile(file: string, targetLocale: Locale, project?: string) {
  try {
    return await loadEntries(file, targetLocale, project)
  } catch (err) {
    if (isFsErrorFor(err, file)) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to import ${file}: ${message}`, { cause: err })
  }
}

// fs errors already carry the offending path in their message; wrapping would print it twice.
function isFsErrorFor(err: unknown, file: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).path === file
}
