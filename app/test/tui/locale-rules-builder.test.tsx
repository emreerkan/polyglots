import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { saveConfig } from '../../src/config.js'
import { CommandsProvider, type TuiCommands } from '../../src/tui/commands.js'
import { LocaleRules } from '../../src/tui/screens/LocaleRules.js'
import { ESC_DELAY, cleanup, fakeCommands, flat, keys, makeHome, render, tick, waitForText, type Home } from './helpers.js'

let home: Home

beforeEach(async () => {
  home = await makeHome()
  saveConfig({ defaultLocale: 'tr' })
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

function mount(overrides: Partial<TuiCommands> = {}) {
  const commands = fakeCommands(overrides)
  const view = render(
    <CommandsProvider value={commands}>
      <LocaleRules onBack={() => undefined} />
    </CommandsProvider>,
  )
  return { ...view, commands }
}

async function openBuilder(view: ReturnType<typeof mount>) {
  await waitForText(view.lastFrame, /Built-in rules/)
  for (let i = 0; i < 16 && !/❯ Open the rules builder in your browser/.test(view.lastFrame()); i++) {
    view.stdin.write(keys.down)
    await tick()
  }
  expect(view.lastFrame()).toMatch(/❯ Open the rules builder in your browser/)
  view.stdin.write(keys.enter)
  await tick()
}

const URL_TR = 'https://ada.tools/polyglots/rules-builder/?locale=tr_TR'

describe('LocaleRules: the rules builder row', () => {
  it('opens the builder for the locale and shows the address', async () => {
    const openInBrowser = vi.fn(async () => true)
    const view = mount({ openInBrowser })
    await openBuilder(view)
    await waitForText(view.lastFrame, 'Opened')
    expect(openInBrowser).toHaveBeenCalledWith(URL_TR)
    expect(flat(view.lastFrame())).toContain(URL_TR)
  })

  it('shows the address to copy when no browser opens', async () => {
    const view = mount({ openInBrowser: vi.fn(async () => false) })
    await openBuilder(view)
    await waitForText(view.lastFrame, 'Open this address')
    expect(flat(view.lastFrame())).toContain(URL_TR)
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(view.lastFrame, /❯ Open the rules builder/)
  })
})
