import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import type { TranslateEvent } from '../../src/commands/translate.js'
import type { ReviewEvent } from '../../src/types.js'
import { Progress, reduceProgress } from '../../src/tui/components/Progress.js'
import { barDone, barTotal, ReviewProgress, reduceReviewProgress } from '../../src/tui/components/ReviewProgress.js'
import { flat, render, tick } from './helpers.js'
import { openInDefaultApp } from '../../src/tui/open-file.js'

// The real one launches a GUI application. A test run must not open a .po editor on
// whoever is running it.
vi.mock('../../src/tui/open-file.js', () => ({
  openInDefaultApp: vi.fn(() => true),
  openCommand: vi.fn(() => ({ command: 'open', args: [] })),
}))

vi.mock('../../src/tui/clipboard.js', () => ({
  copyToClipboard: vi.fn(() => true),
  clipboardCommands: vi.fn(() => []),
}))

const FILE = '/tmp/work/plugin-tr.po'
const T = 1_700_000_000_000

const events: TranslateEvent[] = [
  { type: 'start', file: FILE, total: 10, pending: 6 },
  { type: 'tm-hit', count: 2 },
  { type: 'saved' },
  { type: 'batch-start', index: 1, of: 2, size: 2, at: T },
  { type: 'batch-done', index: 1, translated: 2, fuzzy: 1, at: T + 60_000 },
  { type: 'saved' },
  { type: 'warning', message: 'placeholder %s missing in draft' },
  { type: 'batch-start', index: 2, of: 2, size: 2, at: T + 60_000 },
  { type: 'batch-skipped', index: 2, size: 2, reason: 'claude exited with code 1', at: T + 90_000 },
  {
    type: 'done',
    summary: { file: FILE, total: 10, pending: 6, fromTm: 2, translated: 2, fuzzy: 1, skipped: 2 },
  },
]

describe('reduceProgress', () => {
  it('accumulates counts, batch position and warnings', () => {
    const state = reduceProgress(events.slice(0, 7))
    expect(state).toMatchObject({
      file: FILE,
      total: 10,
      pending: 6,
      fromTm: 2,
      translated: 2,
      fuzzy: 1,
      skipped: 0,
      done: 4,
      batch: { index: 1, of: 2 },
    })
    expect(state.warnings).toEqual(['placeholder %s missing in draft'])
    expect(state.summary).toBeUndefined()
  })

  it('records skipped batches as warnings and keeps the final summary', () => {
    const state = reduceProgress(events)
    expect(state.done).toBe(6)
    expect(state.skipped).toBe(2)
    expect(state.warnings).toEqual(['placeholder %s missing in draft', 'Batch 2 skipped (2 entries): claude exited with code 1'])
    expect(state.summary?.skipped).toBe(2)
  })
})

// The review screen answers "is it alive?" with a clock and "how long?" with an
// estimate. A translate batch is two long calls and was answering neither.
describe('reduceProgress timing', () => {
  const upTo = (n: number) => reduceProgress(events.slice(0, n))

  it('guesses from a default pace as soon as the first batch starts', () => {
    expect(upTo(4).remainingMs).toBe(2 * 2 * 4_000)
  })

  it('projects from the batches it has timed', () => {
    expect(upTo(5).batchDurations).toEqual([60_000])
    expect(upTo(5).remainingMs).toBe(60_000)
  })

  it('has nothing to go on before the first batch', () => {
    expect(upTo(3).remainingMs).toBeUndefined()
  })

  it('drops the estimate when the run is over', () => {
    expect(reduceProgress(events).remainingMs).toBeUndefined()
  })

  it('follows the phase, so the clock can say which call is running', () => {
    const state = reduceProgress([...events.slice(0, 4), { type: 'batch-phase', index: 1, phase: 'drafting', at: T }])
    expect(state.phase).toEqual({ name: 'drafting', since: T })
  })

  it('closes the phase when the batch ends, so the clock stops', () => {
    const state = reduceProgress([
      ...events.slice(0, 4),
      { type: 'batch-phase', index: 1, phase: 'reviewing', at: T },
      events[4]!,
    ])
    expect(state.phase).toBeUndefined()
  })
})

