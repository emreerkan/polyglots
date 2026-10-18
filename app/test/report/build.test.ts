import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import type Database from 'better-sqlite3'
import { openJobsDb } from '../../src/jobs/db.js'
import { recordBatchFailure, startRun } from '../../src/jobs/runs.js'
import { logsDir, mcpLogPath, runLogStem } from '../../src/logs/paths.js'
import { REPORT_INFLATED_LIMIT_BYTES, REPORT_LIMIT_BYTES, ReportTooLarge, buildReport, encodeReport, summarize, type Report } from '../../src/report/build.js'

let home: string
let db: Database.Database
const savedEnv = { DEEPL_API_KEY: process.env.DEEPL_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'polyglots-report-'))
  process.env.POLYGLOTS_HOME = home
  delete process.env.DEEPL_API_KEY
  delete process.env.OPENAI_API_KEY
  mkdirSync(join(home, 'data'), { recursive: true })
  db = openJobsDb(join(home, 'data', 'jobs.db'))
})
afterEach(() => {
  db.close()
  delete process.env.POLYGLOTS_HOME
  for (const [k, v] of Object.entries(savedEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  rmSync(home, { recursive: true, force: true })
})

const START = new Date(2026, 9, 17, 12, 0, 0).getTime()
const provider = { name: 'antigravity', version: '1.2.3', model: 'flash' }

function seedRun(opts: { debug?: Record<string, string>; logText?: string } = {}): number {
  const runId = startRun(
    db,
    { file: join(home, 'sites', 'plugin-tr_TR.po'), command: 'review', locale: 'tr_TR', nplurals: 2, batchSize: 100, engine: 'e' },
    () => START,
  )
  for (const attempt of [1, 2]) {
    recordBatchFailure(db, { runId, batch: 3, attempt, size: 100, phase: 'review', reason: `timed out ${attempt}`, ms: 1000, final: attempt === 2, at: START + 1000 * attempt })
  }
  mkdirSync(logsDir(), { recursive: true })
  const stem = runLogStem(START, runId)
  const log =
    opts.logText ??
    [
      { t: START, kind: 'run-start', file: join(home, 'sites', 'plugin-tr_TR.po') },
      { t: START + 1000, kind: 'agent-spawn', pid: 4242 },
      { t: START + 5000, kind: 'agent-exit', pid: 4242 },
      { t: START + 9000, kind: 'run-end', ended: 'done' },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n'
  writeFileSync(join(logsDir(), `${stem}.jsonl`), log)
  if (opts.debug) {
    mkdirSync(join(logsDir(), stem), { recursive: true })
    for (const [name, text] of Object.entries(opts.debug)) writeFileSync(join(logsDir(), stem, name), text)
  }
  return runId
}

function writeMcp(lines: object[]): void {
  writeFileSync(mcpLogPath(START), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

describe('buildReport', () => {
  it('holds the run row, its failures, its log and only the MCP lines inside its window', () => {
    const runId = seedRun()
    writeMcp([
      { t: START + 2000, pid: 900, ppid: 4242, tool: 'inside_by_pid' },
      { t: START - 60_000, pid: 900, ppid: 4242, tool: 'before_the_run' },
      { t: START + 7000, pid: 901, ppid: 1, tool: 'between_calls_other_parent' },
    ])
    const report = buildReport(db, [runId], { provider, batchSize: 100, parallel: 2, contact: 'emre', home })
    expect(report).toMatchObject({ schema: 1, provider, batchSize: 100, parallel: 2, contact: 'emre', node: process.version, platform: process.platform })
    expect(typeof report.polyglots).toBe('string')
    expect(report.runs).toHaveLength(1)
    const [run] = report.runs
    expect(run!.failures).toHaveLength(2)
    expect((run!.row as { id: number }).id).toBe(runId)
    expect(run!.log).toContain('"run-start"')
    expect(run!.log).toContain('"run-end"')
    expect(run!.mcp).toContain('inside_by_pid')
    expect(run!.mcp).not.toContain('before_the_run')
    expect(run!.mcp).not.toContain('between_calls_other_parent')
    expect(run!.debug).toEqual([])
  })

  it('keeps an MCP line from another parent when it falls inside an agent call', () => {
    // antigravity runs the MCP server under its own daemon, so the parent pid
    // never matches the agent polyglots spawned; the call's time span does.
    const runId = seedRun()
    writeMcp([{ t: START + 3000, pid: 900, ppid: 77, tool: 'during_the_call' }])
    const [run] = buildReport(db, [runId], { provider, home }).runs
    expect(run!.mcp).toContain('during_the_call')
  })

  it('writes the home folder as ~ everywhere', () => {
    const runId = seedRun({ debug: { 'batch-001-attempt-1.prompt.txt': `Read ${home}/sites/plugin-tr_TR.po` } })
    const report = buildReport(db, [runId], { provider, home })
    const text = JSON.stringify(report)
    expect(text).not.toContain(home)
    expect(text).toContain('~/sites/plugin-tr_TR.po')
  })

  it('replaces every .env value with [redacted], even inside a debug prompt', () => {
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', '.env'), 'DEEPL_API_KEY=abc123\nOPENAI_API_KEY=sk-zz9\n')
    const runId = seedRun({ debug: { 'batch-001-attempt-1.prompt.txt': 'the user pasted DEEPL_API_KEY=abc123 and sk-zz9 here' } })
    const report = buildReport(db, [runId], { provider, home })
    const text = JSON.stringify(report)
    expect(text).not.toContain('abc123')
    expect(text).not.toContain('sk-zz9')
    expect(report.runs[0]!.debug[0]).toEqual({ name: 'batch-001-attempt-1.prompt.txt', text: 'the user pasted DEEPL_API_KEY=[redacted] and [redacted] here' })
  })

  it('never reads config.json', () => {
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', 'config.json'), JSON.stringify({ wporgUsername: 'config-only-value' }))
    const runId = seedRun()
    expect(JSON.stringify(buildReport(db, [runId], { provider, home }))).not.toContain('config-only-value')
  })
})

describe('encodeReport', () => {
  it('cuts the largest debug texts to fit under 1 MB, names them, and keeps the run log whole', () => {
    const big = (n: number) => randomBytes(n).toString('base64')
    const runId = seedRun({ debug: { 'batch-001-attempt-1.stdout.txt': big(1_500_000), 'batch-001-attempt-1.prompt.txt': big(1_500_000), 'small.txt': 'keep me' } })
    const report = buildReport(db, [runId], { provider, home })
    const log = report.runs[0]!.log
    const { body, cut } = encodeReport(report)
    expect(body.length).toBeLessThanOrEqual(REPORT_LIMIT_BYTES)
    expect(cut).toEqual(expect.arrayContaining([`run${runId}/batch-001-attempt-1.stdout.txt`, `run${runId}/batch-001-attempt-1.prompt.txt`]))
    expect(cut).not.toContain(`run${runId}/small.txt`)
    const sent = JSON.parse(gunzipSync(body).toString('utf8')) as Report
    expect(sent.runs[0]!.log).toBe(log)
    expect(sent.cut).toEqual(cut)
    expect(sent.runs[0]!.debug.find((d) => d.name === 'small.txt')!.text).toBe('keep me')
  })

  it('also cuts a report that compresses small but inflates past what the endpoint reads', () => {
    const runId = seedRun({ debug: { 'batch-001-attempt-1.stdout.txt': 'a'.repeat(12_000_000) } })
    const { body, cut } = encodeReport(buildReport(db, [runId], { provider, home }))
    expect(cut).toEqual([`run${runId}/batch-001-attempt-1.stdout.txt`])
    expect(gunzipSync(body).length).toBeLessThanOrEqual(REPORT_INFLATED_LIMIT_BYTES)
  })

  it('cuts a long debug run in a few compressions, not one per halving', () => {
    // Seventy batches of three files each, word-like text that gzips about the
    // way a real prompt and agent output do. Halving one file and compressing
    // the whole report again took hundreds of rounds and half a minute here,
    // with the event loop blocked throughout.
    let seed = 7
    const rand = (n: number): number => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) % n
    }
    const words = Array.from({ length: 4000 }, (_, i) => `w${i.toString(36)}${'aeiou'[i % 5]}`)
    const prose = (bytes: number): string => {
      const parts: string[] = []
      let size = 0
      while (size < bytes) {
        const word = words[rand(words.length)]!
        parts.push(word)
        size += word.length + 1
      }
      return parts.join(' ')
    }
    const debug: Record<string, string> = {}
    for (let batch = 1; batch <= 70; batch++) {
      const stem = `batch-${String(batch).padStart(3, '0')}-attempt-1`
      debug[`${stem}.prompt.txt`] = prose(60_000)
      debug[`${stem}.stdout.txt`] = prose(60_000)
      debug[`${stem}.stderr.txt`] = prose(2_000)
    }
    const runId = seedRun({ debug })
    const report = buildReport(db, [runId], { provider, home })
    let rounds = 0
    const compress = (json: string): Buffer => {
      rounds++
      // Fails fast instead of spending the minutes the old loop took.
      if (rounds > 8) throw new Error(`compressed ${rounds} times`)
      return gzipSync(json)
    }
    const { body, cut } = encodeReport(report, compress)
    expect(rounds).toBeLessThanOrEqual(8)
    expect(body.length).toBeLessThanOrEqual(REPORT_LIMIT_BYTES)
    // Not cut to nothing on the way: the estimate lands near the limit.
    expect(body.length).toBeGreaterThan(REPORT_LIMIT_BYTES * 0.7)
    expect(cut.length).toBeGreaterThan(0)
  })

  it('leaves a report that fits untouched', () => {
    const runId = seedRun({ debug: { 'a.txt': 'short' } })
    const { body, cut } = encodeReport(buildReport(db, [runId], { provider, home }))
    expect(cut).toEqual([])
    expect((JSON.parse(gunzipSync(body).toString('utf8')) as Report).cut).toBeUndefined()
  })

  it('throws ReportTooLarge when the run log alone cannot fit', () => {
    const runId = seedRun({ logText: randomBytes(4_500_000).toString('hex') })
    expect(() => encodeReport(buildReport(db, [runId], { provider, home }))).toThrow(ReportTooLarge)
  })
})

describe('summarize', () => {
  it('lists what the report holds, file by file, with sizes', () => {
    const runId = seedRun({ debug: { 'batch-001-attempt-1.prompt.txt': 'x'.repeat(500) } })
    const stem = runLogStem(START, runId)
    const items = summarize(buildReport(db, [runId], { provider, home, contact: 'me' }))
    const names = items.map((i) => i.name)
    expect(names).toEqual(expect.arrayContaining([`${stem}.jsonl`, `${stem}/batch-001-attempt-1.prompt.txt`]))
    expect(items.find((i) => i.name === `${stem}/batch-001-attempt-1.prompt.txt`)!.bytes).toBe(500)
    for (const i of items) expect(i.bytes).toBeGreaterThanOrEqual(0)
  })
})
