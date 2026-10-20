import { z } from 'zod'
import type { Locale } from '../types.js'
import { MAX_SCHEMA } from '../rules/schema.js'
import { VERSION } from '../version.js'
import { localeOfWpCode, wpCodeOf } from '../wporg/locales.js'

// The index polyglots-data publishes with every build, read by rules fetch
// and tm fetch. Its shape is the cross-repo contract (polyglots-data,
// .docs/integration.md point 3); this file is the one place polyglots reads
// it, so a change to the contract is a change here and nowhere else.

export const MANIFEST_SCHEMA = 1

// GitHub's latest-release redirect, so a new polyglots-data build is picked
// up without a polyglots release. The artifact URLs inside are versioned and
// never overwritten, which is what makes their sha512 worth checking.
export const DEFAULT_MANIFEST_URL = 'https://github.com/emreerkan/polyglots-data/releases/latest/download/index.json'

export interface TmManifestEntry {
  locale: string
  slug: string
  url: string
  bytes: number
  bytesUncompressed: number
  sha512: string
  units: number
  built: string
  // `kind` is `long-text` for readme and release-note projects, whose
  // strings rank below the rest (contract point 9). Kept as any string, so a
  // kind added later is shown rather than refusing the whole manifest.
  projects: { path: string; units: number; stale?: string; kind?: string }[]
}

export interface RulesManifestEntry {
  locale: string
  slug: string
  url: string
  sha512: string
  schema: number
  minPolyglots: string
  status: 'maintained' | 'draft'
  maintainers: string[]
}

// The lists stay unjudged until a command picks its locale's entry, so the
// type says so: an entry is read through findTmEntry or findRulesEntry,
// which validate it, never by indexing these arrays.
export interface Manifest {
  schema: number
  generated: string
  tm: unknown[]
  rules: unknown[]
}

/**
 * Every refusal the data commands make: a manifest too new, a locale it does
 * not have, a file that does not verify. The CLI prints the message and exits
 * 1, so the message is the whole explanation and names what to do.
 */
export class DataError extends Error {
  override name = 'DataError'
}

export function manifestUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.POLYGLOTS_DATA_URL?.trim()
  return override ? override : DEFAULT_MANIFEST_URL
}

// Semver, as the contract says: x.y.z with an optional prerelease and build.
// A prerelease minPolyglots is a version a client can be older than, and
// refusing it as malformed would say "not valid" where "update polyglots" is
// the answer the person needs.
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

// Unknown keys are dropped rather than refused: the producer adding a field
// is not a reason to stop reading the fields this client knows. A field this
// client needs that is missing or mistyped refuses, since a guess at a size
// or a hash would defeat the checks those fields exist for. These judge one
// entry, the one a command asked for, and never its neighbours: see
// parseManifest for why.
const tmEntry = z.object({
  locale: z.string().min(1),
  slug: z.string().min(1),
  url: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  bytesUncompressed: z.number().int().nonnegative(),
  sha512: z.string().regex(/^[0-9a-f]{128}$/i),
  units: z.number().int().nonnegative(),
  built: z.string(),
  projects: z.array(
    z.object({
      path: z.string(),
      units: z.number().int().nonnegative(),
      stale: z.string().optional(),
      kind: z.string().optional(),
    }),
  ),
})

const rulesEntry = z.object({
  locale: z.string().min(1),
  slug: z.string().min(1),
  url: z.string().min(1),
  sha512: z.string().regex(/^[0-9a-f]{128}$/i),
  schema: z.number().int().positive(),
  minPolyglots: z.string().regex(VERSION_PATTERN, 'minPolyglots must be a semver version'),
  status: z.enum(['maintained', 'draft']),
  maintainers: z.array(z.string()),
})

// Only the top level. Validating every entry here made one locale's bad
// entry (a third status, a mistyped hash) refuse the whole manifest, so tm
// fetch de failed naming rules.7, a locale nobody asked for. A shipped client
// cannot be patched, and the producer would have had to bump the manifest
// schema to recover from a typo. The spec's order of checks judges the
// requested entry, so that is the entry that is judged.
//
// A list left out reads as an empty one. rules fetch needs nothing from tm[]
// and tm fetch nothing from rules[], so a manifest published before one of
// them exists answers "lists none" for that command alone, rather than
// refusing both. A list that is present but not an array still refuses.
const manifestShape = z.object({
  schema: z.number().int().positive(),
  generated: z.string(),
  tm: z.array(z.unknown()).default([]),
  rules: z.array(z.unknown()).default([]),
})

