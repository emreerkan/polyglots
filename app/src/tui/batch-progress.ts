import type { TranslateEvent } from '../commands/translate.js'
import type { ReviewEvent } from '../types.js'
import { formatDuration, formatFinishTime } from '../cli/progress.js'
import { reduceReviewProgress } from './components/ReviewProgress.js'
import { reduceProgress } from './components/Progress.js'

/**
 * The state behind a batch of files: each file's own event stream, kept so the
 * screen can reduce it with the single-file reducers rather than measure time a
 * second way, and the overall line worked out from those.
 *
 * `entries` is the file's entry count, known before it starts, which is what a
 * queued file is estimated from. Its reviewable count is not known until its
 * own rules pass runs, so this is the only number there is.
 */
export interface FileTrack {
  input: string
  state: 'queued' | 'running' | 'finished'
  startedAt?: number
  endedAt?: number
  events: Array<ReviewEvent | TranslateEvent>
  entries: number
}

type AnyEvent = ReviewEvent | TranslateEvent

/**
 * Holds every file's events for the life of the batch screen.
 *
 * `entries` events are the large ones, a copy of every entry a batch decided,
 * and only the inspected screen's entries list reads them. A batch of large
 * files left running for hours would hold all of them for nothing, so they are
 * dropped for a file nobody has opened. The cost is that a file opened part
 * way through lists only the batches that finished after it was opened; the
 * counts, the bar and the clock are reduced from the small events and are
 * whole either way.
 *
 * Every change replaces the track object rather than mutating it, so a screen
 * holding the last `tracks()` in state sees a new value when anything moved.
 */
export function createEventStore(action: 'review' | 'translate') {
  const order: string[] = []
  const byInput = new Map<string, FileTrack>()
  const opened = new Set<string>()

  const get = (input: string): FileTrack => {
    const known = byInput.get(input)
    if (known !== undefined) return known
    // An event for a file nobody queued is still a file that is running: the
    // runner only reports progress from inside a job.
    const fresh: FileTrack = { input, state: 'running', events: [], entries: 0 }
    order.push(input)
    byInput.set(input, fresh)
    return fresh
  }
  const set = (input: string, patch: Partial<FileTrack>) => byInput.set(input, { ...get(input), ...patch })

  return {
    // Which reducer reads these tracks; the screen hands it on to overall and
    // to the inspected file's progress screen, so the two cannot disagree.
    action,
    queue(input: string, entries: number): void {
      if (!byInput.has(input)) order.push(input)
      byInput.set(input, { input, state: 'queued', events: [], entries })
    },
    start(input: string, at: number): void {
      set(input, { state: 'running', startedAt: at })
    },
    finish(input: string, at: number): void {
      set(input, { state: 'finished', endedAt: at })
    },
    push(input: string, e: AnyEvent): void {
      if (e.type === 'entries' && !opened.has(input)) return
      const track = get(input)
      byInput.set(input, { ...track, events: [...track.events, e] })
    },
    open(input: string): void {
      opened.add(input)
    },
    tracks(): FileTrack[] {
      return order.map((input) => byInput.get(input)!)
    },
  }
}

export interface Overall {
  done: number
  running: number
  queued: number
  elapsedMs: number
  // Undefined while there is no estimate; 0 once every batch has closed.
  remainingMs?: number
  upperBound: boolean
  failedBatches: number
  // A pause or a stop has been asked for and the run has not ended: there is
  // no estimate, and line 2 says why rather than "estimating…".
  held?: 'pause' | 'stop'
}

interface Timing {
  // Every batch this file has closed with both ends timed, and their sizes.
  ms: number
  entries: number
  closed: number
  // The batch open now, when there is one.
  openedAt?: number
}

// Read straight off the events rather than out of the reducers, which keep the
// open batch's start to themselves and keep durations without the sizes that
// a pace per entry needs.
function timing(events: AnyEvent[]): Timing {
  const t: Timing = { ms: 0, entries: 0, closed: 0 }
  let size = 0
  for (const e of events) {
    if (e.type === 'batch-start') {
      t.openedAt = e.at
      size = e.size
    } else if (e.type === 'batch-done' || e.type === 'batch-failed' || e.type === 'batch-skipped') {
      if (t.openedAt !== undefined) {
        t.ms += e.at - t.openedAt
        t.entries += size
        t.closed += 1
      }
      t.openedAt = undefined
    }
  }
  return t
}

/**
 * What a running file has been asked to do, and what it still has left, from
 * one pass of its own reducer. In this order, since the cases overlap:
 *
 * 1. A file that has finished has nothing left and is asked nothing any more.
 * 2. A file asked to pause or stop has no honest answer, and has none.
 * 3. A file with a batch total has what its reducer says. The reducers leave
 *    the estimate out where its batches are all closed, or its last one has
 *    under ten seconds to go: as good as nothing left, counted as nothing so
 *    it does not hold the whole line at "estimating…" for its final seconds.
 * 4. A file still in its rules pass has no batch total yet, and has none.
 */
