import type { TuiCommands } from '../../app/src/tui/commands.js'
import type { TuiState } from '../../app/src/tui/state.js'
import type { AgentStatus } from '../../app/src/agent/discover.js'
import type { ReviewEntry, ReviewEvent, ReviewSummary } from '../../app/src/types.js'
import { VERSION } from '../../app/src/version.js'

// The scenarios the site's TUI panels play. Each renders the real App from
// app/src/tui, at a fixed terminal size, and drives it with the keys a person
// would press. Only what would leave the machine or take minutes is swapped
// out: agent discovery, the review itself. The screens, the header's setup
// status, the cards, the progress bar and the recent-entries panel are the
// TUI's own code, so the panels change when the TUI does.
//
// As with the CLI demos in demos.ts, every project, file, string and number
// here is invented, and the locale is not the maintainer's own.

export interface TuiClock {
  /** Moves demo time on by `ms`, firing any interval that falls due, as a run that took that long would. */
  advance(ms: number): void
}

export interface TuiDriver {
  /** Writes keys to the app's stdin, one at a time, letting it settle after each. */
  press(...keys: string[]): Promise<void>
  /** Records the screen as it now stands, held for `hold` ms on the page. */
  shot(hold: number): Promise<void>
  /** Lets the app render and run its effects, as it would between two events of a real run. */
  settle(): Promise<void>
  /** Waits until the screen shows `text`, and fails the snapshot if it never does. */
  waitFor(text: string): Promise<void>
}

export interface TuiFile {
  name: string
  /** How many entries to write, so the picker's count column has a number. */
  entries: number
  /** Minutes before the demo's clock it was last written; the picker sorts newest first. */
  age: number
}

export interface TuiScenario {
  name: string
  columns: number
  rows: number
  /** config.json, as the person would have set it. */
  config: Record<string, unknown>
  /** tui.json. Omitted means a fresh install, where the setup wizard opens by itself. */
  tuiState?: TuiState
  /** .po files in the folder the app was started from. */
  files?: TuiFile[]
  commands(clock: TuiClock, drive: TuiDriver): Partial<TuiCommands>
  play(drive: TuiDriver): Promise<void>
}

// Key codes as a terminal sends them.
export const KEY = {
  up: '\x1b[A',
  down: '\x1b[B',
  enter: '\r',
}

const LOCALE = 'nl'
const FILE = `wp-plugins-lunar-forms-stable-${LOCALE}.po`

const FILES: TuiFile[] = [
  { name: FILE, entries: 213, age: 4 },
  { name: `wp-themes-harbor-${LOCALE}.po`, entries: 65, age: 6 },
  { name: `wp-plugins-quiet-gallery-stable-${LOCALE}.po`, entries: 1_204, age: 60 * 26 },
]

// Discovery, as it answers on a machine with both agents installed and
// signed in. Faked because the real one spawns both binaries, and the build
// machine's answer is not the reader's.
const AGENTS: AgentStatus[] = [
  {
    provider: 'claude',
    bin: 'claude',
    binSource: 'default',
    path: '/usr/local/bin/claude',
    version: 'claude 2.0.0',
    auth: { state: 'signed-in' },
    setup: { state: 'ok' },
    usable: true,
    notes: [],
  },
  {
    provider: 'antigravity',
    bin: 'agy',
    binSource: 'default',
    path: '/usr/local/bin/agy',
    version: 'agy 1.0.0',
    auth: { state: 'signed-in' },
    setup: { state: 'ok' },
    usable: true,
    notes: [],
  },
]

// The wizard walked to the end, with the keys step skipped: this reviewer
// does not draft. Locale rules stay missing, as they are for most locales,
// so the header's status shows a step still to do rather than a row of
// ticks that says nothing.
const SET_UP: TuiState = {
  wizard: { dismissed: true, skipped: ['keys'], confirmed: ['locale'] },
  settings: { exitSummary: true },
  // Seen already, so the home demo shows the cards and not this release's news.
  whatsNew: { seen: VERSION },
}

// What a settled install reports: a glossary synced, the locale's memory
// fetched, no rules file yet. Rows in the memory answer the memory step
// without the manifest, so the demo never reads polyglots-data.
const settled = (): Partial<TuiCommands> => ({
  discoverAgents: async () => AGENTS,
  glossaryCount: () => 1_342,
  memoryCount: () => 48_206,
  hasLocaleRules: () => false,
  localeConfigured: () => true,
})

