import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import React from 'react'
import type { ReviewEvent } from '../../src/types.js'
import { App } from '../../src/tui/App.js'
import { ReviewProgress, reduceReviewProgress } from '../../src/tui/components/ReviewProgress.js'
import {  } from '../../src/tui/screens/Review.js'
import { batchSizeChoices } from '../../src/tui/batch-size.js'
import { DEFAULT_CONFIG, saveConfig } from '../../src/config.js'
import { copyToClipboard } from '../../src/tui/clipboard.js'
import { openInDefaultApp } from '../../src/tui/open-file.js'

// The real one shells out to pbcopy. Nothing in a test run should be writing to
// the developer's clipboard, and a sandbox that blocks spawning would turn an
// assertion about the message into an assertion about the machine.
vi.mock('../../src/tui/clipboard.js', () => ({
  copyToClipboard: vi.fn(() => true),
  clipboardCommands: vi.fn(() => []),
}))

// The real one launches a GUI application. A test run must not open a .po editor on
// whoever is running it.
vi.mock('../../src/tui/open-file.js', () => ({
  openInDefaultApp: vi.fn(() => true),
  openCommand: vi.fn(() => ({ command: 'open', args: [] })),
}))
import type { ReviewFile } from '../../src/tui/commands.js'
import {
  ESC_DELAY,
  fakeCommands,
  flat,
  keys,
  makeHome,
  render,
  reviewSummaryOf,
  tick,
  waitFor,
  waitForText,
  cleanup,
  openFromHome,
  type Home,
} from './helpers.js'

let home: Home
let cwd: string

