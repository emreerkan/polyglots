import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveConfig } from '../../src/config.js'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { App } from '../../src/tui/App.js'
import { cleanup, fakeCommands, flat, keys, makeHome, openFromHome, render, tick, waitFor, waitForText, type Home } from './helpers.js'
import type { ReviewEvent } from '../../src/types.js'
import type { TuiCommands } from '../../src/tui/commands.js'

let home: Home
let cwd: string

beforeEach(async () => {
  home = await makeHome()
  // Named rather than assumed: polyglots has no default locale (no-locale.test.tsx).
  saveConfig({ defaultLocale: 'tr' })
  cwd = join(home.path, 'work')
  await mkdir(cwd)
  await writeFile(join(cwd, 'plugin.po'), '')
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

// The built-in rules list, its detail and its hint come to 25 body rows,
// which a 24-row terminal cannot hold under the wordmark and over the footer.
async function openRuleList(size = { columns: 80, rows: 24 }) {
  const view = render(<App commands={fakeCommands()} cwd={cwd} />, size)
  await openFromHome(view.stdin, 'locale-rules')
  await waitForText(view.lastFrame, 'Locale: tr')
  view.stdin.write(keys.enter)
  await waitForText(view.lastFrame, 'Built-in rules')
  view.stdin.write(keys.enter)
  await waitForText(view.lastFrame, 'placeholder')
  return view
}

const lines = (frame: string) => frame.split('\n')

describe('a screen taller than the body', () => {
  it('keeps the frame inside the terminal, footer included', async () => {
    const { lastFrame } = await openRuleList()
    const frame = lastFrame()
    expect(lines(frame).length).toBeLessThanOrEqual(24)
    expect(flat(frame)).toContain('? help')
  })

  it('says how much is out of sight below', async () => {
    const { lastFrame } = await openRuleList()
    expect(flat(lastFrame())).toMatch(/↓ \d+ more/)
  })

  it('scrolls to keep the row in focus visible, and back', async () => {
    const { lastFrame, stdin } = await openRuleList()
    for (let i = 0; i < 15; i++) {
      stdin.write(keys.down)
      await tick()
    }
    await waitForText(lastFrame, /❯ \[x\] control/)
    expect(lines(lastFrame()).length).toBeLessThanOrEqual(24)
    expect(flat(lastFrame())).toMatch(/↑ \d+ more/)
    expect(flat(lastFrame())).toContain('? help')
    for (let i = 0; i < 15; i++) {
      stdin.write(keys.up)
      await tick()
    }
    await waitForText(lastFrame, /❯ \[x\] placeholder/)
    expect(flat(lastFrame())).toContain('Locale rules')
  })

  it('draws a screen that fits exactly as before, with no marker', async () => {
    const { lastFrame } = await openRuleList({ columns: 80, rows: 40 })
    expect(lastFrame()).not.toMatch(/[↑↓] \d+ more/)
    expect(lastFrame()).toContain('Locale rules')
  })

  it('starts the next screen at its top', async () => {
    const { lastFrame, stdin } = await openRuleList()
    for (let i = 0; i < 15; i++) {
      stdin.write(keys.down)
      await tick()
    }
    await waitForText(lastFrame, /❯ \[x\] control/)
    stdin.write(keys.esc)
    await tick(60)
    await waitForText(lastFrame, 'Built-in rules')
    expect(flat(lastFrame())).toContain('Locale rules ·')
    expect(lastFrame()).not.toMatch(/↑ \d+ more/)
  })

  // Under an overlay or the too-small notice the body lays out at no height;
  // the offset must survive that, or the row in focus comes back out of view.
  it('keeps the row in focus in view across the help overlay and a resize below the minimum', async () => {
    const view = await openRuleList()
    for (let i = 0; i < 15; i++) {
      view.stdin.write(keys.down)
      await tick()
    }
    await waitForText(view.lastFrame, /❯ \[x\] control/)
    view.stdin.write('?')
    await tick(20)
    view.stdin.write(keys.esc)
    await tick(60)
    await waitForText(view.lastFrame, /❯ \[x\] control/)
    view.resize(59, 20)
    await waitForText(view.lastFrame, 'Enlarge the terminal')
    view.resize(80, 24)
    await waitForText(view.lastFrame, /❯ \[x\] control/)
    expect(lines(view.lastFrame()).length).toBeLessThanOrEqual(24)
  })
})

// The dashboards size their entries panel to leave the key hint in the frame,
// but failed batches add a line each below it, and at the minimum size those
// pushed the hint out. The hint is what stops a run, so a run screen keeps it
// in view and lets the top scroll away instead.
describe('a run screen taller than the body', () => {
  it('keeps the pause and stop keys in view at 60x20 when batches fail', async () => {
    await writeFile(join(cwd, 'submission.po'), '')
    const events: ReviewEvent[] = [{ type: 'start', file: 'submission.po', total: 300, reviewable: 300 }]
    for (let b = 1; b <= 6; b++) {
      events.push({ type: 'batch-start', index: b, of: 10, size: 30, at: b * 60_000 })
      events.push({
        type: 'entries',
        index: b,
        entries: Array.from({ length: 30 }, (_, i) => ({ key: `e${b}-${i}`, msgid: `Entry ${b}-${i}`, outcome: 'approved' as const })),
      })
      if (b % 2 === 0) events.push({ type: 'batch-failed', index: b, size: 30, reason: 'claude exited with code 1', at: (b + 1) * 60_000 })
      else events.push({ type: 'batch-done', index: b, problems: 0, at: (b + 1) * 60_000 })
    }
    const reviewFile = vi.fn<TuiCommands['reviewFile']>(async (opts) => {
      for (const e of events) opts.onProgress?.(e)
      opts.onProgress?.({ type: 'batch-start', index: 7, of: 10, size: 30, at: Date.now() })
      return new Promise<never>(() => {})
    })
    const view = render(<App commands={fakeCommands({ reviewFile })} cwd={cwd} />, { columns: 60, rows: 20 })
    await openFromHome(view.stdin, 'review')
    await waitForText(view.lastFrame, 'submission.po')
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Locale/)
    for (let i = 0; i < 4; i++) {
      view.stdin.write(keys.down)
      await tick()
    }
    view.stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length > 0)
    await waitForText(view.lastFrame, /Entry 6-29/)
    await tick(20)
    expect(lines(view.lastFrame()).length).toBeLessThanOrEqual(20)
    expect(flat(view.lastFrame())).toMatch(/p pause/)
  })
})

