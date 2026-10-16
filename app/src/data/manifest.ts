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

export interface Manifest {
  schema: number
  generated: string
  tm: TmManifestEntry[]
  rules: RulesManifestEntry[]
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

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

// Unknown keys are dropped rather than refused: the producer adding a field
// is not a reason to stop reading the fields this client knows. A field this
// client needs that is missing or mistyped refuses, since a guess at a size
// or a hash would defeat the checks those fields exist for.
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
  minPolyglots: z.string().regex(VERSION_PATTERN, 'minPolyglots must be x.y.z'),
  status: z.enum(['maintained', 'draft']),
  maintainers: z.array(z.string()),
})

const manifestShape = z.object({
  schema: z.number().int().positive(),
  generated: z.string(),
  tm: z.array(tmEntry),
  rules: z.array(rulesEntry),
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
  return parsed.data as Manifest
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
export function findEntry<T extends { slug: string; locale: string }>(list: T[], slug: Locale): T {
  const entry = list.find((e) => e.slug === slug)
  if (!entry) {
    const available = [...new Set(list.map((e) => e.slug))].sort()
    throw new DataError(
      available.length > 0
        ? `No polyglots-data entry for ${slug}. Available: ${available.join(', ')}`
        : `No polyglots-data entry for ${slug}; the manifest lists none.`,
    )
  }
  if (wpCodeOf(slug) !== undefined) {
    const named = localeOfWpCode(entry.locale)
    if (named !== slug) {
      const which = named === undefined ? 'which translate.wordpress.org does not list' : `which is ${named} on translate.wordpress.org`
      throw new DataError(`The polyglots-data entry for ${slug} names ${entry.locale}, ${which}, not ${slug}; refusing it.`)
    }
  }
  return entry
}

/**
 * Numeric x.y.z, so 0.10.0 is above 0.9.9. parseManifest has already refused
 * a minPolyglots in any other form; VERSION is always x.y.z.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
