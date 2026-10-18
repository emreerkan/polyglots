import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import React from 'react'
import { saveConfig } from '../../src/config.js'
import { templateFile } from '../../src/reply/templates.js'
import type { TranslateOptions } from '../../src/commands/translate.js'
import { CommandsProvider, type ReviewFile } from '../../src/tui/commands.js'
import { Review } from '../../src/tui/screens/Review.js'
import { Translate } from '../../src/tui/screens/Translate.js'
import { footerKeys } from '../../src/tui/keys.js'
import { cleanup, fakeCommands, flat, keys, makeHome, render, reviewSummaryOf, summaryOf, tick, waitFor, waitForText, type Home } from './helpers.js'

// `a` on a finished or stopped run: the picker opens in the folder of the file
// just done, and the pick goes straight to the options with the last run's
// choices filled in and the cursor on Start.

let home: Home
let root: string
let folder: string

const header = (language: string) =>
  ['msgid ""', 'msgstr ""', '"Content-Type: text/plain; charset=UTF-8\\n"', `"Language: ${language}\\n"`, '', 'msgid "A"', 'msgstr ""', ''].join('\n')

beforeEach(async () => {
  home = await makeHome()
  // The screen opens in root, and the files live one folder down, so a picker
  // that reopened at the screen's cwd rather than the file's folder shows.
  root = join(home.path, 'root')
  folder = join(root, 'fr')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'a.po'), header('sv_SE'))
  await writeFile(join(folder, 'b.po'), header('fi'))
  // Newest first is the default sort: a.po leads, b.po follows.
  await utimes(join(folder, 'a.po'), new Date(2026, 1, 2), new Date(2026, 1, 2))
  await utimes(join(folder, 'b.po'), new Date(2026, 1, 1), new Date(2026, 1, 1))
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

// From the screen's own cwd: into fr/, then the first file.
async function pickFirst(view: View) {
  await waitForText(view.lastFrame, 'fr/')
  await press(view, keys.down)
  view.stdin.write(keys.enter)
  await waitForText(view.lastFrame, 'a.po')
  await press(view, keys.down)
  view.stdin.write(keys.enter)
  await waitForText(view.lastFrame, /Start (review|translation)/)
}

// After `a`: the picker is already in fr/, and b.po is the second file.
async function pickSecond(view: View) {
  await waitForText(view.lastFrame, 'b.po')
  expect(flat(view.lastFrame())).toContain(`Browsing ${folder}`)
  await press(view, keys.down, 2)
  view.stdin.write(keys.enter)
  await waitForText(view.lastFrame, /Start (review|translation)/)
}

const reviewDone: ReviewFile = async (opts) => {
  opts.onProgress?.({ type: 'start', file: opts.file, total: 1, reviewable: 1 })
  opts.onProgress?.({ type: 'done', summary: reviewSummaryOf(opts.file) })
  return reviewSummaryOf(opts.file)
}

function renderReview(reviewFile: ReviewFile) {
  return render(
    <CommandsProvider value={fakeCommands({ reviewFile })}>
      <Review cwd={root} onBack={() => undefined} />
    </CommandsProvider>,
  )
}

