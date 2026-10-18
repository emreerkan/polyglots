import type Database from 'better-sqlite3'
import { defaultExec } from '../agent/discover.js'
import { configuredModel, PROVIDERS, resolveAgentBin, type ProbeExec } from '../agent/providers.js'
import { childEnv } from '../agent/run.js'
import { findOnPath } from '../spawn-plan.js'
import type { ReviewProvider } from '../types.js'
import { localModelId, resolveLocalTarget } from '../draft/local-chat.js'
import { batchFailures, getRun } from '../jobs/index.js'
import { runLogStem } from '../logs/paths.js'
import type { PolyglotsConfig } from '../types.js'
import { buildReport, encodeReport, ReportTooLarge, type Report } from './build.js'
import { problemRuns, saveReport, type SendResult } from './send.js'

// What the command line and the app share about offering a problem report:
// which runs it is about, the line that asks, and what happened to it once it
// was sent. Each front end keeps only its own way of asking. They used to be
// one function in the CLI, and the app would otherwise have had to copy the
// send-then-save order and its wording, which is exactly the kind of copy
// that drifts.

// The endpoint refuses a longer contact line, and a refusal after the upload
// would save the whole report over a few characters nobody needs.
export const CONTACT_MAX = 200

/** What the report says about the command that ran, beside the runs themselves. */
export interface ReportFacts {
  provider: string
  // The provider's --version line; see providerVersion.
  version?: string
  model?: string
  batchSize?: number
  parallel?: number
}

/** The runs a report would be about, and what the offer says about them. */
export interface Problems {
  runIds: number[]
  // Final batch_failure rows across those runs: the batches given up.
  failedBatches: number
  // Distinct files among them, for a batch of files.
  files: number
}

export function findProblems(jobs: Database.Database, runIds: number[]): Problems {
  const problems = problemRuns(jobs, runIds)
  const files = new Set(problems.map((id) => getRun(jobs, id)!.file))
  const failedBatches = problems.reduce((n, id) => n + batchFailures(jobs, id).filter((f) => f.final).length, 0)
  return { runIds: problems, failedBatches, files: files.size }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/**
 * The sentence before the question. Given-up batches are what the person saw
 * on screen, so they lead; a run that threw or was stopped by the breaker
 * with nothing given up is named as a problem without a count that would
 * read "0 batches failed".
 */
export function problemHeadline(p: Problems, batch: boolean): string {
  const files = plural(p.files, 'file', 'files')
  if (p.failedBatches > 0) return `${plural(p.failedBatches, 'batch', 'batches')} failed${batch ? ` in ${files}` : ''}.`
  return batch ? `${files} ended with a problem.` : 'The run ended with a problem.'
}

// The model a problem report names: the one asked for, else the one the
// provider is configured with, else none, and the report says no more than it knows.
export function reportModel(config: PolyglotsConfig, model: string | undefined): { model?: string } {
  if (config.reviewProvider === 'none') return {}
  if (config.reviewProvider === 'local') {
    try {
      return { model: localModelId(resolveLocalTarget(config, model)) }
    } catch {
      return {}
    }
  }
  const chosen = model ?? configuredModel(config.reviewProvider)
  return chosen ? { model: chosen } : {}
}

// How long the offer waits for the provider's version before sending without
// it. agy and claude both answer --version in well under a second; past three
// the binary is in trouble, and that is a fact the report already carries in
// its run log, not a reason to hold the person at the prompt.
export const VERSION_WAIT_MS = 3_000

/**
 * The provider's version, for the report: the first line `<bin> --version`
 * prints, the same line discovery shows. The server's mail summary names it
 * beside the provider ("antigravity 1.4.0"), and a failure that started with
 * an agy release is otherwise invisible in a report.
 *
 * Asked at send time rather than carried from the run, because neither run
 * nor check reads it: discovery does, and only the app runs discovery. One
 * call, found on PATH first so a missing binary costs no spawn, and never a
 * throw: a report without a version is still worth sending. A local model and
 * no reviewer have no binary to ask.
 */
export async function providerVersion(
  provider: string,
  opts: { exec?: ProbeExec; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; timeoutMs?: number } = {},
): Promise<string | undefined> {
  if (!(PROVIDERS as readonly string[]).includes(provider)) return undefined
  const env = opts.env ?? process.env
  try {
    const { bin } = resolveAgentBin(provider as ReviewProvider, env)
    const path = findOnPath(bin, env, opts.platform ?? process.platform)
    if (path === undefined) return undefined
    const timeoutMs = opts.timeoutMs ?? VERSION_WAIT_MS
    const result = await (opts.exec ?? defaultExec)(path, ['--version'], { timeoutMs, env: childEnv(env) })
    if (result.code !== 0) return undefined
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      // Uncut: buildFor cuts it to what the endpoint takes, for the
      // command line and the app alike.
      .find((line) => line.length > 0)
  } catch {
    return undefined
  }
}

/**
 * A version source held to VERSION_WAIT_MS whatever it is: the injected
 * command-line dep, or the app's discovery, which may still be probing every
 * provider. Never rejects, and undefined once the wait is over.
 */
export function boundedVersion(source: Promise<string | undefined>, ms = VERSION_WAIT_MS): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
    timer.unref?.()
  })
  return Promise.race([source.catch(() => undefined), late]).finally(() => clearTimeout(timer))
}

