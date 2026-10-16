import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import React from 'react'
import { saveConfig } from '../../src/config.js'
import { RulesFileChangedError, type RulesFetchPlan } from '../../src/commands/rules-fetch.js'
import { localeRulesFile } from '../../src/rules/load.js'
import { CommandsProvider, type TuiCommands } from '../../src/tui/commands.js'
import { LocaleRules } from '../../src/tui/screens/LocaleRules.js'
import { App } from '../../src/tui/App.js'
import { ESC_DELAY, cleanup, fakeCommands, flat, keys, makeHome, openFromHome, render, rulesEntry, tick, waitFor, waitForText, type Home } from './helpers.js'

let home: Home

beforeEach(async () => {
  home = await makeHome()
  saveConfig({ defaultLocale: 'tr' })
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

const FETCHED = 'schema: 2\nguidance: Use siz.\n'

function plan(patch: Partial<RulesFetchPlan> = {}): RulesFetchPlan {
  return {
    locale: 'tr',
    path: localeRulesFile('tr'),
    entry: rulesEntry(),
    text: FETCHED,
    state: 'changed',
    summary: ['guidance changed:', '  new text', 'status: maintained · maintainers (wordpress.org): emre'],
    ...patch,
  }
}

function mount(overrides: Partial<TuiCommands> = {}, onBack: () => void = () => undefined) {
  const commands = fakeCommands(overrides)
  const view = render(
    <CommandsProvider value={commands}>
      <LocaleRules onBack={onBack} />
    </CommandsProvider>,
  )
  return { ...view, commands }
}

type View = ReturnType<typeof mount>

async function openFetch(view: View) {
  await waitForText(view.lastFrame, /Locale/)
  view.stdin.write(keys.enter)
  await waitForText(view.lastFrame, /Built-in rules/)
  await selectFetch(view)
}

async function selectFetch(view: View) {
  for (let i = 0; i < 12 && !/❯ Fetch from polyglots-data/.test(view.lastFrame()); i++) {
    view.stdin.write(keys.down)
    await tick()
  }
  expect(view.lastFrame()).toMatch(/❯ Fetch from polyglots-data/)
  view.stdin.write(keys.enter)
  await tick()
}

describe('LocaleRules: fetch from polyglots-data', () => {
  it('shows the rules fetch summary and writes on confirm', async () => {
    // The fake writes what the plan holds, so the screen's reload has a file to read.
    const writeRulesFetch = vi.fn(async (p: RulesFetchPlan) => {
      await mkdir(dirname(p.path), { recursive: true })
      await writeFile(p.path, p.text)
    })
    const view = mount({ planRulesFetch: vi.fn(async () => plan()), writeRulesFetch })
    await openFetch(view)
    await waitForText(view.lastFrame, 'guidance changed:')
    const frame = flat(view.lastFrame())
    expect(frame).toContain('new text')
    expect(frame).toContain('This replaces')
    expect(frame).toContain('status: maintained')
    expect(view.commands.planRulesFetch).toHaveBeenCalledWith('tr', view.commands.dataClient)
    expect(writeRulesFetch).not.toHaveBeenCalled()

    view.stdin.write('y')
    await waitForText(view.lastFrame, 'Wrote')
    expect(writeRulesFetch).toHaveBeenCalledTimes(1)
    // Reloaded from disk: the overview counts the fetched guidance.
    expect(flat(view.lastFrame())).toContain(`Guidance ${'Use siz.'.length} of`)
  })

  it('cancels with esc and writes nothing', async () => {
    const view = mount({ planRulesFetch: vi.fn(async () => plan()) })
    await openFetch(view)
    await waitForText(view.lastFrame, 'guidance changed:')
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(view.lastFrame, /❯ Fetch from polyglots-data/)
    view.stdin.write('y')
    await tick()
    expect(view.commands.writeRulesFetch).not.toHaveBeenCalled()
  })

  it('says so and asks nothing when the local file is already the published one', async () => {
    const view = mount({ planRulesFetch: vi.fn(async () => plan({ state: 'same', summary: [] })) })
    await openFetch(view)
    await waitForText(view.lastFrame, 'Already the published file.')
    expect(flat(view.lastFrame())).not.toContain('This replaces')
    view.stdin.write('y')
    await tick()
    expect(view.commands.writeRulesFetch).not.toHaveBeenCalled()
  })

  it('asks before writing a new file too, naming where it goes', async () => {
    const view = mount({ planRulesFetch: vi.fn(async () => plan({ state: 'new' })) })
    await openFetch(view)
    await waitForText(view.lastFrame, 'guidance changed:')
    expect(flat(view.lastFrame())).not.toContain('This replaces')
    expect(flat(view.lastFrame())).toMatch(/y writes .*tr_TR\.yaml/)
    expect(view.commands.writeRulesFetch).not.toHaveBeenCalled()
  })

  it('shows a refusal and offers no write', async () => {
    const view = mount({
      planRulesFetch: vi.fn(async () => {
        throw new Error('needs rules schema 3; this polyglots reads up to 2. Update polyglots.')
      }),
    })
    await openFetch(view)
    await waitForText(view.lastFrame, 'needs rules schema 3')
    view.stdin.write('y')
    await tick()
    expect(view.commands.writeRulesFetch).not.toHaveBeenCalled()
  })

  // The write refuses when the file changed while the summary was on screen.
  // The summary is then about a file that is gone, and y bound to it would
  // refuse again on every press, so the screen plans again and the next y
  // writes against what is on disk now.
  it('plans again after the file changed under the summary', async () => {
    const first = plan({ summary: ['guidance changed:', '  first summary'] })
    const second = plan({ summary: ['guidance changed:', '  second summary'] })
    const planRulesFetch = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const writeRulesFetch = vi
      .fn(async (p: RulesFetchPlan) => {
        await mkdir(dirname(p.path), { recursive: true })
        await writeFile(p.path, p.text)
      })
      .mockRejectedValueOnce(new RulesFileChangedError(first.path))
    const view = mount({ planRulesFetch, writeRulesFetch })
    await openFetch(view)
    await waitForText(view.lastFrame, 'first summary')
    view.stdin.write('y')
    await waitForText(view.lastFrame, 'second summary')
    expect(flat(view.lastFrame())).toContain('changed since the summary')
    expect(planRulesFetch).toHaveBeenCalledTimes(2)
    view.stdin.write('y')
    await waitForText(view.lastFrame, 'Wrote')
    expect(writeRulesFetch).toHaveBeenCalledTimes(2)
    expect(writeRulesFetch.mock.calls[1]![0]).toBe(second)
  })

  // The fetched file replaces the one on disk, and the edits on screen were
  // made against that file: fetching would drop them without a word.
  it('refuses while there are unsaved edits', async () => {
    const view = mount({ planRulesFetch: vi.fn(async () => plan()) })
    await waitForText(view.lastFrame, /Locale/)
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Built-in rules/)
    // Glossary match, then → to change the ratio: an unsaved edit.
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /How much of a glossary term/)
    view.stdin.write(keys.right)
    await tick()
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(view.lastFrame, 'unsaved changes')
    await selectFetch(view)
    await waitForText(view.lastFrame, 'Save or discard')
    expect(view.commands.planRulesFetch).not.toHaveBeenCalled()
  })

  // Inside the app's frame, which scrolls to follow the line the arrows are
  // on; a summary is as long as the file's prompt text and can run to pages.
  it('scrolls a summary longer than the screen with the arrow keys', async () => {
    const summary = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`)
    const commands = fakeCommands({ planRulesFetch: vi.fn(async () => plan({ summary })) })
    const view = render(<App commands={commands} />, { columns: 80, rows: 24 })
    await tick()
    await openFromHome(view.stdin, 'locale-rules')
    await openFetch({ ...view, commands })
    await waitForText(view.lastFrame, 'line 1')
    expect(view.lastFrame()).not.toContain('line 60')
    expect(view.lastFrame()).toContain('more below')
    for (let i = 0; i < 59; i++) {
      view.stdin.write(keys.down)
      await tick()
    }
    await waitFor(() => view.lastFrame().includes('line 60'))
  })
})
