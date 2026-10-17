import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openJobsDb } from '../../src/jobs/db.js'
import {
  batchFailures,
  endRun,
  finishRun,
  getRun,
  liveRuns,
  reapAbandonedRuns,
  recordBatchFailure,
  startRun,
  stopOwnRuns,
} from '../../src/jobs/runs.js'

let db: Database.Database
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyglots-runs-'))
  db = openJobsDb(join(dir, 'jobs.db'))
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

const input = {
  file: '/tmp/plugin-tr.po',
  project: 'Plugins - Thing - Stable',
  command: 'review' as const,
  locale: 'tr' as const,
  nplurals: 2,
  batchSize: 25,
  engine: 'claude',
}

describe('startRun', () => {
  it('records a running job and returns its id', () => {
    const id = startRun(db, input, () => 1000)
    const row = getRun(db, id)!
    expect(row.state).toBe('running')
    expect(row.file).toBe('/tmp/plugin-tr.po')
    expect(row.project).toBe('Plugins - Thing - Stable')
    expect(row.startedAt).toBe(1000)
    expect(row.finishedAt).toBeUndefined()
  })

  it('leaves the totals empty until the run finishes', () => {
    const row = getRun(db, startRun(db, input))!
    expect(row.entries).toBeUndefined()
    expect(row.flagged).toBeUndefined()
  })

  it('accepts a file with no Project-Id-Version header', () => {
    const { project, ...noProject } = input
    const row = getRun(db, startRun(db, noProject))!
    expect(row.project).toBeUndefined()
  })
})

describe('finishRun', () => {
  const totals = {
    entries: 294,
    flagged: 108,
    repaired: 108,
    unreviewed: 0,
    approvable: 186,
    byCategory: { 'title-case': 80, glossary: 39 },
  }

  it('freezes the totals and marks the run done', () => {
    const id = startRun(db, input, () => 1000)
    finishRun(db, id, totals, () => 5000)
    const row = getRun(db, id)!
    expect(row.state).toBe('done')
    expect(row.finishedAt).toBe(5000)
    expect(row.entries).toBe(294)
    expect(row.flagged).toBe(108)
    expect(row.approvable).toBe(186)
    expect(row.byCategory).toEqual({ 'title-case': 80, glossary: 39 })
  })

  it('survives the verdicts behind it being deleted', () => {
    // The whole point of freezing: a glossary edit prunes every verdict, and
    // last year's numbers must not move because of it.
    const id = startRun(db, input)
    finishRun(db, id, totals)
    db.prepare('DELETE FROM audit_verdict').run()
    expect(getRun(db, id)!.flagged).toBe(108)
  })

})

describe('getRun reading a row back', () => {
  const totals = {
    entries: 294,
    flagged: 0,
    repaired: 0,
    unreviewed: 0,
    approvable: 294,
    byCategory: { 'title-case': 3 },
  }

  it('reads a legitimate zero as zero, not as an absent snapshot', () => {
    // A review that finished and flagged nothing is the best possible result.
    // Reported as "no snapshot" it would look like a run that never completed.
    const id = startRun(db, input)
    finishRun(db, id, totals)
    const row = getRun(db, id)!
    expect(row.flagged).toBe(0)
    expect(row.repaired).toBe(0)
    expect(row.unreviewed).toBe(0)
  })

  it('reads an unparseable by_category as absent rather than throwing', () => {
    const id = startRun(db, input)
    finishRun(db, id, totals)
    db.prepare('UPDATE run SET by_category = ? WHERE id = ?').run('{not json', id)
    expect(() => getRun(db, id)).not.toThrow()
    expect(getRun(db, id)!.byCategory).toBeUndefined()
  })

  it('reads a by_category holding a non-number as absent, not as a partial tally', () => {
    // A chart built from a tally with one entry silently dropped is worse than
    // one that admits it has nothing to draw.
    const id = startRun(db, input)
    finishRun(db, id, totals)
    db.prepare('UPDATE run SET by_category = ? WHERE id = ?').run('{"title-case":"lots"}', id)
    expect(getRun(db, id)!.byCategory).toBeUndefined()
  })

  it('reads a by_category holding an array as absent', () => {
    const id = startRun(db, input)
    finishRun(db, id, totals)
    db.prepare('UPDATE run SET by_category = ? WHERE id = ?').run('[1,2,3]', id)
    expect(getRun(db, id)!.byCategory).toBeUndefined()
  })
})

describe('endRun', () => {
  it('marks a run stopped, with no totals to report', () => {
    const id = startRun(db, input, () => 1000)
    endRun(db, id, 'stopped', () => 5000)
    const row = getRun(db, id)!
    expect(row.state).toBe('stopped')
    expect(row.finishedAt).toBe(5000)
    // Statistics are only honest for a run that looked at every entry.
    expect(row.entries).toBeUndefined()
    expect(row.flagged).toBeUndefined()
    expect(row.approvable).toBeUndefined()
  })

})

