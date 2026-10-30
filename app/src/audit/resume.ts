import { createHash } from 'node:crypto'
import type { GlossaryEntry, Locale } from '../types.js'
import { VERSION } from '../version.js'
import { buildAuditPrompt } from './prompt.js'
import { REPAIRABLE_RULES } from './repair.js'
import { profileFor } from './rules/profiles.js'
import { loadLocaleRules, rulesFingerprint } from '../rules/load.js'

// A long review is hours of `claude -p` calls. Resume itself now lives in the
// job store, keyed by what each entry looked like, but the marker is still
// written into the problems file's header because it is useful for a human to
// read there: it says how far a run got. Nothing reads it back.
export const MARKER_HEADER = 'X-Polyglots-Review'

// The last format anything ever decoded. Kept as a fixed value, not bumped
// further, since a marker is write-only now.
const FORMAT = 2

// Kept as named parts rather than one hash. `glossary` and `rules` feed
// configHash, which is the key the verdict cache is pruned by when either
// changes; `source`, `batchSize` and `ai` ride along only because the written
// marker is informational and used to say more than that.
export interface Fingerprint {
  source: string
  glossary: string
  rules: string
  batchSize: number
  ai: boolean
}

export interface ReviewMarker {
  // Batches finished, and how many there were. Everything before `done` is
  // already decided and persisted; the batch that was interrupted is not.
  done: number
  of: number
  // What those batches decided, so a resumed run can report a summary covering
  // the whole submission rather than only the part it ran itself.
  problems: number
  unreviewed: number
  // Entries the skipped batches repaired. Their text is in the file, but the
  // count is not recoverable from it, so it rides along here.
  repaired: number
  byRule: Record<string, number>
}

// The build that wrote it. Nothing reads the marker back for its counts, but
// this one field is read: it is what tells an ignored marker from 0.2.0-0.4.0
// apart from one this build wrote seconds ago, which is the difference between
// a true notice and telling a reviewer their work was thrown away.
export function encodeMarker(marker: ReviewMarker): string {
  return JSON.stringify({ v: FORMAT, polyglots: VERSION, ...marker })
}

// True for a marker from a build that predates the job store, which is the
// population the "ignored, reviewing from the top" notice exists for. Those
// markers meant something and no longer do. One this build wrote means nothing
// and never did, so saying it is being ignored would be noise on the most
// common workflow there is: running review over the same submission twice.
//
// Unreadable counts as earlier. A marker nobody can parse is not one this build
// wrote, and erring towards the notice costs a line of output.
export function writtenByEarlierVersion(header: string): boolean {
  try {
    const value: unknown = JSON.parse(header)
    if (typeof value !== 'object' || value === null) return true
    return typeof (value as { polyglots?: unknown }).polyglots !== 'string'
  } catch {
    return true
  }
}

const HASH_LENGTH = 16

export interface FingerprintInput {
  source: string
  locale: Locale
  batchSize: number
  noAi: boolean
  glossary: GlossaryEntry[]
  properNouns: string[]
}

// Written as escapes, not literal control bytes, so the file stays text to git and grep.
const UNIT = '\u0000'
const FIELD = '\u0001'
const PART = '\u0002'

function hash(...parts: string[]): string {
  return createHash('sha256').update(parts.join(PART)).digest('hex').slice(0, HASH_LENGTH)
}

// Everything that decides what a batch contains and how it is judged. If any of
// it moved, the earlier verdicts answered a different question: `configHash`
// (jobs/hash.ts) is built from this, and a change to it prunes every cached
// verdict for the locale rather than letting old and new answers mix.
export function fingerprintReview(input: FingerprintInput): Fingerprint {
  const profile = profileFor(input.locale)
  // Added only when the locale has a rules file. Hashing an empty part would
  // still change the joined string, and with it every cached verdict of
  // everyone who never writes a file.
  const localeRules = rulesFingerprint(loadLocaleRules(input.locale))
  return {
    source: hash(input.source),
    glossary: hash(
      ...input.glossary.map((g) => [g.sourceTerm, g.translation, g.partOfSpeech ?? '', g.notes ?? ''].join(FIELD)).sort(),
    ),
    rules: hash(
      input.locale,
      String(profile.glossaryStemRatio),
      [...profile.rules].sort().join(','),
      [...input.properNouns].sort().join(UNIT),
      // What the rules repair on their own. Widening the set changes the verdicts
      // the earlier batches would have reached, so it has to refuse a resume.
      [...REPAIRABLE_RULES].join(','),
      // The guidance itself, so editing the prompt invalidates a resume without
      // anyone having to remember to bump a version number.
      buildAuditPrompt([], input.locale, 2),
      ...(localeRules ? [localeRules] : []),
    ),
    batchSize: input.batchSize,
    ai: !input.noAi,
  }
}
