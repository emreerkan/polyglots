import { z } from 'zod'
import type { Locale } from '../types.js'
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
const manifestShape = z.object({
  schema: z.number().int().positive(),
  generated: z.string(),
  tm: z.array(z.unknown()),
  rules: z.array(z.unknown()),
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

/** The rules entry for a locale, its whole shape validated. */
export function findRulesEntry(manifest: Manifest, slug: Locale): RulesManifestEntry {
  return judge(manifest.rules, slug, 'rules', rulesEntry)
}

// The lookup reads only `slug` from each row, defensively, so a row with no
// readable slug is passed over rather than refusing the lookup for everyone:
// it cannot be the entry asked for by name. The chosen row is then validated
// in full before the registry cross-check, so the cross-check reads a
// `locale` that is known to be a string.
function judge<T extends { slug: string; locale: string }>(rows: readonly unknown[], slug: Locale, kind: 'tm' | 'rules', shape: z.ZodType<T>): T {
  const slugOf = (row: unknown): string | undefined => {
    const value = typeof row === 'object' && row !== null ? (row as { slug?: unknown }).slug : undefined
    return typeof value === 'string' ? value : undefined
  }
  const row = rows.find((r) => slugOf(r) === slug)
  if (row === undefined) throw missingEntry(rows.map(slugOf).filter((s) => s !== undefined), slug)
  const parsed = shape.safeParse(row)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
    throw new DataError(`The polyglots-data ${kind} entry for ${slug} is not valid: ${where}${issue?.message ?? 'unreadable'}; refusing it.`)
  }
  checkWpCode(parsed.data.locale, slug)
  return parsed.data
}

function missingEntry(slugs: readonly string[], slug: Locale): DataError {
  const available = [...new Set(slugs)].sort()
  return new DataError(
    available.length > 0
      ? `No polyglots-data entry for ${slug}. Available: ${available.join(', ')}`
      : `No polyglots-data entry for ${slug}; the manifest lists none.`,
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
