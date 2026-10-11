import { Box, Text } from 'ink'
import { useState } from 'react'
import type { ReviewEntry, ReviewEntryOutcome, ReviewEvent, ReviewSummary } from '../../types.js'
import type { Token } from '../../ui/tokens.js'
import { RecentEntries, recentEntries, RECENT_LIMIT, type PanelRow } from './RecentEntries.js'
import { buildReport } from '../../review/message.js'
import { fillTemplate, replyCaution, type Template } from '../../reply/templates.js'
import { copyToClipboard } from '../clipboard.js'
import { openInDefaultApp } from '../open-file.js'
import { renderBar } from './Progress.js'
import { estimateRemainingMs, formatDuration, formatFinishTime } from '../../cli/progress.js'
import { useElapsed } from '../hooks/useElapsed.js'
import { useKeys } from '../hooks/useKeys.js'

export interface ReviewProgressState {
  started: boolean
  file?: string
  total: number
  reviewable: number
  ruleFlagged: number
  suspects: number
  // Settled from the memory without a model. Shown beside the rule counts so a
  // run that sends fewer batches than its size suggests says why.
  memoryApproved: number
  memoryRepaired: number
  problems: number
  unreviewed: number
  batchesDone: number
  batchesTotal: number
  // Work a previous run did, inherited from the job store before this one
  // started. Counted apart from `batchesDone` so the reducer never has to
  // pretend a batch ran that did not.
  skippedBatches: number
  cachedEntries: number
  // A batch has started and not yet finished. The bar cannot move while that is
  // true, so it is what the elapsed clock hangs off.
  inFlight: boolean
  batchIndex: number
  batchDurations: number[]
  remainingMs?: number
  /**
   * What the operator has asked for and the run has not reached yet.
   *
   * Separate from `paused` because the two answer different questions. This is
   * the keypress, acknowledged the instant it lands; `paused` is the run
   * actually parked, which cannot be true until the batch in flight has
   * finished and saved. Collapsing them told somebody who pressed p that the
   * run was parked while it was still spending metered calls, and pressing q
   * said nothing whatsoever for minutes.
   */
  intent?: 'pause' | 'stop'
  paused: boolean
  failures: string[]
  written: string[]
  // Set when the output file from a previous run still carried a marker from
  // before resume moved to the job store. Reviewing from the top either way,
  // but the person waiting on this deserves to know that's what's happening.
  markerIgnored?: string
  summary?: ReviewSummary
}

export function reduceReviewProgress(events: ReviewEvent[]): ReviewProgressState {
  const state: ReviewProgressState = {
    started: false,
    total: 0,
    reviewable: 0,
    ruleFlagged: 0,
    suspects: 0,
    memoryApproved: 0,
    memoryRepaired: 0,
    problems: 0,
    unreviewed: 0,
    batchesDone: 0,
    batchesTotal: 0,
    skippedBatches: 0,
    cachedEntries: 0,
    inFlight: false,
    batchIndex: 0,
    batchDurations: [],
    paused: false,
    failures: [],
    written: [],
  }

  // Only set while a batch is open, so a duration is recorded exactly once and a
  // fixture without timestamps records none rather than NaN.
  let openedAt: number | undefined
  // Feeds the default-pace guess that stands in until a batch has been timed.
  let batchSize = 0

  const close = (at: unknown) => {
    if (typeof openedAt === 'number' && typeof at === 'number') state.batchDurations.push(at - openedAt)
    openedAt = undefined
  }

  for (const e of events) {
    switch (e.type) {
      case 'start':
        state.started = true
        state.file = e.file
        state.total = e.total
        state.reviewable = e.reviewable
        break
      case 'cached':
        state.skippedBatches = e.batches
        state.cachedEntries = e.entries
        break
      case 'rules-done':
        state.ruleFlagged = e.flagged
        state.suspects = e.suspects
        state.memoryApproved = e.memoryApproved ?? 0
        state.memoryRepaired = e.memoryRepaired ?? 0
        state.problems += e.flagged
        break
      case 'batch-start':
        state.batchesTotal = e.of
        state.batchIndex = e.index
        batchSize = e.size
        state.inFlight = true
        openedAt = typeof e.at === 'number' ? e.at : undefined
        break
      case 'batch-done':
        state.batchesDone += 1
        state.problems += e.problems
        state.inFlight = false
        close(e.at)
        break
      case 'batch-failed':
        state.batchesDone += 1
        state.inFlight = false
        close(e.at)
        state.unreviewed += e.size
        state.failures.push(`Batch ${e.index} failed (${e.size} entries): ${e.reason}`)
        break
      case 'written':
        state.written.push(e.file)
        break
      case 'marker-ignored':
        state.markerIgnored = e.file
        break
      // Only the intent is recorded here. The clock stops when the batch it is
      // waiting for closes, because until then the batch really is running and
      // a stopped clock would understate what it cost.
      case 'paused':
        state.intent = 'pause'
        break
      case 'stopping':
        state.intent = 'stop'
        break
      case 'resumed':
        state.intent = undefined
        break
      case 'done':
        state.summary = e.summary
        break
    }
  }

  state.remainingMs = estimateRemainingMs(state.batchDurations, state.batchesTotal - state.batchesDone, batchSize)

  // Parked is the intent having arrived, which it has not while the batch it
  // waits for is still open. A stop never reads as parked: that run is leaving.
  state.paused = state.intent === 'pause' && !state.inFlight

  // An estimate of the hour still to run is noise once the answer is that it
  // is not going to run it.
  if (state.intent) state.remainingMs = undefined

  if (state.summary) {
    state.inFlight = false
    state.remainingMs = undefined
    state.problems = state.summary.problems
    state.unreviewed = state.summary.unreviewed
  }
  return state
}

