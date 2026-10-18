import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type Database from 'better-sqlite3'
import { openJobsDb } from '../../src/jobs/db.js'
import { endRun, recordBatchFailure, startRun } from '../../src/jobs/runs.js'
import { logsDir, runLogStem } from '../../src/logs/paths.js'
import {
  DEFAULT_REPORTS_URL,
  problemRuns,
  reportsUrl,
  saveReport,
  sendReport,
  shouldOffer,
} from '../../src/report/send.js'

let home: string
let db: Database.Database

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'polyglots-send-'))
  process.env.POLYGLOTS_HOME = home
  mkdirSync(join(home, 'data'), { recursive: true })
  db = openJobsDb(join(home, 'data', 'jobs.db'))
})
afterEach(() => {
  db.close()
  delete process.env.POLYGLOTS_HOME
  rmSync(home, { recursive: true, force: true })
})

const START = new Date(2026, 9, 17, 12, 0, 0).getTime()

function seed(runEnd?: Record<string, unknown>): number {
  const id = startRun(
    db,
    { file: join(home, 'plugin-tr_TR.po'), command: 'review', locale: 'tr_TR', nplurals: 2, batchSize: 10, engine: 'e' },
    () => START,
  )
  if (runEnd) {
    mkdirSync(logsDir(), { recursive: true })
    const lines = [
      { t: START, kind: 'run-start' },
      { t: START + 5000, kind: 'run-end', ...runEnd },
    ]
    writeFileSync(join(logsDir(), `${runLogStem(START, id)}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }
  return id
}

function failure(runId: number, attempt: number, final: boolean): void {
  recordBatchFailure(db, { runId, batch: 1, attempt, size: 10, phase: 'review', reason: 'timed out', ms: 1000, final, at: START + attempt })
}

describe('reportsUrl', () => {
  it('is the default, or POLYGLOTS_REPORTS_URL when set', () => {
    expect(DEFAULT_REPORTS_URL).toBe('https://ada.tools/polyglots/api/reports')
    expect(reportsUrl({})).toBe(DEFAULT_REPORTS_URL)
    expect(reportsUrl({ POLYGLOTS_REPORTS_URL: '  ' })).toBe(DEFAULT_REPORTS_URL)
    expect(reportsUrl({ POLYGLOTS_REPORTS_URL: 'http://localhost:9/r' })).toBe('http://localhost:9/r')
  })
})

describe('problemRuns', () => {
  it('counts a run with a batch given up', () => {
    const id = seed({ ended: 'done' })
    failure(id, 1, false)
    failure(id, 2, true)
    expect(problemRuns(db, [id])).toEqual([id])
  })

  it('counts a run that ended failed', () => {
    const id = seed()
    endRun(db, id, 'failed')
    expect(problemRuns(db, [id])).toEqual([id])
  })

  it('counts a run the breaker stopped', () => {
    const id = seed({ ended: 'stopped', reason: 'breaker' })
    endRun(db, id, 'stopped')
    expect(problemRuns(db, [id])).toEqual([id])
  })

  it('does not count an attempt the retry rescued', () => {
    const id = seed({ ended: 'done' })
    failure(id, 1, false)
    expect(problemRuns(db, [id])).toEqual([])
  })

  it('does not count a run the person stopped', () => {
    const id = seed({ ended: 'stopped' })
    endRun(db, id, 'stopped')
    expect(problemRuns(db, [id])).toEqual([])
  })

  it('keeps only the runs with problems, in the order given, and skips unknown ids', () => {
    const clean = seed({ ended: 'done' })
    const failed = seed()
    endRun(db, failed, 'failed')
    expect(problemRuns(db, [failed, clean, 9999])).toEqual([failed])
  })
})

describe('shouldOffer', () => {
  it('offers when there are problems and the person has not said never', () => {
    expect(shouldOffer({}, [1])).toBe(true)
    expect(shouldOffer({ problemReports: 'ask' }, [1])).toBe(true)
  })

  it('never offers with problemReports never, or without problems', () => {
    expect(shouldOffer({ problemReports: 'never' }, [1])).toBe(false)
    expect(shouldOffer({}, [])).toBe(false)
  })
})

describe('sendReport', () => {
  const body = gzipSync(Buffer.from('{"schema":1}'))

  function fake(respond: () => Response | Promise<Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return respond()
    }) as typeof fetch
    return { fn, calls }
  }

  it('posts the gzip body unchanged with JSON and gzip headers, and returns the id', async () => {
    const { fn, calls } = fake(() => Response.json({ id: '1a2b3c' }))
    const result = await sendReport(fn, body, { POLYGLOTS_REPORTS_URL: 'http://localhost:9/r' })
    expect(result).toEqual({ ok: true, id: '1a2b3c' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://localhost:9/r')
    expect(calls[0]!.init.method).toBe('POST')
    const headers = new Headers(calls[0]!.init.headers)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('content-encoding')).toBe('gzip')
    expect(Buffer.from(calls[0]!.init.body as Uint8Array).equals(body)).toBe(true)
  })

  it('sends to the default endpoint when nothing overrides it', async () => {
    const { fn, calls } = fake(() => Response.json({ id: 'x' }))
    await sendReport(fn, body, {})
    expect(calls[0]!.url).toBe(DEFAULT_REPORTS_URL)
  })

  it('returns the server error message on a refusal', async () => {
    const { fn } = fake(() => Response.json({ error: 'contact is longer than 200 characters' }, { status: 400 }))
    expect(await sendReport(fn, body, {})).toEqual({ ok: false, message: 'contact is longer than 200 characters' })
  })

  // The message is quoted inside a sentence that ends in its own full stop.
  it('drops a full stop the server message ends with', async () => {
    const { fn } = fake(() => Response.json({ error: 'Bad report. ' }, { status: 400 }))
    expect(await sendReport(fn, body, {})).toEqual({ ok: false, message: 'Bad report' })
  })

  it('names the status when a server error has no message', async () => {
    const { fn } = fake(() => new Response('<html>bad gateway</html>', { status: 502 }))
    const result = await sendReport(fn, body, {})
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('502')
  })

  it('says to try again later on 503', async () => {
    const { fn } = fake(() =>
      Response.json({ error: 'too many reports this hour' }, { status: 503, headers: { 'retry-after': '600' } }),
    )
    const result = await sendReport(fn, body, {})
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('try again later')
  })

  it('names the host it could not reach when the request throws', async () => {
    const { fn } = fake(() => {
      throw new TypeError('fetch failed')
    })
    expect(await sendReport(fn, body, { POLYGLOTS_REPORTS_URL: 'https://reports.example.test/api' })).toEqual({
      ok: false,
      message: 'could not reach reports.example.test',
    })
  })

  it('treats a 200 without an id as not sent', async () => {
    const { fn } = fake(() => Response.json({}))
    const result = await sendReport(fn, body, {})
    expect(result.ok).toBe(false)
  })
})

describe('saveReport', () => {
  it('writes the body under the logs folder and returns the path', () => {
    const body = gzipSync(Buffer.from('{"schema":1}'))
    const path = saveReport(body, '2026-10-17T10-00-00-000Z-run3')
    expect(path).toBe(join(logsDir(), 'report-2026-10-17T10-00-00-000Z-run3.json.gz'))
    expect(readFileSync(path).equals(body)).toBe(true)
  })
})