beforeEach(async () => {
  home = await makeHome()
  // Named rather than assumed: polyglots has no default locale (no-locale.test.tsx).
  saveConfig({ defaultLocale: 'tr' })
  cwd = join(home.path, 'work')
  await mkdir(cwd)
  await writeFile(join(cwd, 'submission.po'), '')
  await writeFile(join(cwd, 'memory.tmx'), '')
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

const FILE = '/tmp/work/submission.po'

const events: ReviewEvent[] = [
  { type: 'start', file: FILE, total: 120, reviewable: 100 },
  { type: 'rules-done', flagged: 12, suspects: 20 },
  { type: 'batch-start', index: 1, of: 2, size: 44, at: 1_000_000 },
  { type: 'batch-done', index: 1, problems: 8, at: 1_060_000 },
  { type: 'batch-start', index: 2, of: 2, size: 44, at: 1_060_000 },
  { type: 'batch-failed', index: 2, size: 44, reason: 'claude exited with code 1', at: 1_120_000 },
  { type: 'written', file: '/tmp/work/submission-problems.po' },
  {
    type: 'done',
    summary: reviewSummaryOf(FILE, {
      total: 120,
      skipped: 20,
      reviewed: 100,
      problems: 64,
      approvable: 36,
      unreviewed: 44,
      byRule: { 'title-case': 9, glossary: 7, placeholder: 4 },
      problemsFile: '/tmp/work/submission-problems.po',
    }),
  },
]

describe('reduceReviewProgress', () => {
  it('accumulates rule findings, batch position and problems', () => {
    const state = reduceReviewProgress(events.slice(0, 4))
    expect(state).toMatchObject({
      started: true,
      file: FILE,
      total: 120,
      reviewable: 100,
      ruleFlagged: 12,
      suspects: 20,
      problems: 20,
      batchesDone: 1,
      batchesTotal: 2,
    })
    expect(state.failures).toEqual([])
    expect(state.summary).toBeUndefined()
  })

  it('records a failed batch as unreviewed without losing the run', () => {
    const state = reduceReviewProgress(events)
    expect(state.unreviewed).toBe(44)
    expect(state.failures).toEqual(['Batch 2 failed (44 entries): claude exited with code 1'])
    expect(state.summary?.problems).toBe(64)
  })
})

// Resume is per entry and lives in the job store, so a resumed run batches only
// its outstanding entries and the bar counts those from zero. Nothing is
// inherited, and nothing on screen claims otherwise.
describe('reduceReviewProgress on a resumed run', () => {
  const events: ReviewEvent[] = [
    { type: 'start', file: FILE, total: 200, reviewable: 200 },
    { type: 'batch-start', index: 1, of: 10, size: 25, at: 1_000_000 },
    { type: 'batch-done', index: 1, problems: 2, at: 1_060_000 },
  ]

  it('counts the batches this run has to do, and no inherited ones', () => {
    expect(reduceReviewProgress(events)).toMatchObject({ batchesDone: 1, batchesTotal: 10 })
  })

  it('says nothing on screen about picking up an earlier run', () => {
    const frame = flat(render(<ReviewProgress events={events} />).lastFrame())
    expect(frame).not.toMatch(/resum\w+ after/i)
  })

  it('estimates from the batches it timed', () => {
    const state = reduceReviewProgress([
      ...events,
      { type: 'batch-start', index: 2, of: 10, size: 25, at: 1_060_000 },
      { type: 'batch-done', index: 2, problems: 0, at: 1_120_000 },
    ])
    expect(state.batchDurations).toEqual([60_000, 60_000])
    expect(state.remainingMs).toBe(8 * 60_000)
  })
})

describe('ReviewProgress remaining time', () => {
  const timed = (n: number, ms: number): ReviewEvent[] => {
    const out: ReviewEvent[] = [{ type: 'start', file: FILE, total: 200, reviewable: 200 }]
    let t = 1_000_000
    for (let i = 1; i <= n; i++) {
      out.push({ type: 'batch-start', index: i, of: 8, size: 25, at: t })
      t += ms
      out.push({ type: 'batch-done', index: i, problems: 1, at: t })
    }
    out.push({ type: 'batch-start', index: n + 1, of: 8, size: 25, at: t })
    return out
  }

  it('estimates what is left once it has a couple of batches to go on', () => {
    const state = reduceReviewProgress(timed(3, 60_000))
    expect(state.batchDurations).toEqual([60_000, 60_000, 60_000])
    expect(state.remainingMs).toBe(5 * 60_000)
  })

  // Two batches into a 114-batch run is half an hour of silence. The guess is
  // rough and says so by changing as soon as a real batch lands.
  it('guesses from a default pace before any batch has finished', () => {
    const state = reduceReviewProgress([
      { type: 'start', file: FILE, total: 2831, reviewable: 2805 },
      { type: 'batch-start', index: 1, of: 114, size: 25, at: 1_000_000 },
    ])
    expect(state.remainingMs).toBe(114 * 25 * 4_000)
  })

  it('replaces the guess with the first batch it actually timed', () => {
    expect(reduceReviewProgress(timed(1, 60_000)).remainingMs).toBe(7 * 60_000)
  })

  it('has nothing to guess from before the first batch is announced', () => {
    const state = reduceReviewProgress([{ type: 'start', file: FILE, total: 2831, reviewable: 2805 }])
    expect(state.remainingMs).toBeUndefined()
  })

  it('ignores events with no timestamp rather than producing nonsense', () => {
    const state = reduceReviewProgress([
      { type: 'start', file: FILE, total: 50, reviewable: 50 },
      { type: 'batch-start', index: 1, of: 2, size: 25 } as ReviewEvent,
      { type: 'batch-done', index: 1, problems: 0 } as ReviewEvent,
    ])
    // Nothing was timed, so nothing is measured; the estimate falls back to the
    // default pace rather than to NaN.
    expect(state.batchDurations).toEqual([])
    expect(state.remainingMs).toBe(1 * 25 * 4_000)
  })

  it('shows the estimate and a finish time in the line', () => {
    const { lastFrame } = render(<ReviewProgress events={timed(3, 60_000)} />)
    const frame = flat(lastFrame())
    expect(frame).toMatch(/5m left/)
    expect(frame).toMatch(/\d{1,2}[:.]\d{2}/)
  })
})

describe('ReviewProgress in-flight clock', () => {
  it('marks a batch as in flight once it starts and not before', () => {
    const before = reduceReviewProgress([{ type: 'start', file: FILE, total: 10, reviewable: 10 }])
    expect(before.inFlight).toBe(false)

    const during = reduceReviewProgress([
      { type: 'start', file: FILE, total: 10, reviewable: 10 },
      { type: 'batch-start', index: 1, of: 4, size: 25, at: 1000 },
    ])
    expect(during.inFlight).toBe(true)

    const after = reduceReviewProgress([
      { type: 'start', file: FILE, total: 10, reviewable: 10 },
      { type: 'batch-start', index: 1, of: 4, size: 25, at: 1000 },
      { type: 'batch-done', index: 1, problems: 2, at: 2000 },
    ])
    expect(after.inFlight).toBe(false)
  })

  // Two counters (batches done and batch in flight) read as a contradiction; the
  // bar already shows the completed fraction, so the text says what is happening.
  it('shows one counter, not both, while a batch is in flight', () => {
    const { lastFrame } = render(
      <ReviewProgress
        events={[
          { type: 'start', file: FILE, total: 200, reviewable: 200 },
          { type: 'batch-start', index: 1, of: 8, size: 25, at: 1_000_000 },
          { type: 'batch-done', index: 1, problems: 1, at: 1_060_000 },
          { type: 'batch-start', index: 2, of: 8, size: 25, at: 1_060_000 },
          { type: 'batch-done', index: 2, problems: 2, at: 1_120_000 },
          { type: 'batch-start', index: 3, of: 8, size: 25, at: 1_120_000 },
        ]}
      />,
    )
    const frame = flat(lastFrame())
    expect(frame).toMatch(/batch 3\/8/)
    expect(frame).not.toMatch(/2\/8/)
  })

  it('falls back to a completed count when no batch is running', () => {
    const { lastFrame } = render(
      <ReviewProgress
        events={[
          { type: 'start', file: FILE, total: 200, reviewable: 200 },
          { type: 'batch-start', index: 1, of: 8, size: 25, at: 1_000_000 },
          { type: 'batch-done', index: 1, problems: 1, at: 1_060_000 },
        ]}
      />,
    )
    expect(flat(lastFrame())).toMatch(/1\/8/)
  })

  // A batch is a single claude call taking minutes; without this the bar sits at
  // the same fraction with no way to tell work from a wedged subprocess.
  it('shows the batch it is waiting on while one is in flight', () => {
    const { lastFrame } = render(
      <ReviewProgress
        events={[
          { type: 'start', file: FILE, total: 100, reviewable: 100 },
          { type: 'batch-start', index: 1, of: 4, size: 25, at: 1_000_000 },
        ]}
      />,
    )
    expect(flat(lastFrame())).toMatch(/batch 1\/4/)
    expect(flat(lastFrame())).toMatch(/\d+s/)
  })
})

describe('ReviewProgress needs-your-eye', () => {
  it('reports entries only the human can judge after a rules-only run', () => {
    const summary = reviewSummaryOf('plugin-tr.po', { problems: 2, needsReview: 7, approvable: 40 })
    const { lastFrame } = render(<ReviewProgress events={[{ type: 'start', file: 'plugin-tr.po', total: 49, reviewable: 49 }, { type: 'done', summary }]} />)
    expect(lastFrame() ?? '').toMatch(/7 of those are unadjudicated/i)
  })
})

describe('ReviewProgress', () => {
  it('renders a bar over batches with a running problem count', async () => {
    const { lastFrame } = render(<ReviewProgress events={events.slice(0, 4)} />)
    await tick()
    const frame = lastFrame() ?? ''
    expect(frame).toMatch(/▰+▱+ 1\/2/)
    expect(frame).toContain('problems 20')
    expect(frame).not.toContain('Done.')
  })

  it('renders the failed batch line', async () => {
    const { lastFrame } = render(<ReviewProgress events={events} />)
    await tick()
    expect(lastFrame()).toContain('Batch 2 failed (44 entries): claude exited with code 1')
  })

  it('renders the summary with the rule breakdown and the problems path', async () => {
    const { lastFrame } = render(<ReviewProgress events={events} />)
    await tick()
    const frame = flat(lastFrame())
    expect(frame).toContain('64 problems')
    expect(frame).toContain('36 approvable')
    expect(frame).toContain('44 unreviewed')
    expect(frame).toContain('title-case 9')
    expect(frame).toContain('glossary 7')
    expect(frame).toContain('/tmp/work/submission-problems.po')
    expect(frame).not.toContain('-report.md')
  })

  // Repaired entries are written fuzzy, and fuzzy is what `translate` selects, so
  // telling the user to run it over this file re-translates every repair the
  // review just made. The repair exists in no other file.
  it('sends the user to their .po editor rather than back through translate', async () => {
    const { lastFrame } = render(<ReviewProgress events={events} />)
    await tick()
    const frame = flat(lastFrame())
    expect(frame).not.toContain('polyglots translate')
    expect(frame).toMatch(/\.po editor/)
  })

  it('says the submission is clean when nothing was flagged', async () => {
    const clean: ReviewEvent[] = [
      { type: 'start', file: FILE, total: 10, reviewable: 10 },
      {
        type: 'done',
        summary: reviewSummaryOf(FILE, {
          total: 10,
          skipped: 0,
          reviewed: 10,
          problems: 0,
          approvable: 10,
          unreviewed: 0,
          byRule: {},
          problemsFile: undefined,
        }),
      },
    ]
    const { lastFrame } = render(<ReviewProgress events={clean} />)
    await tick()
    const frame = flat(lastFrame())
    expect(frame).toMatch(/nothing flagged|no problems/i)
    expect(frame).toContain('10 approvable')
    expect(frame).not.toContain('problems.po')
  })

  it('omits the unreviewed count when every batch succeeded', async () => {
    const { lastFrame } = render(
      <ReviewProgress
        events={[
          { type: 'start', file: FILE, total: 10, reviewable: 10 },
          { type: 'done', summary: reviewSummaryOf(FILE, { unreviewed: 0 }) },
        ]}
      />,
    )
    await tick()
    expect(flat(lastFrame())).not.toContain('unreviewed')
  })

  it('says it stopped early when entries were left unreviewed', () => {
    const events: ReviewEvent[] = [
      { type: 'start', file: FILE, total: 200, reviewable: 200 },
      { type: 'done', summary: reviewSummaryOf(FILE, { problems: 12, approvable: 40, pending: 148, written: 12 }) },
    ]
    const frame = flat(render(<ReviewProgress events={events} />).lastFrame())
    expect(frame).toMatch(/stopped early/i)
    expect(frame).toContain('148')
  })

  it('reports repairs in the summary', () => {
    const repairEvents: ReviewEvent[] = [
      { type: 'start', file: FILE, total: 120, reviewable: 100 },
      { type: 'done', summary: reviewSummaryOf(FILE, { problems: 40, approvable: 60, repaired: 33 }) },
    ]
    expect(flat(render(<ReviewProgress events={repairEvents} />).lastFrame())).toMatch(/33 repaired/)
  })

  // Whitespace-only fixes are written but count as neither a problem nor a
  // needsReview entry, so flagged (problems + needsReview) undercounts what
  // was written. Subtracting repaired from flagged instead of written would
  // print a negative "left for you" here.
  it('never goes negative when everything written was a mechanical fix', () => {
    const wsEvents: ReviewEvent[] = [
      { type: 'start', file: FILE, total: 10, reviewable: 10 },
      {
        type: 'done',
        summary: reviewSummaryOf(FILE, { problems: 0, needsReview: 0, approvable: 10, repaired: 10, written: 10 }),
      },
    ]
    const frame = flat(render(<ReviewProgress events={wsEvents} />).lastFrame())
    expect(frame).toContain('10 repaired, 0 left for you')
    expect(frame).not.toMatch(/-\d+ left for you/)
  })

  it('names a locale rule given up on as a runaway', () => {
    const skippedEvents: ReviewEvent[] = [
      { type: 'start', file: FILE, total: 10, reviewable: 10 },
      { type: 'done', summary: { ...reviewSummaryOf(FILE, { approvable: 10 }), skippedRules: ['nested repetition'] } },
    ]
    expect(flat(render(<ReviewProgress events={skippedEvents} />).lastFrame())).toContain(
      'locale rule skipped (took longer than 100 ms): nested repetition',
    )
    expect(flat(render(<ReviewProgress events={events} />).lastFrame())).not.toContain('locale rule skipped')
  })
})

describe('batchSizeChoices', () => {
  it('offers a ladder from a small batch to a large one', () => {
    expect(batchSizeChoices(25)).toEqual([10, 25, 50, 75, 100])
  })

  // Otherwise a locale team that set an unusual default in config.json could not
  // get back to it after one keypress.
  it('keeps a configured size reachable, in its place on the ladder', () => {
    expect(batchSizeChoices(40)).toEqual([10, 25, 40, 50, 75, 100])
    expect(batchSizeChoices(200)).toEqual([10, 25, 50, 75, 100, 200])
  })
})

describe('Review screen', () => {
  const openReview = async (commands = fakeCommands()) => {
    const view = render(<App commands={commands} cwd={cwd} />)
    await openFromHome(view.stdin, 'review')
    await waitForText(view.lastFrame, 'submission.po')
    return view
  }

  // The picker highlights '..' first, so the file needs one step down.
  const pickFile = async (view: { stdin: { write(d: string): void }; lastFrame: () => string | undefined }) => {
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Start review/)
  }

  it('filters the picker to .po files', async () => {
    const { lastFrame } = await openReview()
    expect(lastFrame()).toContain('submission.po')
    expect(lastFrame()).not.toContain('memory.tmx')
  })

  // The form has no locale field once one is configured, so what the config
  // holds is read off the run it starts rather than off the screen.
  it('runs in the locale from the config, without a field for it', async () => {
    await mkdir(join(home.path, 'config'), { recursive: true })
    await writeFile(join(home.path, 'config', 'config.json'), JSON.stringify({ defaultLocale: 'de' }))
    const reviewFile = vi.fn<ReviewFile>(async (opts) => {
      opts.onProgress?.({ type: 'done', summary: reviewSummaryOf(opts.file) })
      return reviewSummaryOf(opts.file)
    })
    const view = await openReview(fakeCommands({ reviewFile }))
    await pickFile(view)
    expect(flat(view.lastFrame())).not.toContain('Locale:')
    for (let i = 0; i < 3; i++) {
      view.stdin.write(keys.down)
      await tick()
    }
    view.stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length > 0)
    expect(reviewFile.mock.calls[0]?.[0]).toMatchObject({ locale: 'de' })
  })

  it('passes the picked file, locale and AI choice to the command', async () => {
    const reviewFile = vi.fn<ReviewFile>(async (opts) => {
      opts.onProgress?.({ type: 'start', file: opts.file, total: 3, reviewable: 3 })
      opts.onProgress?.({ type: 'done', summary: reviewSummaryOf(opts.file) })
      return reviewSummaryOf(opts.file)
    })
    const view = await openReview(fakeCommands({ reviewFile }))
    await pickFile(view)
    const { lastFrame, stdin } = view

    stdin.write(keys.down)
    await tick()
    stdin.write(' ')
    await waitForText(lastFrame, /Skip AI checks:\s*yes/i)
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.enter)

    await waitFor(() => reviewFile.mock.calls.length > 0)
    expect(reviewFile.mock.calls[0]?.[0]).toMatchObject({
      file: join(cwd, 'submission.po'),
      locale: 'tr',
      noAi: true,
    })
  })

  // With reviewProvider none there is no AI to skip to or from: the field is
  // fixed on, says why, and the run is rules-only without anyone toggling it.
  it('fixes rules-only on when the review provider is none, and says why', async () => {
    saveConfig({ defaultLocale: 'tr', reviewProvider: 'none' })
    const reviewFile = vi.fn<ReviewFile>(async (opts) => {
      opts.onProgress?.({ type: 'done', summary: reviewSummaryOf(opts.file) })
      return reviewSummaryOf(opts.file)
    })
    const view = await openReview(fakeCommands({ reviewFile }))
    await pickFile(view)
    const { lastFrame, stdin } = view
    await waitForText(lastFrame, /Skip AI checks:\s*yes/i)
    expect(flat(lastFrame())).toContain('No AI is set up as the review provider')
    stdin.write(keys.down)
    await tick()
    stdin.write(' ')
    await tick()
    expect(flat(lastFrame())).toMatch(/Skip AI checks:\s*yes/i)
    for (let i = 0; i < 2; i++) {
      stdin.write(keys.down)
      await tick()
    }
    stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length > 0)
    expect(reviewFile.mock.calls[0]?.[0]).toMatchObject({ noAi: true })
  })

  /**
   * The reducer could always describe a pending stop; nothing ever told it one
   * had been asked for. Pressing q set the run control to stopping and the
   * screen subscribed to paused and resumed only, so the key registered in
   * silence and the display went on looking exactly like a run that had not
   * heard it until the batch in flight ended, minutes later.
   */
  it('says a stop is coming the moment q is pressed', async () => {
    const reviewFile = vi.fn<ReviewFile>(async (opts) => {
      opts.onProgress?.({ type: 'start', file: opts.file, total: 200, reviewable: 200 })
      opts.onProgress?.({ type: 'batch-start', index: 1, of: 2, size: 100, at: Date.now() })
      // Never resolves: the point is what the screen says while a batch that
      // has not finished is still being judged.
      return new Promise<never>(() => {})
    })
    const view = await openReview(fakeCommands({ reviewFile }))
    await pickFile(view)
    const { lastFrame, stdin } = view

    stdin.write(keys.down)
    await tick()
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length > 0)

    stdin.write('q')
    await waitForText(lastFrame, /will stop after this batch/)
    // The run is leaving, so it must not also read as parked.
    expect(flat(lastFrame())).not.toMatch(/paused after batch/)
  })

  it('defaults the batch size from the config', async () => {
    await mkdir(join(home.path, 'config'), { recursive: true })
    await writeFile(join(home.path, 'config', 'config.json'), JSON.stringify({ batchSize: 50 }))
    const view = await openReview()
    await pickFile(view)

    expect(flat(view.lastFrame())).toMatch(/Batch size:\s*50/)
  })

  // An agent's batch, often 100, is three times what a small local context
  // holds, so the experimental local reviewer starts small and says why.
  it('starts a local review at a small batch, marked experimental, with a warning over the context', async () => {
    await mkdir(join(home.path, 'config'), { recursive: true })
    await writeFile(
      join(home.path, 'config', 'config.json'),
      JSON.stringify({
        batchSize: 100,
        reviewProvider: 'local',
        ollama: { baseUrl: 'http://localhost:11434', model: 'qwen3.8:27b-mlx', contextLength: 4096 },
      }),
    )
    const view = await openReview()
    await pickFile(view)
    const frame = flat(view.lastFrame())
    expect(frame).toMatch(/Batch size:\s*12/)
    expect(frame).toContain('Provider: local (experimental)')
    expect(frame).not.toMatch(/more than the 4,096-token context/)
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.right)
    await waitForText(view.lastFrame, /Batch size:\s*25/)
    expect(flat(view.lastFrame())).toMatch(/more than the 4,096-token context/)
  })

  // A whole-night review is where batch size actually matters: fewer, larger
  // calls finish sooner, and the CLI flag is no help from inside the TUI.
  it('passes the chosen batch size to the command', async () => {
    const reviewFile = vi.fn<ReviewFile>(async (opts) => {
      opts.onProgress?.({ type: 'done', summary: reviewSummaryOf(opts.file) })
      return reviewSummaryOf(opts.file)
    })
    const view = await openReview(fakeCommands({ reviewFile }))
    await pickFile(view)
    const { lastFrame, stdin } = view

    stdin.write(keys.right)
    await waitForText(lastFrame, /Batch size:\s*50/)
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.enter)

    await waitFor(() => reviewFile.mock.calls.length > 0)
    expect(reviewFile.mock.calls[0]?.[0]).toMatchObject({ batchSize: 50 })
  })

  // Without this the TUI has no answer to a refused resume: the message names
  // starting over, and there would be no way to do it.
  it('passes the start-over choice to the command', async () => {
    const reviewFile = vi.fn<ReviewFile>(async (opts) => {
      opts.onProgress?.({ type: 'done', summary: reviewSummaryOf(opts.file) })
      return reviewSummaryOf(opts.file)
    })
    const view = await openReview(fakeCommands({ reviewFile }))
    await pickFile(view)
    const { lastFrame, stdin } = view

    stdin.write(keys.down)
    await tick()
    stdin.write(keys.down)
    await tick()
    stdin.write(' ')
    await waitForText(lastFrame, /Start over:\s*yes/i)
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.enter)

    await waitFor(() => reviewFile.mock.calls.length > 0)
    expect(reviewFile.mock.calls[0]?.[0]).toMatchObject({ fresh: true })
  })

  it('resumes an interrupted review unless told to start over', async () => {
    const reviewFile = vi.fn<ReviewFile>(async (opts) => {
      opts.onProgress?.({ type: 'done', summary: reviewSummaryOf(opts.file) })
      return reviewSummaryOf(opts.file)
    })
    const view = await openReview(fakeCommands({ reviewFile }))
    await pickFile(view)

    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.enter)

    await waitFor(() => reviewFile.mock.calls.length > 0)
    expect(reviewFile.mock.calls[0]?.[0]).toMatchObject({ fresh: false })
  })

  // Discovery reports on the binary the override names, so a TUI run that
  // ignored it would spawn bare claude from PATH: the menu would say ready and
  // batch one would fail with ENOENT, the failure discovery exists to catch.
  it('runs the agent binary named by POLYGLOTS_AGENT_BIN', async () => {
    vi.stubEnv('POLYGLOTS_AGENT_BIN', '/opt/claude/bin/claude')
    try {
      const reviewFile = vi.fn<ReviewFile>(async (opts) => {
        opts.onProgress?.({ type: 'done', summary: reviewSummaryOf(opts.file) })
        return reviewSummaryOf(opts.file)
      })
      const view = await openReview(fakeCommands({ reviewFile }))
      await pickFile(view)
      for (let i = 0; i < 3; i++) {
        view.stdin.write(keys.down)
        await tick()
      }
      view.stdin.write(keys.enter)

      await waitFor(() => reviewFile.mock.calls.length > 0)
      expect(reviewFile.mock.calls[0]?.[0]).toMatchObject({ bin: '/opt/claude/bin/claude' })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('shows the summary when the run finishes', async () => {
    const view = await openReview()
    await pickFile(view)
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /approvable/)
  })

  it('returns to the menu with escape before a run starts', async () => {
    const { lastFrame, stdin } = await openReview()
    stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(lastFrame, 'Review statistics')
  })
})

