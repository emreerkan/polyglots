import { createReadStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import type Database from 'better-sqlite3'
import type { DataClient } from '../data/download.js'
import { DataError, findTmEntry, type TmManifestEntry } from '../data/manifest.js'
import { dataDir, dbFile } from '../paths.js'
import { openDb } from '../storage/db.js'
import { readOnly } from '../storage/read-only.js'
import { insertTmIfAbsent } from '../storage/tm.js'
import { decodeXml, parseTmx } from '../tmx/parse.js'
import type { Locale } from '../types.js'
import { localeDisplayName, splitLocale } from '../wporg/locales.js'

// A sanity ceiling, not a budget: real locales are tens of MiB. The whole
// decompressed file is held in memory to be parsed, so an entry claiming more
// is refused before anything is downloaded rather than trusted to be honest.
const TM_CEILING = 200 * 1024 * 1024

// The rows per transaction, so a review writing to the same database waits
// for one chunk at most (see insertTmIfAbsent).
const CHUNK = 5000

// What a unit without any x-project is filed under. Every row the vault adds
// then has a project, so a person can still tell them from their own.
const VAULT_PROJECT = 'polyglots-data'

export interface TmFetchPlan {
  locale: Locale
  entry: TmManifestEntry
  existing: number
  summary: string[]
}

export type TmFetchProgress = { phase: 'downloading' } | { phase: 'importing'; done: number; total: number }

export interface TmFetchResult {
  units: number
  added: number
  present: number
  projects: number
  ms: number
}

const plural = (n: number, word: string): string => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`

// Binary units, since the ceiling above is stated in MiB and the two should
// read alike when someone compares them.
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} B`
}

/**
 * Every check that can be made before downloading, and the summary the person
 * answers the question on; nothing is downloaded or written. The order is the
 * spec's: the manifest and its entry first, then the ceiling, so a locale the
 * vault does not have or an absurd size is refused without a byte fetched.
 *
 * The count of rows already held is read through a read-only handle when no
 * database is given: the plan only looks, and openDb runs migrations, which
 * is a write to the one file polyglots cannot regenerate.
 */
export async function planTmFetch(locale: Locale, client: DataClient, db?: Database.Database): Promise<TmFetchPlan> {
  const manifest = await client.manifest()
  const entry = findTmEntry(manifest, locale)
  if (entry.bytesUncompressed > TM_CEILING) {
    throw new DataError(`The polyglots-data memory for ${locale} claims more than 200 MiB; refusing it.`)
  }
  const countRows = (d: Database.Database): number =>
    (d.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM tm WHERE locale = ?').get(locale) as { n: number }).n
  const existing = db ? countRows(db) : readOnly(dbFile(), countRows, 0)

  const stale = entry.projects.flatMap((p) => (p.stale === undefined ? [] : [p.stale])).sort()
  // Any other kind, including one the producer adds later, is normal here, as
  // it is for the x-weight it would come with.
  const longText = entry.projects.filter((p) => p.kind === 'long-text').length
  const summary = [
    `${localeDisplayName(locale)} (${locale}): ${plural(entry.units, 'string')}, ${formatBytes(entry.bytes)} download, built ${entry.built.slice(0, 10)}`,
    `${plural(entry.projects.length, 'project')}${stale.length > 0 ? `, ${stale.length} not refreshed in this build (oldest ${stale[0]!.slice(0, 10)})` : ''}`,
    ...(longText > 0
      ? [`${plural(longText, 'long-text project')} (readmes, release notes); ${longText === 1 ? 'its' : 'their'} strings rank below the rest.`]
      : []),
    existing > 0
      ? `You already have ${plural(existing, 'string')} for ${locale}. This adds what is new; it never changes or deletes your rows.`
      : `Your memory has no ${locale} strings yet.`,
  ]
  return { locale, entry, existing, summary }
}

/**
 * Downloads, verifies, decompresses and imports the plan's entry, insert-only.
 *
 * The download lands in the data directory, verified against the manifest's
 * size and sha512 as it streams; the gunzip that follows has its own hard
 * stop at the size the manifest claims, because a verified hash says the file
 * is the one published, not that it is small once inflated. Nothing touches
 * the database until the whole file has parsed, so every refusal leaves the
 * memory exactly as it was, and the temp file is removed on every path.
 */
export async function runTmFetch(
  plan: TmFetchPlan,
  client: DataClient,
  opts: { db?: Database.Database; onProgress?: (e: TmFetchProgress) => void } = {},
): Promise<TmFetchResult> {
  const started = Date.now()
  const { entry, locale } = plan
  opts.onProgress?.({ phase: 'downloading' })
  const temp = await client.download(entry.url, { maxBytes: entry.bytes, sha512: entry.sha512, dir: dataDir() })
  let xml: Buffer
  try {
    xml = await gunzipCapped(temp, entry.bytesUncompressed)
  } finally {
    await rm(temp, { force: true }).catch(() => undefined)
  }

  // The target <tuv> is found by the language the file writes, and the row
  // is filed under the slug, where every reader looks for it. They are not
  // the same string. The slug is a translate.wordpress.org label, and for
  // Burmese (mya), Valencian (ca-val), Breton (bre/br) and a few others it
  // is not even a prefix of the xml:lang the vault writes (my-MM,
  // ca-valencia), so matching by the slug found no target, imported nothing
  // and still exited 0. The vault writes the WP code without its set, since
  // a TMX cannot name one (nl-NL for nl_NL_formal), and that is rebuilt here
  // from the code the manifest names, which findTmEntry has already checked
  // against the slug.
  const rows = parseTmx(decodeXml(xml), { targetLocale: targetLang(entry.locale, locale) }).map((e) => ({
    ...e,
    locale,
    project: e.project || VAULT_PROJECT,
  }))
  // An entry that promises units and yields none is a file this client cannot
  // read the way the producer wrote it, not an empty memory; saying "0 new
  // strings" would read as success.
  if (entry.units > 0 && rows.length === 0) {
    throw new DataError(`The polyglots-data memory for ${locale} has no ${entry.locale} units; nothing was imported.`)
  }

  const db = opts.db ?? openDb()
  try {
    let added = 0
    // Sliced here rather than inside insertTmIfAbsent so progress can be
    // reported per chunk; each slice is still one transaction.
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK)
      added += insertTmIfAbsent(db, slice, entry.built, CHUNK).added
      opts.onProgress?.({ phase: 'importing', done: i + slice.length, total: rows.length })
    }
    return { units: rows.length, added, present: rows.length - added, projects: entry.projects.length, ms: Date.now() - started }
  } finally {
    if (opts.db === undefined) db.close()
  }
}

// The producer's rule for the target's xml:lang (contract point 4): the WP
// code with the set suffix taken off, nl_NL_formal as nl-NL. parseTmx
// normalises case and separators, so only the suffix needs handling here.
function targetLang(code: string, locale: Locale): string {
  const { set } = splitLocale(locale)
  const suffix = `_${set}`
  return set !== 'default' && code.toLowerCase().endsWith(suffix.toLowerCase()) ? code.slice(0, -suffix.length) : code
}

async function gunzipCapped(path: string, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  try {
    await pipeline(createReadStream(path), createGunzip(), async (source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) {
        total += chunk.length
        if (total > limit) throw new DataError('The polyglots-data memory is larger than the manifest says; nothing was imported.')
        chunks.push(chunk)
      }
    })
  } catch (err) {
    if (err instanceof DataError) throw err
    throw new DataError(`The polyglots-data memory is not a valid gzip file (${(err as Error).message}); nothing was imported.`)
  }
  return Buffer.concat(chunks)
}