describe('Progress', () => {
  it('renders a bar with counts while running', async () => {
    const { lastFrame } = render(<Progress events={events.slice(0, 5)} />)
    await tick()
    const frame = lastFrame() ?? ''
    expect(frame).toMatch(/▰+▱+ 4\/6/)
    expect(frame).toContain('batch 1/2')
    expect(frame).toContain('fuzzy 1')
    expect(frame).not.toContain('Done.')
  })

  it('shows the phase clock and the estimate while a batch runs', async () => {
    const { lastFrame } = render(
      <Progress events={[...events.slice(0, 4), { type: 'batch-phase', index: 1, phase: 'drafting', at: Date.now() }]} />,
    )
    await tick()
    const frame = lastFrame() ?? ''
    expect(frame).toMatch(/drafting \d+s/)
    expect(frame).toMatch(/left, done by /)
  })

  it('renders warnings and the final summary', async () => {
    const { lastFrame } = render(<Progress events={events} />)
    await tick()
    const frame = lastFrame() ?? ''
    expect(frame).toMatch(/▰{20} 6\/6/)
    expect(frame).toContain('placeholder %s missing in draft')
    expect(frame).toContain('Batch 2 skipped (2 entries): claude exited with code 1')
    expect(frame).toContain('Done. 2 translated, 1 fuzzy, 2 from TM, 2 skipped.')
    expect(frame).toContain(`Open ${FILE} in your .po editor to review.`)
  })

  it('shows the stop reason when the run was halted', async () => {
    const stopped: TranslateEvent[] = [
      { type: 'start', file: FILE, total: 10, pending: 6 },
      { type: 'tm-hit', count: 0 },
      { type: 'batch-start', index: 1, of: 3, size: 2, at: T },
      {
        type: 'done',
        summary: { file: FILE, total: 10, pending: 6, fromTm: 0, translated: 0, fuzzy: 0, skipped: 0, stopped: 'DeepL quota exceeded' },
      },
    ]
    const { lastFrame } = render(<Progress events={stopped} />)
    await tick()
    expect(lastFrame()).toContain('Stopped: DeepL quota exceeded')
    expect(lastFrame()).toContain('Done. 0 translated')
  })

  it('takes the counts from the summary when no batch events were seen', async () => {
    const sparse: TranslateEvent[] = [
      { type: 'start', file: FILE, total: 10, pending: 4 },
      { type: 'done', summary: { file: FILE, total: 10, pending: 4, fromTm: 1, translated: 3, fuzzy: 1, skipped: 0 } },
    ]
    const { lastFrame } = render(<Progress events={sparse} />)
    await tick()
    expect(lastFrame()).toMatch(/▰{20} 4\/4/)
    expect(lastFrame()).toContain('fuzzy 1')
  })

  it('counts the entries a locale rule changed, and says nothing when none were', async () => {
    const fixed: TranslateEvent[] = [
      { type: 'start', file: FILE, total: 10, pending: 4 },
      { type: 'done', summary: { file: FILE, total: 10, pending: 4, fromTm: 0, translated: 4, fuzzy: 0, skipped: 0, fixedByRules: 2 } },
    ]
    const { lastFrame } = render(<Progress events={fixed} />)
    await tick()
    expect(flat(lastFrame())).toContain('fixed by locale rules 2')
    const plain = render(<Progress events={events} />)
    await tick()
    expect(plain.lastFrame()).not.toContain('locale rules')
  })

  it('names a locale rule given up on as a runaway', async () => {
    const skipped: TranslateEvent[] = [
      { type: 'start', file: FILE, total: 10, pending: 4 },
      { type: 'done', summary: { file: FILE, total: 10, pending: 4, fromTm: 0, translated: 4, fuzzy: 0, skipped: 0, skippedRules: ['nested repetition'] } },
    ]
    const { lastFrame } = render(<Progress events={skipped} />)
    await tick()
    expect(flat(lastFrame())).toContain('locale rule skipped (took longer than 100 ms): nested repetition')
    const plain = render(<Progress events={events} />)
    await tick()
    expect(plain.lastFrame()).not.toContain('locale rule skipped')
  })

  it('renders a waiting line before the start event', async () => {
    const { lastFrame } = render(<Progress events={[]} />)
    await tick()
    expect(lastFrame()).toMatch(/Loading|Starting/)
  })
})

describe('ReviewProgress and an ignored marker', () => {
  it('renders the notice when the event arrives', () => {
    const state = reduceReviewProgress([
      { type: 'start', file: '/tmp/a.po', total: 10, reviewable: 10 },
      { type: 'marker-ignored', file: '/tmp/a-repaired.po' },
    ])
    expect(state.markerIgnored).toBe('/tmp/a-repaired.po')
  })

  it('shows nothing when no marker was ignored', () => {
    const state = reduceReviewProgress([{ type: 'start', file: '/tmp/a.po', total: 10, reviewable: 10 }])
    expect(state.markerIgnored).toBeUndefined()
  })

  it('paints the notice, rather than only holding it in state', async () => {
    const { lastFrame } = render(
      <ReviewProgress
        events={[
          { type: 'start', file: '/tmp/a.po', total: 10, reviewable: 10 },
          { type: 'marker-ignored', file: '/tmp/a-repaired.po' },
        ]}
      />,
    )
    await tick()
    expect(lastFrame()).toMatch(/earlier version/i)
  })
})

