import type Database from 'better-sqlite3'
import type { Locale } from '../types.js'
import { parseTally, type Clock } from './json.js'

// The first three mirror RunState in run-control.ts exactly, so the pause key
// needs no new vocabulary. `done` is the terminal state RunState has no need to
// name, because a finished run has no control left to exercise. `stopped` is
// also terminal, unlike `stopping`, which is a control state a run passes
// through on its way to either `stopped` or `done`.
// What a run row can actually say. `running` is set at the start, `done` by
// finishRun with its frozen totals, `stopped` by endRun with none.
//
// This deliberately does NOT mirror `RunState` in run-control.ts. That one is
// in-memory control state for the pause key, and nothing writes `paused` or
// `stopping` to this table: a row saying so would be a state the code cannot
// produce, which is worse than a missing one because it invites a reader to
// handle a case that never arrives. If a later feature genuinely persists a
// paused run, adding the member back is one word.
export type RunRowState = 'running' | 'done' | 'stopped'

/**
 * How a run that did not finish came to an end.
 *
 * `state` alone cannot say. It records only that a run is terminal, so a
 * deliberate stop, a thrown error and a killed process all read as `stopped`,
 * and anything counting "did not finish" counts all three as faults. Stopping
 * part way to look at the output and resuming later is ordinary use of this
 * tool, and its work is cached, so filing it beside a crash reports a workflow
 * as a problem.
 *
 * - `stopped`   the operator ended it; the work so far is cached and resumable
 * - `failed`    it threw; the run did not decide how much it got through
 * - `abandoned` the process died and `reapAbandonedRuns` cleared the row later
 */
export type RunEnding = 'stopped' | 'failed' | 'abandoned'

export interface StartRunInput {
  file: string
  // The Project-Id-Version header. Captured because a reviewed file gets moved,
  // renamed or deleted, and its path stops being a reliable name for the work.
  project?: string
  command: 'review' | 'translate'
  locale: Locale
  nplurals: number
  batchSize: number
  engine: string
}

export interface RunTotals {
  entries: number
  flagged: number
  repaired: number
  unreviewed: number
  approvable: number
  byCategory: Record<string, number>
}

export interface RunRow extends StartRunInput {
  id: number
  state: RunRowState
  startedAt: number
  finishedAt?: number
  entries?: number
  flagged?: number
  repaired?: number
  unreviewed?: number
  approvable?: number
  byCategory?: Record<string, number>
  // Absent while running, absent when `done`, and absent on a row written
  // before the column existed, which cannot say how it ended.
  ending?: RunEnding
}

