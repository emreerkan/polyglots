import { describe, expect, it } from 'vitest'
import {
  createEventStore,
  fileLine,
  nearTimeout,
  openBatchMs,
  overall,
  overallLines,
  type FileTrack,
} from '../../src/tui/batch-progress.js'
import type { TranslateEvent } from '../../src/commands/translate.js'
import type { ReviewEvent } from '../../src/types.js'

const MIN = 60_000

const track = (input: string, state: FileTrack['state'], events: Array<ReviewEvent | TranslateEvent> = [], entries = 0): FileTrack => ({
  input,
  state,
  events,
  entries,
  ...(state === 'queued' ? {} : { startedAt: 0 }),
})

// One review file with `done` timed batches of `size` entries, each `ms` long,
// out of `of`, and the next one open at the moment the last one closed.
function reviewing(input: string, opts: { size: number; ms: number; done: number; of: number }): FileTrack {
  const events: ReviewEvent[] = [{ type: 'start', file: input, total: opts.size * opts.of, reviewable: opts.size * opts.of }]
  let at = 0
  for (let i = 1; i <= opts.done; i++) {
    events.push({ type: 'batch-start', index: i, of: opts.of, size: opts.size, at })
    at += opts.ms
    events.push({ type: 'batch-done', index: i, problems: 0, at })
  }
  if (opts.done < opts.of) events.push({ type: 'batch-start', index: opts.done + 1, of: opts.of, size: opts.size, at })
  return track(input, 'running', events)
}

