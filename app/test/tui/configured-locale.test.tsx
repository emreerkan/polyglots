import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import React from 'react'
import { saveConfig } from '../../src/config.js'
import { CommandsProvider, type ReviewFile, type TuiCommands } from '../../src/tui/commands.js'
import { Review } from '../../src/tui/screens/Review.js'
import { Translate } from '../../src/tui/screens/Translate.js'
import { SyncGlossary } from '../../src/tui/screens/SyncGlossary.js'
import { cleanup, fakeCommands, flat, keys, makeHome, render, reviewSummaryOf, summaryOf, tick, waitFor, waitForText, type Home } from './helpers.js'

// With a locale configured, the header names it on every screen and l changes
// it. The run forms used to repeat it as an editable field, which was a second,
// per-screen locale switch: one that Antigravity's lookup server never heard,
// so a typed nl answered tm_lookup from the tr memory. The forms now leave the
// locale to the header and only say so when the picked file disagrees.

let home: Home
let cwd: string

const po = (language: string) =>
  ['msgid ""', 'msgstr ""', '"Content-Type: text/plain; charset=UTF-8\\n"', `"Language: ${language}\\n"`, '', 'msgid "A"', 'msgstr ""', ''].join('\n')

beforeEach(async () => {
  home = await makeHome()
  saveConfig({ defaultLocale: 'tr' })
  cwd = join(home.path, 'work')
  await mkdir(cwd)
  await writeFile(join(cwd, 'a.po'), po('tr_TR'))
  await writeFile(join(cwd, 'b.po'), po('nl_NL'))
  await utimes(join(cwd, 'a.po'), 5000, 5000)
  await utimes(join(cwd, 'b.po'), 4000, 4000)
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

type View = ReturnType<typeof render>

const press = async (view: View, key: string, times = 1) => {
  for (let i = 0; i < times; i++) {
    view.stdin.write(key)
    await tick()
  }
}

function mount(screen: 'review' | 'translate', overrides: Partial<TuiCommands> = {}) {
  return render(
    <CommandsProvider value={fakeCommands(overrides)}>
      {screen === 'review' ? <Review cwd={cwd} onBack={() => undefined} /> : <Translate cwd={cwd} onBack={() => undefined} />}
    </CommandsProvider>,
  )
}

// The picker opens on '..', then a.po, then b.po.
async function pick(view: View, which: 'a' | 'b', startLabel: RegExp) {
  await waitForText(view.lastFrame, 'b.po')
  await press(view, keys.down, which === 'a' ? 1 : 2)
  view.stdin.write(keys.enter)
  await waitForText(() => flat(view.lastFrame()), startLabel)
}

const reviewDone: ReviewFile = async (opts) => {
  opts.onProgress?.({ type: 'start', file: opts.file, total: 1, reviewable: 1 })
  opts.onProgress?.({ type: 'done', summary: reviewSummaryOf(opts.file) })
  return reviewSummaryOf(opts.file)
}

describe('Review with a configured locale', () => {
  it('has no locale field and opens on the first option', async () => {
    const view = mount('review')
    await pick(view, 'a', /Start review/)
    const frame = flat(view.lastFrame())
    expect(frame).not.toContain('Locale:')
    expect(frame).toMatch(/❯ Batch size/)
  })

  it('runs in the configured locale', async () => {
    const reviewFile = vi.fn<ReviewFile>(reviewDone)
    const view = mount('review', { reviewFile })
    await pick(view, 'a', /Start review/)
    await press(view, keys.down, 3)
    view.stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length === 1)
    expect(reviewFile.mock.calls[0]?.[0]).toMatchObject({ locale: 'tr' })
  })

  it('says when the file names another locale, and how to change it', async () => {
    const view = mount('review')
    await pick(view, 'b', /Start review/)
    await waitForText(() => flat(view.lastFrame()), "The file's Language header says nl_NL. Press l to change the locale.")
  })

  it('says it for Antigravity too, which runs in the configured locale', async () => {
    saveConfig({ reviewProvider: 'antigravity' })
    const view = mount('review')
    await pick(view, 'b', /Start review/)
    await waitForText(() => flat(view.lastFrame()), "The file's Language header says nl_NL.")
  })

  it('stays quiet when the file names the configured locale', async () => {
    const view = mount('review')
    await pick(view, 'a', /Start review/)
    await tick(50)
    expect(flat(view.lastFrame())).not.toContain('Language header')
  })
})

describe('Translate with a configured locale', () => {
  it('has no locale field, and the cursor goes from the engine to the batch size', async () => {
    const view = mount('translate')
    await pick(view, 'a', /Start translation/)
    expect(flat(view.lastFrame())).not.toContain('Locale:')
    await press(view, keys.down, 2)
    expect(flat(view.lastFrame())).toMatch(/❯ Batch size/)
  })

  it('runs in the configured locale', async () => {
    const translateFile = vi.fn(async (opts: { file: string }) => summaryOf(opts.file))
    const view = mount('translate', { translateFile } as Partial<TuiCommands>)
    await pick(view, 'a', /Start translation/)
    await press(view, keys.down, 4)
    view.stdin.write(keys.enter)
    await waitFor(() => translateFile.mock.calls.length === 1)
    expect(translateFile.mock.calls[0]?.[0]).toMatchObject({ locale: 'tr' })
  })

  it('says when the file names another locale', async () => {
    const view = mount('translate')
    await pick(view, 'b', /Start translation/)
    await waitForText(() => flat(view.lastFrame()), "The file's Language header says nl_NL. Press l to change the locale.")
  })
})

describe('the local batch with a configured locale', () => {
  it('has no locale field and runs every file in the configured locale', async () => {
    const reviewFile = vi.fn<ReviewFile>(async (opts) => reviewSummaryOf(opts.file))
    const view = mount('review', { reviewFile })
    await waitForText(view.lastFrame, 'b.po')
    await press(view, '*')
    await press(view, keys.down)
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Parallel/)
    expect(flat(view.lastFrame())).not.toContain('Locale:')
    expect(flat(view.lastFrame())).toMatch(/❯ Parallel/)
    await press(view, keys.down, 4)
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /2 done/)
    expect(reviewFile.mock.calls.map((c) => c[0].locale)).toEqual(['tr', 'tr'])
  })
})

describe('SyncGlossary with a configured locale', () => {
  it('has no locale field and syncs the configured locale on enter', async () => {
    const commands = fakeCommands()
    const view = render(
      <CommandsProvider value={commands}>
        <SyncGlossary onBack={() => undefined} />
      </CommandsProvider>,
    )
    await waitForText(view.lastFrame, 'enter to sync')
    expect(flat(view.lastFrame())).not.toContain('Locale:')
    view.stdin.write('x')
    await tick()
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'Synced 42 glossary entries for tr.')
    expect(vi.mocked(commands.syncGlossary).mock.calls[0]![0]).toMatchObject({ locale: 'tr' })
  })
})