describe('another file after a review', () => {
  it('opens the picker in the folder of the file just done and carries the preferences, not start over', async () => {
    saveConfig({ defaultLocale: 'tr' })
    const reviewFile = vi.fn<ReviewFile>(reviewDone)
    const view = renderReview(reviewFile)
    await pickFirst(view)

    // With the locale configured the cursor starts on the batch size.
    await press(view, keys.right)
    await waitForText(() => flat(view.lastFrame()), /Batch size:\s*50/)
    await press(view, keys.down) // skip AI
    await press(view, ' ')
    await press(view, keys.down) // start over
    await press(view, ' ')
    await waitForText(() => flat(view.lastFrame()), /Start over:\s*yes/)
    await press(view, keys.down)
    view.stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length === 1)
    await waitForText(() => flat(view.lastFrame()), 'a another file')

    view.stdin.write('a')
    await pickSecond(view)
    const frame = flat(view.lastFrame())
    expect(frame).toContain('Review b.po')
    expect(frame).toMatch(/Batch size:\s*50/)
    expect(frame).toMatch(/Skip AI checks:\s*yes/)
    expect(frame).toMatch(/Start over:\s*no/)
    expect(frame).toContain('❯ Start review')

    // One enter, because the cursor is already on Start.
    view.stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length === 2)
    expect(reviewFile.mock.calls[1]?.[0]).toMatchObject({
      file: join(folder, 'b.po'),
      locale: 'tr',
      batchSize: 50,
      noAi: true,
      fresh: false,
    })
  })

  // A reply greets the requester by name, and the next file in a folder of
  // submissions is usually someone else's.
  it('clears the requester for the next file', async () => {
    saveConfig({ defaultLocale: 'tr' })
    const file = templateFile('tr', 'approved')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'Hello @{username}.')
    const reviewFile = vi.fn<ReviewFile>(reviewDone)
    const view = renderReview(reviewFile)
    await pickFirst(view)
    // The cursor starts on the requester, the first field with the locale hidden.
    view.stdin.write('ayse')
    await waitForText(() => flat(view.lastFrame()), /Requester:\s*ayse/)
    await press(view, keys.down, 4)
    view.stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length === 1)
    await waitForText(() => flat(view.lastFrame()), 'a another file')

    view.stdin.write('a')
    await pickSecond(view)
    const frame = flat(view.lastFrame())
    expect(frame).not.toContain('ayse')
    expect(frame).toContain('optional, fills {username} in the reply')
    expect(frame).toContain('❯ Start review')
  })

  it("reads the next file's Language header again when the locale came from a header", async () => {
    const reviewFile = vi.fn<ReviewFile>(reviewDone)
    const view = renderReview(reviewFile)
    await pickFirst(view)
    await waitForText(() => flat(view.lastFrame()), /Locale: +sv\b/)
    await press(view, keys.down, 4)
    view.stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length === 1)
    expect(reviewFile.mock.calls[0]?.[0]).toMatchObject({ locale: 'sv' })
    await waitForText(() => flat(view.lastFrame()), 'a another file')

    view.stdin.write('a')
    await pickSecond(view)
    await waitForText(() => flat(view.lastFrame()), /Locale: +fi\b/)
    view.stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length === 2)
    expect(reviewFile.mock.calls[1]?.[0]).toMatchObject({ file: join(folder, 'b.po'), locale: 'fi' })
  })

  it('carries a locale the person typed over the next file\'s header', async () => {
    // A first file with no header, so the field starts empty and is typed into.
    await writeFile(join(folder, 'a.po'), header('').replace(/"Language: \\n"\n/, ''))
    await utimes(join(folder, 'a.po'), new Date(2026, 1, 2), new Date(2026, 1, 2))
    const reviewFile = vi.fn<ReviewFile>(reviewDone)
    const view = renderReview(reviewFile)
    await pickFirst(view)
    view.stdin.write('pt_BR')
    await waitForText(() => flat(view.lastFrame()), /Locale: +pt_BR/)
    await press(view, keys.down, 4)
    view.stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length === 1)
    await waitForText(() => flat(view.lastFrame()), 'a another file')

    view.stdin.write('a')
    await pickSecond(view)
    // Give the header read time to land, so a carry that lost to it shows.
    await tick(50)
    const carried = reviewFile.mock.calls[0]?.[0].locale
    expect(flat(view.lastFrame())).toContain(`Locale: ${carried}`)
    expect(flat(view.lastFrame())).not.toMatch(/Locale: +fi\b/)
    view.stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length === 2)
    expect(reviewFile.mock.calls[1]?.[0]).toMatchObject({ file: join(folder, 'b.po'), locale: carried })
    expect(carried).toMatch(/^pt/)
  })

  // The configured locale is not a field, so nothing can be carried: the next
  // file runs in it again, and says so when its header names another language.
  it('runs the next file in the configured locale again, and says when its header disagrees', async () => {
    saveConfig({ defaultLocale: 'tr' })
    const reviewFile = vi.fn<ReviewFile>(reviewDone)
    const view = renderReview(reviewFile)
    await pickFirst(view)
    await press(view, keys.down, 3)
    view.stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length === 1)
    await waitForText(() => flat(view.lastFrame()), 'a another file')
    view.stdin.write('a')
    await pickSecond(view)
    await waitForText(() => flat(view.lastFrame()), "The file's Language header says fi. Press l to change the locale.")
    expect(flat(view.lastFrame())).not.toContain('Locale:')
    view.stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length === 2)
    expect(reviewFile.mock.calls[1]?.[0]).toMatchObject({ file: join(folder, 'b.po'), locale: 'tr' })
  })

  // Stopping to look at the output and moving on is ordinary use, so a run
  // ended with q offers the next file the same as one that finished.
  it('offers another file after a stopped run', async () => {
    saveConfig({ defaultLocale: 'tr' })
    const reviewFile = vi.fn<ReviewFile>(async (opts) => {
      opts.onProgress?.({ type: 'start', file: opts.file, total: 200, reviewable: 200 })
      if (reviewFile.mock.calls.length > 1) return reviewSummaryOf(opts.file)
      opts.onProgress?.({ type: 'batch-start', index: 1, of: 2, size: 100, at: Date.now() })
      // Ends the way a real run does on q: after the batch in flight.
      await new Promise<void>((resolve) => {
        const off = opts.control?.subscribe((state) => {
          if (state === 'stopping') {
            off?.()
            resolve()
          }
        })
      })
      const summary = reviewSummaryOf(opts.file, { unreviewed: 100 })
      opts.onProgress?.({ type: 'done', summary })
      return summary
    })
    const view = renderReview(reviewFile)
    await pickFirst(view)
    await press(view, keys.right) // batch, where the cursor starts
    await press(view, keys.down, 3)
    view.stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length === 1)
    view.stdin.write('q')
    await waitForText(() => flat(view.lastFrame()), 'a another file')

    view.stdin.write('a')
    await pickSecond(view)
    expect(flat(view.lastFrame())).toMatch(/Batch size:\s*50/)
    view.stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length === 2)
    expect(reviewFile.mock.calls[1]?.[0]).toMatchObject({ file: join(folder, 'b.po'), batchSize: 50 })
  })

  it('does not answer a while the run is going', async () => {
    saveConfig({ defaultLocale: 'tr' })
    const reviewFile = vi.fn<ReviewFile>(async () => new Promise<never>(() => {}))
    const view = renderReview(reviewFile)
    await pickFirst(view)
    await press(view, keys.down, 3)
    view.stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length === 1)
    view.stdin.write('a')
    await tick(20)
    expect(flat(view.lastFrame())).not.toContain('Browsing')
  })
})