describe('ReviewProgress requester message', () => {
  const doneWith = (patch: Parameters<typeof reviewSummaryOf>[1]): ReviewEvent[] => [
    { type: 'start', file: FILE, total: 120, reviewable: 120 },
    { type: 'done', summary: reviewSummaryOf(FILE, patch) },
  ]

  it('offers a sentence the reviewer can post back', () => {
    const { lastFrame } = render(
      <ReviewProgress
        events={doneWith({ repaired: 37, byGroup: { glossary: 24, meaning: 11, 'title-case': 6, other: 5 } })}
      />,
    )
    // Ink wraps the sentence to the terminal width, so it is compared unwrapped.
    const frame = (lastFrame() ?? '').replace(/\s+/g, ' ')
    expect(frame).toContain('I fixed 37 entries')
    expect(frame).toContain('~25 glossary inconsistencies, ~10 meaning and fluency problems')
    expect(frame).toContain('~5 title-case issues, plus a few smaller ones.')
    expect(frame).toContain('c to copy')
  })

  // Nothing repaired means there is nothing to tell anyone, and an empty message
  // on screen would only invite posting it.
  it('offers nothing when nothing was repaired', () => {
    const { lastFrame } = render(<ReviewProgress events={doneWith({ repaired: 0, byGroup: {} })} />)
    expect(lastFrame() ?? '').not.toContain('c to copy')
  })

  it('confirms a copy that worked', async () => {
    const { lastFrame, stdin } = render(
      <ReviewProgress events={doneWith({ repaired: 4, byGroup: { glossary: 4 } })} />,
    )
    await tick()
    stdin.write('c')
    await tick()
    expect(lastFrame() ?? '').toMatch(/copied to the clipboard/i)
  })

  // The sentence stays on screen when the clipboard is unreachable, so a failed
  // copy costs a keystroke rather than the run's output.
  it('says so when the clipboard cannot be reached, keeping the sentence visible', async () => {
    vi.mocked(copyToClipboard).mockReturnValueOnce(false)
    const { lastFrame, stdin } = render(
      <ReviewProgress events={doneWith({ repaired: 4, byGroup: { glossary: 4 } })} />,
    )
    await tick()
    stdin.write('c')
    await tick()
    const frame = (lastFrame() ?? '').replace(/\s+/g, ' ')
    expect(frame).toMatch(/could not reach the clipboard/i)
    expect(frame).toContain('I fixed 4 entries')
  })
})