describe('overall', () => {
  it('counts files by state and runs the clock from Start', () => {
    const tracks = [
      ...['a', 'b', 'c'].map((f) => track(f, 'finished')),
      track('d', 'running'),
      ...['e', 'f', 'g', 'h'].map((f) => track(f, 'queued')),
    ]
    const o = overall(tracks, { parallel: 1, now: 42 * MIN + 5_000, startedAt: 5_000, action: 'review' })
    expect(o).toMatchObject({ done: 3, running: 1, queued: 4, elapsedMs: 42 * MIN })
    expect(overallLines(o)[0]).toBe('3 of 8 files done · 1 running · 4 queued · 42m elapsed')
  })

  it('counts the batches given up across every file, review and translate alike', () => {
    const review = track('a.po', 'finished', [
      { type: 'batch-failed', index: 1, size: 10, reason: 'timeout', at: 1 },
      { type: 'batch-done', index: 2, problems: 0, at: 2 },
      { type: 'batch-failed', index: 3, size: 10, reason: 'timeout', at: 3 },
    ])
    const translate = track('b.po', 'finished', [{ type: 'batch-skipped', index: 1, size: 5, reason: 'gone', at: 1 }])
    const o = overall([review, translate], { parallel: 2, now: MIN, startedAt: 0, action: 'review' })
    expect(o.failedBatches).toBe(3)
    expect(overallLines(o)[1]).toContain('3 batches failed')
  })

  it('keeps the estimate hidden until a batch has finished somewhere', () => {
    const running = track('a.po', 'running', [
      { type: 'start', file: 'a.po', total: 100, reviewable: 100 },
      { type: 'batch-start', index: 1, of: 5, size: 20, at: 0 },
    ])
    const o = overall([running, track('b.po', 'queued', [], 50)], { parallel: 1, now: MIN, startedAt: 0, action: 'review' })
    expect(o.remainingMs).toBeUndefined()
    expect(overallLines(o)[1]).toBe('estimating…')
  })

  // The last batch of the last file has closed and only the writing is left:
  // there is nothing to estimate, which is not the same as still estimating,
  // and the CLI would otherwise end every batch run on "estimating…".
  it('says nothing about time once every batch has closed and nothing is queued', () => {
    const last = reviewing('a.po', { size: 10, ms: MIN, done: 2, of: 2 })
    const failed = track('b.po', 'running', [
      { type: 'batch-start', index: 1, of: 1, size: 10, at: 0 },
      { type: 'batch-failed', index: 1, size: 10, reason: 'timeout', at: MIN },
    ])
    expect(overallLines(overall([last], { parallel: 1, now: 2 * MIN, startedAt: 0, action: 'review' }))[1]).toBe('')
    expect(overallLines(overall([last, failed], { parallel: 2, now: 2 * MIN, startedAt: 0, action: 'review' }))[1]).toBe('1 batch failed')
  })

  it('on one slot, adds the queued files at the run’s pace per entry to the running file’s own estimate', () => {
    // Two batches left at a minute each, and 20 queued entries at 6 s each.
    const running = reviewing('a.po', { size: 10, ms: MIN, done: 1, of: 3 })
    const o = overall([running, track('b.po', 'queued', [], 20)], { parallel: 1, now: MIN, startedAt: 0, action: 'review' })
    expect(o.remainingMs).toBe(2 * MIN + 2 * MIN)
    expect(o.upperBound).toBe(true)
    expect(overallLines(o, 0)[1]).toMatch(/^up to ~4m left, done by /)
  })

  it('drops the upper bound once nothing is queued', () => {
    const running = reviewing('a.po', { size: 10, ms: MIN, done: 1, of: 3 })
    const o = overall([running], { parallel: 1, now: MIN, startedAt: 0, action: 'review' })
    expect(o.upperBound).toBe(false)
    expect(overallLines(o, 0)[1]).toMatch(/^~2m left, done by /)
  })

  it('on two slots, hands each queued file to the slot that frees first', () => {
    // A has ten minutes left, B two; the run's pace is 6 s an entry, so a
    // queued file of 50 entries is five minutes. Both go to B, at 2 and at 7,
    // and B is the last slot to free, at 12.
    const a = reviewing('a.po', { size: 10, ms: 5 * MIN, done: 1, of: 3 })
    const b = reviewing('b.po', { size: 50, ms: MIN, done: 1, of: 3 })
    const o = overall([a, b, track('c.po', 'queued', [], 50), track('d.po', 'queued', [], 50)], {
      parallel: 2,
      now: 5 * MIN,
      startedAt: 0,
      action: 'review',
    })
    expect(o.remainingMs).toBe(12 * MIN)
  })

  // Two running files, one with an estimate and one without: the line does
  // not sum half an answer with a guess, so it says it is still estimating.
  it('keeps estimating while another file is still in its rules pass', () => {
    const timed = reviewing('a.po', { size: 10, ms: MIN, done: 1, of: 3 })
    const rules = track('b.po', 'running', [{ type: 'start', file: 'b.po', total: 40, reviewable: 40 }])
    const o = overall([timed, rules], { parallel: 2, now: MIN, startedAt: 0, action: 'review' })
    expect(o.remainingMs).toBeUndefined()
    expect(overallLines(o)[1]).toBe('estimating…')
  })

  // "estimating…" says work is still going on, which a pending pause or stop
  // is the opposite of. The pause's own line says what happens next; this one
  // says only that there is no figure, and the stop gets its own word because
  // the screen's stopping line is not a pause.
  it('has no estimate while a running file has been asked to pause or stop, and says so', () => {
    for (const [type, words] of [
      ['paused', 'no estimate while paused'],
      ['stopping', 'no estimate while stopping'],
    ] as const) {
      const timed = reviewing('a.po', { size: 10, ms: MIN, done: 1, of: 3 })
      const asked = reviewing('b.po', { size: 10, ms: MIN, done: 1, of: 3 })
      asked.events.push({ type, at: MIN })
      const o = overall([timed, asked], { parallel: 2, now: MIN, startedAt: 0, action: 'review' })
      expect(o.remainingMs, type).toBeUndefined()
      expect(overallLines(o)[1], type).toBe(words)
    }
  })

  // The batch screen's runs do not carry the pause in their events: the
  // screen holds the batch's control state itself and hands it in.
  it('takes a pending pause or stop from the caller, over an estimate it would otherwise give', () => {
    const running = reviewing('a.po', { size: 10, ms: MIN, done: 1, of: 3 })
    const queued = track('b.po', 'queued', [], 20)
    const at = { parallel: 1, now: MIN, startedAt: 0, action: 'review' } as const
    expect(overall([running, queued], at).remainingMs).toBe(4 * MIN)
    const paused = overall([running, queued], { ...at, held: 'pause' })
    expect(paused.remainingMs).toBeUndefined()
    expect(overallLines(paused)[1]).toBe('no estimate while paused')
    expect(overallLines(overall([running, queued], { ...at, held: 'stop' }))[1]).toBe('no estimate while stopping')
    const failed = track('c.po', 'finished', [{ type: 'batch-failed', index: 1, size: 5, reason: 'gone', at: 1 }])
    expect(overallLines(overall([running, failed], { ...at, held: 'pause' }))[1]).toBe('no estimate while paused · 1 batch failed')
  })

  // The caller's pause and a file's own stop can both be pending: the stop is
  // the one that ends the run, so it is what the line names.
  it('names a stop over a pause, whichever source each comes from', () => {
    const at = { parallel: 2, now: MIN, startedAt: 0, action: 'review' } as const
    const stopping = reviewing('a.po', { size: 10, ms: MIN, done: 1, of: 3 })
    stopping.events.push({ type: 'stopping', at: MIN })
    const timed = reviewing('b.po', { size: 10, ms: MIN, done: 1, of: 3 })
    expect(overallLines(overall([stopping, timed], { ...at, held: 'pause' }))[1]).toBe('no estimate while stopping')
    const pausing = reviewing('c.po', { size: 10, ms: MIN, done: 1, of: 3 })
    pausing.events.push({ type: 'paused', at: MIN })
    expect(overallLines(overall([pausing, timed], { ...at, held: 'stop' }))[1]).toBe('no estimate while stopping')
    expect(overallLines(overall([pausing, stopping], at))[1]).toBe('no estimate while stopping')
  })

  it('estimates translate files through the translate reducer', () => {
    const events: TranslateEvent[] = [
      { type: 'start', file: 'a.po', total: 30, pending: 30 },
      { type: 'batch-start', index: 1, of: 3, size: 10, at: 0 },
      { type: 'batch-done', index: 1, translated: 10, fuzzy: 0, at: MIN },
      { type: 'batch-start', index: 2, of: 3, size: 10, at: MIN },
    ]
    const o = overall([track('a.po', 'running', events)], { parallel: 1, now: MIN, startedAt: 0, action: 'translate' })
    expect(o.remainingMs).toBe(2 * MIN)
  })
})

