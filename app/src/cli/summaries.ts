import type { TranslateSummary } from '../commands/translate.js'
import { fuzzyTotal } from '../commands/translate-counts.js'
import type { ReviewSummary } from '../types.js'
import type { Tally } from '../commands/fetch-report.js'
import type { StatsSummary } from '../commands/stats.js'
import { box, displayWidth, padTo, sparkline, table } from '../ui/layout.js'
import { hintLine, nextLine } from '../ui/messages.js'
import type { Painter } from '../ui/paint.js'
import { replyCaution } from '../reply/templates.js'
import { PATTERN_BUDGET_MS } from '../rules/sandbox.js'

// A locale rule the sandbox gave up on, one line per rule and outside the
// box: it is not a count but something to fix in the rules file, and the
// entry where it hung carries the same words in the output file.
export function skippedRuleLines(p: Painter, labels: readonly string[] | undefined): string[] {
  return (labels ?? []).map((label) => `${p.paint('warn', p.glyphs.warn)} ${skippedRuleText(label)}`)
}

export const skippedRuleText = (label: string) => `locale rule skipped (took longer than ${PATTERN_BUDGET_MS} ms): ${label}`

// Each command's closing block, as pure functions of a painter and a summary.
// Kept out of cli.ts so they can be tested with colour forced on and off
// without running a command, and so the TUI can reuse the wording later.

// One count for every fuzzy entry, since each is as much to check before
// upload, with the memory's share named: those are a choice between approved
// wordings rather than a draft, and read differently.
function fuzzyRow(p: Painter, s: TranslateSummary): string[] {
  const total = fuzzyTotal(s)
  if (total === 0) return ['fuzzy', '0', '']
  const note = s.fromTmFuzzy ? `check before upload; ${s.fromTmFuzzy} from TM` : 'check before upload'
  return ['fuzzy', p.paint('warn', String(total)), p.paint('muted', note)]
}

export function translateSummary(p: Painter, s: TranslateSummary, dryRun: boolean): string[] {
  const title = s.stopped
    ? `${p.paint('warn', p.glyphs.warn)} Stopped`
    : dryRun
      ? `${p.paint('accent', p.glyphs.bullet)} Dry run`
      : `${p.paint('success', p.glyphs.ok)} Done`
  const rows = table(
    [
      ['translated', String(s.translated)],
      ['from TM', String(s.fromTm)],
      fuzzyRow(p, s),
      ['skipped', String(s.skipped)],
      // Only on a memory-only run, which is the one run that leaves entries
      // alone by design. Every other run's table is unchanged.
      ...(s.untranslated === undefined
        ? []
        : [['untranslated', String(s.untranslated), s.untranslated > 0 ? p.paint('muted', 'no memory match; left for you') : '']]),
      // Only when a fix pattern changed something, so a locale without fixes
      // reads as it always has. Each such entry carries a note in the file.
      ...(s.fixedByRules === undefined ? [] : [['fixed by locale rules', String(s.fixedByRules)]]),
    ],
    { align: ['left', 'right', 'left'] },
  )
  const next =
    dryRun ? 'Nothing was written.'
    : s.stopped ? 'Re-run the same command to resume.'
    : `Open ${p.paint('path', s.file)} in your .po editor to review.`
  return [...box(p, title, rows), ...skippedRuleLines(p, s.skippedRules), nextLine(p, next)]
}

export interface ReviewSummaryOptions {
  // reviewProvider is none: the run was rules-only by standing choice, so the
  // advice to re-run with AI would point at something the person opted out of.
  noReviewer?: boolean
  // The filled reply template, printed instead of the requester message it
  // contains. Only the label is painted: the text is HTML bound for an o2
  // comment and goes out exactly as filled, never wrapped or coloured, so
  // what the terminal shows is what a copy of it pastes.
  reply?: { name: string; text: string }
}

