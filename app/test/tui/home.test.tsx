import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import React from 'react'
import { stripVTControlCharacters } from 'node:util'
import { App } from '../../src/tui/App.js'
import { MAX_FRAME_COLUMNS } from '../../src/tui/size.js'
import { DEFAULT_CONFIG, saveConfig } from '../../src/config.js'
import type { PolyglotsConfig } from '../../src/types.js'
import { HOME, RESERVED_KEYS, walk } from '../../src/tui/menu.js'
import { nextProvider } from '../../src/tui/screens/Home.js'
import {
  agentStatus,
  ESC_DELAY,
  fakeCommands,
  flat,
  openFromHome,
  keys,
  makeHome,
  tick,
  unusableAgent,
  waitForText,
  render,
  cleanup,
  type Home,
} from './helpers.js'


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

// Written out rather than derived from the menu tree, because this is the
// assertion about what the user sees and deriving it would make it agree with
// the code by construction. The length check below is what stops it drifting.
const EXPECTED_HOME = [
  'r Review a submitted .po',
  't Translate a .po file',
  'f Fetch from translate.wordpress.org',
  's Review statistics',
  'o Tools',
  'c Configuration',
  'h Help',
  'a About',
]

describe('Home', () => {
  it('shows eight cards in a grid with the wordmark at 120x40', async () => {
    const { lastFrame } = render(<App commands={fakeCommands()} cwd={cwd} />, { columns: 120, rows: 40 })
    await tick()
    const frame = flat(lastFrame())
    for (const item of EXPECTED_HOME) expect(frame).toContain(item)
    expect(EXPECTED_HOME).toHaveLength(HOME.length)
    expect(lastFrame()).toContain('▛▌▛▌▐ ▌▌▛▌▐ ▛▌▜▘▛▘')
    expect(lastFrame()).toContain('╭')
    // Two cards on one line is what makes it a grid.
    // Review first, so it has focus when the app opens: reviewing
    // submissions is what the app is for.
    expect(lastFrame()).toMatch(/Review a submitted \.po.*Translate a \.po file/)
    expect(frame).toMatch(/› r Review/)
  })

  // Every screen shares the home grid's width and its left edge, so the eye
  // does not jump between a centred home and screens pinned to the left.
  it('keeps the whole frame in one column as wide as the home grid on a wide terminal', async () => {
    const { lastFrame } = render(<App commands={fakeCommands()} cwd={cwd} />, { columns: 200, rows: 40 })
    await tick()
    const lines = stripVTControlCharacters(lastFrame()).split('\n').filter((l) => l.trim() !== '')
    const left = Math.min(...lines.map((l) => l.length - l.trimStart().length))
    const right = Math.max(...lines.map((l) => l.trimEnd().length))
    expect(right - left).toBe(MAX_FRAME_COLUMNS)
    // Centred; an odd margin rounds whichever way the layout engine likes.
    expect(Math.abs(left - (200 - MAX_FRAME_COLUMNS) / 2)).toBeLessThanOrEqual(0.5)
    const wordmark = lines.find((l) => l.includes('▛▌▛▌'))!
    const footer = lines.find((l) => l.includes('quit'))!
    expect(wordmark.length - wordmark.trimStart().length).toBe(left)
    expect(footer.length - footer.trimStart().length).toBe(left)
  })

  it('fits the grid exactly at 80x24', async () => {
    const { lastFrame } = render(<App commands={fakeCommands()} cwd={cwd} />, { columns: 80, rows: 24 })
    await tick()
    const lines = lastFrame().split('\n')
    expect(lines.length).toBeLessThanOrEqual(24)
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(80)
    expect(lastFrame()).toMatch(/Review a submitted \.po.*Translate a \.po file/)
    expect(flat(lastFrame())).toContain('a About')
    expect(flat(lastFrame())).toContain('? help')
  })

  it('switches to a one-column list without the wordmark below 80 columns', async () => {
    const { lastFrame } = render(<App commands={fakeCommands()} cwd={cwd} />, { columns: 70, rows: 24 })
    await tick()
    const frame = lastFrame()
    for (const item of EXPECTED_HOME) expect(flat(frame)).toContain(item)
    expect(frame).not.toContain('╭')
    expect(frame).not.toContain('▛▌')
    expect(frame).not.toMatch(/Review a submitted \.po.*Translate a \.po file/)
  })

  it('asks for a larger terminal below 60x20, and lays out again on resize', async () => {
    const view = render(<App commands={fakeCommands()} cwd={cwd} />, { columns: 59, rows: 20 })
    await tick()
    expect(flat(view.lastFrame())).toMatch(/Enlarge the terminal to at least 60×20 \(now 59×20\)/)
    view.resize(120, 40)
    await waitForText(view.lastFrame, 'Translate a .po file')
    expect(view.lastFrame()).toContain('╭')
  })

  it('opens a card by its hotkey', async () => {
    const { lastFrame, stdin } = render(<App commands={fakeCommands()} cwd={cwd} />)
    await tick()
    stdin.write('t')
    await waitForText(lastFrame, 'plugin.po')
    expect(lastFrame()).toContain(cwd)
  })

  it('moves between cards with the arrows and opens one with enter', async () => {
    const { lastFrame, stdin } = render(<App commands={fakeCommands()} cwd={cwd} />)
    await tick()
    stdin.write(keys.right)
    await tick()
    expect(flat(lastFrame())).toMatch(/› t Translate/)
    stdin.write(keys.down)
    await tick()
    expect(flat(lastFrame())).toMatch(/› s Review statistics/)
    stdin.write(keys.left)
    await tick()
    expect(flat(lastFrame())).toMatch(/› f Fetch/)
    stdin.write(keys.up)
    await tick()
    expect(flat(lastFrame())).toMatch(/› r Review/)
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'Review')
    expect(lastFrame()).toContain('plugin.po')
  })

  it('moves down the list one item at a time in the narrow layout', async () => {
    const { lastFrame, stdin } = render(<App commands={fakeCommands()} cwd={cwd} />, { columns: 70, rows: 24 })
    await tick()
    stdin.write(keys.down)
    await tick()
    expect(flat(lastFrame())).toMatch(/› t Translate/)
  })

  it('opens Tools as a submenu, and goes back a level at a time', async () => {
    const { lastFrame, stdin } = render(<App commands={fakeCommands()} cwd={cwd} />)
    await tick()
    stdin.write('o')
    await waitForText(lastFrame, 'Split a .po into parts')
    expect(flat(lastFrame())).toContain('i Import Translation Memory')
    expect(flat(lastFrame())).toContain('e Export Translation Memory')
    stdin.write('s')
    await waitForText(lastFrame, 'Split')
    stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(lastFrame, 'Import Translation Memory')
    stdin.write('q')
    await waitForText(lastFrame, 'Translate a .po file')
  })

  it('reaches the TM import picker through Tools', async () => {
    const { lastFrame, stdin } = render(<App commands={fakeCommands()} cwd={cwd} />)
    await openFromHome(stdin, 'import-tm')
    await waitForText(lastFrame, /Import Translation Memory · locale/)
    // The fake manifest lists no memory, so the file is the one way in.
    expect(flat(lastFrame())).toContain('Import a file')
  })

  it('reaches the glossary sync screen through Configuration', async () => {
    const { lastFrame, stdin } = render(<App commands={fakeCommands()} cwd={cwd} />)
    await openFromHome(stdin, 'sync-glossary')
    await waitForText(lastFrame, /[Ll]ocale/)
    expect(lastFrame()).toContain('tr')
  })

  it('reaches the API key screen through Configuration', async () => {
    const { lastFrame, stdin } = render(<App commands={fakeCommands()} cwd={cwd} />)
    await openFromHome(stdin, 'configure-keys')
    await waitForText(lastFrame, 'DEEPL_API_KEY')
    expect(lastFrame()).toContain('(not set)')
  })

  it('returns home with q and with escape', async () => {
    const { lastFrame, stdin } = render(<App commands={fakeCommands()} cwd={cwd} />)
    await tick()
    stdin.write('t')
    await waitForText(lastFrame, 'plugin.po')

    stdin.write('q')
    await waitForText(lastFrame, 'About')

    stdin.write('t')
    await waitForText(lastFrame, 'plugin.po')
    stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(lastFrame, 'About')
  })

  it('exits the app when q is pressed on home', async () => {
    let exited = false
    const { stdin } = render(<App commands={fakeCommands()} cwd={cwd} onExit={() => (exited = true)} />)
    await tick()
    stdin.write('q')
    await tick()
    expect(exited).toBe(true)
  })

  it('exits on Ctrl+C when nothing is running', async () => {
    let exited = false
    const { stdin } = render(<App commands={fakeCommands()} cwd={cwd} onExit={() => (exited = true)} />)
    await tick()
    stdin.write('\u0003')
    await tick()
    expect(exited).toBe(true)
  })
})

