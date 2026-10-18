import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main, type CliDeps } from '../../src/cli.js'
import type { ReviewOptions } from '../../src/commands/review.js'
import type { ReviewEvent, ReviewSummary } from '../../src/types.js'

// `review a.po b.po --parallel 2` prints a line every time one of the files
// closes a batch: the file, the batch, the file's own time and the overall
// line the batch screen shows, so a long run on the command line says how far
// it is without a bar that two jobs would garble.

function sink() {
  return {
    isTTY: false,
    text: '',
    write(chunk: string) {
      this.text += chunk
      return true
    },
  }
}

function stdinWith() {
  const stream = new PassThrough() as PassThrough & { isTTY?: boolean }
  stream.isTTY = false
  stream.end()
  return stream
}

const summary = (file: string): ReviewSummary => ({
  file,
  locale: 'tr',
  total: 20,
  skipped: 0,
  reviewed: 20,
  problems: 0,
  needsReview: 0,
  approvable: 20,
  unreviewed: 0,
  repaired: 0,
  written: 0,
  pending: 0,
  byRule: {},
  byGroup: {},
})

const po = `msgid ""
msgstr ""
"Language: tr\\n"
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Save"
msgstr "Kaydet"
`

const T0 = new Date('2026-10-17T20:00:00Z').getTime()
const MIN = 60_000

let home: string
let savedEnv: NodeJS.ProcessEnv
let a: string
let b: string

beforeEach(async () => {
  savedEnv = { ...process.env }
  home = await mkdtemp(join(tmpdir(), 'polyglots-cli-batch-lines-'))
  process.env.POLYGLOTS_HOME = home
  await mkdir(join(home, 'config'), { recursive: true })
  await writeFile(join(home, 'config', 'config.json'), JSON.stringify({ defaultLocale: 'tr' }))
  a = join(home, 'a-tr.po')
  b = join(home, 'b-tr.po')
  await writeFile(a, po)
  await writeFile(b, po)
  // Only the clock is faked: the run's own timers and sqlite stay real.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(async () => {
  vi.useRealTimers()
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  await rm(home, { recursive: true, force: true })
})

/**
 * Two fake files sharing one script: each step is one file's event at a set
 * time, and a file waits for its turn, so the events reach the CLI in exactly
 * this order however the two jobs are scheduled. Neither returns until the
 * whole script has run, so no file finishes part way through.
 */
function scripted(steps: Array<{ file: () => string; at: number; event: (at: number) => ReviewEvent }>) {
  let next = 0
  const waiters: Array<() => void> = []
  const wake = () => {
    for (const w of waiters.splice(0)) w()
  }
  const turn = (i: number) =>
    new Promise<void>((resolve) => {
      const check = () => (next >= i ? resolve() : waiters.push(check))
      check()
    })
  return async (opts: ReviewOptions): Promise<ReviewSummary> => {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!
      if (step.file() !== opts.file) continue
      await turn(i)
      vi.setSystemTime(T0 + step.at)
      opts.onProgress?.(step.event(T0 + step.at))
      next = i + 1
      // Skip ahead past the steps that belong to nobody waiting.
      wake()
    }
    await turn(steps.length)
    return summary(opts.file)
  }
}

async function run(argv: string[], deps: Omit<CliDeps, 'streams'>) {
  const stdout = sink()
  const stderr = sink()
  const code = await main(argv, { env: {}, ...deps, streams: { stdin: stdinWith(), stdout, stderr } })
  return { code, stdout: stdout.text, stderr: stderr.text }
}

