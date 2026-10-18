import { agentBinOverride } from '../agent/providers.js'
import { hasProviderCheck, type ProviderCheck } from '../agent/agy-check.js'
import { debugEnabled } from '../logs/debug.js'
import { MAX_PARALLEL, runFileBatch, type BatchItem, type FileBatchOptions } from '../commands/batch.js'
import { tallyOf, type ProjectEnd } from '../commands/fetch-report.js'
import type { reviewFile } from '../commands/review.js'
import type { translateFile } from '../commands/translate.js'
import { createRunControl, type RunControl, type RunState } from '../run-control.js'
import type { PolyglotsConfig } from '../types.js'
import { table } from '../ui/layout.js'
import type { Painter } from '../ui/paint.js'
import { UsageError, parsePositiveInt } from './args.js'
import { watchKeys, type KeyStream } from './keys.js'
import { replyCaution } from '../reply/templates.js'
import { fetchTally, tallyCell } from './summaries.js'
import { errorLine, warnLine } from '../ui/messages.js'
import { countEntries } from '../po/count.js'
import { formatDuration } from './progress.js'

/** What a batch on the command line needs from the CLI: fetch's and review's. */
export interface BatchCli {
  stdin: NodeJS.ReadableStream & KeyStream
  config: () => PolyglotsConfig
  reviewFile: typeof reviewFile
  translate: typeof translateFile
  // Records the batch's runs as stopped if a signal ends it; see stopOnSignal.
  stopRunsOnSignal: () => () => void
  // The provider check, antigravity's or codex's; see startProviderCheck.
  checkProvider: () => Promise<ProviderCheck>
  // Told each file's run id as it starts, for the problem report offered
  // after the batch (src/cli/problem-report.ts).
  onRunStarted?: (runId: number) => void
  // Read for POLYGLOTS_DEBUG; process.env when not given.
  env?: NodeJS.ProcessEnv
  ui: { out: Painter; err: Painter }
  out(line: string): void
  err(line: string): void
}

/** --parallel, on fetch and on a review of several files. */
export function parseParallel(raw: string | undefined): number {
  const parallel = raw === undefined ? 1 : parsePositiveInt('--parallel', raw)
  if (parallel > MAX_PARALLEL) {
    throw new UsageError(
      `--parallel is at most ${MAX_PARALLEL}; past that the provider's rate limit sets the pace, not the job count`,
    )
  }
  return parallel
}

/**
 * The provider check, started the moment a run is settled enough to be
 * worth one and handed to it unawaited. The run awaits it only just before
 * its first call to the agent, so it runs beside everything that comes first:
 * the file read, review's rules pass, translate's memory lookups and its
 * first batch's drafts, and for fetch the project lookups and downloads as
 * well. A run the cache answers in full never awaits it at all. Undefined for
 * a provider with no check (hasProviderCheck), which is never asked. Never rejects: a check that
 * throws is a check with no answer, and no answer never blocks a run.
 */
export function startProviderCheck(
  cli: Pick<BatchCli, 'config' | 'checkProvider'>,
  reachesAgent: boolean,
): Promise<ProviderCheck | undefined> | undefined {
  if (!reachesAgent || !hasProviderCheck(cli.config().reviewProvider)) return undefined
  try {
    return cli.checkProvider().catch(() => undefined)
  } catch {
    return undefined
  }
}

const EXIT_OK = 0
const EXIT_ERROR = 1
const EXIT_STOPPED = 3

/**
 * Runs a batch on the command line: keys and signals watched, one line per
 * file as it starts and ends and one per batch it closes, and each item's
 * ending returned in order.
 *
 * Progress is printed as lines on stderr rather than the per-batch bar a
 * single run draws. Several jobs redrawing one bar line at once would garble
 * it, and with one slot the start and end lines read as a queue.
 */
