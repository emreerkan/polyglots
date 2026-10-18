import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import React from 'react'
import { saveConfig } from '../../src/config.js'
import type { TranslateOptions } from '../../src/commands/translate.js'
import { CommandsProvider, type ReviewFile } from '../../src/tui/commands.js'
import { Review } from '../../src/tui/screens/Review.js'
import { Translate } from '../../src/tui/screens/Translate.js'
import { cleanup, fakeCommands, flat, keys, makeHome, render, reviewSummaryOf, summaryOf, tick, waitFor, waitForText, type Home } from './helpers.js'

// A run started from the app reads config debug, as the CLI does, and the
// notice reviewFile and translateFile give through onWarn lands on the screen
// rather than on stderr under Ink's frame.

let home: Home
let root: string

beforeEach(async () => {
  home = await makeHome()
  root = join(home.path, 'root')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'a.po'), ['msgid ""', 'msgstr ""', '"Language: tr\\n"', '', 'msgid "A"', 'msgstr ""', ''].join('\n'))
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

async function pickFile(view: View) {
  await waitForText(view.lastFrame, 'a.po')
  await press(view, keys.down)
  view.stdin.write(keys.enter)
  await waitForText(view.lastFrame, /Start (review|translation)/)
}

const NOTICE = 'Debug mode: prompts and agent output are saved in /logs/run7'

describe('debug mode in the app', () => {
  it('passes config debug to a review and shows its notice', async () => {
    saveConfig({ defaultLocale: 'tr', debug: true })
    const reviewFile = vi.fn<ReviewFile>(async (opts) => {
      opts.onWarn?.(NOTICE)
      opts.onProgress?.({ type: 'start', file: opts.file, total: 1, reviewable: 1 })
      opts.onProgress?.({ type: 'done', summary: reviewSummaryOf(opts.file) })
      return reviewSummaryOf(opts.file)
    })
    const view = render(
      <CommandsProvider value={fakeCommands({ reviewFile })}>
        <Review cwd={root} onBack={() => undefined} />
      </CommandsProvider>,
    )
    await pickFile(view)
    await press(view, keys.down, 3)
    view.stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length === 1)
    expect(reviewFile.mock.calls[0]?.[0]).toMatchObject({ debug: true })
    await waitForText(() => flat(view.lastFrame()), NOTICE)
  })

  // A batch of files runs through BatchRun, which reads config debug on its
  // own and keeps the last three notices under the file list: one per file
  // would push the files off the screen on a large batch.
  it('passes config debug to every file of a batch and shows the last notices', async () => {
    saveConfig({ defaultLocale: 'tr', debug: true })
    await writeFile(join(root, 'b.po'), ['msgid ""', 'msgstr ""', '"Language: tr\\n"', '', 'msgid "B"', 'msgstr ""', ''].join('\n'))
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let n = 0
    const reviewFile = vi.fn<ReviewFile>(async (opts) => {
      // Two notices a file, four in all, so the first falls off the three kept.
      for (let i = 0; i < 2; i++) opts.onWarn?.(`Debug mode: prompts and agent output are saved in /logs/run${++n}`)
      await held
      return reviewSummaryOf(opts.file)
    })
    const view = render(
      <CommandsProvider value={fakeCommands({ reviewFile })}>
        <Review cwd={root} onBack={() => undefined} />
      </CommandsProvider>,
    )
    await waitForText(view.lastFrame, 'a.po')
    await press(view, '*')
    await press(view, keys.down)
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Parallel/)
    // The locale is fixed, so the cursor starts on parallel: up to 2 so both
    // files run at once, then down to start.
    await press(view, keys.right, 1)
    await press(view, keys.down, 4)
    view.stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length === 2)
    expect(reviewFile.mock.calls.map((c) => c[0].debug)).toEqual([true, true])
    await waitForText(() => flat(view.lastFrame()), '/logs/run4')
    const frame = flat(view.lastFrame())
    expect(frame).toContain('/logs/run2')
    expect(frame).toContain('/logs/run3')
    expect(frame).not.toContain('/logs/run1')
    release()
  })

  it('passes debug: false to a translation when it is off, and shows a notice it is given', async () => {
    saveConfig({ defaultLocale: 'tr' })
    const translateFile = vi.fn(async (opts: TranslateOptions) => {
      opts.onWarn?.(NOTICE)
      const summary = summaryOf(opts.file)
      opts.onProgress?.({ type: 'start', file: opts.file, total: summary.total, pending: summary.pending })
      opts.onProgress?.({ type: 'done', summary })
      return summary
    })
    const view = render(
      <CommandsProvider value={fakeCommands({ translateFile })}>
        <Translate cwd={root} onBack={() => undefined} />
      </CommandsProvider>,
    )
    await pickFile(view)
    await press(view, keys.down, 4)
    view.stdin.write(keys.enter)
    await waitFor(() => translateFile.mock.calls.length === 1)
    expect(translateFile.mock.calls[0]?.[0]).toMatchObject({ debug: false })
    await waitForText(() => flat(view.lastFrame()), NOTICE)
  })
})