describe('batch lines on the command line', () => {
  it('prints one line per closed batch, in event order, with the file time and the overall counts', async () => {
    const reviewFile = scripted([
      { file: () => a, at: 0, event: (at) => ({ type: 'batch-start', index: 1, of: 2, size: 10, at }) },
      { file: () => b, at: 0, event: (at) => ({ type: 'batch-start', index: 1, of: 1, size: 10, at }) },
      { file: () => a, at: 1 * MIN, event: (at) => ({ type: 'batch-done', index: 1, problems: 0, at }) },
      { file: () => a, at: 1 * MIN, event: (at) => ({ type: 'batch-start', index: 2, of: 2, size: 10, at }) },
      { file: () => b, at: 3 * MIN, event: (at) => ({ type: 'batch-failed', index: 1, size: 10, reason: 'timed out', at }) },
      { file: () => a, at: 5 * MIN, event: (at) => ({ type: 'batch-done', index: 2, problems: 0, at }) },
    ])
    const r = await run(['review', a, b, '--parallel', '2', '--no-ai'], { reviewFile })
    expect(r.code).toBe(0)

    const lines = r.stderr.split('\n').filter((l) => / · batch \d|left, done by|estimating…|batch(es)? failed$/.test(l))
    expect(lines[0]).toBe(`${a} · batch 1/2 · 1m · 0 of 2 files done · 2 running · 0 queued · 1m elapsed`)
    // A finished batch is what makes an estimate possible.
    expect(lines[1]).toMatch(/^~\d+m left, done by /)
    expect(lines[2]).toBe(`${b} · batch 1/1 · 3m · 0 of 2 files done · 2 running · 0 queued · 3m elapsed`)
    expect(lines[3]).toMatch(/ · 1 batch failed$/)
    expect(lines[4]).toBe(`${a} · batch 2/2 · 5m · 0 of 2 files done · 2 running · 0 queued · 5m elapsed`)
    // Every batch has closed, so the estimate goes and the failed count stays.
    expect(lines[5]).toBe('1 batch failed')
    expect(lines).toHaveLength(6)
  })

  it('prints the second line again only when it has changed', async () => {
    // b never reaches its first batch, so it has no estimate of its own and
    // the line stays at "estimating…" through both of a's batches.
    const reviewFile = scripted([
      { file: () => a, at: 0, event: (at) => ({ type: 'batch-start', index: 1, of: 3, size: 10, at }) },
      { file: () => a, at: 1 * MIN, event: (at) => ({ type: 'batch-done', index: 1, problems: 0, at }) },
      { file: () => a, at: 1 * MIN, event: (at) => ({ type: 'batch-start', index: 2, of: 3, size: 10, at }) },
      { file: () => a, at: 2 * MIN, event: (at) => ({ type: 'batch-done', index: 2, problems: 0, at }) },
    ])
    const r = await run(['review', a, b, '--parallel', '2', '--no-ai'], { reviewFile })
    const lines = r.stderr.split('\n').filter((l) => / · batch \d|estimating…|left, done by/.test(l))
    expect(lines).toEqual([
      `${a} · batch 1/3 · 1m · 0 of 2 files done · 2 running · 0 queued · 1m elapsed`,
      'estimating…',
      `${a} · batch 2/3 · 2m · 0 of 2 files done · 2 running · 0 queued · 2m elapsed`,
    ])
  })

  // The printer runs inside the run's onProgress, so a throw from it would
  // reach the batch loop and fail a metered run over a line of output.
  it('drops a batch line it cannot print and still ends the review done', async () => {
    // Not scripted: a throw there would leave the other file waiting for a
    // turn that never comes, and the test would time out instead of failing.
    const reviewFile = async (opts: ReviewOptions): Promise<ReviewSummary> => {
      opts.onProgress?.({ type: 'batch-start', index: 1, of: 1, size: 10, at: Date.now() })
      opts.onProgress?.({ type: 'batch-done', index: 1, problems: 0, at: Date.now() })
      return summary(opts.file)
    }
    const stdout = sink()
    const stderr = sink()
    const write = stderr.write.bind(stderr)
    stderr.write = (chunk: string) => {
      if (chunk.includes(' · batch ')) throw new Error('EPIPE')
      return write(chunk)
    }
    const code = await main(['review', a, b, '--no-ai'], { env: {}, reviewFile, streams: { stdin: stdinWith(), stdout, stderr } })
    expect(code).toBe(0)
    expect(stderr.text).toMatch(/\[2\/2\] .*b-tr\.po: done/)
    expect(stderr.text).not.toMatch(/: failed/)
  })

  // The Started and [n/N] lines go through the batch's own event handler,
  // which the run calls between files; a throw there must not end the batch.
  it('drops a start or end line it cannot print and still ends the review done', async () => {
    const stdout = sink()
    const stderr = sink()
    const write = stderr.write.bind(stderr)
    stderr.write = (chunk: string) => {
      if (chunk.startsWith('Started ') || chunk.startsWith('[1/2]')) throw new Error('EPIPE')
      return write(chunk)
    }
    const code = await main(['review', a, b, '--no-ai'], {
      env: {},
      reviewFile: async (opts) => summary(opts.file),
      streams: { stdin: stdinWith(), stdout, stderr },
    })
    expect(code).toBe(0)
    expect(stderr.text).toMatch(/\[2\/2\] .*b-tr\.po: done/)
    expect(stdout.text).toMatch(/done\s+2/)
  })

  // The batch lines' own bookkeeping ran in the same try as the count, and
  // first: a throw from it on one file's end skipped the count, so every
  // [n/N] after it was one too low and the batch ended on [1/2].
  it('counts a file that ended even when the batch lines fail on its end', async () => {
    type Progress = typeof import('../../src/tui/batch-progress.js')
    vi.doMock('../../src/tui/batch-progress.js', async (importOriginal) => {
      const real = await importOriginal<Progress>()
      return {
        ...real,
        createEventStore: (action: 'review' | 'translate') => {
          const store = real.createEventStore(action)
          let thrown = false
          return {
            ...store,
            finish(input: string, at: number) {
              if (!thrown) {
                thrown = true
                throw new Error('store broke')
              }
              store.finish(input, at)
            },
          }
        },
      }
    })
    try {
      const r = await run(['review', a, b, '--no-ai'], { reviewFile: async (opts) => summary(opts.file) })
      expect(r.code).toBe(0)
      expect(r.stderr).toMatch(/\[1\/2\] .*a-tr\.po: done/)
      expect(r.stderr).toMatch(/\[2\/2\] .*b-tr\.po: done/)
    } finally {
      vi.doUnmock('../../src/tui/batch-progress.js')
    }
  })

  // A batch's runs never see the pause in their own events: the batch holds
  // the control and the runs only act on it at their next boundary. Without
  // the control's state, every batch closed during a pause printed an
  // estimate that counted down as if the run were still going.
  it('says there is no estimate while a pause or a stop is pending', async () => {
    const reviewFile = async (opts: ReviewOptions): Promise<ReviewSummary> => {
      if (opts.file !== a) return summary(opts.file)
      // After b has ended, so a is the one file left and has an estimate.
      await new Promise((resolve) => setTimeout(resolve, 20))
      const at = (ms: number) => (vi.setSystemTime(T0 + ms), T0 + ms)
      opts.onProgress?.({ type: 'batch-start', index: 1, of: 3, size: 10, at: at(0) })
      opts.onProgress?.({ type: 'batch-done', index: 1, problems: 0, at: at(1 * MIN) })
      opts.onProgress?.({ type: 'batch-start', index: 2, of: 3, size: 10, at: at(1 * MIN) })
      opts.control!.pause()
      opts.onProgress?.({ type: 'batch-done', index: 2, problems: 0, at: at(2 * MIN) })
      opts.onProgress?.({ type: 'batch-start', index: 3, of: 3, size: 10, at: at(2 * MIN) })
      opts.control!.stop()
      opts.onProgress?.({ type: 'batch-done', index: 3, problems: 0, at: at(3 * MIN) })
      return summary(opts.file)
    }
    const r = await run(['review', a, b, '--parallel', '2', '--no-ai'], { reviewFile })
    const seconds = r.stderr.split('\n').filter((l) => /left, done by|estimating…|no estimate while/.test(l))
    expect(seconds).toEqual([expect.stringMatching(/^~\d+m left, done by /), 'no estimate while paused', 'no estimate while stopping'])
  })

  it('prints no batch line when no file closes a batch', async () => {
    const r = await run(['review', a, b, '--no-ai'], { reviewFile: async (opts) => summary(opts.file) })
    expect(r.code).toBe(0)
    expect(r.stderr).not.toMatch(/ · batch /)
    expect(r.stderr).not.toMatch(/files done/)
  })
})