// Six batches of twenty-five. Strings are the kind a forms plugin has; the
// outcomes and the rules beside them are spread the way a real submission's
// are, mostly approved.
const BATCHES: ReviewEntry[][] = [
  [
    { key: '1', msgid: 'Add a new field', outcome: 'approved' },
    { key: '2', msgid: 'Required fields are marked %s', outcome: 'approved' },
    { key: '3', msgid: 'Form settings', outcome: 'repaired', rules: ['glossary'] },
    { key: '4', msgid: 'Send a copy to the submitter', outcome: 'approved' },
  ],
  [
    { key: '5', msgid: 'Your message has been sent.', outcome: 'approved' },
    { key: '6', msgid: '%d entries', outcome: 'repaired', rules: ['placeholder'] },
    { key: '7', msgid: 'Export entries as CSV', outcome: 'approved' },
  ],
  [
    { key: '8', msgid: 'Redirect after submission', outcome: 'approved' },
    { key: '9', msgid: 'Spam protection', outcome: 'repaired', rules: ['glossary', 'meaning'] },
    { key: '10', msgid: 'Drag fields to reorder them.', outcome: 'approved' },
    { key: '11', msgid: 'Maximum file size: %s', outcome: 'approved' },
  ],
  [
    { key: '12', msgid: 'Conditional logic', outcome: 'approved' },
    { key: '13', msgid: 'Show this field if…', outcome: 'flagged', rules: ['punctuation'] },
    { key: '14', msgid: 'Email notifications', outcome: 'approved' },
  ],
  [
    { key: '15', msgid: 'Please enter a valid email address.', outcome: 'approved' },
    { key: '16', msgid: 'View all <a href="%s">entries</a>', outcome: 'repaired', rules: ['html'] },
    { key: '17', msgid: 'Duplicate form', outcome: 'approved' },
  ],
  [
    { key: '18', msgid: 'This form is closed.', outcome: 'approved' },
    { key: '19', msgid: 'Save and continue later', outcome: 'repaired', rules: ['meaning'] },
    { key: '20', msgid: 'Thank you! We will be in touch.', outcome: 'approved' },
  ],
]
const PROBLEMS_PER_BATCH = [2, 1, 3, 1, 2, 2]

const summaryOf = (file: string): ReviewSummary => ({
  file,
  locale: LOCALE,
  total: 213,
  skipped: 63,
  reviewed: 150,
  problems: 14,
  needsReview: 0,
  approvable: 136,
  unreviewed: 0,
  pending: 0,
  repaired: 13,
  written: 14,
  byRule: { glossary: 6, punctuation: 3, placeholder: 1, html: 1 },
  byGroup: { glossary: 6, meaning: 5, other: 2 },
  problemsFile: file.replace(/\.po$/, '-repaired.po'),
})

/**
 * Home, then a review of a plugin's waiting strings from the file picker to
 * the message for the requester, then home again. The panel's still is the
 * first frame, home, which is also where the replay ends.
 */
export const reviewFlow: TuiScenario = {
  name: 'review',
  columns: 100,
  rows: 24,
  config: { defaultLocale: LOCALE, reviewProvider: 'claude', wporgUsername: 'your-wporg-name' },
  tuiState: SET_UP,
  files: FILES,
  commands: (clock, drive) => ({
    ...settled(),
    reviewFile: async (opts) => {
      const emit = (e: ReviewEvent) => opts.onProgress?.(e)
      const summary = summaryOf(opts.file)
      emit({ type: 'start', file: FILE, total: summary.total, reviewable: summary.reviewed })
      clock.advance(1_400)
      emit({ type: 'rules-done', flagged: 4, suspects: 19, memoryApproved: 27, memoryRepaired: 2 })
      const of = BATCHES.length
      let at = 0
      for (const [i, entries] of BATCHES.entries()) {
        const index = i + 1
        emit({ type: 'batch-start', index, of, size: 25, at })
        // The elapsed clock starts when the screen has drawn the batch.
        await drive.settle()
        // Into the batch, so the elapsed clock beside it has moved.
        const took = 38_000 + ((i * 7_919) % 9_000)
        clock.advance(took - 6_000)
        await drive.shot(i === 0 ? 1_100 : 450)
        clock.advance(6_000)
        at += took
        emit({ type: 'entries', index, entries })
        emit({ type: 'batch-done', index, problems: PROBLEMS_PER_BATCH[i]!, at })
        await drive.shot(i === of - 1 ? 500 : 700)
      }
      emit({ type: 'written', file: summary.problemsFile! })
      emit({ type: 'done', summary })
      return summary
    },
  }),
  async play(drive) {
    await drive.waitFor('Review a submitted .po')
    await drive.shot(2_800)
    await drive.press('r')
    await drive.waitFor('Browsing')
    await drive.shot(900)
    await drive.press(KEY.down)
    await drive.shot(1_000)
    await drive.press(KEY.enter)
    await drive.waitFor('Start review')
    await drive.shot(1_300)
    await drive.press(KEY.down, KEY.down, KEY.down, KEY.down)
    await drive.shot(900)
    await drive.press(KEY.enter)
    await drive.waitFor('Message for the requester')
    await drive.shot(5_500)
    await drive.press(KEY.enter)
    await drive.waitFor('Review a submitted .po')
    await drive.shot(1_500)
  },
}

/** A fresh install: no tui.json, so the setup wizard opens at its first step. */
export const setup: TuiScenario = {
  name: 'setup',
  columns: 100,
  rows: 24,
  config: {},
  commands: () => ({
    discoverAgents: async () => AGENTS,
    // No local model server running, which is the common case and keeps the
    // build from probing ports on whatever machine runs it.
    discoverModels: async () => [],
    glossaryCount: () => undefined,
    memoryCount: () => undefined,
    hasLocaleRules: () => false,
    localeConfigured: () => false,
  }),
  async play(drive) {
    await drive.waitFor('Locale')
    await drive.press('n', 'l')
    await drive.shot(0)
  },
}

export const TUI_SCENARIOS: readonly TuiScenario[] = [reviewFlow, setup]
