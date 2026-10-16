import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { DEFAULT_CONFIG, saveConfig } from '../../src/config.js'
import type { TmFetchPlan } from '../../src/commands/tm-fetch.js'
import type { Manifest } from '../../src/data/manifest.js'
import { App } from '../../src/tui/App.js'
import { CommandsProvider, type TuiCommands } from '../../src/tui/commands.js'
import { Wizard } from '../../src/tui/screens/Wizard.js'
import { setupStatus } from '../../src/tui/setup.js'
import { DEFAULT_TUI_STATE, type TuiState } from '../../src/tui/state.js'
import {
  ESC_DELAY,
  agentStatus,
  cleanup,
  fakeCommands,
  flat,
  keys,
  makeHome,
  manifestWith,
  memoryTuiState,
  render,
  tick,
  tmEntry,
  waitFor,
  waitForText,
  type Home,
} from './helpers.js'

let home: Home
beforeEach(async () => {
  home = await makeHome()
  saveConfig({ defaultLocale: 'tr' })
})
afterEach(async () => {
  cleanup()
  await home.cleanup()
})

const STATUS = setupStatus({
  config: { ...DEFAULT_CONFIG, defaultLocale: 'tr' },
  secrets: {},
  state: DEFAULT_TUI_STATE,
  agents: [agentStatus('claude')],
  localeConfigured: true,
  glossaryCount: 0,
  hasLocaleRules: false,
  memory: 'missing',
})

function plan(): TmFetchPlan {
  return { locale: 'tr', entry: tmEntry(), existing: 0, summary: ['Turkish (tr): 1,002 strings, 98.1 KiB download, built 2026-10-15'] }
}

function mount(manifest: () => Promise<Manifest>, overrides: Partial<TuiCommands> = {}) {
  let state: TuiState = structuredClone(DEFAULT_TUI_STATE)
  const onRecord = vi.fn((patch: (s: TuiState) => TuiState) => {
    state = patch(state)
  })
  const commands = fakeCommands({ dataClient: { manifest: vi.fn(manifest), download: vi.fn() }, ...overrides })
  const view = render(
    <CommandsProvider value={commands}>
      <Wizard start="memory" status={STATUS} onRecord={onRecord} onDone={() => undefined} />
    </CommandsProvider>,
  )
  return { ...view, commands, onRecord, state: () => state }
}

describe('the wizard memory step', () => {
  it('wizard: offers the memory step only when the manifest has the locale', async () => {
    const listed = mount(async () => manifestWith({ tm: [tmEntry()] }), { planTmFetch: vi.fn(async () => plan()) })
    await waitForText(listed.lastFrame, 'Turkish (tr): 1,002 strings')
    expect(flat(listed.lastFrame())).toContain('Step 5 of 6')
    expect(flat(listed.lastFrame())).toContain('Translation memory')
    cleanup()

    const unlisted = mount(async () => manifestWith({ tm: [tmEntry({ slug: 'de', locale: 'de_DE' })] }))
    await waitForText(unlisted.lastFrame, 'Step 6 of 6')
    expect(flat(unlisted.lastFrame())).toContain('Locale rules')
    expect(unlisted.commands.planTmFetch).not.toHaveBeenCalled()
    // Nothing to skip: a locale the vault does not have counts as done on its own.
    expect(unlisted.state().wizard.skipped).not.toContain('memory')
  })

  it('reads a wp code in config as its slug, as tm fetch does', async () => {
    saveConfig({ defaultLocale: 'tr_TR' })
    const planTmFetch = vi.fn(async (_locale: string) => plan())
    const view = mount(async () => manifestWith({ tm: [tmEntry()] }), { planTmFetch })
    await waitForText(view.lastFrame, 'Turkish (tr): 1,002 strings')
    expect(planTmFetch.mock.calls[0]![0]).toBe('tr')
  })

  it('wizard: offline skips the memory step without waiting', async () => {
    const view = mount(async () => {
      throw new Error('GET https://example.invalid/index.json failed: getaddrinfo ENOTFOUND')
    })
    // Not the client's 15 s timeout, nor any wait of the wizard's own: the
    // step is gone as soon as the rejection lands and React has drawn.
    await waitFor(() => flat(view.lastFrame()).includes('Step 6 of 6'), 100)
    const frame = flat(view.lastFrame())
    expect(frame).toContain('Could not reach polyglots-data; skipped.')
    expect(frame).toContain('Step 6 of 6')
    expect(view.state().wizard.skipped).toContain('memory')
  })

  it('draws at once while the manifest is read, and esc skips the step', async () => {
    const view = mount(() => new Promise<Manifest>(() => {}))
    await waitForText(view.lastFrame, 'Step 5 of 6')
    expect(flat(view.lastFrame())).toContain('Checking polyglots-data')
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(view.lastFrame, 'Step 6 of 6')
    expect(view.state().wizard.skipped).toContain('memory')
  })

  it('imports and moves on to the rules step', async () => {
    const runTmFetch = vi.fn(async () => ({ units: 1002, added: 1002, present: 0, projects: 4, ms: 1_000 }))
    const view = mount(async () => manifestWith({ tm: [tmEntry()] }), { planTmFetch: vi.fn(async () => plan()), runTmFetch })
    await waitForText(view.lastFrame, '1,002 strings')
    view.stdin.write('y')
    await waitForText(view.lastFrame, 'Imported 1,002 new strings')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'Step 6 of 6')
    expect(runTmFetch).toHaveBeenCalledTimes(1)
    expect(view.state().wizard.confirmed).toContain('memory')
  })

  // tui.json is what the header and the launch check read; a failed fetch
  // recorded as confirmed would mark the memory step done with no rows in it.
  it('does not confirm the step when the fetch fails', async () => {
    const runTmFetch = vi.fn(async () => {
      throw new Error('sha512 mismatch for tr_TR.tmx.gz')
    })
    const view = mount(async () => manifestWith({ tm: [tmEntry()] }), { planTmFetch: vi.fn(async () => plan()), runTmFetch })
    await waitForText(view.lastFrame, '1,002 strings')
    view.stdin.write('y')
    await waitForText(view.lastFrame, 'Fetch failed: sha512 mismatch')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'Step 6 of 6')
    expect(view.state().wizard.confirmed).not.toContain('memory')
  })
})