describe('another file after a translation', () => {
  it('carries the engine and batch size, and resets the mode and start over', async () => {
    saveConfig({ defaultLocale: 'tr' })
    const translateFile = vi.fn(async (opts: TranslateOptions) => {
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
    await pickFirst(view)
    await press(view, keys.right) // mode: all
    await waitForText(() => flat(view.lastFrame()), /Mode:\s*all/)
    await press(view, keys.down) // engine
    await press(view, keys.right) // deepl -> openai
    await waitForText(() => flat(view.lastFrame()), /Draft engine:\s*openai/)
    await press(view, keys.down) // batch
    await press(view, keys.right)
    await waitForText(() => flat(view.lastFrame()), /Batch size:\s*50/)
    await press(view, keys.down) // start over
    await press(view, keys.right)
    await waitForText(() => flat(view.lastFrame()), /Start over:\s*yes/)
    await press(view, keys.down)
    view.stdin.write(keys.enter)
    await waitFor(() => translateFile.mock.calls.length === 1)
    expect(translateFile.mock.calls[0]?.[0]).toMatchObject({ fresh: true })
    await waitForText(() => flat(view.lastFrame()), 'a another file')

    view.stdin.write('a')
    await pickSecond(view)
    const frame = flat(view.lastFrame())
    expect(frame).toContain('Translate b.po')
    expect(frame).toMatch(/Mode:\s*pending only/)
    expect(frame).toMatch(/Draft engine:\s*openai/)
    expect(frame).toMatch(/Batch size:\s*50/)
    expect(frame).toMatch(/Start over:\s*no/)
    expect(frame).toContain('❯ Start translation')
    view.stdin.write(keys.enter)
    await waitFor(() => translateFile.mock.calls.length === 2)
    expect(translateFile.mock.calls[1]?.[0]).not.toHaveProperty('fresh')
    expect(translateFile.mock.calls[1]?.[0]).toMatchObject({
      file: join(folder, 'b.po'),
      mode: 'pending',
      draftEngine: 'openai',
      batchSize: 50,
      locale: 'tr',
    })
  })
})

const noHeader = async () => {
  // A first file with no Language header, so the field starts empty and is typed into.
  await writeFile(join(folder, 'a.po'), header('').replace(/"Language: \\n"\n/, ''))
  await utimes(join(folder, 'a.po'), new Date(2026, 1, 2), new Date(2026, 1, 2))
}

const translateDone = async (opts: TranslateOptions) => {
  const summary = summaryOf(opts.file)
  opts.onProgress?.({ type: 'start', file: opts.file, total: summary.total, pending: summary.pending })
  opts.onProgress?.({ type: 'done', summary })
  return summary
}

function renderTranslate(translateFile: (opts: TranslateOptions) => Promise<ReturnType<typeof summaryOf>>) {
  return render(
    <CommandsProvider value={fakeCommands({ translateFile })}>
      <Translate cwd={root} onBack={() => undefined} />
    </CommandsProvider>,
  )
}

// Translate keeps its own copy of the carry, so each case the review side
// covers is run here too rather than assumed.
describe('another file after a translation, the locale and a stop', () => {
  it("reads the next file's Language header again when the locale came from a header", async () => {
    const translateFile = vi.fn(translateDone)
    const view = renderTranslate(translateFile)
    await pickFirst(view)
    await waitForText(() => flat(view.lastFrame()), /Locale: +sv\b/)
    await press(view, keys.down, 5)
    view.stdin.write(keys.enter)
    await waitFor(() => translateFile.mock.calls.length === 1)
    expect(translateFile.mock.calls[0]?.[0]).toMatchObject({ locale: 'sv' })
    await waitForText(() => flat(view.lastFrame()), 'a another file')

    view.stdin.write('a')
    await pickSecond(view)
    await waitForText(() => flat(view.lastFrame()), /Locale: +fi\b/)
    view.stdin.write(keys.enter)
    await waitFor(() => translateFile.mock.calls.length === 2)
    expect(translateFile.mock.calls[1]?.[0]).toMatchObject({ file: join(folder, 'b.po'), locale: 'fi' })
  })

  it("carries a locale the person typed over the next file's header", async () => {
    await noHeader()
    const translateFile = vi.fn(translateDone)
    const view = renderTranslate(translateFile)
    await pickFirst(view)
    await press(view, keys.down, 2) // locale
    view.stdin.write('pt_BR')
    await waitForText(() => flat(view.lastFrame()), /Locale: +pt_BR/)
    await press(view, keys.down, 3)
    view.stdin.write(keys.enter)
    await waitFor(() => translateFile.mock.calls.length === 1)
    await waitForText(() => flat(view.lastFrame()), 'a another file')

    view.stdin.write('a')
    await pickSecond(view)
    await tick(50)
    const carried = translateFile.mock.calls[0]?.[0].locale
    expect(carried).toMatch(/^pt/)
    expect(flat(view.lastFrame())).toContain(`Locale: ${carried}`)
    view.stdin.write(keys.enter)
    await waitFor(() => translateFile.mock.calls.length === 2)
    expect(translateFile.mock.calls[1]?.[0]).toMatchObject({ file: join(folder, 'b.po'), locale: carried })
  })

  it('offers another file after a stopped run', async () => {
    saveConfig({ defaultLocale: 'tr' })
    const translateFile = vi.fn(async (opts: TranslateOptions) => {
      const summary = summaryOf(opts.file)
      opts.onProgress?.({ type: 'start', file: opts.file, total: summary.total, pending: summary.pending })
      if (translateFile.mock.calls.length > 1) return summary
      await new Promise<void>((resolve) => {
        const off = opts.control?.subscribe((state) => {
          if (state === 'stopping') {
            off?.()
            resolve()
          }
        })
      })
      opts.onProgress?.({ type: 'done', summary })
      return summary
    })
    const view = renderTranslate(translateFile)
    await pickFirst(view)
    await press(view, keys.down) // engine
    await press(view, keys.right)
    await waitForText(() => flat(view.lastFrame()), /Draft engine:\s*openai/)
    await press(view, keys.down, 3)
    view.stdin.write(keys.enter)
    await waitFor(() => translateFile.mock.calls.length === 1)
    view.stdin.write('q')
    await waitForText(() => flat(view.lastFrame()), 'a another file')

    view.stdin.write('a')
    await pickSecond(view)
    expect(flat(view.lastFrame())).toMatch(/Draft engine:\s*openai/)
    view.stdin.write(keys.enter)
    await waitFor(() => translateFile.mock.calls.length === 2)
    expect(translateFile.mock.calls[1]?.[0]).toMatchObject({ file: join(folder, 'b.po'), draftEngine: 'openai', locale: 'tr' })
  })
})

// A carried typed locale wins over the next file's header, by the ruling. The
// cursor sits on Start, so the options screen has to say when the two disagree
// or one enter sends a Finnish catalogue through as Portuguese.
describe('a carried locale that disagrees with the file', () => {
  it('review says what the header names', async () => {
    await noHeader()
    const reviewFile = vi.fn<ReviewFile>(reviewDone)
    const view = renderReview(reviewFile)
    await pickFirst(view)
    view.stdin.write('pt_BR')
    await press(view, keys.down, 4)
    view.stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length === 1)
    await waitForText(() => flat(view.lastFrame()), 'a another file')
    view.stdin.write('a')
    await pickSecond(view)
    await waitForText(() => flat(view.lastFrame()), "The file's Language header says fi.")
  })

  it('translate says what the header names', async () => {
    await noHeader()
    const translateFile = vi.fn(translateDone)
    const view = renderTranslate(translateFile)
    await pickFirst(view)
    await press(view, keys.down, 2)
    view.stdin.write('pt_BR')
    await press(view, keys.down, 3)
    view.stdin.write(keys.enter)
    await waitFor(() => translateFile.mock.calls.length === 1)
    await waitForText(() => flat(view.lastFrame()), 'a another file')
    view.stdin.write('a')
    await pickSecond(view)
    await waitForText(() => flat(view.lastFrame()), "The file's Language header says fi.")
  })

  it('stays quiet when the header and the field agree', async () => {
    const reviewFile = vi.fn<ReviewFile>(reviewDone)
    const view = renderReview(reviewFile)
    await pickFirst(view)
    await waitForText(() => flat(view.lastFrame()), /Locale: +sv\b/)
    await tick(50)
    expect(flat(view.lastFrame())).not.toContain('Language header says')
  })
})

describe('the done footer', () => {
  it.each(['review', 'translate'] as const)('%s lists a for another file and still lists enter', (screen) => {
    const done = footerKeys(screen, false, 'done').map((k) => `${k.keys} ${k.does}`)
    expect(done).toContain('a another file with the same settings')
    expect(done).toContain('enter back to the menu once it is done')
  })
})