function fileState(track: FileTrack, action: 'review' | 'translate'): { intent?: 'pause' | 'stop'; remainingMs?: number } {
  // The two reducers name "has a batch total" differently; the rest is shared.
  const read = (s: { summary?: unknown; intent?: 'pause' | 'stop'; remainingMs?: number }, totalKnown: boolean) => {
    if (s.summary !== undefined) return { remainingMs: 0 }
    if (s.intent !== undefined) return { intent: s.intent }
    if (totalKnown) return { remainingMs: s.remainingMs ?? 0 }
    return {}
  }
  if (action === 'review') {
    const s = reduceReviewProgress(track.events as ReviewEvent[])
    return read(s, s.batchesTotal > 0)
  }
  const s = reduceProgress(track.events as TranslateEvent[])
  return read(s, s.batch !== undefined)
}

/**
 * The overall line's numbers.
 *
 * The estimate is the time the last slot frees: each running file holds a
 * slot until its own estimate runs out, and each queued file, costed at this
 * run's pace per entry so far, goes to whichever slot frees first. On one
 * slot that is the plain sum. A queued file's cost is its whole entry count,
 * when the verdict cache will usually answer much of it again, so while any
 * file is queued the figure is an upper bound and says so.
 *
 * Hidden until a batch has closed somewhere in the run, as on a single file,
 * and whenever a running file has no estimate of its own: half an answer
 * summed with a guess is worse than saying it is still estimating.
 *
 * Hidden too while a pause or a stop is pending, which `held` says. It comes
 * from the caller, because the batch screen's runs never see the pause in
 * their own events: the screen holds the batch's control and the runs only
 * act on it. A run whose events do carry the intent (a caller that reports
 * it, as a single file's screen does) is read as well, so the two sources
 * cannot disagree into an estimate. A stop outranks a pause: it is the one
 * that ends the run.
 */
export function overall(
  tracks: FileTrack[],
  opts: { parallel: number; now: number; startedAt: number; action: 'review' | 'translate'; held?: 'pause' | 'stop' },
): Overall {
  const running = tracks.filter((t) => t.state === 'running')
  const queued = tracks.filter((t) => t.state === 'queued')
  let failedBatches = 0
  let ms = 0
  let entries = 0
  let closed = 0
  for (const t of tracks) {
    for (const e of t.events) if (e.type === 'batch-failed' || e.type === 'batch-skipped') failedBatches += 1
    const timed = timing(t.events)
    ms += timed.ms
    entries += timed.entries
    closed += timed.closed
  }

  const result: Overall = {
    done: tracks.filter((t) => t.state === 'finished').length,
    running: running.length,
    queued: queued.length,
    elapsedMs: Math.max(0, opts.now - opts.startedAt),
    upperBound: queued.length > 0,
    failedBatches,
  }

  // A stop outranks a pause, so a stop from the caller needs no file read;
  // otherwise each running file is reduced once, for its intent and its
  // estimate together.
  if (opts.held === 'stop') return { ...result, held: 'stop' }
  const states = running.map((t) => fileState(t, opts.action))
  const intents = states.map((f) => f.intent)
  const held = intents.includes('stop') ? 'stop' : opts.held === 'pause' || intents.includes('pause') ? 'pause' : undefined
  if (held !== undefined) return { ...result, held }

  const remainingMs = (() => {
    if (closed === 0 || (running.length === 0 && queued.length === 0)) return undefined
    const slots: number[] = []
    for (const f of states) {
      if (f.remainingMs === undefined) return undefined
      slots.push(f.remainingMs)
    }
    if (queued.length > 0) {
      if (entries === 0) return undefined
      const perEntry = ms / entries
      while (slots.length < Math.max(1, opts.parallel)) slots.push(0)
      for (const t of queued) {
        let first = 0
        for (let i = 1; i < slots.length; i++) if (slots[i]! < slots[first]!) first = i
        slots[first]! += t.entries * perEntry
      }
    }
    const last = Math.max(0, ...slots)
    if (last > 0) return last
    // Every running file has closed its last batch and nothing is queued: what
    // is left is writing the files, which is nothing to estimate rather than
    // something still being estimated, so it is 0 and not unknown. With files
    // queued, a nought means their size is unknown (fetch's, not downloaded
    // yet), and that is still unknown.
    return queued.length === 0 ? 0 : undefined
  })()

  return remainingMs === undefined ? result : { ...result, remainingMs }
}

