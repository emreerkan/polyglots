import { text } from 'node:stream/consumers'
import { localReviewBatchSize } from '../review/local.js'
import { batchAdvice } from '../agent/providers.js'
import { defaultOutDir, type fetchProjects, type resolveProjects, type Fetched, type Resolution } from '../commands/fetch.js'
import { describeResolution, endOfResolution, waitNotice, type ProjectEnd } from '../commands/fetch-report.js'
import { loadSecrets } from '../config.js'
import { loadLocaleRules } from '../rules/load.js'
import { parseProjectLines, type FetchStatus } from '../wporg/projects.js'
import { UsageError, parseDraftEngine, parsePositiveInt, secretForEngine } from './args.js'
import { parseParallel, printBatchEnd, runBatchJobs, type BatchCli } from './batch.js'
import { requireLocale } from './locale.js'
import { warnLine } from '../ui/messages.js'
import { table } from '../ui/layout.js'
import type { checkLocalModel } from '../draft/discover.js'
import { localModelId, resolveLocalTarget } from '../draft/local-chat.js'
import { warnAboutLocalModel, warnAboutLocalReview, warnUniversalOnly } from './run-notices.js'

export interface FetchFlags {
  get?: string
  parallel?: string
  outDir?: string
  force?: boolean
  batchSize?: string
  fresh?: boolean
  ai?: boolean
  draftEngine?: string
  locale?: string
}

export interface FetchCli extends BatchCli {
  resolveProjects: typeof resolveProjects
  fetchProjects: typeof fetchProjects
  checkLocalModel: typeof checkLocalModel
}

function parseFetchStatus(raw: string | undefined): FetchStatus {
  if (raw === 'waiting' || raw === 'untranslated') return raw
  throw new UsageError(
    raw === undefined
      ? '--get is required: waiting (to review) or untranslated (to translate)'
      : `--get must be waiting (to review) or untranslated (to translate), got "${raw}"`,
  )
}

/**
 * `polyglots fetch`: resolve a list of projects, download their waiting or
 * untranslated strings, and review or translate every one.
 *
 * The status decides the action. Waiting strings are somebody's submission and
 * are reviewed; untranslated ones are translated. Never both, so a run can never
 * translate over the submissions other contributors are waiting on.
 *
 * Both databases are opened once for the batch and handed to every job. Each
 * job opening its own would put several writers on one WAL file from one
 * process for no gain, and better-sqlite3 is synchronous, so jobs sharing a
 * handle cannot interleave a write.
 *
 * After the downloads it is the same batch a review of several local files
 * runs: runBatchJobs, then printBatchEnd.
 */
export async function runFetch(cli: FetchCli, names: string[], flags: FetchFlags): Promise<number> {
  const status = parseFetchStatus(flags.get)
  const parallel = parseParallel(flags.parallel)
  const config = cli.config()
  const locale = requireLocale(flags.locale, config)
  loadLocaleRules(locale)
  warnUniversalOnly(cli, locale)
  // The experimental local reviewer gets its own small default, as on review
  // and translate; see resolveBatchSize in cli.ts.
  const batchSize =
    flags.batchSize !== undefined
      ? parsePositiveInt('--batch-size', flags.batchSize)
      : config.reviewProvider === 'local'
        ? localReviewBatchSize(config.batchSize)
        : config.batchSize
  const outDir = flags.outDir ?? defaultOutDir()
  const review = status === 'waiting'

  // A pasted list arrives on stdin; a terminal on stdin means nobody piped one.
  const piped = cli.stdin.isTTY === true ? '' : await text(cli.stdin)
  const refs = parseProjectLines([...names, piped].join('\n'))
  if (refs.length === 0) throw new UsageError('No projects given. Name them as arguments, or pipe a list on stdin.')

  // Checked before any request, so a missing key is not found out after the
  // downloads, as the first job's failure, then again for every other job.
  const draftEngine = parseDraftEngine(flags.draftEngine ?? config.defaultDraftEngine)
  const secrets = review ? {} : loadSecrets()
  if (!review) {
    const secretName = secretForEngine(draftEngine)
    if (secretName && !secrets[secretName]?.trim()) {
      throw new Error(`Draft engine "${draftEngine}" needs ${secretName}. Set it with: polyglots config set-key ${secretName}`)
    }
  } else {
    const advice = batchAdvice(config.reviewProvider, batchSize)
    if (advice) cli.err(warnLine(cli.ui.err, advice))
  }
  // Checked here, as translate and review check them, rather than left to the
  // first batch: by then every export has been downloaded, and with several
  // projects queued the same failure would be met once per project. Warned,
  // never refused, for the reasons given where translate does it in cli.ts.
  const draftTarget = !review && draftEngine === 'local' ? resolveLocalTarget(config) : undefined
  if (draftTarget) await warnAboutLocalModel(cli, draftTarget)
  if (config.reviewProvider === 'local' && !(review && flags.ai === false)) {
    const reviewTarget = resolveLocalTarget(config)
    const same = draftTarget !== undefined && localModelId(draftTarget) === localModelId(reviewTarget)
    await warnAboutLocalReview(cli, reviewTarget, batchSize, locale, same ? 'skip-check' : 'check')
  }

  cli.err(`Checking ${refs.length} ${refs.length === 1 ? 'project' : 'projects'} on translate.wordpress.org...`)
  const onWait = (ms: number) => cli.err(waitNotice(ms))
  const resolutions = await cli.resolveProjects(refs, { locale, status, onWait })
  for (const line of table(resolutions.map((r) => [r.input, describeResolution(r, status)]), { indent: 2 })) cli.out(line)

  const ends = new Map<string, ProjectEnd>()
  for (const r of resolutions) {
    const end = endOfResolution(r, status)
    if (end) ends.set(r.input, end)
  }

  const ready = resolutions.filter((r): r is Extract<Resolution, { state: 'ready' }> => r.state === 'ready')
  if (ready.length > 0) {
    cli.err(`Downloading ${ready.length} ${ready.length === 1 ? 'export' : 'exports'} to ${outDir}...`)
    const fetched = await cli.fetchProjects(ready, {
      locale,
      status,
      outDir,
      onWait,
      ...(flags.force ? { force: true } : {}),
    })
    const toRun: Array<Extract<Fetched, { file: string }>> = []
    for (const f of fetched) {
      if (f.state === 'failed') ends.set(f.input, { tally: 'failed', detail: `download failed: ${f.reason}` })
      else toRun.push(f)
    }
    if (toRun.length > 0) {
      const results = await runBatchJobs(cli, toRun, {
        review,
        localeOf: () => locale,
        batchSize,
        parallel,
        draftEngine,
        secrets,
        ...(flags.ai === false ? { noAi: true } : {}),
        ...(flags.fresh ? { fresh: true } : {}),
        kept: new Set(toRun.filter((f) => f.state === 'kept').map((f) => f.file)),
        noun: 'project',
      })
      toRun.forEach((f, i) => ends.set(f.input, results[i]!))
    }
  }

  const final = resolutions.map((r): ProjectEnd => ends.get(r.input) ?? { tally: 'failed', detail: 'never ran' })
  return printBatchEnd(cli, resolutions.map((r, i) => ({ input: r.input, end: final[i]! })), 'Fetched')
}