describe('liveRuns', () => {
  it('finds a run this process started', () => {
    startRun(db, input)
    expect(liveRuns(db).map((r) => r.command)).toEqual(['review'])
  })

  it('ignores a finished run', () => {
    const id = startRun(db, input)
    finishRun(db, id, { entries: 1, flagged: 0, repaired: 0, unreviewed: 0, approvable: 1, byCategory: {} })
    expect(liveRuns(db)).toEqual([])
  })

  it('ignores an abandoned run', () => {
    endRun(db, startRun(db, input), 'stopped')
    expect(liveRuns(db)).toEqual([])
  })

  it('ignores a row left running by a process that is gone', () => {
    // A hard kill leaves state='running' forever. Without the pid check that
    // row would block every later build, which is worse than the hazard the
    // check exists to prevent.
    const id = startRun(db, input)
    db.prepare('UPDATE run SET pid = ? WHERE id = ?').run(999_999, id)
    expect(liveRuns(db)).toEqual([])
  })

  it('reports enough to name what is running', () => {
    startRun(db, input)
    const [run] = liveRuns(db)
    expect(run).toMatchObject({ command: 'review', file: '/tmp/plugin-tr.po' })
    expect(run!.pid).toBe(process.pid)
  })

  it('treats a row with no pid as not live, since it predates the column', () => {
    const id = startRun(db, input)
    db.prepare('UPDATE run SET pid = NULL WHERE id = ?').run(id)
    expect(liveRuns(db)).toEqual([])
  })
})

describe('reapAbandonedRuns', () => {
  const dead = (id: number) => db.prepare('UPDATE run SET pid = ? WHERE id = ?').run(999_999, id)

  it('marks a row whose process is gone as stopped', () => {
    const id = startRun(db, input)
    dead(id)
    expect(reapAbandonedRuns(db, () => 5000)).toBe(1)
    const row = getRun(db, id)!
    expect(row.state).toBe('stopped')
    expect(row.finishedAt).toBe(5000)
  })


  it('reaps a row with no pid, which predates the column', () => {
    // This is the row the live database actually has: killed before 0.7.1 added
    // the pid, so there is nothing to check it against and it can never clear
    // itself. liveRuns already calls it not live; the two must agree.
    const id = startRun(db, input)
    db.prepare('UPDATE run SET pid = NULL WHERE id = ?').run(id)
    expect(reapAbandonedRuns(db)).toBe(1)
    expect(getRun(db, id)!.state).toBe('stopped')
  })

  it('leaves a genuinely running job alone', () => {
    // The whole risk of a reaper: killing the bookkeeping of a run still in
    // flight. This process is alive by definition, so its row must survive.
    const id = startRun(db, input)
    expect(reapAbandonedRuns(db)).toBe(0)
    expect(getRun(db, id)!.state).toBe('running')
  })

  it('reaps the dead row and spares the live one in the same pass', () => {
    const live = startRun(db, input)
    const gone = startRun(db, input)
    dead(gone)
    expect(reapAbandonedRuns(db)).toBe(1)
    expect(getRun(db, live)!.state).toBe('running')
    expect(getRun(db, gone)!.state).toBe('stopped')
  })

  it('does not touch a finished run', () => {
    const id = startRun(db, input)
    finishRun(db, id, { entries: 9, flagged: 1, repaired: 0, unreviewed: 0, approvable: 8, byCategory: {} })
    expect(reapAbandonedRuns(db)).toBe(0)
    expect(getRun(db, id)!.state).toBe('done')
    // finishRun froze these totals. A reaper that rewrote finished_at would
    // corrupt the one record stats reads as history.
    expect(getRun(db, id)!.entries).toBe(9)
  })

  it('does not touch an already-stopped run', () => {
    const id = startRun(db, input)
    endRun(db, id, 'stopped', () => 100)
    expect(reapAbandonedRuns(db, () => 200)).toBe(0)
    expect(getRun(db, id)!.finishedAt).toBe(100)
  })

  it('claims no totals for the run it reaps', () => {
    // An abandoned run did not look at every entry, so it has no honest
    // throughput to report. Same reasoning as endRun.
    const id = startRun(db, input)
    dead(id)
    reapAbandonedRuns(db)
    const row = getRun(db, id)!
    expect(row.entries).toBeUndefined()
    expect(row.flagged).toBeUndefined()
  })

  it('is idempotent', () => {
    const id = startRun(db, input)
    dead(id)
    expect(reapAbandonedRuns(db)).toBe(1)
    expect(reapAbandonedRuns(db)).toBe(0)
  })

  it('agrees with liveRuns about what is live', () => {
    // Two notions of "live" that can drift is the defect this guards against:
    // the reaper would stop a run the build guard still protects.
    const live = startRun(db, input)
    const gone = startRun(db, input)
    dead(gone)
    const liveIds = liveRuns(db).map((r) => r.id)
    reapAbandonedRuns(db)
    const stillRunning = db.prepare(`SELECT id FROM run WHERE state = 'running'`).all() as Array<{ id: number }>
    expect(stillRunning.map((r) => r.id)).toEqual(liveIds)
    expect(liveIds).toEqual([live])
    expect(gone).not.toBe(live)
  })
})

