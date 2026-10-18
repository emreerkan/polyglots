import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import React from 'react'
import { saveConfig } from '../../src/config.js'
import type { TranslateOptions } from '../../src/commands/translate.js'
import { CommandsProvider, type ReviewFileOptions, type TuiCommands } from '../../src/tui/commands.js'
import { Review } from '../../src/tui/screens/Review.js'
import { Translate } from '../../src/tui/screens/Translate.js'
import { GlyphProvider } from '../../src/tui/theme.js'
import { ASCII_GLYPHS, UNICODE_GLYPHS } from '../../src/ui/glyphs.js'
import { cleanup, fakeCommands, flat, keys, makeHome, render, reviewSummaryOf, summaryOf, tick, waitFor, waitForText, type Home } from './helpers.js'

// Several local files marked in the Review and Translate pickers and run as
// one batch, through the same run stage Fetch uses after its downloads.

let home: Home
let cwd: string

const po = (language: string | undefined) => `msgid ""
msgstr ""
"Project-Id-Version: Themes - Koji\\n"
${language === undefined ? '' : `"Language: ${language}\\n"\n`}"MIME-Version: 1.0\\n"
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Save"
msgstr "Kaydet"
`

// Written with spaced mtimes so the picker's newest-first order is the
// test's to know: .., a.po, b.po, a-problems.po, a-repaired.po, more/.
async function files(languages: { a?: string | undefined; b?: string | undefined } = { a: 'tr', b: 'tr' }) {
  const at = (path: string, seconds: number) => utimes(path, seconds, seconds)
  await writeFile(join(cwd, 'a.po'), po('a' in languages ? languages.a : 'tr'))
  await writeFile(join(cwd, 'b.po'), po('b' in languages ? languages.b : 'tr'))
  await writeFile(join(cwd, 'a-problems.po'), po('tr'))
  await writeFile(join(cwd, 'a-repaired.po'), po('tr'))
  await mkdir(join(cwd, 'more'))
  await writeFile(join(cwd, 'more', 'd.po'), po('tr'))
  await at(join(cwd, 'a.po'), 5000)
  await at(join(cwd, 'b.po'), 4000)
  await at(join(cwd, 'a-problems.po'), 3000)
  await at(join(cwd, 'a-repaired.po'), 2000)
}

// saveConfig merges, so no locale is written over the file instead.
async function noLocale() {
  await mkdir(join(home.path, 'config'), { recursive: true })
  await writeFile(join(home.path, 'config', 'config.json'), '{}')
}