describe('the header', () => {
  it('shows the version, the provider with its model, and the setup count', async () => {
    const commands = fakeCommands({
      // A locale, or there is nothing for the rules step to have rules for.
      loadConfig: () => ({ ...DEFAULT_CONFIG, defaultLocale: 'tr', reviewProvider: 'antigravity' }),
      discoverAgents: async () => [agentStatus('claude'), agentStatus('antigravity', { model: 'Gemini 3.8 Flash (Low)' })],
      hasLocaleRules: () => true,
    })
    const { lastFrame } = render(<App commands={commands} cwd={cwd} />)
    await waitForText(lastFrame, 'Flash')
    const frame = flat(lastFrame())
    expect(frame).toMatch(/polyglots \d+\.\d+\.\d+/)
    expect(frame).toContain('review antigravity · Gemini 3.8 Flash (Low)')
    // locale is not configured by the file, keys and glossary are missing;
    // the provider, the rules and the memory (the fake manifest lists none
    // for tr, so there is nothing to fetch) are done.
    await waitForText(lastFrame, /setup 3\/6/)
  })

  it('opens the wizard at a missing step from the setup status', async () => {
    const { lastFrame, stdin } = render(<App commands={fakeCommands()} cwd={cwd} />)
    // The memory step is done: the fake manifest lists no memory for tr.
    await waitForText(lastFrame, 'setup 2/6')
    stdin.write(keys.tab)
    await tick()
    // Focus lands on the first step that is not done.
    expect(flat(lastFrame())).toMatch(/› ✗ locale/)
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'Step 1 of 6')
  })
})