/** How long the file's open batch has run, or undefined with none open. */
export function openBatchMs(track: FileTrack, now: number): number | undefined {
  if (track.state !== 'running') return undefined
  const { openedAt } = timing(track.events)
  return openedAt === undefined ? undefined : Math.max(0, now - openedAt)
}

/**
 * True once the open batch has run past its agent's timeout less a minute:
 * it is about to fail, and this is the hang the batch screen used to hide.
 */
export function nearTimeout(track: FileTrack, now: number, timeoutMs: number): boolean {
  const open = openBatchMs(track, now)
  return open !== undefined && open > timeoutMs - 60_000
}

/**
 * The two lines above the file list. Plain text: the screen colours the
 * failed count, and the CLI prints the same words.
 *
 * `now` is only for the finish time and defaults to the clock.
 */
export function overallLines(o: Overall, now: number = Date.now()): [string, string] {
  const total = o.done + o.running + o.queued
  const first = `${o.done} of ${total} files done · ${o.running} running · ${o.queued} queued · ${formatDuration(o.elapsedMs)} elapsed`
  const parts: string[] = []
  if (o.remainingMs === 0) {
    // Nothing left to time; see overall.
  } else if (o.remainingMs !== undefined) {
    parts.push(`${o.upperBound ? 'up to ' : ''}~${formatDuration(o.remainingMs)} left, done by ${formatFinishTime(o.remainingMs, now)}`)
  } else if (o.held !== undefined) {
    // Not "estimating…", which says work is going on toward a figure. The
    // stop has its own word: the screen's line under the list for it is a
    // stopping line, not a pause, and "paused" here would contradict it.
    parts.push(o.held === 'stop' ? 'no estimate while stopping' : 'no estimate while paused')
  } else if (o.running + o.queued > 0) {
    parts.push('estimating…')
  }
  if (o.failedBatches > 0) parts.push(`${o.failedBatches} ${o.failedBatches === 1 ? 'batch' : 'batches'} failed`)
  return [first, parts.join(' · ')]
}

// The open batch's clock with its seconds, unlike formatDuration's whole
// minutes: this one ticks every second on screen, and "19m" for a whole
// minute reads as a clock that has stopped, which is the one thing this clock
// is there to rule out.
function clock(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** Batches the file gave up: failed in a review, skipped in a translate. */
export function failedBatches(track: FileTrack): number {
  return track.events.filter((e) => e.type === 'batch-failed' || e.type === 'batch-skipped').length
}

/**
 * One file's line in the batch list, after its name: what state it is in,
 * its open batch and how long that has run, or its total time once finished.
 *
 * `near` is set past the agent's timeout less a minute, and the words say so
 * as well as the colour, so the marker survives a terminal without colour and
 * a test can read it. Without a `timeoutMs` (a local model, or no AI) nothing
 * is ever near: there is no limit to be near.
 */
// A pause is asked for at once and reached only when the open batch has
// closed and saved, so while a batch is open the file is pausing, not
// paused: the file's own screen keeps the two apart (ReviewProgress's
// intent), since "paused" beside a running batch clock told someone the run
// was parked while it still spent metered calls. A stop has no parked state
// to tell apart: the file ends when its batch does.
const intentText = (intent: 'pause' | 'stop' | undefined, batchOpen: boolean): string => {
  if (intent === 'pause') return batchOpen ? ' · pausing' : ' · paused'
  if (intent === 'stop') return ' · stopping'
  return ''
}

export function fileLine(track: FileTrack, now: number, action: 'review' | 'translate', timeoutMs?: number): { text: string; near: boolean } {
  if (track.state === 'queued') return { text: 'queued', near: false }
  const failed = failedBatches(track)
  const failedText = failed > 0 ? ` · ${failed} ${failed === 1 ? 'batch' : 'batches'} failed` : ''
  if (track.state === 'finished') {
    const total = track.startedAt !== undefined && track.endedAt !== undefined ? ` · ${formatDuration(track.endedAt - track.startedAt)}` : ''
    return { text: `finished${total}${failedText}`, near: false }
  }
  let last: { index: number; of: number } | undefined
  for (const e of track.events) if (e.type === 'batch-start') last = { index: e.index, of: e.of }
  const open = openBatchMs(track, now)
  const near = open !== undefined && timeoutMs !== undefined && nearTimeout(track, now, timeoutMs)
  const text =
    'running' +
    (last ? ` · batch ${last.index}/${last.of}` : '') +
    (open !== undefined ? ` · ${clock(open)} in this batch` : '') +
    (near ? ' · near the time limit' : '') +
    // What the batch asked of it, which the screen pushes into its events: a
    // row that read "running" alone under the "Paused." line said the file
    // was going on, when it parks at the end of this batch.
    intentText(fileState(track, action).intent, open !== undefined)
  return { text, near }
}