export function parseManifest(json: unknown): Manifest {
  // The schema first, on its own: a newer manifest may be shaped in ways this
  // client cannot describe, and "update polyglots" is the only useful thing
  // to say about it. Contract point 3: refuse, never guess.
  const schema = typeof json === 'object' && json !== null ? (json as { schema?: unknown }).schema : undefined
  if (typeof schema === 'number' && schema > MANIFEST_SCHEMA) {
    throw new DataError(`the polyglots-data manifest is schema ${schema}; this polyglots reads up to ${MANIFEST_SCHEMA}. Update polyglots.`)
  }
  const parsed = manifestShape.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
    throw new DataError(`the polyglots-data manifest is not valid: ${where}${issue?.message ?? 'unreadable'}`)
  }
  return parsed.data
}

/**
 * The entry for a locale, by slug: the wp.org id with its set, which is how
 * polyglots keys everything else. The WordPress code in `locale` is checked
 * against the registry when the registry knows the slug, because importing
 * under a slug whose language differs from the file's would put one
 * language's wordings into another's memory, where nothing ever takes them
 * out. A slug the registry does not know is a locale wp.org added after this
 * build, and the manifest is trusted for it (contract point 3).
 */
export function findEntry<T extends { slug: string; locale: string }>(list: readonly T[], slug: Locale): T {
  const entry = list.find((e) => e.slug === slug)
  if (!entry) throw missingEntry(list.map((e) => e.slug), slug)
  checkWpCode(entry.locale, slug)
  return entry
}

/** The tm entry for a locale, its whole shape validated. */
export function findTmEntry(manifest: Manifest, slug: Locale): TmManifestEntry {
  return judge(manifest.tm, slug, 'tm', tmEntry)
}

/** What this client can read, for choosing among a locale's rules rows. */
export interface RulesReader {
  maxSchema: number
  version: string
}

/**
 * The rules entry for a locale, its whole shape validated.
 *
 * A locale may have one row per rules schema. Every client up to 1.1 takes
 * the first row with the slug, so polyglots-data lists the oldest schema
 * first, and those clients keep receiving updates written for them. This one
 * takes the newest row it can read: the highest schema at or below its own,
 * whose minPolyglots it meets. When none qualifies it returns the highest
 * row, and rules fetch refuses that with "Update polyglots", which then
 * names the newest version the person could have.
 *
 * Every row is judged, and a row that is not valid is passed over rather
 * than refused, so a typo in one schema's row does not cut the locale off
 * from the other. Only when no row is valid is the first one's error shown,
 * the error the single-row lookup gave.
 */
export function findRulesEntry(manifest: Manifest, slug: Locale, reader: RulesReader = { maxSchema: MAX_SCHEMA, version: VERSION }): RulesManifestEntry {
  return findRulesEntryWithNotes(manifest, slug, reader).entry
}

/**
 * findRulesEntry, with a note for each row passed over as not valid whose
 * schema is above the chosen one. Without it, a typo in the newer row would
 * hand the person the older rules with nothing to say why, and the only
 * trace in the fetch summary would be the sections that went missing.
 */
export function findRulesEntryWithNotes(
  manifest: Manifest,
  slug: Locale,
  reader: RulesReader = { maxSchema: MAX_SCHEMA, version: VERSION },
): { entry: RulesManifestEntry; notes: string[] } {
  const rows = rowsFor(manifest.rules, slug)
  const judged = rows.map((row) => validate(row, slug, 'rules', rulesEntry))
  const valid = judged.flatMap((j) => ('entry' in j ? [j.entry] : []))
  if (valid.length === 0) throw (judged[0] as { error: DataError }).error
  const readable = valid.filter((e) => e.schema <= reader.maxSchema && compareVersions(reader.version, e.minPolyglots) >= 0)
  const highest = (list: RulesManifestEntry[]) => list.reduce((best, e) => (e.schema > best.schema ? e : best))
  const entry = highest(readable.length > 0 ? readable : valid)
  const notes = judged.flatMap((j, i) => {
    if (!('error' in j)) return []
    const schema = (rows[i] as { schema?: unknown }).schema
    if (typeof schema !== 'number' || schema <= entry.schema || schema > reader.maxSchema) return []
    return [`The schema ${schema} rules entry was passed over: ${j.error.message.replace(/; refusing it\.$/, '')}. Fetched the schema ${entry.schema} entry instead.`]
  })
  return { entry, notes }
}

