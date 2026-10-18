import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import React from 'react'
import { App } from '../../src/tui/App.js'
import { saveConfig } from '../../src/config.js'
import { DEFAULT_TUI_STATE, type TuiState } from '../../src/tui/state.js'
import { cleanup, ESC_DELAY, fakeCommands, flat, keys, makeHome, memoryTuiState, render, tick, waitForText, type Home } from './helpers.js'

let home: Home
let cwd: string

beforeEach(async () => {
  home = await makeHome()
  saveConfig({ defaultLocale: 'tr' })
  cwd = join(home.path, 'work')
  await mkdir(cwd)
  await writeFile(join(cwd, 'plugin.po'), '')
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

const LIST = {
  '0.34.0': ['Thirty-four.'],
  '0.33.0': ['Thirty-three, one.', 'Thirty-three, two.', 'Thirty-three, three.'],
  '0.32.0': ['Thirty-two.'],
}

const settled = (seen: string | undefined): TuiState => ({
  ...DEFAULT_TUI_STATE,
  wizard: { ...DEFAULT_TUI_STATE.wizard, dismissed: true },
  whatsNew: seen === undefined ? {} : { seen },
})

function app(state: TuiState, version: string, size = { columns: 120, rows: 40 }) {
  const tui = memoryTuiState(state)
  const view = render(<App commands={fakeCommands(tui)} cwd={cwd} version={version} whatsNew={LIST} />, size)
  return { ...view, tui }
}

const lastSeen = (tui: ReturnType<typeof memoryTuiState>) => tui.saveTuiState.mock.calls.at(-1)?.[0].whatsNew.seen

describe("What's new on home", () => {
  it('lists the new version under the cards and records it as seen', async () => {
    const { lastFrame, tui } = app(settled('0.33.0'), '0.34.0')
    await waitForText(lastFrame, "What's new in 0.34.0")
    expect(flat(lastFrame())).toContain('Thirty-four.')
    expect(flat(lastFrame())).not.toContain('Thirty-three')
    expect(lastSeen(tui)).toBe('0.34.0')
  })

  // whatsNewLines counts one empty line above the heading, so the block must
  // draw exactly one: none would crowd it against the row above, and two
  // would cost a row the count did not budget for. The row above is the cards
  // or, when it is shown, the status line under them, and both are checked.
  describe('leaves exactly one empty line above the heading', () => {
    const gapAbove = (frame: string | undefined): { gap: number; above: string } => {
      const lines = (frame ?? '').split('\n')
      const at = lines.findIndex((l) => l.includes("What's new in 0.34.0"))
      let row = at - 1
      while (row >= 0 && lines[row]!.trim() === '') row -= 1
      return { gap: at - 1 - row, above: lines[row] ?? '' }
    }

    it('under the cards', async () => {
      const { lastFrame } = app(settled('0.33.0'), '0.34.0')
      await waitForText(lastFrame, "What's new in 0.34.0")
      const { gap, above } = gapAbove(lastFrame())
      expect(gap).toBe(1)
      expect(above).not.toContain('Checking agents…')
    })

    it('under the status line', async () => {
      const tui = memoryTuiState(settled('0.33.0'))
      const { lastFrame } = render(
        <App commands={fakeCommands({ ...tui, discoverAgents: () => new Promise(() => {}) })} cwd={cwd} version="0.34.0" whatsNew={LIST} />,
        { columns: 120, rows: 40 },
      )
      await waitForText(lastFrame, "What's new in 0.34.0")
      const { gap, above } = gapAbove(lastFrame())
      expect(above).toContain('Checking agents…')
      expect(gap).toBe(1)
    })
  })

  // Three lines at most, whatever was skipped: the rest are a link away.
  it('names the version on each line when several are shown, and says how many more there are', async () => {
    const { lastFrame } = app(settled('0.31.0'), '0.34.0')
    await waitForText(lastFrame, "What's new")
    const frame = flat(lastFrame())
    expect(frame).toContain('0.34.0 Thirty-four.')
    expect(frame).toContain('0.33.0 Thirty-three, one.')
    expect(frame).toContain('0.33.0 Thirty-three, two.')
    expect(frame).not.toContain('Thirty-three, three.')
    expect(frame).toContain('and 2 more: github.com/emreerkan/polyglots/releases')
  })

  it('stays for the rest of the session after the first showing', async () => {
    const { lastFrame, stdin } = app(settled('0.33.0'), '0.34.0')
    await waitForText(lastFrame, 'Thirty-four.')
    stdin.write('o')
    await waitForText(lastFrame, 'Split a .po into parts')
    stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(lastFrame, 'Translate a .po file')
    expect(flat(lastFrame())).toContain('Thirty-four.')
  })

  it('is not shown again once seen', async () => {
    const { lastFrame } = app(settled('0.34.0'), '0.34.0')
    await waitForText(lastFrame, 'Translate a .po file')
    await tick(20)
    expect(flat(lastFrame())).not.toContain("What's new")
  })

  // 80x24 is exactly the grid and its wordmark. With no row to spare the
  // block waits for a taller terminal, and its one showing is not spent.
  it('waits, unseen, while the terminal has no room for it', async () => {
    const { lastFrame, tui } = app(settled('0.31.0'), '0.34.0', { columns: 80, rows: 24 })
    await waitForText(lastFrame, 'Translate a .po file')
    await tick(20)
    expect(flat(lastFrame())).not.toContain("What's new")
    expect(lastSeen(tui)).not.toBe('0.34.0')
  })

  // The wizard opens first when setup has a step missing. Recording the
  // version then would spend the showing on a screen that never drew it.
  it('is not recorded while the wizard is open', async () => {
    const tui = memoryTuiState({ ...DEFAULT_TUI_STATE, whatsNew: { seen: '0.33.0' } })
    const { lastFrame } = render(
      <App commands={fakeCommands({ ...tui, localeConfigured: () => false })} cwd={cwd} version="0.34.0" whatsNew={LIST} />,
      { columns: 120, rows: 40 },
    )
    await waitForText(lastFrame, /[Ll]ocale/)
    await tick(20)
    expect(flat(lastFrame())).not.toContain('Translate a .po file')
    expect(lastSeen(tui)).not.toBe('0.34.0')
  })

  // Someone whose tui.json predates the feature is told about this release.
  it('shows the current version to someone whose state has no version yet', async () => {
    const { lastFrame } = app(settled(undefined), '0.33.0')
    await waitForText(lastFrame, "What's new in 0.33.0")
  })

  // Nothing to show still records the version, so that a first-time user's
  // tui.json exists and the next update is news to them.
  it('records the version even when there is nothing to show', async () => {
    const { lastFrame, tui } = app({ ...settled('0.34.0'), whatsNew: { seen: '0.34.0' } }, '0.34.1')
    await waitForText(lastFrame, 'Translate a .po file')
    await tick(20)
    expect(lastSeen(tui)).toBe('0.34.1')
  })
})
