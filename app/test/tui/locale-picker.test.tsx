import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import React from 'react'
import { loadConfig, saveConfig } from '../../src/config.js'
import { App } from '../../src/tui/App.js'
import { createActivity } from '../../src/tui/hooks/activity.js'
import { DEFAULT_TUI_STATE, type TuiState } from '../../src/tui/state.js'
import { cleanup, ESC_DELAY, fakeCommands, flat, keys, makeHome, memoryTuiState, openFromHome, render, tick, waitForText, type Home } from './helpers.js'

// The locale changes from any screen: l, or the palette's Change locale, opens
// a picker over the screen, and a pick saves defaultLocale as setup would.

let home: Home
let cwd: string

beforeEach(async () => {
  home = await makeHome()
  saveConfig({ defaultLocale: 'tr' })
  cwd = join(home.path, 'work')
  await mkdir(cwd)
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

const dismissed = (patch: Partial<TuiState> = {}): TuiState => ({
  ...DEFAULT_TUI_STATE,
  wizard: { ...DEFAULT_TUI_STATE.wizard, dismissed: true },
  ...patch,
})

async function type(stdin: { write(data: string): void }, text: string) {
  for (const ch of text) {
    stdin.write(ch)
    await tick()
  }
}

async function openPicker(view: ReturnType<typeof render>) {
  await tick()
  view.stdin.write('l')
  await waitForText(view.lastFrame, 'Change locale')
}

describe('the locale picker', () => {
  it('l opens the picker and enter on a match saves defaultLocale', async () => {
    const save = vi.fn(saveConfig)
    const tui = memoryTuiState(dismissed())
    const view = render(<App commands={fakeCommands({ saveConfig: save, ...tui })} cwd={cwd} />)
    await waitForText(view.lastFrame, 'locale tr')
    await openPicker(view)
    await type(view.stdin, 'nl')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'locale nl')
    expect(save).toHaveBeenCalledWith({ defaultLocale: 'nl' })
    expect(loadConfig().defaultLocale).toBe('nl')
    expect(flat(view.lastFrame())).not.toContain('Change locale')
    expect(tui.loadTuiState().recentLocales).toEqual(['nl'])
  })

  it('l is ignored while a text field has focus', async () => {
    const view = render(<App commands={fakeCommands()} cwd={cwd} />)
    await openFromHome(view.stdin, 'sync-glossary')
    await waitForText(view.lastFrame, 'Locale:')
    view.stdin.write('l')
    await waitForText(view.lastFrame, 'trl')
    expect(flat(view.lastFrame())).not.toContain('Change locale')
  })

  it('lists recent locales first with an empty query', async () => {
    const view = render(<App commands={fakeCommands(memoryTuiState(dismissed({ recentLocales: ['de', 'tr'] })))} cwd={cwd} />)
    await openPicker(view)
    const frame = flat(view.lastFrame())
    expect(frame).toMatch(/de de_DE .*tr tr_TR current/)
  })

  it('picking the current locale changes nothing', async () => {
    const save = vi.fn(saveConfig)
    const view = render(<App commands={fakeCommands({ saveConfig: save })} cwd={cwd} />)
    await openFromHome(view.stdin, 'sync-glossary')
    await waitForText(view.lastFrame, 'Locale:')
    view.stdin.write('x')
    await waitForText(view.lastFrame, 'trx')
    // Over the field, through the palette: l would type into it.
    view.stdin.write('\u000b')
    await waitForText(view.lastFrame, 'Go to')
    await type(view.stdin, 'locale')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'Search:')
    await type(view.stdin, 'tr')
    view.stdin.write(keys.enter)
    await tick(20)
    expect(flat(view.lastFrame())).not.toContain('Change locale')
    expect(save).not.toHaveBeenCalled()
    expect(view.lastFrame()).toContain('trx')
  })

  it('refuses while a run is busy', async () => {
    const save = vi.fn(saveConfig)
    const activity = createActivity()
    const view = render(<App commands={fakeCommands({ saveConfig: save })} cwd={cwd} activity={activity} />)
    activity.begin()
    await openPicker(view)
    await type(view.stdin, 'nl')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'The locale changes after the run ends.')
    expect(save).not.toHaveBeenCalled()
    expect(loadConfig().defaultLocale).toBe('tr')
  })

  it('refuses while Locale rules has unsaved edits', async () => {
    const save = vi.fn(saveConfig)
    const view = render(<App commands={fakeCommands({ saveConfig: save })} cwd={cwd} />)
    await openFromHome(view.stdin, 'locale-rules')
    await waitForText(view.lastFrame, 'Locale')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'Built-in rules')
    for (let i = 0; i < 20 && !/❯ Glossary match/.test(view.lastFrame() ?? ''); i++) {
      view.stdin.write(keys.down)
      await tick()
    }
    view.stdin.write(keys.enter)
    await tick()
    view.stdin.write(keys.right)
    await tick()
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(view.lastFrame, 'unsaved changes')
    await openPicker(view)
    await type(view.stdin, 'nl')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'Save or discard the changes first.')
    expect(save).not.toHaveBeenCalled()
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(view.lastFrame, 'unsaved changes')
  })

  it('remounts the current screen in the new locale', async () => {
    const view = render(<App commands={fakeCommands()} cwd={cwd} />)
    await openFromHome(view.stdin, 'import-tm')
    await waitForText(view.lastFrame, 'Import Translation Memory · locale tr')
    await openPicker(view)
    await type(view.stdin, 'nl')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'Import Translation Memory · locale nl')
  })

  it('a failed save keeps the picker open with the error', async () => {
    const save = vi.fn(() => {
      throw new Error('disk full')
    })
    const view = render(<App commands={fakeCommands({ saveConfig: save })} cwd={cwd} />)
    await openPicker(view)
    await type(view.stdin, 'nl')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'Could not save that: disk full')
    expect(flat(view.lastFrame())).toContain('Change locale')
    expect(flat(view.lastFrame())).toContain('locale tr')
  })

  it('the palette has Change locale', async () => {
    const view = render(<App commands={fakeCommands()} cwd={cwd} />)
    await tick()
    view.stdin.write('\u000b')
    await waitForText(view.lastFrame, 'Go to')
    await type(view.stdin, 'locale')
    expect(flat(view.lastFrame())).toContain('Change locale')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'Search:')
    expect(flat(view.lastFrame())).not.toContain('Go to')
  })
})