describe('ReviewProgress opening the repaired file', () => {
  const REPAIRED = '/tmp/work/submission-problems.po'

  it('opens the repaired file rather than the submission', async () => {
    const { stdin } = render(
      <ReviewProgress
        events={[
          { type: 'start', file: FILE, total: 10, reviewable: 10 },
          { type: 'done', summary: reviewSummaryOf(FILE, { problems: 2, problemsFile: REPAIRED }) },
        ]}
      />,
    )
    await tick()
    stdin.write('o')
    await tick()
    expect(vi.mocked(openInDefaultApp)).toHaveBeenCalledWith(REPAIRED)
  })

  // Nothing was written, so there is nothing to open and o must not launch the
  // submission the reviewer was given.
  it('does nothing when the run wrote no file', async () => {
    vi.mocked(openInDefaultApp).mockClear()
    const { lastFrame, stdin } = render(
      <ReviewProgress
        events={[
          { type: 'start', file: FILE, total: 10, reviewable: 10 },
          { type: 'done', summary: reviewSummaryOf(FILE, { problems: 0, problemsFile: undefined }) },
        ]}
      />,
    )
    await tick()
    stdin.write('o')
    await tick()
    expect(vi.mocked(openInDefaultApp)).not.toHaveBeenCalled()
    expect(lastFrame() ?? '').not.toContain('o to open')
  })
})