describe('Progress opening the translated file', () => {
  const done: TranslateEvent[] = [
    { type: 'start', file: FILE, total: 10, pending: 6 },
    {
      type: 'done',
      summary: { file: FILE, total: 10, pending: 6, fromTm: 1, translated: 4, fuzzy: 1, skipped: 0 },
    },
  ]

  // Translate rewrites the submission in place, so the file worth opening is the
  // one that was handed in, not a separate output.
  it('opens the file the run wrote in place', async () => {
    vi.mocked(openInDefaultApp).mockClear()
    const { lastFrame, stdin } = render(<Progress events={done} />)
    await tick()
    expect(lastFrame() ?? '').toContain('o to open')
    stdin.write('o')
    await tick()
    expect(vi.mocked(openInDefaultApp)).toHaveBeenCalledWith(FILE)
  })

  // Opening it mid-run would show a catalogue still being rewritten after every
  // batch, which is exactly the half-written state the tool works to avoid.
  it('does nothing while the run is still going', async () => {
    vi.mocked(openInDefaultApp).mockClear()
    const { stdin } = render(<Progress events={[{ type: 'start', file: FILE, total: 10, pending: 6 }]} />)
    await tick()
    stdin.write('o')
    await tick()
    expect(vi.mocked(openInDefaultApp)).not.toHaveBeenCalled()
  })
})

describe('ReviewProgress rule counts', () => {
  const rulesRun = (flagged: number, suspects: number) => [
    { type: 'start' as const, file: FILE, total: 9826, reviewable: 9826 },
    { type: 'rules-done' as const, flagged, suspects },
  ]

  /**
   * The four rules that fire most on Turkish submissions are all `suspect`
   * severity, so a file can carry thousands of rule findings and no errors at
   * all. Reporting only the error count, under a label reading "flagged by
   * rules", showed 0 on a file where the rules had flagged 5,529 of 9,826
   * entries: 4,784 title-case, 944 apostrophe, 311 untranslated, 4 punctuation.
   */
  it('reports entries the rules only suspect, not just the ones they condemn', () => {
    const { lastFrame } = render(<ReviewProgress events={rulesRun(0, 5529)} />)
    const frame = (lastFrame() ?? '').replace(/\s+/g, ' ')
    expect(frame).toContain('5529')
  })

  it('tells the two apart rather than summing them', () => {
    const { lastFrame } = render(<ReviewProgress events={rulesRun(12, 20)} />)
    const frame = (lastFrame() ?? '').replace(/\s+/g, ' ')
    expect(frame).toContain('12')
    expect(frame).toContain('20')
    expect(frame).not.toContain('32')
  })

  it('keeps both counts when the rules found nothing', () => {
    const { lastFrame } = render(<ReviewProgress events={rulesRun(0, 0)} />)
    expect(reduceReviewProgress(rulesRun(0, 0)).suspects).toBe(0)
    expect(lastFrame() ?? '').toContain('reviewable')
  })
})