describe('the open batch', () => {
  const open = track('a.po', 'running', [{ type: 'batch-start', index: 2, of: 2, size: 10, at: 0 }])

  it('is timed from its batch-start', () => {
    expect(openBatchMs(open, 3 * MIN)).toBe(3 * MIN)
    expect(openBatchMs(reviewing('b.po', { size: 10, ms: MIN, done: 2, of: 2 }), 3 * MIN)).toBeUndefined()
  })

  it('is near its timeout once it has run past the timeout less a minute', () => {
    expect(nearTimeout(open, 19 * MIN + 1_000, 20 * MIN)).toBe(true)
    expect(nearTimeout(open, 18 * MIN + 59_000, 20 * MIN)).toBe(false)
  })
})

describe('createEventStore', () => {
  const entries: ReviewEvent = { type: 'entries', index: 1, entries: [{ key: 'k', msgid: 'Hello', outcome: 'approved' }] }
  const start: ReviewEvent = { type: 'batch-start', index: 1, of: 2, size: 1, at: 0 }

  it('drops entries events for a file nobody has opened and keeps them once it is', () => {
    const store = createEventStore('review')
    store.push('a.po', start)
    store.push('a.po', entries)
    expect(store.tracks()[0]!.events).toEqual([start])
    store.open('a.po')
    store.push('a.po', entries)
    expect(store.tracks()[0]!.events).toEqual([start, entries])
  })

  it('lists queued files in order, then moves them through running to finished', () => {
    const store = createEventStore('translate')
    store.queue('a.po', 10)
    store.queue('b.po', 20)
    store.start('b.po', 100)
    store.finish('b.po', 900)
    expect(store.tracks()).toEqual([
      { input: 'a.po', state: 'queued', events: [], entries: 10 },
      { input: 'b.po', state: 'finished', events: [], entries: 20, startedAt: 100, endedAt: 900 },
    ])
  })
})

