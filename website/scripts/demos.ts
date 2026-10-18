import type { CliDeps } from '../../app/src/cli.js'
import type { Resolution, Fetched } from '../../app/src/commands/fetch.js'
import type { TranslateEvent, TranslateSummary } from '../../app/src/commands/translate.js'
import type { StatsSummary } from '../../app/src/commands/stats.js'
import type { ReviewEvent, ReviewSummary } from '../../app/src/types.js'
import type { DataClient } from '../../app/src/data/download.js'
import type { ProviderCheck } from '../../app/src/agent/agy-check.js'

// The scenarios the site's terminal panels play. Each is a real command line,
// run through the real cli.ts with only the slow, networked part swapped out:
// the review, the translation, the download. Everything the person sees around
// that part (header, progress line, summary box, requester message) is the
// CLI's own code, so the panels change when the CLI does.
//
// Every project, file and number here is invented. The panels are public, and
// a real submission would put a real contributor's work on show.
//
// Each panel runs in a different locale, set the way a person sets theirs, in
// config.json. polyglots is for every locale team, and a site whose every demo
// was one language would read as a tool for that language. The locale is
// written down explicitly too: there is no default to fall back on.

export interface Clock {
  /** Moves demo time on by `ms` (what the run would really take) and sets how long the panel lingers on the frame the next write makes. */
  advance(ms: number, linger: number): void
  now(): number
}

export interface Scenario {
  name: string
  argv: string[]
  /** Files the command insists exist before it starts. Created empty. */
  files?: string[]
  /** Settings to write to config.json first. */
  config?: Record<string, unknown>
  deps(clock: Clock): CliDeps
}

const PLUGIN_FILE = 'wp-plugins-lunar-forms-stable-de.po'
const THEME_FILE = 'wp-themes-harbor-pt-br.po'
const FETCH_LOCALE = 'nl'

// Typed in full, so a field added to ReviewSummary breaks the snapshot's
// typecheck here rather than printing `undefined` on the site.
// No title-case findings: German capitalises its nouns, so the check is off
// for it, and a panel showing it fire would be showing a German team noise.
const reviewSummary = (file: string, locale: string): ReviewSummary => ({
  file,
  locale,
  total: 412,
  skipped: 126,
  reviewed: 286,
  problems: 22,
  needsReview: 0,
  approvable: 264,
  unreviewed: 0,
  pending: 0,
  repaired: 21,
  written: 23,
  byRule: { glossary: 9, placeholder: 2, punctuation: 3, html: 1 },
  byGroup: { glossary: 9, meaning: 9, other: 3 },
  problemsFile: file.replace(/\.po$/, '-repaired.po'),
})

// The antigravity check, answered as unknown: the panels run the default
// provider, which is never asked, and a demo switched to antigravity must
// still never run agy during a build. Unknown never stops a run, so it would
// play exactly as it does now.
const noProviderCheck = async (): Promise<ProviderCheck> => ({ signIn: { state: 'unknown', ms: 0 }, at: 0 })

// The problem report send, answered as sent: the demo runs never start a run
// row, so no offer is made, but a panel that one day shows a failed batch
// must still never post to the reports endpoint during a build.
const noReportSend = async () => ({ ok: true as const, id: 'demo' })

// The provider version a report names, answered as unknown for the same
// reason: no build ever runs an agent binary to ask it.
const noProviderVersion = async () => undefined

const FLAGGED_PER_BATCH = [3, 1, 4, 0, 2, 5, 1, 3, 2, 1]

function playReview(clock: Clock, emit: (e: ReviewEvent) => void, file: string, locale: string): ReviewSummary {
  const summary = reviewSummary(file, locale)
  emit({ type: 'start', file, total: summary.total, reviewable: summary.reviewed })
  clock.advance(1_800, 700)
  emit({ type: 'rules-done', flagged: 17, suspects: 41, memoryApproved: 38, memoryRepaired: 4 })
  const of = FLAGGED_PER_BATCH.length
  FLAGGED_PER_BATCH.forEach((problems, i) => {
    const index = i + 1
    clock.advance(400, 350)
    emit({ type: 'batch-start', index, of, size: index === of ? 19 : 25, at: clock.now() })
    clock.advance(31_000 + ((i * 7_919) % 9_000), 420)
    emit({ type: 'batch-done', index, problems, at: clock.now() })
  })
  clock.advance(300, 500)
  emit({ type: 'written', file: summary.problemsFile! })
  return summary
}

export const review: Scenario = {
  name: 'review',
  argv: ['review', PLUGIN_FILE],
  files: [PLUGIN_FILE],
  // The username is set so the requester message carries the link it carries
  // for a reviewer who has set theirs, which is how the message is meant to be
  // used.
  config: { defaultLocale: 'de', wporgUsername: 'your-wporg-name' },
  deps: (clock) => ({
    checkProvider: noProviderCheck,
    sendReport: noReportSend,
    providerVersion: noProviderVersion,
    reviewFile: async (opts) => playReview(clock, (e) => opts.onProgress?.(e), opts.file, opts.locale),
  }),
}