// The lookup reads only `slug` from each row, defensively, so a row with no
// readable slug is passed over rather than refusing the lookup for everyone:
// it cannot be the entry asked for by name.
function rowsFor(rows: readonly unknown[], slug: Locale): unknown[] {
  const slugOf = (row: unknown): string | undefined => {
    const value = typeof row === 'object' && row !== null ? (row as { slug?: unknown }).slug : undefined
    return typeof value === 'string' ? value : undefined
  }
  const found = rows.filter((r) => slugOf(r) === slug)
  if (found.length === 0) throw missingEntry(rows.map(slugOf).filter((s) => s !== undefined), slug)
  return found
}

// A row is validated in full before the registry cross-check, so the
// cross-check reads a `locale` that is known to be a string. Both failures
// are returned rather than thrown, for findRulesEntry to weigh against the
// locale's other rows.
function validate<T extends { slug: string; locale: string }>(row: unknown, slug: Locale, kind: 'tm' | 'rules', shape: z.ZodType<T>): { entry: T } | { error: DataError } {
  const parsed = shape.safeParse(row)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
    return { error: new DataError(`The polyglots-data ${kind} entry for ${slug} is not valid: ${where}${issue?.message ?? 'unreadable'}; refusing it.`) }
  }
  try {
    checkWpCode(parsed.data.locale, slug)
  } catch (err) {
    if (err instanceof DataError) return { error: err }
    throw err
  }
  return { entry: parsed.data }
}

// The tm list keeps the first row with the slug, as every released client
// reads it: polyglots-data publishes one memory per locale.
function judge<T extends { slug: string; locale: string }>(rows: readonly unknown[], slug: Locale, kind: 'tm' | 'rules', shape: z.ZodType<T>): T {
  const result = validate(rowsFor(rows, slug)[0], slug, kind, shape)
  if ('error' in result) throw result.error
  return result.entry
}

// Named by the WordPress code people type, with the slug beside it the way
// the rest of the app writes a locale: a bare "sv" or "de/formal" read as a
// different locale from the sv_SE or de_DE_formal that was asked for. A slug
// this build does not know has no code, and is named as it is.
const named = (slug: string) => {
  const wp = wpCodeOf(slug as Locale)
  return wp === undefined ? slug : `${wp} (${slug})`
}

function missingEntry(slugs: readonly string[], slug: Locale): DataError {
  const available = [...new Set(slugs.map((s) => wpCodeOf(s as Locale) ?? s))].sort()
  return new DataError(
    available.length > 0
      ? `No polyglots-data entry for ${named(slug)}. Available: ${available.join(', ')}`
      : `No polyglots-data entry for ${named(slug)}; the manifest lists none.`,
  )
}

function checkWpCode(code: string, slug: Locale): void {
  if (wpCodeOf(slug) === undefined) return
  const named = localeOfWpCode(code)
  if (named !== slug) {
    const which = named === undefined ? 'which translate.wordpress.org does not list' : `which is ${named} on translate.wordpress.org`
    throw new DataError(`The polyglots-data entry for ${slug} names ${code}, ${which}, not ${slug}; refusing it.`)
  }
}

/**
 * Semver precedence, numeric in each part, so 0.10.0 is above 0.9.9 and a
 * prerelease is below its release: 1.0.0-rc.1 does not satisfy a
 * minPolyglots of 1.0.0, and 1.0.0 satisfies 1.0.0-rc.1. Build metadata is
 * ignored, as semver says. A plain split on dots once read 1.0.0-rc.1 as
 * 1, 0, NaN, and NaN compares as neither older nor newer, so every check
 * passed.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const bare = v.split('+')[0] ?? ''
    const dash = bare.indexOf('-')
    const core = (dash === -1 ? bare : bare.slice(0, dash)).split('.').map((n) => Number(n) || 0)
    return { core, pre: dash === -1 ? undefined : bare.slice(dash + 1) }
  }
  const pa = split(a)
  const pb = split(b)
  for (let i = 0; i < 3; i++) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0)
    if (d !== 0) return d
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === undefined) return 1
  if (pb.pre === undefined) return -1
  return comparePrerelease(pa.pre, pb.pre)
}

// Dot-separated identifiers, left to right: numeric ones numerically and
// below any alphanumeric one, the rest in ASCII order, and a shorter list
// below a longer one it is a prefix of (semver 11.4).
function comparePrerelease(a: string, b: string): number {
  const ia = a.split('.')
  const ib = b.split('.')
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i]
    const y = ib[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d
    } else if (nx !== ny) {
      return nx ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}