export function reviewSummary(
  p: Painter,
  s: ReviewSummary,
  requesterMessage: string | undefined,
  opts: ReviewSummaryOptions = {},
): string[] {
  // Undecided entries are written beside decided ones, so flagged is both.
  const flagged = s.problems + s.needsReview
  const stopped = s.pending > 0
  const title = stopped ? `${p.paint('warn', p.glyphs.warn)} Stopped early` : `${p.paint('success', p.glyphs.ok)} Reviewed`
  const rows: string[][] = [
    ['reviewed', String(s.reviewed), p.paint('muted', `${s.skipped} not submitted`)],
    ['flagged', flagged > 0 ? p.paint('warn', String(flagged)) : '0', ''],
    // Green says "there is something here you can approve", so a zero stays
    // plain, the way a zero flagged count does.
    ['approvable', s.approvable > 0 ? p.paint('success', String(s.approvable)) : '0', ''],
  ]
  if (s.needsReview > 0) {
    const advice = opts.noReviewer ? 'yours to judge; marked in the file' : 're-run without --no-ai to decide them'
    rows.push(['guesses', String(s.needsReview), p.paint('muted', advice)])
  }
  if (s.unreviewed > 0) rows.push(['unreviewed', p.paint('warn', String(s.unreviewed)), p.paint('muted', 'could not be reviewed; flagged')])
  if (stopped) rows.push(['not reached', p.paint('warn', String(s.pending)), ''])
  // written - repaired, not flagged - repaired: a whitespace-only fix is neither
  // a problem nor a needsReview entry, so flagged - repaired can go negative.
  if (s.repaired > 0) rows.push(['repaired', String(s.repaired), p.paint('muted', `${s.written - s.repaired} left for you`)])
  const out = [...box(p, title, table(rows, { align: ['left', 'right', 'left'] })), ...skippedRuleLines(p, s.skippedRules)]
  // The reply instead of the message, not under it: the reply already holds
  // the message, and printing both put the same sentence on screen twice.
  if (opts.reply) {
    out.push('')
    out.push(p.paint('heading', `Reply (${opts.reply.name} template):`))
    // Above the text rather than in it: the reply is copied as printed.
    const caution = replyCaution(s)
    if (caution) out.push(p.paint('warn', caution))
    out.push(opts.reply.text, '')
  } else if (requesterMessage) out.push('', p.paint('heading', 'Message for the requester:'), requesterMessage, '')
  // A stopped run that found something says both: the file holds what was
  // found so far, and the rest still needs a run. Only a run that reached the
  // end may call the rest approvable, since a stopped one has entries nothing
  // has looked at.
  if (s.problemsFile) out.push(nextLine(p, `Wrote ${p.paint('path', s.problemsFile)}`))
  if (stopped) out.push(nextLine(p, 'Re-run the same command to carry on.'))
  else if (!s.problemsFile) out.push(nextLine(p, 'Nothing flagged; the whole submission looks approvable.'))
  return out
}

// A project's outcome word, coloured by how it ended. Skipped is muted rather
// than a warning: a project with nothing waiting is a normal answer.
export function tallyCell(p: Painter, tally: string): string {
  if (tally === 'done') return p.paint('success', tally)
  if (tally === 'failed') return p.paint('error', tally)
  if (tally === 'stopped') return p.paint('warn', tally)
  return p.paint('muted', tally)
}

// Titled by the worst outcome, since that is the one needing action.
// Titled by the verb of the command that ran the batch: a fetch, or a review
// of several local files, which shares everything after the downloads.
export function fetchTally(p: Painter, t: Tally, verb = 'Fetched'): string[] {
  const title =
    t.failed > 0 ? `${p.paint('error', p.glyphs.fail)} ${verb} with failures`
    : t.stopped > 0 ? `${p.paint('warn', p.glyphs.warn)} Stopped`
    : `${p.paint('success', p.glyphs.ok)} ${verb}`
  const rows = table(
    [['done', String(t.done)], ['failed', String(t.failed)], ['skipped', String(t.skipped)], ...(t.stopped > 0 ? [['stopped', String(t.stopped)]] : [])],
    { align: ['left', 'right'] },
  )
  const out = box(p, title, rows)
  if (t.stopped > 0) out.push(nextLine(p, 'Run the same list again to carry on.'))
  return out
}