describe('the menu tree', () => {
  it('never binds one key twice within a level, nor a reserved key', () => {
    const levels = [HOME, ...HOME.filter((n) => n.children).map((n) => n.children!)]
    for (const level of levels) {
      const keysAt = level.map((n) => n.key)
      expect(new Set(keysAt).size).toBe(keysAt.length)
      for (const key of keysAt) expect(RESERVED_KEYS).not.toContain(key)
    }
  })

  it('gives every node a single-character key, a description and help', () => {
    for (const { node } of walk()) {
      expect(node.key).toHaveLength(1)
      expect(node.description.length).toBeGreaterThan(0)
      expect(node.help.length).toBeGreaterThan(0)
    }
  })
})

describe('overlays', () => {
  it('opens help for the current screen with ?, and keeps keys away from the screen beneath', async () => {
    const { lastFrame, stdin } = render(<App commands={fakeCommands()} cwd={cwd} />)
    await tick()
    stdin.write('?')
    await waitForText(lastFrame, 'Keys on this screen')
    stdin.write('t')
    await tick()
    expect(lastFrame()).toContain('Keys on this screen')
    stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(lastFrame, 'Translate a .po file')
    expect(lastFrame()).not.toContain('Keys on this screen')
  })

  it('leaves ? to a text field that is being typed into', async () => {
    const { lastFrame, stdin } = render(<App commands={fakeCommands()} cwd={cwd} />)
    await openFromHome(stdin, 'sync-glossary')
    await waitForText(lastFrame, 'Locale:')
    stdin.write('?')
    await tick()
    expect(lastFrame()).not.toContain('Keys on this screen')
    expect(lastFrame()).toContain('tr?')
  })

  it('finds and opens a screen from the command palette', async () => {
    const { lastFrame, stdin } = render(<App commands={fakeCommands()} cwd={cwd} />)
    await tick()
    stdin.write('\u000b')
    await waitForText(lastFrame, 'Go to')
    for (const ch of 'split') {
      stdin.write(ch)
      await tick()
    }
    expect(flat(lastFrame())).toContain('Tools › Split a .po into parts')
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'Split')
    expect(lastFrame()).not.toContain('Go to')
  })

  it('opens the palette with : too', async () => {
    const { lastFrame, stdin } = render(<App commands={fakeCommands()} cwd={cwd} />)
    await tick()
    stdin.write(':')
    await waitForText(lastFrame, 'Go to')
  })
})

