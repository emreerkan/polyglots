import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type Database from 'better-sqlite3'
import { parse as parseDotenv } from 'dotenv'
import { batchFailures, getRun } from '../jobs/index.js'
import { logsDir, mcpLogPath, runLogStem } from '../logs/paths.js'
import { secretsFile } from '../paths.js'
import { VERSION } from '../version.js'

export interface ReportRun {
  runId: number
  command: string
  file: string
  startedAt: number
}

export interface Report {
  schema: 1
  polyglots: string
  node: string
  platform: string
  provider: { name: string; version?: string; model?: string }
  batchSize?: number
  parallel?: number
  runs: Array<{ row: unknown; failures: unknown[]; log: string; mcp: string; debug: Array<{ name: string; text: string }> }>
  contact?: string
  cut?: string[]
}

// What the reports endpoint accepts, sent and inflated. The inflated limit is
// checked here too: a report of highly repetitive debug output can gzip under
// a megabyte and still inflate past what the server will read, and a refusal
// after the upload is a worse answer than a cut before it.
export const REPORT_LIMIT_BYTES = 1_000_000
export const REPORT_INFLATED_LIMIT_BYTES = 8_000_000

export class ReportTooLarge extends Error {
  constructor(bytes: number) {
    super(
      `The problem report is ${Math.ceil(bytes / 1000)} kB compressed even with the debug files cut, over the ${REPORT_LIMIT_BYTES / 1_000_000} MB limit. Turn debug mode off and run again.`,
    )
    this.name = 'ReportTooLarge'
  }
}

export interface BuildReportOptions {
  provider: Report['provider']
  batchSize?: number
  parallel?: number
  contact?: string
  // The home folder to write as ~, beside os.homedir(). Tests pass their temp
  // home, which is not under the real one.
  home?: string
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

type LogLine = { t?: unknown; kind?: unknown; pid?: unknown }

function parseLines(text: string): LogLine[] {
  const out: LogLine[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (value && typeof value === 'object') out.push(value as LogLine)
    } catch {
      // A torn last line from a process killed mid-write: the rest still reads.
    }
  }
  return out
}

// Each local day the window touches, since the MCP log is one file per local
// day. Stepped by calendar date rather than by 24 hours, so a daylight-saving
// change inside a long run neither skips a day nor reads one twice.
function mcpFilesBetween(from: number, to: number): string[] {
  const files: string[] = []
  const day = new Date(from)
  day.setHours(0, 0, 0, 0)
  while (day.getTime() <= to) {
    files.push(mcpLogPath(day.getTime()))
    day.setDate(day.getDate() + 1)
  }
  return files
}

// The MCP server cannot know which run called it, so its lines are joined to a
// run here. The time window alone would hand a run every other run's lookups
// from the same hours, a parallel batch's sibling included, so when the run
// log names the agents it spawned, a line must also come from one of them
// (claude starts the server as its own child) or fall inside one of their
// calls (antigravity starts it under its own long-lived process, whose pid
// polyglots never sees). A run log with no agent lines, a rules-only run or
// one that died before its first batch, falls back to the window.
function mcpLinesFor(lines: LogLine[], from: number, to: number): string {
  const spawns = new Map<number, number>()
  const calls: Array<[number, number]> = []
  for (const line of lines) {
    if (typeof line.t !== 'number' || typeof line.pid !== 'number') continue
    if (line.kind === 'agent-spawn') spawns.set(line.pid, line.t)
    if (line.kind === 'agent-exit') {
      const start = spawns.get(line.pid)
      if (start !== undefined) calls.push([start, line.t])
    }
  }
  // A call with no exit line was still going when the log stopped.
  const ended = new Set(calls.map(([start]) => start))
  for (const start of spawns.values()) if (!ended.has(start)) calls.push([start, to])
  const pids = new Set(spawns.keys())

  const kept: string[] = []
  for (const file of mcpFilesBetween(from, to)) {
    for (const raw of readText(file).split('\n')) {
      if (raw.trim() === '') continue
      let line: { t?: unknown; ppid?: unknown }
      try {
        line = JSON.parse(raw) as typeof line
      } catch {
        continue
      }
      const t = line.t
      if (typeof t !== 'number' || t < from || t > to) continue
      if (pids.size > 0 && !(typeof line.ppid === 'number' && pids.has(line.ppid)) && !calls.some(([a, b]) => t >= a && t <= b)) continue
      kept.push(raw)
    }
  }
  return kept.join('\n')
}

