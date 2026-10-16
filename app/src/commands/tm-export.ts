import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { po } from 'gettext-parser'
import type { GetTextTranslations } from 'gettext-parser'
import type Database from 'better-sqlite3'
import { openDb } from '../storage/index.js'
import type { Locale } from '../types.js'
import { VERSION } from '../version.js'

export type TmExportFormat = 'tmx' | 'po'

export interface ExportTmOptions {
  locale: Locale
  file?: string
  format?: TmExportFormat
  db?: Database.Database
}

export interface ExportTmResult {
  // Translations written. For `po` this is one per source and context, since
  // that is all the format can hold.
  entries: number
  // Wordings a `po` export could not carry. Always 0 for TMX.
  dropped: number
  text: string
  file?: string
}

interface Row {
  source: string
  target: string
  context: string
  project: string | null
  weight: number
  updated_at: string
}

// TMX is the default because it is the only one of the two that can carry a
// memory whole: a source with several approved wordings is ordinary here, and
// `po` keys its entries by source and context.
function formatFor(file: string | undefined, explicit: TmExportFormat | undefined): TmExportFormat {
  if (explicit) return explicit
  return extname(file ?? '').toLowerCase() === '.po' ? 'po' : 'tmx'
}

const xml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// TMX wants a compact UTC stamp. A row whose date cannot be read keeps the
// attribute off rather than inventing one.
function stamp(updatedAt: string): string {
  const at = new Date(updatedAt)
  if (Number.isNaN(at.getTime())) return ''
  return ` creationdate="${at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}"`
}

// The props are the ones the importer reads back, so a person who imports
// their own export gets the memory they had rather than a flattened one.
// Without x-weight every long-text row came back normal, and the tm-conflict
// noise on readme strings that the weight exists to quiet came back with it;
// without x-context a scoped row came back context-less. TMX wants props
// before the tuvs, and a prop is written only where the row has the value,
// since an absent prop already reads as context-less, no project and normal.
function props(row: Row): string {
  const prop = (type: string, value: string) => `\t\t\t<prop type="${type}">${xml(value)}</prop>\n`
  return (
    (row.context === '' ? '' : prop('x-context', row.context)) +
    (row.project === null || row.project === '' ? '' : prop('x-project', row.project)) +
    (row.weight === 0 ? prop('x-weight', 'low') : '')
  )
}

function toTmx(rows: Row[], locale: Locale, version: string): string {
  const units = rows
    .map(
      (row) =>
        `\t\t<tu${stamp(row.updated_at)}>\n` +
        props(row) +
        `\t\t\t<tuv xml:lang="en">\n\t\t\t\t<seg>${xml(row.source)}</seg>\n\t\t\t</tuv>\n` +
        `\t\t\t<tuv xml:lang="${locale}">\n\t\t\t\t<seg>${xml(row.target)}</seg>\n\t\t\t</tuv>\n` +
        `\t\t</tu>\n`,
    )
    .join('')
  return (
    `<?xml version="1.0"?>\n<tmx version="1.4">\n` +
    `\t<header creationtool="polyglots" creationtoolversion="${version}" datatype="PlainText"` +
    ` segtype="sentence" adminlang="en" srclang="en" o-tmf="PoeditTM" />\n\t<body>\n${units}\t</body>\n</tmx>\n`
  )
}

function toPo(rows: Row[], locale: Locale): string {
  const translations: GetTextTranslations['translations'] = {}
  for (const row of rows) {
    const context = (translations[row.context] ??= {})
    context[row.source] = {
      msgid: row.source,
      msgstr: [row.target],
      ...(row.context === '' ? {} : { msgctxt: row.context }),
    }
  }
  const data: GetTextTranslations = {
    charset: 'utf-8',
    headers: { 'MIME-Version': '1.0', 'Content-Type': 'text/plain; charset=UTF-8', Language: locale },
    translations,
  }
  return po.compile(data).toString('utf8')
}

/**
 * Writes the translation memory out, as TMX or as a `.po`.
 *
 * TMX carries the memory whole. A `.po` cannot: it keys its entries by source
 * and context, so a source with several approved wordings loses all but one.
 * The most recently updated is kept, and `dropped` counts the rest, because an
 * export that quietly holds less than it was asked for is worse than one that
 * says so.
 */
export async function exportTm(opts: ExportTmOptions): Promise<ExportTmResult> {
  const format = formatFor(opts.file, opts.format)
  const ownsDb = opts.db === undefined
  const db = opts.db ?? openDb()
  try {
    const rows = db
      .prepare<[string], Row>(
        `SELECT source, target, context, project, weight, updated_at FROM tm
         WHERE locale = ?
         ORDER BY source, context, updated_at DESC, id DESC`,
      )
      .all(opts.locale)

    const kept = format === 'tmx' ? rows : first(rows)
    const text = format === 'tmx' ? toTmx(kept, opts.locale, VERSION) : toPo(kept, opts.locale)
    const result: ExportTmResult = { entries: kept.length, dropped: rows.length - kept.length, text }
    if (!opts.file) return result
    await mkdir(dirname(opts.file), { recursive: true })
    await writeFile(opts.file, text, 'utf8')
    return { ...result, file: opts.file }
  } finally {
    if (ownsDb) db.close()
  }
}

// One row per source and context, in the order the query already sorted them,
// so the survivor is the most recently updated.
function first(rows: Row[]): Row[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const key = `${row.source}\u0000${row.context}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
