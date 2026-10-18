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

// A locale with a glossary and rules, so a change to it offers no setup and
// the picker's own behaviour is what a test sees.
const setUp = { glossaryCount: () => 5, hasLocaleRules: () => true }

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
    expect(tui.loadTuiState().recentLocales).toEqual(['nl', 'tr'])
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

  it('lists the current locale, marked, on a fresh install with no recent locales', async () => {
    const view = render(<App commands={fakeCommands()} cwd={cwd} />)
    await openPicker(view)
    expect(flat(view.lastFrame())).toMatch(/tr tr_TR current/)
  })

  it('offers the locale left behind after a switch', async () => {
    const view = render(<App commands={fakeCommands(setUp)} cwd={cwd} />)
    await openPicker(view)
    await type(view.stdin, 'nl')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'locale nl')
    await openPicker(view)
    expect(flat(view.lastFrame())).toMatch(/nl nl_NL current .*tr tr_TR/)
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
    await waitForText(view.lastFrame, 'The locale changes after the current job ends.')
    expect(save).not.toHaveBeenCalled()
    expect(loadConfig().defaultLocale).toBe('tr')
  })

  it('refuses while Locale rules has unsaved edits', async () => {
    const save = vi.fn(saveConfig)
    const view = render(<App commands={fakeCommands({ saveConfig: save })} cwd={cwd} />)
    await openFromHome(view.stdin, 'locale-rules')
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
    const view = render(<App commands={fakeCommands(setUp)} cwd={cwd} />)
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

describe('the setup offer on a change of locale', () => {
  // The prompt's text, with the border Ink draws at each wrap taken out.
  const prompt = (frame: string | undefined) => {
    const text = flat(frame).replace(/(\s*│\s*)+/g, ' ')
    return text.slice(text.indexOf(' has no '), text.indexOf('not now') + 'not now'.length)
  }
  async function change(view: ReturnType<typeof render>, id: string) {
    await openPicker(view)
    await type(view.stdin, id)
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, `locale ${id}`)
  }

  it('the first change to an unconfigured locale offers setup once', async () => {
    const tui = memoryTuiState(dismissed())
    const view = render(<App commands={fakeCommands(tui)} cwd={cwd} />)
    await change(view, 'nl')
    await waitForText(view.lastFrame, 'nl has no glossary or locale rules yet.')
    expect(prompt(view.lastFrame())).toContain("Until then, reviews go without glossary term checks and this locale's own checks.")
    expect(flat(view.lastFrame())).toContain('Set them up now? y set up · n not now')
    view.stdin.write('n')
    await tick()
    expect(flat(view.lastFrame())).not.toContain('Set them up now?')
    expect(tui.loadTuiState().wizard.locales.nl?.asked).toBe(true)
    await change(view, 'tr')
    await tick(20)
    expect(flat(view.lastFrame())).not.toContain('Set them up now?')
    await change(view, 'nl')
    await tick(20)
    expect(flat(view.lastFrame())).not.toContain('Set them up now?')
  })

  it('y opens setup on the missing steps and returns to the screen', async () => {
    const tui = memoryTuiState(dismissed())
    const view = render(<App commands={fakeCommands(tui)} cwd={cwd} />)
    await openFromHome(view.stdin, 'import-tm')
    await waitForText(view.lastFrame, 'Import Translation Memory · locale tr')
    await change(view, 'nl')
    await waitForText(view.lastFrame, 'Set them up now?')
    view.stdin.write('y')
    await waitForText(view.lastFrame, 'Glossary sync')
    // The glossary is skipped, the memory step passes by itself since the
    // fake manifest lists none, and the rules step is skipped too.
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(view.lastFrame, 'Locale rules')
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(view.lastFrame, 'Import Translation Memory · locale nl')
    expect(flat(view.lastFrame())).not.toContain('Setup ·')
  })

  // With the glossary there, the rules still missing: the consequence named is
  // only what is lost, and the question is put in the singular.
  it('one missing step is named alone, in the singular', async () => {
    const view = render(<App commands={fakeCommands({ ...memoryTuiState(dismissed()), glossaryCount: () => 5 })} cwd={cwd} />)
    await change(view, 'nl')
    await waitForText(view.lastFrame, 'nl has no locale rules yet.')
    const frame = prompt(view.lastFrame())
    expect(frame).toContain("Until then, reviews go without this locale's own checks.")
    expect(frame).toContain('Set it up now? y set up · n not now')
    expect(frame).not.toContain('glossary')
  })

  it('a configured locale gets no offer', async () => {
    const tui = memoryTuiState(dismissed())
    const view = render(<App commands={fakeCommands({ ...tui, ...setUp })} cwd={cwd} />)
    await change(view, 'nl')
    await tick(20)
    expect(flat(view.lastFrame())).not.toContain('Set them up now?')
    expect(tui.loadTuiState().wizard.locales.nl?.asked).toBe(true)
  })

  // Offline, whether polyglots-data has a memory for the locale is unknown,
  // and that alone is no reason to interrupt a change of locale.
  it('an unknown memory listing alone gets no offer', async () => {
    const view = render(
      <App
        commands={fakeCommands({
          ...memoryTuiState(dismissed()),
          ...setUp,
          memoryCount: () => 0,
          dataClient: {
            manifest: async () => {
              throw new Error('offline')
            },
            download: async () => {
              throw new Error('offline')
            },
          },
        })}
        cwd={cwd}
      />,
    )
    await change(view, 'nl')
    await tick(20)
    expect(flat(view.lastFrame())).not.toContain('Set them up now?')
  })

  it('choosing a locale in setup marks it asked', async () => {
    const tui = memoryTuiState(dismissed())
    const view = render(<App commands={fakeCommands(tui)} cwd={cwd} />)
    await tick()
    view.stdin.write('c')
    await waitForText(view.lastFrame, 'Setup wizard')
    view.stdin.write('w')
    await waitForText(view.lastFrame, 'Search:')
    view.stdin.write(keys.backspace)
    await tick()
    view.stdin.write(keys.backspace)
    await tick()
    await type(view.stdin, 'de_DE')
    await waitForText(view.lastFrame, 'de_DE')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'Step 2 of 6')
    expect(tui.loadTuiState().wizard.locales.de?.asked).toBe(true)
    // As the picker does: the locale replaced stays one key away.
    expect(tui.loadTuiState().recentLocales).toEqual(['de', 'tr'])
  })

  // The launch migration's save can fail, and the next write re-reads the
  // file. Migrated again there, the answers an older file kept in the global
  // lists still land under the locale they were given for.
  it('a write after a failed launch save still carries the migration', async () => {
    let state: TuiState = { ...DEFAULT_TUI_STATE, wizard: { dismissed: true, skipped: ['memory'], confirmed: [], locales: {} } }
    let saves = 0
    const tui = {
      loadTuiState: () => state,
      saveTuiState: (next: TuiState) => {
        if (saves++ === 0) throw new Error('read-only')
        state = next
      },
    }
    const view = render(<App commands={fakeCommands({ ...tui, ...setUp })} cwd={cwd} />)
    await change(view, 'nl')
    await tick(20)
    expect(state.wizard.skipped).not.toContain('memory')
    expect(state.wizard.locales.tr?.skipped).toContain('memory')
  })
})