describe('ReviewProgress resuming', () => {
  /**
   * A resumed run used to be indistinguishable from a cold one: the same
   * header, and a bar counting from zero out of however many batches were
   * left. On a 9,826-entry file with 2,300 entries already judged, the only
   * difference on screen was 302 where a first run said 394.
   */
  const resumed = [
    { type: 'start' as const, file: FILE, total: 9826, reviewable: 9826 },
    { type: 'cached' as const, entries: 2300, batches: 92 },
    { type: 'batch-start' as const, index: 1, of: 302, size: 25, at: T },
  ]

  it('counts the inherited batches as done, and into the total', () => {
    const state = reduceReviewProgress(resumed)
    expect(state.skippedBatches).toBe(92)
    expect(state.cachedEntries).toBe(2300)
    expect(barDone(state)).toBe(92)
    expect(barTotal(state)).toBe(394)
  })

  it('shows the inherited work in the counter rather than starting at zero', () => {
    const { lastFrame } = render(<ReviewProgress events={resumed} />)
    const frame = (lastFrame() ?? '').replace(/\s+/g, ' ')
    expect(frame).toContain('batch 93/394')
    expect(frame).toContain('2300 already judged')
  })

  it('keeps counting from the inherited point as batches finish', () => {
    const state = reduceReviewProgress([
      ...resumed,
      { type: 'batch-done' as const, index: 1, problems: 2, at: T + 1000 },
    ])
    expect(barDone(state)).toBe(93)
    expect(barTotal(state)).toBe(394)
  })

  // A cold run must not grow a "0 already judged" line or a shifted counter.
  it('is unchanged when nothing was inherited', () => {
    const cold = [
      { type: 'start' as const, file: FILE, total: 100, reviewable: 100 },
      { type: 'batch-start' as const, index: 1, of: 4, size: 25, at: T },
    ]
    const state = reduceReviewProgress(cold)
    expect(barDone(state)).toBe(0)
    expect(barTotal(state)).toBe(4)
    expect((render(<ReviewProgress events={cold} />).lastFrame() ?? '')).not.toContain('already judged')
  })

  // Everything already judged: no batch ever starts, so the total is whatever
  // was inherited and the bar is full rather than empty.
  it('reads as finished when the cache covered the whole file', () => {
    const state = reduceReviewProgress([
      { type: 'start' as const, file: FILE, total: 50, reviewable: 50 },
      { type: 'cached' as const, entries: 50, batches: 2 },
    ])
    expect(barDone(state)).toBe(2)
    expect(barTotal(state)).toBe(2)
  })
})

/**
 * Pressing p or q registers the intent immediately, but the run only acts on it
 * at the next batch boundary, which on a hundred-entry batch is minutes away.
 * Until then the screen said nothing at all about a stop, and claimed outright
 * that a pause had already happened while the batch was still being judged.
 * Both left the person who pressed the key watching a bar that had not moved,
 * unable to tell a registered keypress from a dropped one.
 */
describe('ReviewProgress while a stop or a pause is waiting for the batch', () => {
  const midBatch: ReviewEvent[] = [
    { type: 'start', file: '/tmp/a.po', total: 20, reviewable: 20 },
    { type: 'batch-start', index: 1, of: 2, size: 10, at: 0 },
    { type: 'batch-done', index: 1, problems: 1, at: 60_000 },
    { type: 'batch-start', index: 2, of: 2, size: 10, at: 60_000 },
  ]

  it('says a stop is coming, and does not pretend it has happened', () => {
    const state = reduceReviewProgress([...midBatch, { type: 'stopping', at: 61_000 }])
    expect(state.intent).toBe('stop')
    // The batch it is waiting for is still running, so the clock still belongs
    // to it and the bar has not moved.
    expect(state.inFlight).toBe(true)
    expect(state.paused).toBe(false)
  })

  it('says a pause is coming rather than claiming the run is already parked', () => {
    const state = reduceReviewProgress([...midBatch, { type: 'paused', at: 61_000 }])
    expect(state.intent).toBe('pause')
    expect(state.inFlight).toBe(true)
    expect(state.paused).toBe(false)
  })

  it('reports the pause as done once the batch it was waiting for ends', () => {
    const state = reduceReviewProgress([
      ...midBatch,
      { type: 'paused', at: 61_000 },
      { type: 'batch-done', index: 2, problems: 0, at: 120_000 },
    ])
    expect(state.paused).toBe(true)
    expect(state.inFlight).toBe(false)
  })

  it('forgets a pending pause when the run is resumed', () => {
    const state = reduceReviewProgress([...midBatch, { type: 'paused', at: 61_000 }, { type: 'resumed', at: 62_000 }])
    expect(state.intent).toBeUndefined()
    expect(state.paused).toBe(false)
  })

  // A stop asked for after a pause is still a stop: the run is leaving.
  it('lets a stop overrule a pause that has not taken effect', () => {
    const state = reduceReviewProgress([
      ...midBatch,
      { type: 'paused', at: 61_000 },
      { type: 'stopping', at: 62_000 },
    ])
    expect(state.intent).toBe('stop')
  })

  // Estimating an hour of work left is noise once you have said to stop.
  it('drops the remaining-time estimate, which is no longer the plan', () => {
    const state = reduceReviewProgress([...midBatch, { type: 'stopping', at: 61_000 }])
    expect(state.remainingMs).toBeUndefined()
  })

  it('paints the notice rather than only holding it in state', async () => {
    const { lastFrame } = render(<ReviewProgress events={[...midBatch, { type: 'stopping', at: 61_000 }]} />)
    await tick()
    expect(flat(lastFrame())).toContain('will stop after this batch')
  })

  it('paints the pending pause too', async () => {
    const { lastFrame } = render(<ReviewProgress events={[...midBatch, { type: 'paused', at: 61_000 }]} />)
    await tick()
    expect(flat(lastFrame())).toContain('will pause after this batch')
  })
})