export const translate: Scenario = {
  name: 'translate',
  argv: ['translate', THEME_FILE],
  files: [THEME_FILE],
  config: { defaultLocale: 'pt-br' },
  deps: (clock) => ({
    checkProvider: noProviderCheck,
    sendReport: noReportSend,
    providerVersion: noProviderVersion,
    translate: async (opts) => {
      const emit = (e: TranslateEvent) => opts.onProgress?.(e)
      const sizes = [25, 25, 12]
      const fuzzy = [2, 1, 2]
      const summary: TranslateSummary = { file: opts.file, total: 318, pending: 74, fromTm: 12, translated: 62, fuzzy: 5, skipped: 0 }
      emit({ type: 'start', file: opts.file, total: summary.total, pending: summary.pending })
      clock.advance(900, 600)
      emit({ type: 'tm-hit', count: summary.fromTm })
      sizes.forEach((size, i) => {
        const index = i + 1
        clock.advance(300, 300)
        emit({ type: 'batch-start', index, of: sizes.length, size, at: clock.now() })
        emit({ type: 'batch-phase', index, phase: 'drafting', at: clock.now() })
        clock.advance(4_000, 700)
        emit({ type: 'batch-phase', index, phase: 'reviewing', at: clock.now() })
        clock.advance(28_000, 900)
        emit({ type: 'batch-done', index, translated: size, fuzzy: fuzzy[i]!, at: clock.now() })
      })
      emit({ type: 'saved' })
      emit({ type: 'done', summary })
      return summary
    },
  }),
}

export const fetch: Scenario = {
  name: 'fetch',
  // A literal ~ rather than an expanded path: it is what the person would
  // type, and the downloads are faked, so nothing is written there.
  argv: ['fetch', '--get', 'waiting', '--out-dir', '~/Downloads/polyglots', 'lunar-forms', 'harbor', 'quiet-gallery'],
  config: { defaultLocale: FETCH_LOCALE, wporgUsername: 'your-wporg-name' },
  deps: (clock) => ({
    sendReport: noReportSend,
    providerVersion: noProviderVersion,
    resolveProjects: async (refs) => {
      clock.advance(4_500, 900)
      return refs.map((ref): Resolution => {
        if (ref.slug === 'lunar-forms') return { input: ref.slug, state: 'ready', type: 'wp-plugins', slug: 'lunar-forms', branch: 'stable', count: 286 }
        if (ref.slug === 'harbor') return { input: ref.slug, state: 'ready', type: 'wp-themes', slug: 'harbor', count: 41 }
        return { input: ref.slug, state: 'empty', reason: 'nothing waiting' }
      })
    },
    fetchProjects: async (ready) => {
      clock.advance(7_000, 900)
      return ready.map((r): Fetched => ({
        input: r.input,
        state: 'fetched',
        file: r.type === 'wp-themes' ? `wp-themes-${r.slug}-${FETCH_LOCALE}.po` : `wp-plugins-${r.slug}-${r.branch}-${FETCH_LOCALE}.po`,
      }))
    },
    reviewFile: async (opts) => {
      clock.advance(60_000, 1_100)
      if (opts.file.startsWith('wp-themes-')) {
        // Nothing flagged, so nothing written: the real run sets no
        // problemsFile then, and the table must not claim a file it lacks.
        const { problemsFile: _none, ...clean } = reviewSummary(opts.file, opts.locale)
        return { ...clean, total: 64, skipped: 23, reviewed: 41, problems: 0, approvable: 41, repaired: 0, written: 0, byRule: {}, byGroup: {} }
      }
      return reviewSummary(opts.file, opts.locale)
    },
  }),
}

// A summary with a few months behind it, enough for the sparkline to have a
// shape. Project names are invented.
const STATS_SUMMARY: Omit<StatsSummary, 'file'> = {
  submissions: 148,
  entries: 21_734,
  incomplete: 2,
  translateRuns: 37,
  translateEntries: 4_912,
  flagged: 2_391,
  weeks: [310, 420, 380, 520, 610, 480, 700, 655, 590, 810, 760, 905],
  topProjects: [
    { project: 'lunar-forms', runs: 9, entries: 2_870, flagged: 344 },
    { project: 'harbor', runs: 6, entries: 1_402, flagged: 98 },
    { project: 'quiet-gallery', runs: 4, entries: 966, flagged: 151 },
  ],
}

// On a terminal, which is what the demo panel is, `stats` serves the page
// rather than writing a file, and stays up until Ctrl+C. The fake reports the
// server as ready and then returns, which is the Ctrl+C the panel cannot
// press; the port and token are made up.
export const stats: Scenario = {
  name: 'stats',
  argv: ['stats'],
  deps: (clock) => ({
    serveStats: async (_opts, onReady) => {
      clock.advance(400, 300)
      onReady({ url: 'http://127.0.0.1:52817/k3v9q2/', opened: true, summary: STATS_SUMMARY })
      clock.advance(1800, 0)
    },
  }),
}

// polyglots-data as the demos see it: a manifest with nothing in it, and a
// download that refuses. No panel fetches rules or a TM, so neither is ever
// reached today; a panel that starts to would show "no entry" rather than
// reach GitHub during a build, and its demo would then fake its own.
export const offlineData: DataClient = {
  manifest: async () => ({ schema: 1, generated: '', tm: [], rules: [] }),
  download: async () => {
    throw new Error('not in a demo')
  },
}

export const SCENARIOS: readonly Scenario[] = [review, translate, fetch, stats]