describe('the review screen names its provider', () => {
  /**
   * A review that recorded `antigravity` spent Claude's subscription for an
   * entire night without anything on screen to contradict it. Naming the agent
   * on the screens that start and report a job is what makes that visible.
   */
  const withProvider = (reviewProvider: 'claude' | 'antigravity') =>
    fakeCommands({ loadConfig: () => ({ ...DEFAULT_CONFIG, reviewProvider }) })

  const open = async (reviewProvider: 'claude' | 'antigravity') => {
    const view = render(<App commands={withProvider(reviewProvider)} cwd={cwd} />)
    await openFromHome(view.stdin, 'review')
    await waitForText(view.lastFrame, 'Review a submitted')
    return view
  }

  it('says nothing while a file is still being picked', async () => {
    const view = await open('antigravity')
    expect(view.lastFrame() ?? '').not.toContain('Provider:')
  })

  it('names the agent on the options screen, where the job starts', async () => {
    const view = await open('antigravity')
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'Provider:')
    expect((view.lastFrame() ?? '').replace(/\s+/g, ' ')).toContain('Provider: antigravity')
  })

  it('names claude when that is what is configured', async () => {
    const view = await open('claude')
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'Provider:')
    expect((view.lastFrame() ?? '').replace(/\s+/g, ' ')).toContain('Provider: claude')
  })
})