/**
 * Translate emitted paused and resumed from the day it had a pause key, and
 * its reducer has never had a case for either, so the events fell through the
 * switch and the screen never said a word. It needs the same account of an
 * intent that is waiting for a boundary.
 */
describe('Progress while a stop or a pause is waiting for the batch', () => {
  const midBatch: TranslateEvent[] = [
    { type: 'start', file: FILE, total: 20, pending: 20 },
    { type: 'batch-start', index: 1, of: 2, size: 10, at: 0 },
    { type: 'batch-done', index: 1, translated: 10, fuzzy: 0, at: 60_000 },
    { type: 'batch-start', index: 2, of: 2, size: 10, at: 60_000 },
  ]

  it('says a stop is coming', async () => {
    const { lastFrame } = render(<Progress events={[...midBatch, { type: 'stopping', at: 61_000 }]} />)
    await tick()
    expect(flat(lastFrame())).toContain('will stop after this batch')
  })

  it('says a pause is coming, and reports it done at the boundary', async () => {
    const { lastFrame } = render(<Progress events={[...midBatch, { type: 'paused', at: 61_000 }]} />)
    await tick()
    expect(flat(lastFrame())).toContain('will pause after this batch')

    const parked = reduceProgress([
      ...midBatch,
      { type: 'paused', at: 61_000 },
      { type: 'batch-done', index: 2, translated: 10, fuzzy: 0, at: 120_000 },
    ])
    expect(parked.paused).toBe(true)
  })
})

/**
 * The resume line said "1 batches left", and the plural was the smallest of
 * three things wrong with it. The count was the batches this run started
 * with, so it never went down: ten batches in it still claimed all twelve.
 * And between inheriting the cached verdicts and starting the first batch,
 * which on a large file is the whole rules pass, no batch count was known yet
 * and it said "0 batches left" to a run with all its work ahead of it.
 */
describe('ReviewProgress resume line', () => {
  const resumed = (...more: ReviewEvent[]): ReviewEvent[] => [
    { type: 'start', file: '/tmp/a.po', total: 5_900, reviewable: 5_900 },
    { type: 'cached', entries: 5_797, batches: 58 },
    ...more,
  ]
  const frame = async (events: ReviewEvent[]) => {
    const { lastFrame } = render(<ReviewProgress events={events} />)
    await tick()
    return flat(lastFrame())
  }

  it('says one batch, not one batches', async () => {
    const text = await frame(resumed({ type: 'batch-start', index: 1, of: 1, size: 100, at: 0 }))
    expect(text).toContain('5797 already judged, 1 batch left.')
  })

  it('keeps the plural for more than one', async () => {
    const text = await frame(resumed({ type: 'batch-start', index: 1, of: 3, size: 100, at: 0 }))
    expect(text).toContain('3 batches left.')
  })

  it('counts down as batches finish', async () => {
    const text = await frame(
      resumed(
        { type: 'batch-start', index: 1, of: 3, size: 100, at: 0 },
        { type: 'batch-done', index: 1, problems: 0, at: 1_000 },
        { type: 'batch-start', index: 2, of: 3, size: 100, at: 1_000 },
      ),
    )
    expect(text).toContain('2 batches left.')
  })

  it('does not claim nothing is left before any batch has been counted', async () => {
    const text = await frame(resumed())
    expect(text).toContain('Resuming: 5797 already judged.')
    expect(text).not.toMatch(/0 batch/)
  })
})

describe('ReviewProgress and what the memory settled', () => {
  const events = (approved: number, repaired: number): ReviewEvent[] => [
    { type: 'start', file: '/tmp/a.po', total: 1359, reviewable: 1359 },
    { type: 'rules-done', flagged: 200, suspects: 600, memoryApproved: approved, memoryRepaired: repaired },
  ]

  it('says how many entries never went to the model', async () => {
    const { lastFrame } = render(<ReviewProgress events={events(71, 173)} />)
    await tick()
    expect(flat(lastFrame())).toContain('memory: 71 approved, 173 repaired')
  })

  it('keeps quiet when the memory settled nothing', async () => {
    const { lastFrame } = render(<ReviewProgress events={events(0, 0)} />)
    await tick()
    expect(flat(lastFrame())).not.toContain('memory:')
  })
})
