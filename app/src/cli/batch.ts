import { agentBinOverride } from '../agent/providers.js'
import type { ProviderCheck } from '../agent/agy-check.js'
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
import { errorLine } from '../ui/messages.js'

/** What a batch on the command line needs from the CLI: fetch's and review's. */
export interface BatchCli {
  stdin: NodeJS.ReadableStream & KeyStream
  config: () => PolyglotsConfig
  reviewFile: typeof reviewFile
  translate: typeof translateFile
  // Records the batch's runs as stopped if a signal ends it; see stopOnSignal.
  stopRunsOnSignal: () => () => void
  // The antigravity check; see startProviderCheck.
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
 * The antigravity check, started the moment a run is settled enough to be
 * worth one and handed to it unawaited. The run awaits it only just before
 * its first call to the agent, so it runs beside everything that comes first:
 * the file read, review's rules pass, translate's memory lookups and its
 * first batch's drafts, and for fetch the project lookups and downloads as
 * well. A run the cache answers in full never awaits it at all. Undefined for
 * any other provider, which is never asked. Never rejects: a check that
 * throws is a check with no answer, and no answer never blocks a run.
 */
export function startProviderCheck(
  cli: Pick<BatchCli, 'config' | 'checkProvider'>,
  reachesAgent: boolean,
): Promise<ProviderCheck | undefined> | undefined {
  if (!reachesAgent || cli.config().reviewProvider !== 'antigravity') return undefined
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
 * file as it starts and ends, and each item's ending returned in order.
 *
 * Progress is one line per item on stderr rather than the per-batch bar a
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
  const control: RunControl = createRunControl()
  const unwatchKeys = watchKeys(cli.stdin, control, {
    onInterrupt: () => {
      unwatchKeys()
      process.kill(process.pid, 'SIGINT')
    },
  })
  const unwatchSignals = cli.stopRunsOnSignal()
  const unsubscribe = control.subscribe((state: RunState) => {
    if (state === 'paused') cli.err(`Pausing every running ${opts.noun} after its current batch. Press p to resume.`)
    if (state === 'running') cli.err('Resumed.')
    if (state === 'stopping') cli.err(`Stopping after the current batches. ${capitalise(opts.noun)}s not started yet will not start.`)
  })
  const { kept, noun: _noun, debug: flag, ...batch } = opts
  let finished = 0
  // Said once, on the first file it stopped. With several files running at
  // once each meets the same refusal, and the table still names it per line.
  let refusalSaid = false
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
        onWarn: (line) => cli.err(line),
        ...(cli.onRunStarted === undefined ? {} : { onRunStarted: cli.onRunStarted }),
        onEvent: (e) => {
          if (e.type === 'start') {
            const note = kept?.has(e.item.file) ? ' (existing file kept)' : ''
            cli.err(`Started ${e.item.input}${note}`)
          } else {
            finished += 1
            if (e.outcome.state === 'stopped' && e.outcome.reason !== undefined && !refusalSaid) {
              refusalSaid = true
              cli.err(errorLine(cli.ui.err, e.outcome.reason))
            }
            cli.err(`[${finished}/${items.length}] ${e.item.input}: ${tallyCell(cli.ui.err, e.outcome.state)}`)
          }
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
