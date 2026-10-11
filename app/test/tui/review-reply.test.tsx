import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import React from 'react'
import type { ReviewEvent, ReviewSummary } from '../../src/types.js'
import { App } from '../../src/tui/App.js'
import { ReviewProgress } from '../../src/tui/components/ReviewProgress.js'
import { saveConfig } from '../../src/config.js'
import { copyToClipboard } from '../../src/tui/clipboard.js'
import { templateFile } from '../../src/reply/templates.js'
import type { ReviewFile } from '../../src/tui/commands.js'

// Never the developer's real clipboard (review.test.tsx says why).
vi.mock('../../src/tui/clipboard.js', () => ({
  copyToClipboard: vi.fn(() => true),
  clipboardCommands: vi.fn(() => []),
}))
vi.mock('../../src/tui/open-file.js', () => ({
  openInDefaultApp: vi.fn(() => true),
  openCommand: vi.fn(() => ({ command: 'open', args: [] })),
}))

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

let home: Home
let cwd: string

beforeEach(async () => {
  home = await makeHome()
  saveConfig({ defaultLocale: 'tr' })
  cwd = join(home.path, 'work')
  await mkdir(cwd)
  await writeFile(join(cwd, 'submission.po'), '')
  vi.mocked(copyToClipboard).mockClear()
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

const FILE = '/tmp/work/submission.po'

const doneWith = (patch: Partial<ReviewSummary>): ReviewEvent[] => [
  { type: 'start', file: FILE, total: 120, reviewable: 120 },
  { type: 'done', summary: reviewSummaryOf(FILE, patch) },
]

const TEMPLATES = [
  { name: 'approved', text: 'Hello @{username},\n\n{No problems.|I fixed a few.}\n\n{results_copy}\n\nCheers!\n' },
  { name: 'declined', text: 'Not yet, @{username}.' },
]

describe('ReviewProgress reply', () => {
  it('shows no reply without templates, and says where to make one', () => {
    const { lastFrame } = render(<ReviewProgress events={doneWith({ repaired: 4, byGroup: { glossary: 4 } })} />)
    const frame = flat(lastFrame())
    expect(frame).not.toMatch(/Reply ·/)
    expect(frame).toContain('No reply template for this locale yet. Create one in Configuration › Reply templates.')
  })

  it('does not point at Configuration while the run is stopped part way', () => {
    const { lastFrame } = render(<ReviewProgress events={doneWith({ repaired: 4, pending: 10, byGroup: { glossary: 4 } })} />)
    expect(flat(lastFrame())).not.toContain('No reply template')
  })

  it('shows the filled approved reply, even when nothing was repaired', () => {
    const { lastFrame } = render(
      <ReviewProgress events={doneWith({ repaired: 0, byGroup: {} })} templates={TEMPLATES} requester="ayse" />,
    )
    const frame = flat(lastFrame())
    expect(frame).toContain('Reply · approved template')
    expect(frame).toContain('Hello @ayse,')
    expect(frame).toContain('No problems.')
    expect(frame).toContain('y to copy')
    expect(frame).toContain('t for the next template')
  })

  it('takes the some-problems text and warns when entries are flagged but none repaired', () => {
    const { lastFrame } = render(
      <ReviewProgress events={doneWith({ repaired: 0, needsReview: 3, byGroup: {} })} templates={TEMPLATES} />,
    )
    const frame = flat(lastFrame())
    expect(frame).toContain('I fixed a few.')
    expect(frame).toContain('3 entries are flagged for you. Check the verdict sentence before you post.')
  })

  it('shows no warning above the reply of a clean run', () => {
    const { lastFrame } = render(<ReviewProgress events={doneWith({ repaired: 0, byGroup: {} })} templates={TEMPLATES} />)
    expect(flat(lastFrame())).not.toContain('flagged for you')
  })

  it('copies the exact reply text with y', async () => {
    const { lastFrame, stdin } = render(
      <ReviewProgress events={doneWith({ repaired: 4, byGroup: { glossary: 4 } })} templates={TEMPLATES} />,
    )
    await tick()
    stdin.write('y')
    await tick()
    const copied = vi.mocked(copyToClipboard).mock.calls.at(-1)?.[0]
    expect(copied).toBe(
      'Hello @{username},\n\nI fixed a few.\n\n' +
        'I fixed 4 entries, which you can see <a href="">here</a>. They included 4 glossary inconsistencies.\n\nCheers!',
    )
    expect(flat(lastFrame())).toMatch(/reply copied to the clipboard/i)
  })

  it('switches to the next template with t, and copies that one', async () => {
    const { lastFrame, stdin } = render(
      <ReviewProgress events={doneWith({ repaired: 0, byGroup: {} })} templates={TEMPLATES} requester="ayse" />,
    )
    await tick()
    stdin.write('t')
    await tick()
    expect(flat(lastFrame())).toContain('Reply · declined template')
    expect(flat(lastFrame())).toContain('Not yet, @ayse.')
    stdin.write('y')
    await tick()
    expect(vi.mocked(copyToClipboard).mock.calls.at(-1)?.[0]).toBe('Not yet, @ayse.')
    stdin.write('t')
    await tick()
    expect(flat(lastFrame())).toContain('Reply · approved template')
  })

  it('offers no t with a single template', () => {
    const { lastFrame } = render(
      <ReviewProgress events={doneWith({ repaired: 0, byGroup: {} })} templates={TEMPLATES.slice(0, 1)} />,
    )
    expect(flat(lastFrame())).not.toContain('next template')
  })

  it('shows no reply for a run that stopped early', () => {
    const { lastFrame } = render(
      <ReviewProgress events={doneWith({ repaired: 0, byGroup: {}, pending: 20 })} templates={TEMPLATES} />,
    )
    expect(flat(lastFrame())).not.toContain('Reply ·')
  })
})

describe('Review screen requester field', () => {
  const openOptions = async (reviewFile?: ReviewFile) => {
    const view = render(<App commands={fakeCommands(reviewFile ? { reviewFile } : {})} cwd={cwd} />)
    await openFromHome(view.stdin, 'review')
    await waitForText(view.lastFrame, 'submission.po')
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Locale/)
    return view
  }

  it('is not offered when the locale has no reply template', async () => {
    const view = await openOptions()
    expect(flat(view.lastFrame())).not.toContain('Requester')
  })

  it('is offered with a template, and its username fills the reply', async () => {
    const file = templateFile('tr', 'approved')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'Hello @{username}, {none|some}.')
    const reviewFile = vi.fn<ReviewFile>(async (opts) => {
      const summary = reviewSummaryOf(opts.file, { repaired: 0, byGroup: {} })
      opts.onProgress?.({ type: 'start', file: opts.file, total: 3, reviewable: 3 })
      opts.onProgress?.({ type: 'done', summary })
      return summary
    })
    const view = await openOptions(reviewFile)
    expect(flat(view.lastFrame())).toContain('Requester')

    view.stdin.write(keys.down)
    await tick()
    view.stdin.write('ayse')
    await waitForText(view.lastFrame, /Requester:\s*ayse/)
    // Requester, batch, skip AI, start over, then Start.
    for (let i = 0; i < 4; i++) {
      view.stdin.write(keys.down)
      await tick()
    }
    view.stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length > 0)
    await waitForText(view.lastFrame, 'Hello @ayse, none.')
  })
})