describe('the app and the memory step', () => {
  it('counts memory in the header from the rows the memory holds', async () => {
    const commands = fakeCommands({
      loadConfig: () => ({ ...DEFAULT_CONFIG, defaultLocale: 'tr' }),
      localeConfigured: () => true,
      memoryCount: vi.fn(() => 1_002),
      dataClient: { manifest: vi.fn(async () => manifestWith({ tm: [tmEntry()] })), download: vi.fn() },
    })
    const { lastFrame } = render(<App commands={commands} />)
    await waitForText(lastFrame, /setup \d\/6/)
    expect(flat(lastFrame())).toMatch(/✓ memory/)
    // Rows answer the question; the network is not asked.
    expect(commands.dataClient.manifest).not.toHaveBeenCalled()
  })

  // A hand-edited tr_TR is tr to every CLI command. Read raw, the memory
  // was counted under tr_TR (none) and the manifest asked for tr_TR (not
  // listed), so the step read as done with nothing fetched.
  it('counts memory under the slug when config holds a wp code', async () => {
    const memoryCount = vi.fn((locale: string) => (locale === 'tr' ? 1_002 : 0))
    const commands = fakeCommands({
      loadConfig: () => ({ ...DEFAULT_CONFIG, defaultLocale: 'tr_TR' }),
      localeConfigured: () => true,
      memoryCount,
      dataClient: { manifest: vi.fn(async () => manifestWith({ tm: [tmEntry()] })), download: vi.fn() },
    })
    const { lastFrame } = render(<App commands={commands} />)
    await waitForText(lastFrame, /setup \d\/6/)
    expect(flat(lastFrame())).toMatch(/✓ memory/)
    expect(memoryCount).toHaveBeenCalledWith('tr')
    expect(memoryCount).not.toHaveBeenCalledWith('tr_TR')
    expect(commands.dataClient.manifest).not.toHaveBeenCalled()
  })

  it('reads the memory step as missing under a wp code when the vault has the slug and the memory is empty', async () => {
    const commands = fakeCommands({
      loadConfig: () => ({ ...DEFAULT_CONFIG, defaultLocale: 'tr_TR' }),
      localeConfigured: () => true,
      memoryCount: vi.fn(() => 0),
      dataClient: { manifest: vi.fn(async () => manifestWith({ tm: [tmEntry()] })), download: vi.fn() },
    })
    const { lastFrame } = render(<App commands={commands} />)
    await waitFor(() => vi.mocked(commands.dataClient.manifest).mock.calls.length > 0)
    await waitForText(lastFrame, /✗ memory/)
  })

  it('opens the wizard at the memory step when the vault has the locale and the memory is empty', async () => {
    const commands = fakeCommands({
      ...memoryTuiState(structuredClone(DEFAULT_TUI_STATE)),
      loadConfig: () => ({ ...DEFAULT_CONFIG, defaultLocale: 'tr', defaultDraftEngine: 'none' }),
      localeConfigured: () => true,
      glossaryCount: () => 10,
      hasLocaleRules: () => true,
      memoryCount: vi.fn(() => 0),
      dataClient: { manifest: vi.fn(async () => manifestWith({ tm: [tmEntry()] })), download: vi.fn() },
      planTmFetch: vi.fn(async () => plan()),
    })
    const { lastFrame, stdin } = render(<App commands={commands} />)
    await waitForText(lastFrame, /setup 5\/6/)
    expect(flat(lastFrame())).toMatch(/✗ memory/)
    await tick()
    stdin.write(keys.tab)
    await tick()
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'Step 5 of 6')
    await waitFor(() => flat(lastFrame()).includes('1,002 strings'))
  })
})