const REVIEW_TONE: Record<ReviewEntryOutcome, Token> = {
  approved: 'success',
  flagged: 'warn',
  repaired: 'accent',
  unreviewed: 'error',
}

function reviewRow(entry: ReviewEntry): PanelRow {
  return {
    key: entry.key,
    outcome: entry.outcome,
    tone: REVIEW_TONE[entry.outcome],
    msgid: entry.msgid,
    ...(entry.rules ? { detail: entry.rules.join(', ') } : {}),
  }
}

function ruleBreakdown(byRule: Record<string, number>): string[] {
  return Object.entries(byRule)
    .sort(([, a], [, b]) => b - a)
    .map(([rule, n]) => `${rule} ${n}`)
}

/**
 * Where the bar sits, counting the work a previous run already did.
 *
 * Inherited batches are added to both ends rather than left out, so a resumed
 * run opens part way along a bar the same length a first run would have had.
 * Counting from zero out of what is left is accurate and reads as a restart,
 * which is the whole complaint this answers.
 */
export function barDone(state: ReviewProgressState): number {
  return state.skippedBatches + state.batchesDone
}

export function barTotal(state: ReviewProgressState): number {
  return state.skippedBatches + state.batchesTotal
}

/**
 * What a resumed run says it inherited, and what it still has to do.
 *
 * The remaining count is worked out rather than read off the batch total,
 * which is what this run started with and never goes down: ten batches in, it
 * went on claiming all twelve. A failed batch counts as done here, since it is
 * no longer this run's to attempt. And until the first batch has started there
 * is no total to subtract from, the whole rules pass on a large file, so the
 * clause is left off rather than reporting nothing left to a run with all its
 * work ahead of it.
 */
function resumeLine(state: ReviewProgressState): string {
  const judged = `Resuming: ${state.cachedEntries} already judged`
  if (state.batchesTotal === 0) return `${judged}.`
  const left = Math.max(0, state.batchesTotal - state.batchesDone)
  return `${judged}, ${left} ${left === 1 ? 'batch' : 'batches'} left.`
}

export interface ReviewProgressProps {
  events: ReviewEvent[]
  wporgUsername?: string
  // The locale's reply templates, approved first, and the requester's username
  // for {username}. Read by the screen when the run ends, not here, for the
  // same reason as wporgUsername.
  templates?: readonly Template[]
  requester?: string
}

/**
 * `wporgUsername` is threaded in as a prop rather than read from the config
 * here, so this stays a component of its inputs and the tests that render it
 * with a handful of events keep working without a config on disk.
 */