const n = (v: number) => v.toLocaleString('en')

// The numbers both endings share: the totals box, the top projects and the
// unfinished-review hint. Empty means nothing has been recorded at all, which
// each caller words for its own ending.
function statsBody(p: Painter, s: Omit<StatsSummary, 'file'>): string[] {
  const rows: string[][] = []
  if (s.submissions > 0) {
    const rate = s.entries === 0 ? 0 : Math.round((s.flagged / s.entries) * 100)
    rows.push(['submissions', n(s.submissions)], ['entries', n(s.entries)], ['flagged', `${n(s.flagged)}`, p.paint('muted', `${rate}%`)])
  }
  const reviewRows = rows.length
  if (s.translateRuns > 0) rows.push(['translate runs', n(s.translateRuns)], ['drafted', n(s.translateEntries)])
  const lines = table(rows, { align: ['left', 'right', 'left'] })
  // The sparkline is kept out of the table. As a cell of the counts column it
  // was the widest thing in it, and right-aligning every count to its width
  // left the numbers a dozen columns from their labels. Drawn as its own line,
  // it starts where the counts column starts and runs on past it.
  if (s.submissions > 0 && s.weeks.length > 0) {
    const labelWidth = Math.max(...rows.map((r) => displayWidth(r[0]!)))
    const spark = p.paint('accent', sparkline(s.weeks, p.glyphs.spark))
    lines.splice(reviewRows, 0, `${padTo('weekly', labelWidth)}  ${spark}  ${p.paint('muted', `last ${s.weeks.length} weeks`)}`)
  }
  const out = box(p, `${p.paint('accent', p.glyphs.bullet)} Statistics`, lines)
  if (s.topProjects.length > 0) {
    out.push('', p.paint('heading', 'Top projects'))
    out.push(...table(
      s.topProjects.map((r) => [r.project, `${n(r.entries)} entries`, `${r.entries === 0 ? 0 : Math.round((r.flagged / r.entries) * 100)}% flagged`]),
      { indent: 2, align: ['left', 'right', 'right'] },
    ))
  }
  return out
}

const nothingRecorded = (s: Omit<StatsSummary, 'file'>): boolean => s.submissions === 0 && s.translateRuns === 0

const incompleteHint = (p: Painter, s: Omit<StatsSummary, 'file'>): string[] =>
  s.incomplete > 0 ? [hintLine(p, `${s.incomplete} unfinished ${s.incomplete === 1 ? 'review is' : 'reviews are'} left out of the totals.`)] : []

export function statsSummary(p: Painter, s: StatsSummary): string[] {
  if (nothingRecorded(s)) {
    return [nextLine(p, `Nothing recorded yet. Wrote ${p.paint('path', s.file)} anyway; it will fill in as you work.`)]
  }
  return [...statsBody(p, s), ...incompleteHint(p, s), nextLine(p, `Wrote ${p.paint('path', s.file)}`)]
}

// The ending while the page is served rather than written: where it is, and
// how to stop the server, since the command keeps running until Ctrl+C.
export function statsServingSummary(
  p: Painter,
  s: Omit<StatsSummary, 'file'>,
  url: string,
  opened: boolean,
  sharedWith?: { pid: number },
): string[] {
  const body = nothingRecorded(s) ? [nextLine(p, 'Nothing recorded yet. The page fills in as you work.')] : statsBody(p, s)
  const open = opened ? 'Opened in your browser.' : 'Open it in a browser.'
  return [
    ...body,
    ...incompleteHint(p, s),
    nextLine(p, `Serving ${p.paint('path', url)}`),
    hintLine(
      p,
      sharedWith
        ? `${open} It is served by another polyglots (pid ${sharedWith.pid}) and stops when that one quits.`
        : `${open} Ctrl+C to stop.`,
    ),
  ]
}