export function startRun(db: Database.Database, input: StartRunInput, now: Clock = () => Date.now()): number {
  const result = db
    .prepare(
      `INSERT INTO run (file, project, command, locale, nplurals, batch_size, engine, state, pid, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    )
    .run(
      input.file,
      input.project ?? null,
      input.command,
      input.locale,
      input.nplurals,
      input.batchSize,
      input.engine,
      process.pid,
      now(),
    )
  return Number(result.lastInsertRowid)
}

// Written once, from the same numbers the user was shown, and never
// recalculated. Not a denormalisation to be kept in sync with anything: a
// record of what was true at a moment, whose value comes precisely from not
// tracking later changes. The verdicts behind it are pruned whenever the
// glossary moves, so a live query would rewrite history.
export function finishRun(
  db: Database.Database,
  runId: number,
  totals: RunTotals,
  now: Clock = () => Date.now(),
): void {
  db.prepare(
    `UPDATE run SET state = 'done', finished_at = ?, entries = ?, flagged = ?, repaired = ?,
       unreviewed = ?, approvable = ?, by_category = ? WHERE id = ?`,
  ).run(
    now(),
    totals.entries,
    totals.flagged,
    totals.repaired,
    totals.unreviewed,
    totals.approvable,
    JSON.stringify(totals.byCategory),
    runId,
  )
}

// A run that ended without finishing. Terminal, unlike `stopping`, which is a
// control state a run passes through. It freezes no totals, since a run that did
// not look at every entry has no honest throughput or quality numbers to
// report.
//
// `ending` is required rather than defaulted because the caller is the only
// thing that knows, and a default would quietly file every crash as whatever
// the common case happened to be. That conflation is the defect this replaced.
export function endRun(
  db: Database.Database,
  runId: number,
  ending: RunEnding,
  now: Clock = () => Date.now(),
): void {
  db.prepare(`UPDATE run SET state = 'stopped', ended = ?, finished_at = ? WHERE id = ?`).run(ending, now(), runId)
}

/**
 * Ends this process's own in-flight runs as `stopped`, for an exit that cannot
 * wait for them to wind down cooperatively.
 *
 * The TUI quits with a run still going by exiting hard, because the run would
 * otherwise keep writing files with no UI. Left alone, its row stays `running`
 * until the reaper finds the pid gone and files it as `abandoned`, which
 * `stats` counts beside crashes. The person asked for this exit, and what the
 * run finished is cached for the next one, so it is a stop, said here before
 * the process goes. Scoped to the pid so a run another process owns is never
 * touched.
 */
export function stopOwnRuns(db: Database.Database, pid: number = process.pid, now: Clock = () => Date.now()): number {
  const ids = db
    .prepare<[number], { id: number }>(`SELECT id FROM run WHERE state = 'running' AND pid = ?`)
    .all(pid)
    .map((r) => r.id)
  const at = now()
  for (const id of ids) endRun(db, id, 'stopped', () => at)
  return ids.length
}

interface Row {
  id: number
  file: string
  project: string | null
  command: string
  locale: string
  nplurals: number
  batch_size: number
  engine: string
  state: string
  started_at: number
  finished_at: number | null
  entries: number | null
  flagged: number | null
  repaired: number | null
  unreviewed: number | null
  approvable: number | null
  by_category: string | null
  ended: string | null
}

function optional(value: number | null): number | undefined {
  return value === null ? undefined : value
}

export function getRun(db: Database.Database, runId: number): RunRow | undefined {
  const row = db.prepare<[number], Row>('SELECT * FROM run WHERE id = ?').get(runId)
  if (!row) return undefined
  const byCategory = parseTally(row.by_category)
  return {
    id: row.id,
    file: row.file,
    ...(row.project === null ? {} : { project: row.project }),
    command: row.command as 'review' | 'translate',
    locale: row.locale as Locale,
    nplurals: row.nplurals,
    batchSize: row.batch_size,
    engine: row.engine,
    state: row.state as RunRowState,
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(optional(row.entries) === undefined ? {} : { entries: row.entries! }),
    ...(optional(row.flagged) === undefined ? {} : { flagged: row.flagged! }),
    ...(optional(row.repaired) === undefined ? {} : { repaired: row.repaired! }),
    ...(optional(row.unreviewed) === undefined ? {} : { unreviewed: row.unreviewed! }),
    ...(optional(row.approvable) === undefined ? {} : { approvable: row.approvable! }),
    ...(byCategory === undefined ? {} : { byCategory }),
    ...(isEnding(row.ended) ? { ending: row.ended } : {}),
  }
}

const ENDINGS: ReadonlySet<string> = new Set<RunEnding>(['stopped', 'failed', 'abandoned'])

// A value this build does not know reads as absent rather than as itself: the
// alternative is handing a caller a union member that does not exist.
function isEnding(value: string | null): value is RunEnding {
  return value !== null && ENDINGS.has(value)
}

export interface LiveRun {
  id: number
  command: string
  file: string
  pid: number
  startedAt: number
}

// Whether the owning process still exists. `kill(pid, 0)` sends no signal; it
// only asks. EPERM means the process is there but owned by someone else, which
// still counts as alive.
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Runs that are genuinely in flight right now.
 *
 * A row saying `running` is not enough on its own: a hard kill leaves one
 * behind forever, and treating that as live would block whatever this is
 * guarding for good. The pid is what tells the two apart. A row with no pid
 * predates the column and is treated as not live, because there is nothing to
 * check it against.
 */
export function liveRuns(db: Database.Database): LiveRun[] {
  const rows = db
    .prepare<[], { id: number; command: string; file: string; pid: number | null; started_at: number }>(
      `SELECT id, command, file, pid, started_at FROM run WHERE state = 'running'`,
    )
    .all()
  return rows
    .filter((r): r is typeof r & { pid: number } => r.pid !== null && alive(r.pid))
    .map((r) => ({ id: r.id, command: r.command, file: r.file, pid: r.pid, startedAt: r.started_at }))
}

/**
 * Clears run rows left at `running` by a process that no longer exists.
 *
 * `endRun` handles an ordinary stop. A `kill -9`, a crash, or a closed
 * terminal has no such path, so the row stays `running` for good. Nothing
 * breaks (`liveRuns` already declines to treat such a row as in flight, so it
 * blocks no build), but `stats` counts it under "did not finish" forever.
 *
 * The live set comes from `liveRuns` rather than from a second pid check, so
 * the two can never disagree. A reaper with its own notion of "alive" could
 * stop a run the build guard is still protecting, which is the one outcome
 * that would make this worse than the mess it cleans up.
 *
 * Errs towards leaving rows behind. A pid the operating system has since
 * recycled reads as alive and is skipped, so an abandoned row can survive a
 * pass; it is reaped the next time that pid is free. Leaving a dead row costs
 * a wrong number in `stats`. Stopping a live run costs the run.
 *
 * Assumes the database is local to this machine, which `~/.local/share` makes
 * true: a pid means nothing on the host that did not issue it.
 */
export function reapAbandonedRuns(db: Database.Database, now: Clock = () => Date.now()): number {
  const live = new Set(liveRuns(db).map((r) => r.id))
  const running = db.prepare<[], { id: number }>(`SELECT id FROM run WHERE state = 'running'`).all()
  const abandoned = running.filter((r) => !live.has(r.id)).map((r) => r.id)
  if (abandoned.length === 0) return 0

  const reap = db.transaction((ids: number[]): void => {
    // No totals, for the reason endRun gives: a run that did not reach
    // every entry has no honest numbers to report.
    const stop = db.prepare(`UPDATE run SET state = 'stopped', ended = 'abandoned', finished_at = ? WHERE id = ?`)
    const at = now()
    for (const id of ids) {
      stop.run(at, id)
    }
  })
  reap(abandoned)
  return abandoned.length
}