describe('switching the review provider', () => {
  it('shows the provider the config names', async () => {
    const commands = fakeCommands({
      loadConfig: () => ({ ...DEFAULT_CONFIG, reviewProvider: 'antigravity' }),
    })
    const { lastFrame } = render(<App commands={commands} cwd={cwd} />)
    await tick()
    expect(lastFrame() ?? '').toContain('review antigravity')
  })

  it('cycles with p and saves the choice', async () => {
    const saved: Partial<PolyglotsConfig>[] = []
    const commands = fakeCommands({
      loadConfig: () => ({ ...DEFAULT_CONFIG, reviewProvider: 'claude' }),
      saveConfig: (patch: Partial<PolyglotsConfig>) => {
        saved.push(patch)
        return { ...DEFAULT_CONFIG, ...patch }
      },
    })
    const { lastFrame, stdin } = render(<App commands={commands} cwd={cwd} />)
    await tick()
    expect(lastFrame() ?? '').toContain('review claude')

    stdin.write('p')
    await tick()
    expect(saved).toEqual([{ reviewProvider: 'antigravity' }])
    expect(lastFrame() ?? '').toContain('review antigravity')

    // Wraps, so one key reaches every provider however many there are.
    stdin.write('p')
    await tick()
    expect(lastFrame() ?? '').toContain('review claude')
  })

  // A run reads the saved config, so moving the display on a failed save would
  // name an agent no review is going to use.
  it('keeps showing the saved provider when the write fails, and says why', async () => {
    const commands = fakeCommands({
      loadConfig: () => ({ ...DEFAULT_CONFIG, reviewProvider: 'claude' }),
      saveConfig: () => {
        throw new Error('EACCES: permission denied')
      },
    })
    const { lastFrame, stdin } = render(<App commands={commands} cwd={cwd} />)
    await tick()
    stdin.write('p')
    await tick()
    const frame = lastFrame() ?? ''
    expect(frame).toContain('review claude')
    expect(frame).toMatch(/EACCES/)
  })
})