describe('createEventStore and overall', () => {
  // A file can end without a done event: a throw ends it with nothing to
  // summarise. finish() is what makes it done, not the event.
  it('counts a file done once finish() is called, with no done event', () => {
    const store = createEventStore('review')
    store.queue('a.po', 10)
    store.start('a.po', 0)
    store.push('a.po', { type: 'batch-start', index: 1, of: 1, size: 10, at: 0 })
    store.finish('a.po', MIN)
    const o = overall(store.tracks(), { parallel: 1, now: MIN, startedAt: 0, action: 'review' })
    expect(o).toMatchObject({ done: 1, running: 0, queued: 0 })
  })
})

describe('fileLine', () => {
  it('gives a finished file its total time and its failed batches', () => {
    const t: FileTrack = {
      ...track('a.po', 'finished', [{ type: 'batch-failed', index: 1, size: 5, reason: 'timed out', at: 1 }]),
      startedAt: 0,
      endedAt: 58 * MIN,
    }
    expect(fileLine(t, 60 * MIN, 'review')).toEqual({ text: 'finished · 58m · 1 batch failed', near: false })
  })

  it('shows the open batch with its seconds, and no marker without a limit', () => {
    const t = reviewing('a.po', { size: 5, ms: MIN, done: 1, of: 2 })
    expect(fileLine(t, MIN + 19 * MIN + 5_000, 'review')).toEqual({ text: 'running · batch 2/2 · 19m 05s in this batch', near: false })
    expect(fileLine(t, MIN + 19 * MIN + 5_000, 'review', 1_200_000)).toEqual({
      text: 'running · batch 2/2 · 19m 05s in this batch · near the time limit',
      near: true,
    })
  })

  // The batch screen tells each running file of a pause or a stop, and a
  // row that still read "running" under the "Paused." line said the file
  // was going on. It says what the file was asked to do, until it resumes.
  // A pause is asked for at once and reached only when the open batch has
  // closed: "paused" beside a running batch clock told someone the file was
  // parked while it still spent metered calls, which is why the file's own
  // screen keeps the two apart. So the row says pausing until then.
  it('says a running file is pausing, paused or stopping once it has been asked to', () => {
    const t = reviewing('a.po', { size: 5, ms: MIN, done: 1, of: 2 })
    t.events.push({ type: 'paused', at: MIN + 1_000 })
    expect(fileLine(t, MIN + 5_000, 'review').text).toBe('running · batch 2/2 · 5s in this batch · pausing')
    t.events.push({ type: 'resumed', at: MIN + 2_000 })
    expect(fileLine(t, MIN + 5_000, 'review').text).toBe('running · batch 2/2 · 5s in this batch')
    t.events.push({ type: 'stopping', at: MIN + 3_000 })
    expect(fileLine(t, MIN + 5_000, 'review').text).toBe('running · batch 2/2 · 5s in this batch · stopping')
    const translating = track('b.po', 'running', [{ type: 'batch-start', index: 1, of: 3, size: 5, at: 0 } as TranslateEvent, { type: 'paused', at: 1 } as TranslateEvent])
    expect(fileLine(translating, 5_000, 'translate').text).toMatch(/ · pausing$/)
  })

  it('says paused once the batch that was open has closed', () => {
    const t = reviewing('a.po', { size: 5, ms: MIN, done: 1, of: 3 })
    t.events.push({ type: 'paused', at: MIN + 1_000 })
    t.events.push({ type: 'batch-done', index: 2, problems: 0, at: 2 * MIN })
    expect(fileLine(t, 2 * MIN + 5_000, 'review').text).toBe('running · batch 2/3 · paused')
  })

  it('says only queued for a file that has not started', () => {
    expect(fileLine(track('b.po', 'queued'), 0, 'review', 1_200_000)).toEqual({ text: 'queued', near: false })
  })
})