function readDebug(dir: string): Array<{ name: string; text: string }> {
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch {
    return []
  }
  const out: Array<{ name: string; text: string }> = []
  for (const name of names) {
    const path = join(dir, name)
    try {
      if (!statSync(path).isFile()) continue
    } catch {
      continue
    }
    out.push({ name, text: readText(path) })
  }
  return out
}

// Every value in .env, under any key, and the two keys polyglots reads from
// the environment too, since a key set only in the shell is just as quotable
// in a prompt. The values are redacted, not the lines dropped: a prompt that
// quotes a key is a report worth reading for everything else in it. config.json
// is never opened; nothing from it belongs in a report.
function secretValues(): string[] {
  const values = new Set<string>()
  const path = secretsFile()
  if (existsSync(path)) {
    for (const value of Object.values(parseDotenv(readText(path)))) if (value.length > 0) values.add(value)
  }
  for (const key of ['DEEPL_API_KEY', 'OPENAI_API_KEY']) {
    const value = process.env[key]
    if (value && value.length > 0) values.add(value)
  }
  return [...values]
}

// Applied to every string in the report, not to its JSON text: on Windows the
// home folder's backslashes are doubled in JSON, and a secret holding a quote
// is escaped, so a replace over the serialised form would miss both. Longest
// first, so a home folder that contains the other is not left half replaced.
function redactor(home: string | undefined): (value: unknown) => unknown {
  const secrets = secretValues().sort((a, b) => b.length - a.length)
  const homes = [...new Set([homedir(), home].filter((h): h is string => typeof h === 'string' && h.length > 0))].sort((a, b) => b.length - a.length)
  const text = (s: string): string => {
    let out = s
    for (const secret of secrets) out = out.split(secret).join('[redacted]')
    for (const h of homes) out = out.split(h).join('~')
    return out
  }
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return text(value)
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]))
    return value
  }
  return walk
}