describe('switching only between usable agents', () => {
  function recorder(reviewProvider: 'claude' | 'antigravity') {
    const saved: Partial<PolyglotsConfig>[] = []
    let current: PolyglotsConfig = { ...DEFAULT_CONFIG, reviewProvider }
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

  it('leaves claude selected when antigravity is unusable, and says why', async () => {
    const config = recorder('claude')
    const commands = fakeCommands({
      ...config,
      discoverAgents: async () => [agentStatus('claude'), unusableAgent('antigravity', 'agy not on PATH')],
    })
    const { lastFrame, stdin } = render(<App commands={commands} cwd={cwd} />)
    await waitForText(lastFrame, 'Unavailable: antigravity (agy not on PATH)')
    stdin.write('p')
    await tick()
    const frame = flat(lastFrame())
    expect(config.saved).toEqual([])
    expect(frame).toContain('review claude')
    expect(frame).toContain('No other usable agent: antigravity: agy not on PATH')
  })

  it('switches and saves when both are usable', async () => {
    const config = recorder('claude')
    const commands = fakeCommands({ ...config })
    const { lastFrame, stdin } = render(<App commands={commands} cwd={cwd} />)
    await tick()
    stdin.write('p')
    await tick()
    expect(config.saved).toEqual([{ reviewProvider: 'antigravity' }])
    expect(lastFrame()).toContain('review antigravity')
    expect(lastFrame()).not.toContain('Unavailable')
  })

  // The menu never rewrites the configured provider: switching it silently
  // would change which engine a run records, behind the person's back.
  it('shows why the configured provider is unusable, and p goes to the usable one and back', async () => {
    const config = recorder('antigravity')
    const reason = 'antigravity is missing permission rules: mcp(polyglots/tm_lookup) (see https://ada.tools/polyglots/docs/antigravity/)'
    const commands = fakeCommands({
      ...config,
      discoverAgents: async () => [agentStatus('claude'), agentStatus('antigravity', { usable: false, reason })],
    })
    const { lastFrame, stdin } = render(<App commands={commands} cwd={cwd} />)
    await waitForText(() => flat(lastFrame()), 'missing permission rules')
    expect(lastFrame()).toContain('review antigravity')
    expect(config.saved).toEqual([])

    stdin.write('p')
    await tick()
    expect(lastFrame()).toContain('review claude')
    stdin.write('p')
    await tick()
    expect(lastFrame()).toContain('review antigravity')
    expect(config.saved).toEqual([{ reviewProvider: 'claude' }, { reviewProvider: 'antigravity' }])
  })

  it('cycles every provider while discovery is still running, and says it is checking', async () => {
    const config = recorder('claude')
    const commands = fakeCommands({ ...config, discoverAgents: () => new Promise(() => {}) })
    const { lastFrame, stdin } = render(<App commands={commands} cwd={cwd} />)
    await tick()
    expect(lastFrame()).toContain('Checking agents…')
    stdin.write('p')
    await tick()
    expect(config.saved).toEqual([{ reviewProvider: 'antigravity' }])
  })

  it('behaves like the old menu when discovery fails', async () => {
    const config = recorder('claude')
    const commands = fakeCommands({ ...config, discoverAgents: async () => Promise.reject(new Error('spawn EPERM')) })
    const { lastFrame, stdin } = render(<App commands={commands} cwd={cwd} />)
    await tick()
    await tick()
    expect(lastFrame()).not.toContain('Checking agents…')
    stdin.write('p')
    await tick()
    expect(config.saved).toEqual([{ reviewProvider: 'antigravity' }])
  })
})

describe('nextProvider', () => {
  it('cycles every provider when nothing is known about which are usable', () => {
    expect(nextProvider('claude')).toBe('antigravity')
    expect(nextProvider('antigravity')).toBe('claude')
  })

  it('keeps the current provider in the rotation even when it is not usable', () => {
    expect(nextProvider('antigravity', ['claude'])).toBe('claude')
    expect(nextProvider('claude', ['claude', 'antigravity'])).toBe('antigravity')
  })

  it('stays put when the current provider is the only one', () => {
    expect(nextProvider('claude', ['claude'])).toBe('claude')
    expect(nextProvider('claude', [])).toBe('claude')
  })

  // The experimental local reviewer is reached only by `config set`, so p
  // leaves it for an agent and never comes back to it.
  it('moves from local to an agent, and never to local', () => {
    expect(nextProvider('local')).toBe('claude')
    expect(nextProvider('local', ['antigravity'])).toBe('antigravity')
    expect(nextProvider('antigravity')).not.toBe('local')
  })
})

describe('the local reviewer on home', () => {
  it('is marked experimental, and p moves away from it', async () => {
    const saved: Partial<PolyglotsConfig>[] = []
    const commands = fakeCommands({
      loadConfig: () => ({ ...DEFAULT_CONFIG, reviewProvider: 'local' }),
      saveConfig: (patch: Partial<PolyglotsConfig>) => {
        saved.push(patch)
        return { ...DEFAULT_CONFIG, ...patch }
      },
    })
    const { lastFrame, stdin } = render(<App commands={commands} cwd={cwd} />)
    await tick()
    expect(lastFrame() ?? '').toContain('review local (experimental)')
    stdin.write('p')
    await tick()
    expect(saved).toEqual([{ reviewProvider: 'claude' }])
    stdin.write('p')
    await tick()
    stdin.write('p')
    await tick()
    expect(saved.map((p) => p.reviewProvider)).not.toContain('local')
  })
})