// What the endpoint takes for the provider's model and version
// (MAX_DETAIL in polyglots-admin's validate.js).
const DETAIL_MAX = 128

/**
 * Free text made into what the endpoint accepts: one line, no control
 * characters, at most `max` long, and none when nothing is left. The endpoint
 * refuses the whole report over one field it cannot take, and only after the
 * upload, so a pasted tab in the contact line or a colour code in a
 * --version line would cost the report itself. A control character becomes a
 * space rather than nothing, so "slack:<tab>emre" stays two words.
 */
function oneLine(text: string, max: number): string | undefined {
  const line = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max).trimEnd()
  return line === '' ? undefined : line
}

/** A contact line as typed: one line, cut to what the endpoint takes, and none when empty. */
export function contactLine(typed: string): string | undefined {
  return oneLine(typed, CONTACT_MAX)
}

export function buildFor(jobs: Database.Database, runIds: number[], facts: ReportFacts, contact?: string): Report {
  // Cleaned here rather than where each is read, since both come from text
  // polyglots does not control: the model from the agent's own settings file
  // or a --model flag, the version from a binary's output or, in the app,
  // from discovery, which does not cut it.
  const version = facts.version === undefined ? undefined : oneLine(facts.version, DETAIL_MAX)
  const model = facts.model === undefined ? undefined : oneLine(facts.model, DETAIL_MAX)
  return buildReport(jobs, runIds, {
    provider: {
      name: facts.provider,
      ...(version === undefined ? {} : { version }),
      ...(model === undefined ? {} : { model }),
    },
    ...(facts.batchSize === undefined ? {} : { batchSize: facts.batchSize }),
    ...(facts.parallel === undefined ? {} : { parallel: facts.parallel }),
    ...(contact === undefined ? {} : { contact }),
  })
}

export type Delivery =
  | { state: 'sent'; id: string; cut: string[] }
  // Not sent, and saved at `path` to send by hand; or, when the save failed
  // too, lost with both reasons.
  | { state: 'kept'; message: string; path: string; cut: string[] }
  | { state: 'lost'; message: string; saveError: string; cut: string[] }
  // Over the limit even cut: not sent and not kept, since the endpoint could
  // never take the saved file either.
  | { state: 'too-large'; message: string }

/**
 * Encodes and sends a report, and keeps it in the logs folder when sending
 * fails. Never throws for a send or save that fails: each is a Delivery the
 * caller words.
 */
export async function deliverReport(report: Report, send: (body: Buffer) => Promise<SendResult>): Promise<Delivery> {
  let encoded: { body: Buffer; cut: string[] }
  try {
    encoded = encodeReport(report)
  } catch (error) {
    if (error instanceof ReportTooLarge) return { state: 'too-large', message: error.message }
    throw error
  }
  const { body, cut } = encoded
  const result = await send(body)
  if (result.ok) return { state: 'sent', id: result.id, cut }
  // Named after the first run with a problem, the one the report opens with.
  const first = report.runs[0]!.row as { id: number; startedAt: number }
  try {
    return { state: 'kept', message: result.message, path: saveReport(body, runLogStem(first.startedAt, first.id)), cut }
  } catch (error) {
    return { state: 'lost', message: result.message, saveError: error instanceof Error ? error.message : String(error), cut }
  }
}

/** The line that says how it went, the same words on the command line and in the app. */
export function deliveryLine(d: Delivery): string {
  switch (d.state) {
    case 'sent':
      return `Sent. Report ${d.id}.`
    case 'kept':
      return `Not sent: ${d.message}. Saved as ${d.path}.`
    case 'lost':
      return `Not sent: ${d.message}. It could not be saved either: ${d.saveError}`
    case 'too-large':
      return `Not sent: ${d.message}`
  }
}

/** The hint that names what was cut to fit, or nothing when nothing was. */
export function cutLine(d: Delivery): string | undefined {
  return d.state !== 'too-large' && d.cut.length > 0 ? `Cut to fit the size limit: ${d.cut.join(', ')}` : undefined
}