export function buildReport(jobs: Database.Database, runIds: number[], opts: BuildReportOptions): Report {
  const runs: Report['runs'] = []
  for (const runId of runIds) {
    const row = getRun(jobs, runId)
    if (!row) continue
    const stem = runLogStem(row.startedAt, runId)
    const log = readText(join(logsDir(), `${stem}.jsonl`))
    const lines = parseLines(log)
    // The window closes at the last line the run wrote, not at finished_at: a
    // run that threw or was killed has no finish time, and its last line is
    // the nearest thing to when it stopped.
    const last = lines.reduce((max, l) => (typeof l.t === 'number' && l.t > max ? l.t : max), row.startedAt)
    const to = lines.length > 0 ? last : (row.finishedAt ?? Date.now())
    runs.push({
      row,
      failures: batchFailures(jobs, runId),
      log,
      mcp: mcpLinesFor(lines, row.startedAt, to),
      debug: readDebug(join(logsDir(), stem)),
    })
  }
  const report: Report = {
    schema: 1,
    polyglots: VERSION,
    node: process.version,
    platform: process.platform,
    provider: opts.provider,
    ...(opts.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
    ...(opts.parallel === undefined ? {} : { parallel: opts.parallel }),
    runs,
    ...(opts.contact === undefined ? {} : { contact: opts.contact }),
  }
  return redactor(opts.home)(report) as Report
}

// Debug files are the only part cut. The run log, the failures and the MCP
// lines are what a report is for and are small without debug mode; a report
// they alone push over the limit is refused rather than sent without them.
// The largest text is halved each time, keeping its start, rather than
// dropped: the head of a prompt or an agent's output says what the call was,
// and the next halving takes the next largest, so the cut spreads over the big
// files instead of erasing one. Under a kilobyte a halving saves too little to
// be worth counting, so it goes to nothing.
//
// Compression is what costs, and gzipSync blocks the event loop while it runs.
// Compressing after every halving took hundreds of rounds on a long debug run,
// half a minute to two minutes with the TUI frozen. So each round estimates how
// many raw bytes must go, from the ratio the last compression gave, halves as
// many files as that takes measured by their raw JSON size, and only then
// compresses again to check. The aim sits a little under the limit, because
// the debug text being cut can compress worse than the report as a whole; a
// round that still misses runs again with the ratio it just measured. The
// exact gzip check is the only gate, so the estimate can cost a few rounds or a
// slightly deeper cut, never a report over the limit.
const CUT_AIM = 0.95

export function encodeReport(report: Report, compress: (json: string) => Buffer = gzipSync): { body: Buffer; cut: string[] } {
  const draft = structuredClone(report)
  delete draft.cut
  const cut: string[] = []
  const encode = (): { body: Buffer; raw: number } => {
    const json = JSON.stringify(cut.length > 0 ? { ...draft, cut } : draft)
    return { body: compress(json), raw: Buffer.byteLength(json) }
  }
  const files = draft.runs.flatMap((run) => run.debug.map((file) => ({ file, name: `run${(run.row as { id: number }).id}/${file.name}` })))
  const jsonBytes = (s: string): number => Buffer.byteLength(JSON.stringify(s))
  let out = encode()
  while (out.body.length > REPORT_LIMIT_BYTES || out.raw > REPORT_INFLATED_LIMIT_BYTES) {
    const ratio = out.body.length / out.raw
    const aim = CUT_AIM * Math.min(REPORT_INFLATED_LIMIT_BYTES, REPORT_LIMIT_BYTES / ratio)
    // The cut list itself grows the JSON as names join it; a round that
    // estimates nothing to remove still halves one file, so it cannot spin.
    let excess = Math.max(1, out.raw - aim)
    let halved = false
    while (excess > 0) {
      let largest: (typeof files)[number] | undefined
      for (const entry of files) if (entry.file.text.length > 0 && (!largest || entry.file.text.length > largest.file.text.length)) largest = entry
      if (!largest) break
      const { file, name } = largest
      const before = jsonBytes(file.text)
      file.text = file.text.length < 1000 ? '' : file.text.slice(0, Math.floor(file.text.length / 2))
      excess -= before - jsonBytes(file.text)
      // Named with its run, since two runs' debug folders hold the same names.
      if (!cut.includes(name)) {
        cut.push(name)
        excess += jsonBytes(name) + 1
      }
      halved = true
    }
    if (!halved) throw new ReportTooLarge(out.body.length)
    out = encode()
  }
  return { body: out.body, cut }
}

// What `v` shows before anything is sent: each run's log, its row and failures,
// its MCP lines and each debug file, named as they are on disk where they come
// from a file, with their uncompressed sizes.
export function summarize(report: Report): Array<{ name: string; bytes: number }> {
  const bytes = (s: string): number => Buffer.byteLength(s)
  const items: Array<{ name: string; bytes: number }> = []
  for (const run of report.runs) {
    const row = run.row as { id: number; startedAt: number }
    const stem = runLogStem(row.startedAt, row.id)
    items.push({ name: `${stem}.jsonl`, bytes: bytes(run.log) })
    items.push({ name: `run ${row.id}: run record and ${run.failures.length} batch failure(s)`, bytes: bytes(JSON.stringify({ row: run.row, failures: run.failures })) })
    items.push({ name: `run ${row.id}: MCP log lines`, bytes: bytes(run.mcp) })
    for (const file of run.debug) items.push({ name: `${stem}/${file.name}`, bytes: bytes(file.text) })
  }
  if (report.contact !== undefined) items.push({ name: 'contact line', bytes: bytes(report.contact) })
  return items
}
