import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveConfig, unsetConfig } from '../../src/config.js'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import React from 'react'
import { App } from '../../src/tui/App.js'
import { statsTarget } from '../../src/tui/screens/Stats.js'
import { DEFAULT_STATS_FILE, type StatsOptions } from '../../src/commands/stats.js'
import { openInDefaultApp } from '../../src/tui/open-file.js'
import { ESC_DELAY, fakeCommands, flat, openFromHome, keys, makeHome, render, tick, waitForText, cleanup, type Home } from './helpers.js'

// The real one launches a browser. A test run must not open one.
vi.mock('../../src/tui/open-file.js', () => ({
  openInDefaultApp: vi.fn(() => true),
  openCommand: vi.fn(() => ({ command: 'open', args: [] })),
}))

let home: Home
let cwd: string

beforeEach(async () => {
  home = await makeHome()
  // Named rather than assumed: polyglots has no default locale (no-locale.test.tsx).
  saveConfig({ defaultLocale: 'tr' })
  cwd = join(home.path, 'work')
  await mkdir(cwd)
  await mkdir(join(cwd, 'reports'))
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

async function openLive(commands = fakeCommands()) {
  const view = render(<App commands={commands} cwd={cwd} />)
  await tick()
  await openFromHome(view.stdin, 'stats')
  await waitForText(view.lastFrame, 'Review statistics')
  return { ...view, commands }
}

// The standalone copy, which is what this screen was before the server: w
// from the live screen.
async function openStats() {
  const view = await openLive()
  view.stdin.write('w')
  await waitForText(view.lastFrame, 'Write to:')
  return view
}

describe('statsTarget', () => {
  it('puts the default name in the chosen folder', () => {
    expect(statsTarget('/tmp/out', '')).toBe(join('/tmp/out', DEFAULT_STATS_FILE))
    expect(statsTarget('/tmp/out', 'polyglots-stats.html')).toBe(join('/tmp/out', 'polyglots-stats.html'))
  })

  // Someone who knows exactly where they want it should not have to walk there.
  it('lets a typed path win over the chosen folder', () => {
    expect(statsTarget('/tmp/out', '/elsewhere/report.html')).toBe('/elsewhere/report.html')
    expect(statsTarget('/tmp/out', '../report.html')).toBe('/tmp/report.html')
  })

  it('ignores surrounding space rather than making a file named for it', () => {
    expect(statsTarget('/tmp/out', '  report.html  ')).toBe(join('/tmp/out', 'report.html'))
  })
})

describe('the live statistics page', () => {
  it('starts the server on entry and shows where it is', async () => {
    const view = await openLive()
    await waitForText(view.lastFrame, 'Serving at')
    expect(view.lastFrame()).toContain('http://127.0.0.1:4321/t0k3n/')
    expect(view.commands.startStatsServer).toHaveBeenCalledTimes(1)
  })

  it('opens the browser on o, and says to copy the address when there is none', async () => {
    const commands = fakeCommands({ openInBrowser: vi.fn(async () => false) })
    const view = await openLive(commands)
    await waitForText(view.lastFrame, 'Serving at')
    view.stdin.write('o')
    await waitForText(view.lastFrame, 'copy the address')
    expect(commands.openInBrowser).toHaveBeenCalledWith('http://127.0.0.1:4321/t0k3n/')
  })

  // Leaving the screen keeps the page live in the browser; coming back must
  // not start a second server beside it.
  it('keeps serving after the screen is left, and reuses the server on return', async () => {
    const view = await openLive()
    await waitForText(view.lastFrame, 'Serving at')
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(view.lastFrame, 'About')
    expect(flat(view.lastFrame())).toContain('stats 127.0.0.1:4321')
    await openFromHome(view.stdin, 'stats')
    await waitForText(view.lastFrame, 'Serving at')
    expect(view.commands.startStatsServer).toHaveBeenCalledTimes(1)
  })

  it('stops on x', async () => {
    const close = vi.fn(async () => {})
    const commands = fakeCommands({ startStatsServer: vi.fn(async () => ({ url: 'http://127.0.0.1:9/x/', port: 9, close })) })
    const view = await openLive(commands)
    await waitForText(view.lastFrame, 'Serving at')
    view.stdin.write('x')
    await waitForText(view.lastFrame, 'Stopped')
    expect(close).toHaveBeenCalledTimes(1)
    expect(flat(view.lastFrame())).not.toContain('stats 127.0.0.1')
  })

  // In the header's right column, under the setup line, as a terminal
  // hyperlink to the full address: the token is in the path, so the short
  // label alone could not be pasted into a browser.
  it('names the server in the header as a link, and not in the footer', async () => {
    const view = await openLive()
    await waitForText(view.lastFrame, 'Serving at')
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(view.lastFrame, 'About')
    const lines = view.lastFrame()!.split('\n')
    const header = lines.slice(0, 4).join('\n')
    expect(flat(header)).toContain('stats 127.0.0.1:4321')
    expect(header).toContain('\u001b]8;;http://127.0.0.1:4321/t0k3n/\u0007')
    expect(lines.at(-1)).not.toContain('127.0.0.1')
  })

  it('stops serving with x from another screen, and says so in the footer while it serves', async () => {
    const close = vi.fn(async () => {})
    const commands = fakeCommands({ startStatsServer: vi.fn(async () => ({ url: 'http://127.0.0.1:9/x/', port: 9, close })) })
    const view = await openLive(commands)
    await waitForText(view.lastFrame, 'Serving at')
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(view.lastFrame, 'About')
    expect(view.lastFrame()!.split('\n').at(-1)).toMatch(/x stop stats/)
    view.stdin.write('x')
    await tick()
    await tick()
    expect(close).toHaveBeenCalledTimes(1)
    expect(flat(view.lastFrame())).not.toContain('stats 127.0.0.1')
    expect(view.lastFrame()!.split('\n').at(-1)).not.toMatch(/stop stats/)
  })

  it('leaves x to a text field that has focus', async () => {
    const close = vi.fn(async () => {})
    const commands = fakeCommands({ startStatsServer: vi.fn(async () => ({ url: 'http://127.0.0.1:9/x/', port: 9, close })) })
    const view = await openLive(commands)
    await waitForText(view.lastFrame, 'Serving at')
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(view.lastFrame, 'About')
    // With a locale configured the screen opens on it and has no field; the
    // prompt appears only when none is set.
    unsetConfig('defaultLocale')
    await openFromHome(view.stdin, 'locale-rules')
    await waitForText(view.lastFrame, 'Locale:')
    view.stdin.write('x')
    await tick()
    expect(close).not.toHaveBeenCalled()
    expect(flat(view.lastFrame())).toContain('Locale: x')
  })

  it('says when the page is served by another polyglots, which keeps it running', async () => {
    const commands = fakeCommands({
      startStatsServer: vi.fn(async () => ({ url: 'http://127.0.0.1:29117/x/', port: 29117, sharedWith: { pid: 4242 }, close: vi.fn(async () => {}) })),
    })
    const view = await openLive(commands)
    await waitForText(view.lastFrame, 'Serving at')
    expect(flat(view.lastFrame())).toMatch(/served by another polyglots \(pid 4242\)/i)
  })

  it('warns when the stats port was taken, since the page settings will not carry over', async () => {
    const commands = fakeCommands({
      startStatsServer: vi.fn(async () => ({ url: 'http://127.0.0.1:9/x/', port: 9, portInUse: 29117, close: vi.fn(async () => {}) })),
    })
    const view = await openLive(commands)
    await waitForText(view.lastFrame, 'Serving at')
    expect(flat(view.lastFrame())).toMatch(/Port 29117 is in use by another program/)
  })

  it('says why it could not start, and still offers the standalone copy', async () => {
    const commands = fakeCommands({ startStatsServer: vi.fn(async () => Promise.reject(new Error('jobs.db is locked'))) })
    const view = await openLive(commands)
    await waitForText(view.lastFrame, 'jobs.db is locked')
    view.stdin.write('w')
    await waitForText(view.lastFrame, 'Write to:')
  })
})

describe('the statistics screen', () => {
  it('offers the folder it was started in', async () => {
    const { lastFrame } = await openStats()
    expect(lastFrame() ?? '').toContain(cwd)
  })

  it('writes into the folder chosen with tab', async () => {
    const view = await openStats()
    view.stdin.write(keys.tab)
    await waitForText(view.lastFrame, 'use this folder')

    // Rows: [ use this folder ], .., reports/. Enter on a folder walks into it,
    // which is what makes the top row the way to say "this one".
    for (let i = 0; i < 2; i++) {
      view.stdin.write(keys.down)
      await tick()
    }
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, join(cwd, 'reports'))

    // The cursor is back on the top row, so one more enter chooses this folder.
    view.stdin.write(keys.enter)
    // The path itself is not asserted here: ink wraps it across lines at this
    // width, so the call recorded below is what proves where the page went.
    await waitForText(view.lastFrame, 'choose folder')

    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'Wrote')
    const written = vi.mocked(view.commands.writeStats).mock.calls[0]![0] as StatsOptions
    expect(written.out).toBe(join(cwd, 'reports', DEFAULT_STATS_FILE))
  })

  it('goes back to the form when the picker is dismissed', async () => {
    const view = await openStats()
    view.stdin.write(keys.tab)
    await waitForText(view.lastFrame, 'use this folder')
    view.stdin.write(keys.esc)
    await waitForText(view.lastFrame, 'choose folder')
    expect(view.lastFrame() ?? '').toContain(cwd)
  })

  it('opens the page with o once it is written', async () => {
    const view = await openStats()
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'o to open')
    view.stdin.write('o')
    await tick()
    expect(vi.mocked(openInDefaultApp)).toHaveBeenCalledWith(join(cwd, DEFAULT_STATS_FILE))
    expect(view.lastFrame() ?? '').toContain('Opening it now.')
  })

  // Nothing has been written yet, so there is nothing to aim a browser at.
  it('does nothing for o before the page exists', async () => {
    vi.mocked(openInDefaultApp).mockClear()
    const view = await openStats()
    view.stdin.write('o')
    await tick()
    expect(vi.mocked(openInDefaultApp)).not.toHaveBeenCalled()
  })
})
