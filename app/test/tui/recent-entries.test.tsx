import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveConfig } from '../../src/config.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import React from 'react'
import type { TranslateEntry, TranslateEvent } from '../../src/commands/translate.js'
import type { ReviewEntry, ReviewEvent } from '../../src/types.js'
import { App } from '../../src/tui/App.js'
import { SizeProvider } from '../../src/tui/size.js'
import { appendEvent, panelRows, recentEntries, RECENT_LIMIT } from '../../src/tui/components/RecentEntries.js'
import { ReviewProgress } from '../../src/tui/components/ReviewProgress.js'
import { Progress } from '../../src/tui/components/Progress.js'
import type { ReviewFile } from '../../src/tui/commands.js'
import {
  cleanup,
  fakeCommands,
  flat,
  keys,
  makeHome,
  openFromHome,
  render,
  reviewSummaryOf,
  tick,
  waitFor,
  waitForText,
  type Home,
} from './helpers.js'

const FILE = '/tmp/work/submission.po'

const reviewEntry = (n: number, patch: Partial<ReviewEntry> = {}): ReviewEntry => ({
  key: `entry ${n}`,
  msgid: `Entry number ${n}`,
  outcome: 'approved',
  ...patch,
})

function reviewBatches(batches: number, size: number): ReviewEvent[] {
  const out: ReviewEvent[] = [{ type: 'start', file: FILE, total: batches * size, reviewable: batches * size }]
  for (let b = 1; b <= batches; b++) {
    out.push({ type: 'batch-start', index: b, of: batches, size, at: b * 60_000 })
    const entries = Array.from({ length: size }, (_, i) => reviewEntry((b - 1) * size + i + 1))
    out.push({ type: 'entries', index: b, entries })
    out.push({ type: 'batch-done', index: b, problems: 0, at: (b + 1) * 60_000 })
  }
  return out
}

describe('appendEvent', () => {
  // A seven-thousand-entry run at a hundred a batch. The screen keeps every
  // event it is handed, so without this it would hold all seven thousand.
  it('keeps no more than the last RECENT_LIMIT entries however long the run', () => {
    let events: ReviewEvent[] = []
    for (const e of reviewBatches(70, 100)) events = appendEvent(events, e)

    const kept = events.flatMap((e) => (e.type === 'entries' ? e.entries : []))
    expect(kept).toHaveLength(RECENT_LIMIT)
    expect(kept.at(-1)?.msgid).toBe('Entry number 7000')
    expect(kept[0]?.msgid).toBe(`Entry number ${7000 - RECENT_LIMIT + 1}`)
  })

  it('never drops an event that is not a list of entries', () => {
    let events: ReviewEvent[] = []
    const all = reviewBatches(70, 100)
    for (const e of all) events = appendEvent(events, e)
    const others = (list: ReviewEvent[]) => list.filter((e) => e.type !== 'entries')
    expect(others(events)).toEqual(others(all))
  })

  it('trims a single event larger than the limit, such as a file the memory filled', () => {
    const entries: TranslateEntry[] = Array.from({ length: 3000 }, (_, i) => ({
      key: `k${i}`,
      msgid: `m${i}`,
      outcome: 'memory',
    }))
    const events = appendEvent<TranslateEvent>([], { type: 'entries', entries })
    const kept = events.flatMap((e) => (e.type === 'entries' ? e.entries : []))
    expect(kept).toHaveLength(RECENT_LIMIT)
    expect(kept.at(-1)?.msgid).toBe('m2999')
  })
})

describe('recentEntries', () => {
  it('returns the newest entries, oldest first, across batches', () => {
    const recent = recentEntries<ReviewEntry>(reviewBatches(3, 4), 6)
    expect(recent.map((e) => e.msgid)).toEqual([7, 8, 9, 10, 11, 12].map((n) => `Entry number ${n}`))
  })
})

describe('panelRows', () => {
  // Measured against what the run screens put above and below the panel, so
  // the key hint at the bottom is never pushed out of the frame.
  it('fits a few rows at the minimum size and more on a taller terminal', () => {
    expect(panelRows({ columns: 60, rows: 20 })).toBeGreaterThanOrEqual(3)
    expect(panelRows({ columns: 80, rows: 24 })).toBeGreaterThan(panelRows({ columns: 60, rows: 20 }))
    expect(panelRows({ columns: 113, rows: 60 })).toBeLessThanOrEqual(12)
  })
})