// A screen with no cursor (Agents at 60x20, a review summary) has nothing for
// the body to follow, so page up and page down move it instead.
describe('a tall screen with no cursor', () => {
  it('scrolls with page down and page up', async () => {
    const view = render(<App commands={fakeCommands()} cwd={cwd} />, { columns: 60, rows: 20 })
    await openFromHome(view.stdin, 'agents')
    await waitForText(() => flat(view.lastFrame()), /more below/)
    expect(flat(view.lastFrame())).not.toMatch(/more above/)
    view.stdin.write(keys.pageDown)
    await waitForText(() => flat(view.lastFrame()), /more above/)
    view.stdin.write(keys.pageUp)
    await waitFor(() => !/more above/.test(flat(view.lastFrame())))
  })

  it('lists the scroll keys in the help overlay', async () => {
    const view = render(<App commands={fakeCommands()} cwd={cwd} />, { columns: 120, rows: 40 })
    await tick()
    view.stdin.write('?')
    await waitForText(() => flat(view.lastFrame()), /pgup pgdn/)
  })
})

// The file picker is taller than the body at 80x24 (title, browsing line,
// sort line, fifteen rows, hint), so its cursor has to be followed too.
describe('the file picker on a short terminal', () => {
  it.each([
    { columns: 80, rows: 24 },
    { columns: 60, rows: 20 },
  ])('keeps the selected file in view at $columns x $rows', async (size) => {
    // The picker lists newest first. Writing the files in a loop gives each
    // its own mtime on APFS, but ext4's coarser clock hands several the same
    // one, the tie falls back to name order, and file-19 drops out of view.
    // So the order is set, not left to the filesystem.
    for (let i = 0; i < 20; i++) {
      const file = join(cwd, `file-${String(i).padStart(2, '0')}.po`)
      await writeFile(file, '')
      await utimes(file, 1_700_000_000 + i, 1_700_000_000 + i)
    }
    const view = render(<App commands={fakeCommands()} cwd={cwd} />, size)
    await openFromHome(view.stdin, 'review')
    await waitForText(view.lastFrame, 'file-19.po')
    // Fifteen rows down from "..": the last row of the picker's window, which
    // sits below the body's bottom edge on both sizes.
    for (let i = 0; i < 15; i++) {
      view.stdin.write(keys.down)
      await tick()
    }
    await waitForText(view.lastFrame, /❯ \S+\.po/)
  })
})