beforeEach(async () => {
  home = await makeHome()
  saveConfig({ defaultLocale: 'tr' })
  cwd = join(home.path, 'work')
  await mkdir(cwd)
  await files()
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

function mount(screen: 'review' | 'translate', overrides: Partial<TuiCommands> = {}, glyphs = UNICODE_GLYPHS) {
  const commands = fakeCommands(overrides)
  const onBack = vi.fn()
  const view = render(
    <GlyphProvider value={glyphs}>
      <CommandsProvider value={commands}>
        {screen === 'review' ? <Review cwd={cwd} onBack={onBack} /> : <Translate cwd={cwd} onBack={onBack} />}
      </CommandsProvider>
    </GlyphProvider>,
  )
  return { ...view, commands, onBack }
}

type View = ReturnType<typeof mount>

async function press(view: View, ...sequence: string[]) {
  for (const k of sequence) {
    view.stdin.write(k)
    await tick()
  }
}

const reviewing = () =>
  vi.fn(async (opts: ReviewFileOptions) => {
    return reviewSummaryOf(opts.file)
  })

describe('marking files in the picker', () => {
  it('marks the highlighted file with space and counts it', async () => {
    const view = mount('review')
    await waitForText(view.lastFrame, 'a.po')
    await press(view, keys.down, ' ')
    await waitForText(view.lastFrame, /1 file marked/)
    expect(view.lastFrame()).toMatch(/• a\.po/)
    expect(view.lastFrame()).not.toMatch(/• b\.po/)
  })

  it('unmarks it with space again, so a file is never marked twice', async () => {
    const view = mount('review')
    await waitForText(view.lastFrame, 'a.po')
    await press(view, keys.down, ' ')
    await waitForText(view.lastFrame, /1 file marked/)
    await press(view, ' ')
    await waitFor(() => !/marked/.test(view.lastFrame()))
    expect(view.lastFrame()).not.toMatch(/• a\.po/)
  })

  it('draws the ASCII bullet on a terminal that cannot draw the other', async () => {
    const view = mount('review', {}, ASCII_GLYPHS)
    await waitForText(view.lastFrame, 'a.po')
    await press(view, keys.down, ' ')
    await waitForText(view.lastFrame, /1 file marked/)
    expect(view.lastFrame()).toMatch(/\* a\.po/)
  })

  // Reviewing a problems file is reviewing the review.
  it.each([
    ['a-problems.po', 3],
    ['a-repaired.po', 4],
  ])('refuses to mark %s, a review output, and says why', async (name, steps) => {
    const view = mount('review')
    await waitForText(view.lastFrame, 'a.po')
    await press(view, ...Array<string>(steps).fill(keys.down), ' ')
    await waitForText(view.lastFrame, /output of a review/)
    expect(flat(view.lastFrame())).toContain(name)
    expect(view.lastFrame()).not.toMatch(/marked/)
  })

  it('marks every eligible file in the folder with *, and unmarks them with * again', async () => {
    const view = mount('review')
    await waitForText(view.lastFrame, 'a.po')
    await press(view, '*')
    await waitForText(view.lastFrame, /2 files marked/)
    expect(view.lastFrame()).toMatch(/• a\.po/)
    expect(view.lastFrame()).toMatch(/• b\.po/)
    expect(view.lastFrame()).not.toMatch(/• a-problems\.po/)
    await press(view, '*')
    await waitFor(() => !/marked/.test(view.lastFrame()))
  })

  it('keeps the marks when moving to another folder', async () => {
    const view = mount('review')
    await waitForText(view.lastFrame, 'a.po')
    await press(view, keys.down, ' ')
    await waitForText(view.lastFrame, /1 file marked/)
    // .., a.po, b.po, a-problems.po, a-repaired.po, more/
    await press(view, keys.down, keys.down, keys.down, keys.down, keys.enter)
    await waitForText(view.lastFrame, 'd.po')
    await press(view, keys.down, ' ')
    await waitForText(view.lastFrame, /2 files marked/)
  })

  it('opens the single-file options when enter is pressed with nothing marked', async () => {
    const view = mount('review')
    await waitForText(view.lastFrame, 'a.po')
    await press(view, keys.down, keys.enter)
    await waitForText(view.lastFrame, /Start review/)
    expect(view.lastFrame()).not.toMatch(/Parallel/)
  })
})

describe('the batch options', () => {
  // Enter on a folder still opens it with files marked, since marks span
  // folders; so the cursor goes to a file first. The picker opens on '..'.
  async function toOptions(view: View) {
    await waitForText(view.lastFrame, 'a.po')
    await press(view, '*', keys.down, keys.enter)
    await waitForText(view.lastFrame, /Parallel/)
  }

  it('lists the marked files before Start, with the batch fields', async () => {
    const view = mount('review')
    await toOptions(view)
    const frame = flat(view.lastFrame())
    expect(frame).toMatch(/• a\.po/)
    expect(frame).toMatch(/• b\.po/)
    expect(frame).toMatch(/Skip AI/)
    expect(frame).toMatch(/Start over/)
    expect(frame).toMatch(/Review 2 files/)
  })

  it('shows "per file" for the locale when none is typed', async () => {
    await noLocale()
    const view = mount('review')
    await toOptions(view)
    expect(view.lastFrame()).toMatch(/Locale:\s+per file/)
  })

  it('offers the draft engine on translate', async () => {
    const view = mount('translate')
    await toOptions(view)
    const frame = flat(view.lastFrame())
    expect(frame).toMatch(/Draft engine/)
    expect(frame).toMatch(/Translate 2 files/)
  })

  it('goes back to the picker on escape, with the marks kept', async () => {
    const view = mount('review')
    await toOptions(view)
    await press(view, keys.esc)
    await tick(60)
    await waitForText(view.lastFrame, /2 files marked/)
    expect(view.onBack).not.toHaveBeenCalled()
  })
})

describe('the batch run', () => {
  // Parallel → batch size → start over → skip AI → start, the locale being fixed.
  it('reviews every marked file with the options chosen and lists how each ended', async () => {
    const reviewFile = reviewing()
    const view = mount('review', { reviewFile })
    await waitForText(view.lastFrame, 'a.po')
    await press(view, '*', keys.down, keys.enter)
    await waitForText(view.lastFrame, /Parallel/)
    await press(view, keys.right, keys.down, keys.down, ' ', keys.down, keys.down, keys.enter)
    await waitForText(view.lastFrame, /2 done, 0 failed, 0 skipped/)
    const calls = reviewFile.mock.calls.map((c) => c[0])
    expect(calls.map((c) => c.file)).toEqual([join(cwd, 'a.po'), join(cwd, 'b.po')])
    expect(calls[0]).toMatchObject({ fresh: true, locale: 'tr' })
    expect(calls[0]!.db).toBeDefined()
    expect(calls[0]!.db).toBe(calls[1]!.db)
    expect(calls[0]!.control).toBe(calls[1]!.control)
    // One message per file, each for its own contributor, shown one at a time.
    expect(flat(view.lastFrame())).toContain('Message 1 of 2 · a.po')
    await press(view, keys.down)
    expect(flat(view.lastFrame())).toContain('Message 2 of 2 · b.po')
  })

  it('runs each file in the locale its header names when none is typed', async () => {
    await noLocale()
    await writeFile(join(cwd, 'b.po'), po('ja'))
    await utimes(join(cwd, 'b.po'), 4000, 4000)
    const reviewFile = reviewing()
    const view = mount('review', { reviewFile })
    await waitForText(view.lastFrame, 'a.po')
    await press(view, '*', keys.down, keys.enter)
    await waitForText(view.lastFrame, /per file/)
    await press(view, keys.down, keys.down, keys.down, keys.down, keys.down, keys.enter)
    await waitForText(view.lastFrame, /2 done/)
    expect(reviewFile.mock.calls.map((c) => [c[0].file, c[0].locale])).toEqual([
      [join(cwd, 'a.po'), 'tr'],
      [join(cwd, 'b.po'), 'ja'],
    ])
  })

  it('fails a file whose header names no locale, and runs the rest', async () => {
    await noLocale()
    await writeFile(join(cwd, 'b.po'), po(undefined))
    await utimes(join(cwd, 'b.po'), 4000, 4000)
    const reviewFile = reviewing()
    const view = mount('review', { reviewFile })
    await waitForText(view.lastFrame, 'a.po')
    await press(view, '*', keys.down, keys.enter)
    await waitForText(view.lastFrame, /per file/)
    await press(view, keys.down, keys.down, keys.down, keys.down, keys.down, keys.enter)
    await waitForText(view.lastFrame, /1 done, 1 failed/)
    expect(flat(view.lastFrame())).toMatch(/b\.po failed .*No locale set/)
    expect(reviewFile).toHaveBeenCalledTimes(1)
  })

  // Parallel → batch size → draft engine → start over → start, the locale being fixed.
  it('translates every marked file in pending mode with the chosen engine', async () => {
    const calls: TranslateOptions[] = []
    const view = mount('translate', {
      translateFile: vi.fn(async (opts: TranslateOptions) => {
        calls.push(opts)
        return summaryOf(opts.file)
      }),
    })
    await waitForText(view.lastFrame, 'a.po')
    await press(view, '*', keys.down, keys.enter)
    await waitForText(view.lastFrame, /Parallel/)
    await press(view, keys.down, keys.down, keys.right, keys.down, keys.down, keys.enter)
    await waitForText(view.lastFrame, /2 done/)
    expect(calls.map((c) => c.file)).toEqual([join(cwd, 'a.po'), join(cwd, 'b.po')])
    expect(calls[0]).toMatchObject({ mode: 'pending', draftEngine: 'openai', locale: 'tr' })
  })
})
