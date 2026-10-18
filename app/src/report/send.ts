import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { batchFailures, getRun } from '../jobs/index.js'
import { logsDir, runLogStem } from '../logs/paths.js'
import { dataDir } from '../paths.js'
import type { PolyglotsConfig } from '../types.js'

export const DEFAULT_REPORTS_URL = 'https://ada.tools/polyglots/api/reports'

// Long enough for a megabyte on a slow line, short enough that a server that
// accepts the connection and never answers does not hold the terminal after
// the summary has already been printed. fetch has no timeout of its own.
const SEND_TIMEOUT_MS = 30_000

/** Where a report goes. Overridable so tests, and anyone self-hosting the endpoint, can point it elsewhere. */
export function reportsUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.POLYGLOTS_REPORTS_URL?.trim()
  return value ? value : DEFAULT_REPORTS_URL
}

// The run log's last run-end line. Last rather than first: the line is
// written once, but a log is appended to, and the end that counts is the one
// nearest the bottom.
function runEndReason(startedAt: number, runId: number): unknown {
  let text: string
  try {
    text = readFileSync(join(logsDir(), `${runLogStem(startedAt, runId)}.jsonl`), 'utf8')
  } catch {
    return undefined
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes('"run-end"')) continue
    try {
      const value = JSON.parse(line) as { kind?: unknown; reason?: unknown }
      if (value.kind === 'run-end') return value.reason
    } catch {
      // A torn line: keep looking above it.
    }
  }
  return undefined
}

/**
 * The runs among `runIds` that had a problem the person could see: a batch
 * given up (a final batch_failure row), a run that ended `failed`, or one the
 * failure breaker stopped. Not a run the person stopped, and not an attempt
 * the retry rescued, which leaves only non-final rows behind.
 *
 * The breaker is read from the run log, not the run row: the row says
 * `stopped` for the breaker and for the person alike, and adding an ending to
 * it would move what `stats` counts as a fault. A run whose log is gone is
 * judged on its row alone, so its breaker stop goes unoffered; it gave up
 * batches on the way there, and those final rows still offer it.
 */
export function problemRuns(jobs: Database.Database, runIds: number[]): number[] {
  return runIds.filter((id) => {
    const row = getRun(jobs, id)
    if (!row) return false
    if (row.ending === 'failed') return true
    if (batchFailures(jobs, id).some((f) => f.final)) return true
    return runEndReason(row.startedAt, id) === 'breaker'
  })
}

/** Whether to offer a report: there is a problem, and the person has not said never. Absent means ask. */
export function shouldOffer(config: Pick<PolyglotsConfig, 'problemReports'>, problems: number[]): boolean {
  return problems.length > 0 && config.problemReports !== 'never'
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

async function errorFrom(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown }
    // Quoted inside "Not sent: <message>. Saved as ...", which has its own
    // full stop, so one the server ends with would print as two.
    const message = typeof body.error === 'string' ? body.error.trim().replace(/[.\s]+$/, '') : ''
    if (message !== '') return message
  } catch {
    // A proxy's HTML error page, or nothing at all: the status says enough.
  }
  return `the server answered ${res.status}`
}

export type SendResult = { ok: true; id: string } | { ok: false; message: string }

/**
 * Posts an encoded report (gzip JSON, as encodeReport makes it) and says how
 * it went. Never throws: every way of not sending is a message the caller
 * shows beside the path it saved the report to.
 */
export async function sendReport(
  fetchFn: typeof fetch,
  body: Buffer,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SendResult> {
  const url = reportsUrl(env)
  let res: Response
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, message: `could not reach ${hostOf(url)}` }
  }
  if (!res.ok) {
    const message = await errorFrom(res)
    // The hourly cap: nothing is wrong with the report, and the saved copy
    // can be sent later. Said even when the server's own message does not.
    if (res.status === 503 && !/try again later/i.test(message)) return { ok: false, message: `${message}; try again later` }
    return { ok: false, message }
  }
  try {
    const answer = (await res.json()) as { id?: unknown }
    if (typeof answer.id === 'string' && answer.id !== '') return { ok: true, id: answer.id }
  } catch {
    // Fall through: a 200 without an id is not a receipt.
  }
  return { ok: false, message: 'the server did not return a report id' }
}

/**
 * Keeps a report that could not be sent, as `report-<stem>.json.gz` in the
 * logs folder, where the 14-day prune already knows the name. Private to the
 * person: it can hold a contact line and, from a debug run, catalogue text.
 */
export function saveReport(body: Buffer, stem: string): string {
  mkdirSync(logsDir(), { recursive: true })
  const path = join(logsDir(), `report-${stem}.json.gz`)
  writeFileSync(path, body, { mode: 0o600 })
  return path
}

// Beside the databases rather than in logs/, where the 14-day prune would
// delete it and the hint would come back every fortnight.
function offerHintFile(): string {
  return join(dataDir(), 'problem-report-hint')
}

/**
 * Whether the offer should still say how to turn it off. Said once, on the
 * first offer ever, not on every one: a person who has read it and kept the
 * offers wants the question, not the same footnote after every failed run.
 */
export function offerHintDue(): boolean {
  return !existsSync(offerHintFile())
}

/** Records that the hint was shown. A write that fails shows it again next time, which is harmless. */
export function markOfferHintShown(): void {
  try {
    mkdirSync(dataDir(), { recursive: true })
    writeFileSync(offerHintFile(), `${new Date().toISOString()}\n`)
  } catch {
    // See above.
  }
}