export async function runBatchJobs(
  cli: BatchCli,
  items: BatchItem[],
  // debug here is the --debug flag alone; config and POLYGLOTS_DEBUG are
  // added below, so fetch, which has no flag, still honours both.
  opts: Omit<FileBatchOptions, 'control' | 'onEvent' | 'onProgress' | 'onWarn' | 'wporgUsername' | 'bin' | 'onRunStarted'> & {
    // Files that were already there and kept, which fetch notes as they start.
    kept?: ReadonlySet<string>
    noun: string
  },
): Promise<ProjectEnd[]> {
  // Before the keys and signals are watched, which only the finally below
  // lets go of: nothing here may throw outside it.
  const control: RunControl = createRunControl()
  const lines = await batchLines(cli, items, {
    parallel: opts.parallel,
    action: opts.review ? 'review' : 'translate',
    held: () => (control.state === 'paused' ? 'pause' : control.state === 'stopping' ? 'stop' : undefined),
  })
  const unwatchKeys = watchKeys(cli.stdin, control, {
    onInterrupt: () => {
      unwatchKeys()
      process.kill(process.pid, 'SIGINT')
    },
  })
  const unwatchSignals = cli.stopRunsOnSignal()
  // Said once, on the first file it stopped. With several files running at
  // once each meets the same refusal, and the table still names it per line.
  // Read by the stopping notice too: a refusal stops the batch through the
  // same control as q, and runFileBatch ends the refused file before it calls
  // stop, so this is already set when the notice would print. The person
  // pressed nothing, and the refusal line has said what to do.
  let refusalSaid = false
  const unsubscribe = control.subscribe((state: RunState) => {
    if (state === 'paused') cli.err(`Pausing every running ${opts.noun} after its current batch. Press p to resume.`)
    if (state === 'running') cli.err('Resumed.')
    if (state === 'stopping' && !refusalSaid) cli.err(`Stopping after the current batches. ${capitalise(opts.noun)}s not started yet will not start.`)
  })
  const { kept, noun: _noun, debug: flag, ...batch } = opts
  let finished = 0
  try {
    return await runFileBatch(
      items,
      { reviewFile: cli.reviewFile, translateFile: cli.translate },
      {
        ...batch,
        control,
        // Translate's review pass and a review both run the configured
        // provider, so the override is resolved for that one, the same way
        // the single-file commands do it.
        bin: agentBinOverride(cli.config().reviewProvider, process.env),
        wporgUsername: cli.config().wporgUsername,
        debug: debugEnabled({ ...(flag === undefined ? {} : { flag }), config: cli.config(), env: cli.env ?? process.env }),
        onWarn: (line) => cli.err(warnLine(cli.ui.err, line)),
        ...(cli.onRunStarted === undefined ? {} : { onRunStarted: cli.onRunStarted }),
        onProgress: lines.onProgress,
        onEvent: (e) => {
          // Called from the pool between files, so a throw here would end
          // the whole batch over a line of output, as a throw from the batch
          // lines would fail a file. Every outcome is still in the table at
          // the end; only the line is lost.
          //
          // The count goes first and outside any try, and the batch lines
          // get a try of their own: in one try with the count after them, a
          // throw from their bookkeeping skipped the count, and every [n/N]
          // after it was one too low.
          if (e.type === 'end') finished += 1
          try {
            lines.onEvent(e)
          } catch {}
          try {
            if (e.type === 'start') {
              const note = kept?.has(e.item.file) ? ' (existing file kept)' : ''
              cli.err(`Started ${e.item.input}${note}`)
            } else {
              if (e.outcome.state === 'stopped' && e.outcome.reason !== undefined && !refusalSaid) {
                refusalSaid = true
                cli.err(errorLine(cli.ui.err, e.outcome.reason))
              }
              cli.err(`[${finished}/${items.length}] ${e.item.input}: ${tallyCell(cli.ui.err, e.outcome.state)}`)
            }
          } catch {}
        },
      },
    )
  } finally {
    unwatchSignals()
    unsubscribe()
    unwatchKeys()
  }
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * One line each time a file closes a batch, done, given up or skipped: the
 * file, the batch, how long the file has run, and the batch screen's overall
 * line, with its second line (the estimate and the failed batches) after it
 * whenever that says something the last one did not.
 *
 * At a batch's end rather than on a clock: a line a second from several jobs
 * would bury the start and end lines and the warnings, and a pipe or a log
 * file has no use for a ticking clock. A file stuck in one batch prints
 * nothing until it closes, which is the limit of a line printer; the run log
 * is where a hang is read back.
 *
 * The overall line comes from the same store and the same sums as the TUI's
 * batch screen, so the two can never disagree on a count or an estimate. That
 * module reduces events with the single-file screens' reducers, which live
 * beside their Ink components, so it is loaded here only when a batch runs:
 * importing it at the top would put Ink and React on the start-up path of
 * every command, which cli.ts goes out of its way to avoid.
 */
async function batchLines(
  cli: Pick<BatchCli, 'err'>,
  items: BatchItem[],
  // The batch's pause or stop, read at each line. The runs never report it
  // in their own events: the batch holds the control and they only act on it
  // at their next boundary, so a batch closed during a pause printed an
  // estimate that counted down as if the run went on. The batch screen
  // passes the same state to overall().
  opts: { parallel: number; action: 'review' | 'translate'; held: () => 'pause' | 'stop' | undefined },
): Promise<{
  onProgress: NonNullable<FileBatchOptions['onProgress']>
  onEvent: NonNullable<FileBatchOptions['onEvent']>
}> {
  const { createEventStore, overall, overallLines } = await import('../tui/batch-progress.js')
  const store = createEventStore(opts.action)
  // A queued file is estimated from its entry count. Fetch's files are not
  // downloaded yet when this runs and count as nothing, as on the batch
  // screen, so a fetch's estimate leaves out the files still queued and is
  // short by them until they start.
  for (const item of items) store.queue(item.input, countEntries(item.file) ?? 0)
  const startedAt = Date.now()
  const inputOf = new Map(items.map((item) => [item.file, item.input]))
  let lastSecond = ''

  return {
    onProgress: (file) => {
      const input = inputOf.get(file) ?? file
      return (e) => {
        // This runs inside the run's onProgress, so anything it throws
        // reaches the batch loop and fails a file whose batches are paid for
        // and fine, over a line of output. The store, the sums and a closed
        // stderr are all this code's own failures, not the run's: the line is
        // dropped and the run goes on. The run log still has the batch.
        try {
          store.push(input, e)
          if (e.type !== 'batch-done' && e.type !== 'batch-failed' && e.type !== 'batch-skipped') return
          const track = store.tracks().find((t) => t.input === input)!
          let of: number | undefined
          for (const seen of track.events) if (seen.type === 'batch-start') of = seen.of
          const elapsed = track.startedAt === undefined ? '' : ` · ${formatDuration(e.at - track.startedAt)}`
          const held = opts.held()
          const [first, second] = overallLines(
            overall(store.tracks(), { parallel: opts.parallel, now: e.at, startedAt, action: opts.action, ...(held === undefined ? {} : { held }) }),
            e.at,
          )
          cli.err(`${input} · batch ${e.index}${of === undefined ? '' : `/${of}`}${elapsed} · ${first}`)
          if (second !== '' && second !== lastSecond) cli.err(second)
          lastSecond = second
        } catch {}
      }
    },
    onEvent: (e) => {
      if (e.type === 'start') store.start(e.item.input, Date.now())
      else store.finish(e.item.input, Date.now())
    },
  }
}

/**
 * The end of a batch: how each line ended, the requester messages, the
 * tally, and the exit code that goes with it.
 *
 * One message per reviewed line, because each goes back to a different
 * contributor. Printed rather than copied, as for a single review. With a
 * reply template, the line's reply is printed instead of its message, which
 * the reply already holds, as reviewSummary does for one file.
 */
export function printBatchEnd(
  cli: Pick<BatchCli, 'ui' | 'out'>,
  rows: Array<{ input: string; end: ProjectEnd }>,
  verb: string,
  replyOf: (end: ProjectEnd) => { name: string; text: string } | undefined = () => undefined,
): number {
  cli.out('')
  for (const line of table(rows.map((r) => [r.input, tallyCell(cli.ui.out, r.end.tally), r.end.detail]), { indent: 2 })) cli.out(line)
  for (const { input, end } of rows) {
    const reply = replyOf(end)
    if (reply) {
      cli.out('')
      cli.out(cli.ui.out.paint('heading', `Reply (${input}, ${reply.name} template):`))
      // Above the text rather than in it: the reply is copied as printed.
      const caution = end.review ? replyCaution({ needsReview: end.review.flagged, unreviewed: 0 }) : undefined
      if (caution) cli.out(cli.ui.out.paint('warn', caution))
      cli.out(reply.text)
      continue
    }
    if (!end.message) continue
    cli.out('')
    cli.out(`Message for the requester (${input}):`)
    cli.out(end.message)
  }
  const tally = tallyOf(rows.map((r) => r.end))
  cli.out('')
  for (const line of fetchTally(cli.ui.out, tally, verb)) cli.out(line)
  if (tally.failed > 0 || rows.some((r) => r.end.refused)) return EXIT_ERROR
  return tally.stopped > 0 ? EXIT_STOPPED : EXIT_OK
}
