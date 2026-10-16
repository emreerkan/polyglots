import { saveConfig } from '../../src/config.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import React from 'react'
import { DEFAULT_CONFIG, loadConfig } from '../../src/config.js'
import { App } from '../../src/tui/App.js'
import { CommandsProvider } from '../../src/tui/commands.js'
import { LocaleRules } from '../../src/tui/screens/LocaleRules.js'
import { Review } from '../../src/tui/screens/Review.js'
import { DEFAULT_TUI_STATE, type TuiState } from '../../src/tui/state.js'
import type { PolyglotsConfig } from '../../src/types.js'
import { cleanup, fakeCommands, flat, keys, makeHome, memoryTuiState, openFromHome, render, tick, waitForText, type Home } from './helpers.js'

// The menu with no locale configured: nothing is prefilled, nothing is
// chosen by pressing enter on an empty field, and the screens that cannot do
// anything without one say so and point at setup.

let home: Home
beforeEach(async () => {
  home = await makeHome()
})
afterEach(async () => {
  cleanup()
  await home.cleanup()
})

function configStore(initial: Partial<PolyglotsConfig> = {}) {
  let current: PolyglotsConfig = { ...DEFAULT_CONFIG, ...initial }
  const saved: Partial<PolyglotsConfig>[] = []
  return {
    saved,
    loadConfig: () => current,
    saveConfig: (patch: Partial<PolyglotsConfig>) => {
      saved.push(patch)
      current = { ...current, ...patch }
      return current
    },
  }
}

describe('the setup wizard with no locale', () => {
  it('asks with an empty search, and enter on it chooses nothing', async () => {
    const config = configStore()
    const state = memoryTuiState(structuredClone(DEFAULT_TUI_STATE) as TuiState)
    const { lastFrame, stdin } = render(<App commands={fakeCommands({ ...config, ...state })} />)
    await waitForText(lastFrame, 'Search:')
    expect(flat(lastFrame())).toMatch(/Search: *(\n|$|[^\w])/)
    expect(flat(lastFrame())).toContain("Type the locale's code")
    stdin.write(keys.enter)
    await tick(20)
    expect(flat(lastFrame())).toContain('Step 1 of 6')
    expect(config.saved).toEqual([])
  })

  it('still starts from the configured locale for someone who has one', async () => {
    const config = configStore({ defaultLocale: 'sv' })
    const state = memoryTuiState(structuredClone(DEFAULT_TUI_STATE) as TuiState)
    const { lastFrame } = render(<App commands={fakeCommands({ ...config, ...state })} />)
    await waitForText(lastFrame, 'Search:')
    expect(flat(lastFrame())).toContain('Search: sv')
  })
})

describe('Locale Rules with no locale', () => {
  it('starts with an empty field rather than tr', async () => {
    const { lastFrame } = render(
      <CommandsProvider value={fakeCommands()}>
        <LocaleRules onBack={() => undefined} />
      </CommandsProvider>,
    )
    await waitForText(lastFrame, /Locale/)
    expect(loadConfig().defaultLocale).toBeUndefined()
    expect(lastFrame()).not.toMatch(/Locale: *tr\b/)
  })
})

describe('Review with no locale', () => {
  it("fills the locale from the picked file's Language header", async () => {
    const cwd = join(home.path, 'work')
    await mkdir(cwd)
    await writeFile(
      join(cwd, 'x-sv.po'),
      ['msgid ""', 'msgstr ""', '"Content-Type: text/plain; charset=UTF-8\\n"', '"Language: sv_SE\\n"', '', 'msgid "A"', 'msgstr "B"', ''].join('\n'),
    )
    const { lastFrame, stdin } = render(
      <CommandsProvider value={fakeCommands()}>
        <Review cwd={cwd} onBack={() => undefined} />
      </CommandsProvider>,
    )
    await waitForText(lastFrame, 'x-sv.po')
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.enter)
    // The header is read after the form appears, so wait for the value itself.
    await waitForText(() => flat(lastFrame()), /Locale: +sv\b/)
  })
})

describe('the header locale in Review', () => {
  async function pick(commandsConfig?: Partial<import('../../src/types.js').PolyglotsConfig>) {
    if (commandsConfig) saveConfig(commandsConfig)
    const cwd = join(home.path, 'work')
    await mkdir(cwd, { recursive: true })
    await writeFile(
      join(cwd, 'x-sv.po'),
      ['msgid ""', 'msgstr ""', '"Content-Type: text/plain; charset=UTF-8\\n"', '"Language: sv_SE\\n"', '', 'msgid "A"', 'msgstr "B"', ''].join('\n'),
    )
    const view = render(
      <CommandsProvider value={fakeCommands()}>
        <Review cwd={cwd} onBack={() => undefined} />
      </CommandsProvider>,
    )
    await waitForText(view.lastFrame, 'x-sv.po')
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'Locale:')
    return view
  }

  it('says the locale came from the file', async () => {
    const view = await pick()
    await waitForText(() => flat(view.lastFrame()), /Locale: +sv\b/)
    expect(flat(view.lastFrame())).toMatch(/From the file's Language header/)
  })

  it('does not prefill from the header for Antigravity, whose lookup server never hears it', async () => {
    const view = await pick({ reviewProvider: 'antigravity' })
    await tick(50)
    expect(flat(view.lastFrame())).not.toMatch(/Locale: +sv\b/)
    expect(flat(view.lastFrame())).toMatch(/Antigravity/)
  })
})

describe.each([
  ['fetch', 'Fetch'],
  ['import-tm', 'Import'],
  ['export-tm', 'Export'],
] as const)('%s with no locale', (id, _title) => {
  it('says a locale is needed and opens setup on enter', async () => {
    const { lastFrame, stdin } = render(<App commands={fakeCommands()} />)
    await waitForText(lastFrame, 'Translate a .po file')
    await openFromHome(stdin, id)
    await waitForText(lastFrame, 'No locale set yet')
    expect(flat(lastFrame())).toContain('enter to open setup')
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'Search:')
    expect(flat(lastFrame())).toContain('Step 1 of 6')
  })
})