describe('ReviewProgress recent entries panel', () => {
  it('lists the latest entries with their outcome and rules, newest last', async () => {
    const events: ReviewEvent[] = [
      ...reviewBatches(1, 2),
      { type: 'batch-start', index: 2, of: 2, size: 3, at: 200_000 },
      {
        type: 'entries',
        index: 2,
        entries: [
          reviewEntry(3, { outcome: 'flagged', rules: ['glossary', 'title-case'] }),
          reviewEntry(4, { outcome: 'repaired', rules: ['placeholder'] }),
          reviewEntry(5, { outcome: 'unreviewed' }),
        ],
      },
    ]
    const { lastFrame } = render(<ReviewProgress events={events} />)
    await tick()
    const frame = lastFrame()
    const lines = frame.split('\n')
    const row = (n: number) => lines.find((l) => l.includes(`Entry number ${n}`)) ?? ''

    expect(row(1)).toMatch(/approved/)
    expect(row(3)).toMatch(/flagged/)
    expect(row(3)).toMatch(/glossary, title-case/)
    expect(row(4)).toMatch(/repaired/)
    expect(row(5)).toMatch(/unreviewed/)
    expect(lines.indexOf(row(5))).toBeGreaterThan(lines.indexOf(row(1)))
  })

  it('says nothing before the first batch lands', async () => {
    const { lastFrame } = render(
      <ReviewProgress events={[{ type: 'start', file: FILE, total: 3, reviewable: 3 }]} />,
    )
    await tick()
    expect(flat(lastFrame())).not.toMatch(/Recent/)
  })

  // At the end the summary and the requester message need the room.
  it('gives way to the summary once the run is done', async () => {
    const events: ReviewEvent[] = [...reviewBatches(1, 2), { type: 'done', summary: reviewSummaryOf(FILE) }]
    const { lastFrame } = render(<ReviewProgress events={events} />)
    await tick()
    expect(flat(lastFrame())).not.toMatch(/Entry number 1/)
  })

  it('shows only as many rows as the terminal leaves room for at 60x20', async () => {
    const { lastFrame } = render(
      <SizeProvider>
        <ReviewProgress events={reviewBatches(2, 20)} />
      </SizeProvider>,
      { columns: 60, rows: 20 },
    )
    await tick()
    const shown = lastFrame()
      .split('\n')
      .filter((l) => /Entry number \d+/.test(l))
    expect(shown).toHaveLength(panelRows({ columns: 60, rows: 20 }))
    expect(shown.at(-1)).toMatch(/Entry number 40/)
    for (const line of lastFrame().split('\n')) expect(line.length).toBeLessThanOrEqual(60)
  })

  it('cuts a long msgid at the frame edge rather than wrapping it', async () => {
    const long = 'A very long source string that goes on and on well past the edge of a narrow terminal frame'
    const events: ReviewEvent[] = [
      { type: 'start', file: FILE, total: 1, reviewable: 1 },
      { type: 'batch-start', index: 1, of: 1, size: 1, at: 0 },
      { type: 'entries', index: 1, entries: [reviewEntry(1, { msgid: long })] },
    ]
    const { lastFrame } = render(
      <SizeProvider>
        <ReviewProgress events={events} />
      </SizeProvider>,
      { columns: 60, rows: 20 },
    )
    await tick()
    const lines = lastFrame().split('\n')
    const at = lines.findIndex((l) => l.includes('A very long source'))
    expect(at).toBeGreaterThanOrEqual(0)
    expect(lines[at + 1] ?? '').not.toMatch(/narrow terminal frame/)
  })
})

describe('Progress recent entries panel', () => {
  it('lists translated entries with where the text came from', async () => {
    const events: TranslateEvent[] = [
      { type: 'start', file: FILE, total: 5, pending: 5 },
      { type: 'tm-hit', count: 1 },
      { type: 'entries', entries: [{ key: 'a', msgid: 'From memory', outcome: 'memory' }] },
      { type: 'batch-start', index: 1, of: 1, size: 3, at: 0 },
      {
        type: 'entries',
        index: 1,
        entries: [
          { key: 'b', msgid: 'Drafted one', outcome: 'drafted' },
          { key: 'c', msgid: 'Doubtful one', outcome: 'fuzzy', from: 'engine' },
          { key: 'd', msgid: 'Failed one', outcome: 'skipped' },
        ],
      },
      { type: 'batch-done', index: 1, translated: 2, fuzzy: 1, at: 60_000 },
    ]
    const { lastFrame } = render(<Progress events={events} />)
    await tick()
    const lines = lastFrame().split('\n')
    const row = (text: string) => lines.find((l) => l.includes(text)) ?? ''
    expect(row('From memory')).toMatch(/memory/)
    expect(row('Drafted one')).toMatch(/drafted/)
    expect(row('Doubtful one')).toMatch(/fuzzy/)
    expect(row('Failed one')).toMatch(/skipped/)
  })
})

describe('the review screen with the panel', () => {
  let home: Home
  let cwd: string

  beforeEach(async () => {
    home = await makeHome()
    // Named rather than assumed: polyglots has no default locale (no-locale.test.tsx).
    saveConfig({ defaultLocale: 'tr' })
    cwd = join(home.path, 'work')
    await mkdir(cwd)
    await writeFile(join(cwd, 'submission.po'), '')
  })

  afterEach(async () => {
    cleanup()
    await home.cleanup()
  })

  for (const size of [
    { columns: 60, rows: 20 },
    { columns: 80, rows: 24 },
  ]) {
    it(`keeps the key hint in the frame at ${size.columns}x${size.rows}`, async () => {
      const reviewFile = vi.fn<ReviewFile>(async (opts) => {
        for (const e of reviewBatches(3, 30)) opts.onProgress?.(e)
        opts.onProgress?.({ type: 'batch-start', index: 4, of: 4, size: 30, at: Date.now() })
        return new Promise<never>(() => {})
      })
      const view = render(<App commands={fakeCommands({ reviewFile })} cwd={cwd} />, size)
      await openFromHome(view.stdin, 'review')
      await waitForText(view.lastFrame, 'submission.po')
      view.stdin.write(keys.down)
      await tick()
      view.stdin.write(keys.enter)
      await waitForText(view.lastFrame, /Start review/)
      for (let i = 0; i < 3; i++) {
        view.stdin.write(keys.down)
        await tick()
      }
      view.stdin.write(keys.enter)
      await waitFor(() => reviewFile.mock.calls.length > 0)
      await waitForText(view.lastFrame, /Entry number 90/)
      expect(flat(view.lastFrame())).toMatch(/p pause/)
    })
  }
})
