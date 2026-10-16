import { basename } from 'node:path'
import { parseTally } from '../jobs/json.js'
import { jobsDbFile } from '../paths.js'
import { UNIVERSAL_RULES } from '../audit/rules/profiles.js'
import { BUILT_IN_RULES, FINDING_KEYS, type BuiltInRule } from '../rules/names.js'
import { readOnly } from '../storage/read-only.js'

/**
 * What an opted-in install sends, at most once a week: all-time totals and
 * nothing that could say whose they are (issue #19).
 *
 * Everything here is a count. The job store also holds project slugs, file
 * paths, the locale and the engine with its model name, and none of them is
 * selected into anything that leaves this function except as a number. The
 * project names are read only to count the distinct ones.
 */
export interface UsagePayload {
  // Random, made on opt-in, replaced by `usage-stats reset`. The server keeps
  // one row per id, so a weekly resend replaces last week's totals.
  installId: string
  version: string
  // Entries looked at by finished reviews.
  reviewed: number
  // Entries a finished translate run machine-drafted.
  drafted: number
  // Entries a finished review repaired.
  repaired: number
  // How many different projects finished runs covered. A count only.
  projects: number
  // How often each finding fired over finished reviews, keyed by the closed
  // set in rules/names.ts.
  findings: Record<string, number>
}

interface Row {
  command: string
  project: string | null
  file: string
  entries: number | null
  repaired: number | null
  by_category: string | null
}

const KNOWN_FINDINGS = new Set(FINDING_KEYS)

// The built-in rules that are not universal run only where a locale's rules
// file turns them on: apostrophe for Turkish, title-case for Turkish and
// Swedish. With few installs, a count under one of those names would say
// which locale someone reviews, which the payload promises never to carry.
// They are summed under one key; the universal rules and the AI categories
// run the same for every locale and keep their names.
const LOCALE_RULE = 'locale-rule'
//
// The reviewer's own title-case category goes the same way: it is asked about
// capitalization only where title-case is on (audit/prompt.ts), so its count
// hints at the locale exactly as the rule's does.
const LOCALE_AI_CATEGORIES = new Set(['ai:title-case'])
const sentAs = (key: string): string =>
  (BUILT_IN_RULES.includes(key as BuiltInRule) && !UNIVERSAL_RULES.includes(key)) || LOCALE_AI_CATEGORIES.has(key)
    ? LOCALE_RULE
    : key

type Totals = Omit<UsagePayload, 'installId' | 'version'>

const ZERO: Totals = { reviewed: 0, drafted: 0, repaired: 0, projects: 0, findings: {} }

function total(rows: Row[]): Totals {
  const t: Totals = { ...ZERO, findings: {} }
  const projects = new Set<string>()
  for (const row of rows) {
    // The same fallback the stats page uses for a run with no project, so the
    // count here and the page's project list agree.
    projects.add(row.project ?? basename(row.file))
    if (row.command === 'review') {
      t.reviewed += row.entries ?? 0
      t.repaired += row.repaired ?? 0
      for (const [key, n] of Object.entries(parseTally(row.by_category) ?? {})) {
        // Dropped, not bucketed as "other": a key outside the known set is
        // something no released polyglots writes, and a custom rule's name, or
        // whatever a future version puts there, is exactly the kind of free
        // text that must not leave the machine on the strength of a guess.
        if (!KNOWN_FINDINGS.has(key)) continue
        // A hand-edited row can hold any finite number; the server takes only
        // whole counts, and one bad value must not lose the whole week.
        if (!Number.isInteger(n) || n < 0) continue
        const as = sentAs(key)
        t.findings[as] = (t.findings[as] ?? 0) + n
      }
    } else if (row.command === 'translate') {
      // `repaired` on a translate run holds the entries the engine drafted;
      // `entries` is everything it was given, memory hits included.
      t.drafted += row.repaired ?? 0
    }
  }
  t.projects = projects.size
  return t
}

/**
 * Builds the payload from the job store, read-only.
 *
 * Read through readOnly rather than openJobsDb: this runs at the start of an
 * ordinary command, possibly beside a review writing to the same file, and
 * openJobsDb would migrate, set WAL, and create a store that does not exist.
 * A missing or unreadable store gives zeros, which is the truth about it.
 */
export function buildUsagePayload(opts: { installId: string; version: string; jobsPath?: string }): UsagePayload {
  const totals = readOnly(
    opts.jobsPath ?? jobsDbFile(),
    (db) =>
      total(
        db
          .prepare<[], Row>(`SELECT command, project, file, entries, repaired, by_category FROM run WHERE state = 'done'`)
          .all(),
      ),
    ZERO,
  )
  return { installId: opts.installId, version: opts.version, ...totals }
}