describe('how a run ended', () => {
  it('records that the operator stopped it', () => {
    // Pressing q is a pause, not a failure: the work is cached and the next
    // run resumes from it. Filing it as abandoned is what made the stats page
    // call a normal workflow step a warning.
    const id = startRun(db, input)
    endRun(db, id, 'stopped')
    expect(getRun(db, id)).toMatchObject({ state: 'stopped', ending: 'stopped' })
  })

  it('records that it threw', () => {
    const id = startRun(db, input)
    endRun(db, id, 'failed')
    expect(getRun(db, id)!.ending).toBe('failed')
  })

  it('records that the reaper found it', () => {
    const id = startRun(db, input)
    db.prepare('UPDATE run SET pid = ? WHERE id = ?').run(999_999, id)
    reapAbandonedRuns(db)
    expect(getRun(db, id)!.ending).toBe('abandoned')
  })

  it('leaves the ending unset on a row that predates the column', () => {
    // Nothing can say how these ended, and guessing would either invent a
    // crash or hide one.
    const id = startRun(db, input)
    db.prepare(`UPDATE run SET state = 'stopped', ended = NULL WHERE id = ?`).run(id)
    expect(getRun(db, id)!.ending).toBeUndefined()
  })

  it('says nothing about a run still going', () => {
    expect(getRun(db, startRun(db, input))!.ending).toBeUndefined()
  })

  it('says nothing about a run that finished', () => {
    const id = startRun(db, input)
    finishRun(db, id, { entries: 1, flagged: 0, repaired: 0, unreviewed: 0, approvable: 1, byCategory: {} })
    expect(getRun(db, id)!.ending).toBeUndefined()
  })
})

describe('stopOwnRuns', () => {
  const owner = (id: number, pid: number) => db.prepare('UPDATE run SET pid = ? WHERE id = ?').run(pid, id)

  it('ends the running rows this process owns as stopped, not abandoned', () => {
    const id = startRun(db, input)
    owner(id, 4242)
    expect(stopOwnRuns(db, 4242, () => 7000)).toBe(1)
    const row = getRun(db, id)!
    expect(row.state).toBe('stopped')
    expect(row.ending).toBe('stopped')
    expect(row.finishedAt).toBe(7000)
  })

  it("leaves another process's runs and finished runs alone", () => {
    const other = startRun(db, input)
    owner(other, 5151)
    const done = startRun(db, input)
    owner(done, 4242)
    finishRun(db, done, { entries: 1, flagged: 0, repaired: 0, unreviewed: 0, approvable: 1, byCategory: {} })
    expect(stopOwnRuns(db, 4242)).toBe(0)
    expect(getRun(db, other)!.state).toBe('running')
    expect(getRun(db, done)!.state).toBe('done')
  })
})

describe('batch failures', () => {
  let dir: string
  let jobs: Database.Database
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'polyglots-failures-'))
    jobs = openJobsDb(join(dir, 'jobs.db'))
  })
  afterEach(async () => {
    jobs.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('keeps every failed attempt of a run, in order, apart from other runs', () => {
    recordBatchFailure(jobs, { runId: 7, batch: 3, attempt: 1, size: 100, phase: 'review', reason: 'timed out', ms: 1_200_000, final: false, at: 10 })
    recordBatchFailure(jobs, { runId: 7, batch: 3, attempt: 2, size: 100, phase: 'review', reason: 'exit code 1', ms: 4_000, final: true, at: 20 })
    recordBatchFailure(jobs, { runId: 8, batch: 1, attempt: 1, size: 50, phase: 'drafting', reason: 'other run', ms: 1, final: false, at: 30 })
    expect(batchFailures(jobs, 7)).toEqual([
      { runId: 7, batch: 3, attempt: 1, size: 100, phase: 'review', reason: 'timed out', ms: 1_200_000, final: false, at: 10 },
      { runId: 7, batch: 3, attempt: 2, size: 100, phase: 'review', reason: 'exit code 1', ms: 4_000, final: true, at: 20 },
    ])
  })
})