export function ReviewProgress({ events, wporgUsername = '', templates = [], requester = '' }: ReviewProgressProps) {
  const state = reduceReviewProgress(events)
  const elapsed = useElapsed(state.inFlight, state.batchIndex)
  const [copied, setCopied] = useState<'yes' | 'no' | undefined>(undefined)
  const [replyCopied, setReplyCopied] = useState<'yes' | 'no' | undefined>(undefined)
  const [templateIndex, setTemplateIndex] = useState(0)
  const [opened, setOpened] = useState(false)
  const report = state.summary === undefined ? undefined : buildReport(state.summary, wporgUsername)
  // The whole reply, around the report. Unlike the report it is offered on a
  // clean run too, since "no problems, PTE approved" is exactly the reply a
  // clean run wants. Not on a run that stopped early: its unreached entries
  // have been judged by nobody, and the reply would be a verdict on them.
  const template = templates[templateIndex % Math.max(1, templates.length)]
  const reply =
    state.summary === undefined || state.summary.pending > 0 || template === undefined
      ? undefined
      : fillTemplate(template.text, {
          ...(requester === '' ? {} : { username: requester }),
          repaired: state.summary.repaired,
          flagged: state.summary.needsReview + state.summary.unreviewed,
          results: report ?? '',
        })
  // The repaired file, which is the thing worth opening: the submission itself is
  // unchanged on disk and reviewing it again would show none of this run's work.
  const repairedFile = state.summary?.problemsFile

  // Both only once the run is over. During it the keys belong to pause, resume
  // and stop, and a c or an o that silently did nothing would still have to be
  // explained to whoever pressed it.
  useKeys({
    reviewResult: {
      open: repairedFile === undefined ? undefined : () => setOpened(openInDefaultApp(repairedFile)),
      copy: report === undefined ? undefined : () => setCopied(copyToClipboard(report) ? 'yes' : 'no'),
      reply: reply === undefined ? undefined : () => setReplyCopied(copyToClipboard(reply) ? 'yes' : 'no'),
      // A copy confirmation belongs to the text it copied, so switching clears it.
      template:
        reply === undefined || templates.length < 2
          ? undefined
          : () => {
              setTemplateIndex((i) => (i + 1) % templates.length)
              setReplyCopied(undefined)
            },
    },
  })

  if (!state.started) return <Text dimColor>Starting…</Text>

  const { summary } = state
  const breakdown = summary ? ruleBreakdown(summary.byRule) : []

  return (
    <Box flexDirection="column">
      {/* The bar already shows the completed fraction, so the text carries one
          counter: which batch is running, or how many are finished. Showing both
          reads as a contradiction (2/8 next to batch 3/8). */}
      <Text>
        {renderBar(barDone(state), barTotal(state) || 1)}{' '}
        {state.paused
          ? `paused after batch ${barDone(state)}/${barTotal(state)}`
          : state.inFlight
            ? `batch ${state.skippedBatches + state.batchIndex}/${barTotal(state)} · reviewing ${elapsed}s`
            : `${barDone(state)}/${barTotal(state)} batches`}
        {/* Said on the same line as the counter rather than below it, where a
            person watching a bar that has not moved is already looking. It
            takes the place of the remaining-time estimate, which the reducer
            drops for the same reason, so the line does not grow and wrap. */}
        {state.intent && state.inFlight
          ? state.intent === 'stop'
            ? ' · will stop after this batch'
            : ' · will pause after this batch'
          : ''}
        {state.remainingMs === undefined
          ? ''
          : ` · ~${formatDuration(state.remainingMs)} left, done by ${formatFinishTime(state.remainingMs)}`}{' '}
        · problems {state.problems}
      </Text>
      {/* Both counts, because they mean different things and one of them is
          usually zero. `wrong` is what the rules proved: an error-severity
          finding, whose verdict is settled before any model sees it. `suspect`
          is what they want a second opinion on. The four rules that fire most
          on a Turkish submission are all suspect severity, so showing only the
          first reported "0 flagged by rules" on a file where the rules had
          flagged 5,529 of 9,826 entries. */}
      <Text dimColor>
        {state.file} · {state.total} entries, {state.reviewable} reviewable · rules: {state.ruleFlagged} wrong,{' '}
        {state.suspects} suspect
        {/* Only when it settled something, so a file the memory has never seen
            does not carry a line of zeros. */}
        {state.memoryApproved + state.memoryRepaired > 0
          ? ` · memory: ${state.memoryApproved} approved, ${state.memoryRepaired} repaired`
          : ''}
      </Text>
      {/* Only when something was inherited. A cold run saying "0 already
          judged" would be noise on every first review. */}
      {state.cachedEntries > 0 && <Text color="green">{resumeLine(state)}</Text>}

      {/* Until the summary, which needs the room for the requester message. */}
      {!summary && <RecentEntries rows={recentEntries<ReviewEntry>(events, RECENT_LIMIT).map(reviewRow)} />}

      {state.markerIgnored && (
        <Text color="yellow">
          Ignoring the unfinished review in {state.markerIgnored}: it was written by an earlier version. Reviewing
          from the top.
        </Text>
      )}

      {state.failures.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">Not reviewed:</Text>
          {state.failures.map((f, i) => (
            <Text key={i} color="yellow">
              {'  - '}
              {f}
            </Text>
          ))}
        </Box>
      )}

      {summary && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>
            Done. {summary.problems + summary.needsReview} problems, {summary.approvable} approvable,{' '}
            {summary.skipped} not submitted
            {summary.unreviewed > 0 ? `, ${summary.unreviewed} unreviewed` : ''}.
          </Text>
          {summary.needsReview > 0 && (
            <Text color="yellow">
              {summary.needsReview} of those are unadjudicated guesses; re-run without “skip AI checks” to have them
              decided.
            </Text>
          )}
          {summary.pending > 0 && (
            <Text color="yellow">
              Stopped early with {summary.pending} entries not reviewed. Run it again to carry on.
            </Text>
          )}
          {summary.repaired > 0 && (
            <Text color="green">
              {summary.repaired} repaired, {summary.written - summary.repaired} left for you.
            </Text>
          )}
          {breakdown.length > 0 && <Text>{breakdown.join(' · ')}</Text>}
          {report && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>Message for the requester · c to copy</Text>
              <Text>{report}</Text>
              {copied === 'yes' && <Text color="green">Copied to the clipboard.</Text>}
              {copied === 'no' && (
                <Text color="yellow">Could not reach the clipboard; copy the line above by hand.</Text>
              )}
            </Box>
          )}
          {reply !== undefined && template !== undefined && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>
                Reply · {template.name} template · y to copy{templates.length > 1 ? ' · t for the next template' : ''}
              </Text>
              {replyCaution(summary) !== undefined && <Text color="yellow">{replyCaution(summary)}</Text>}
              {/* Unstyled, and copied exactly as filled: Ink may wrap it to
                  the terminal on screen, but the clipboard gets the text with
                  its own line breaks and nothing else. */}
              <Text>{reply}</Text>
              {replyCopied === 'yes' && <Text color="green">Reply copied to the clipboard.</Text>}
              {replyCopied === 'no' && (
                <Text color="yellow">Could not reach the clipboard; copy the reply above by hand.</Text>
              )}
            </Box>
          )}
          {/* The Requester field and the reply only appear once a template
              exists, so without this a person who never uses the CLI would
              never learn either is there. Not on a stopped run, which gets
              no reply even with templates. */}
          {templates.length === 0 && summary.pending === 0 && (
            <Box marginTop={1}>
              <Text dimColor>No reply template for this locale yet. Create one in Configuration › Reply templates.</Text>
            </Box>
          )}
          {summary.problemsFile ? (
            <>
              <Text>Wrote {summary.problemsFile}.</Text>
              <Text dimColor>o to open it in your .po editor</Text>
              {opened && <Text color="green">Opening it now.</Text>}
            </>
          ) : (
            summary.pending === 0 && <Text color="green">Nothing flagged; the whole submission looks approvable.</Text>
          )}
        </Box>
      )}
    </Box>
  )
}
