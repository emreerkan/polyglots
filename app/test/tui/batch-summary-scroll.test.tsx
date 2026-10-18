import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { saveConfig } from '../../src/config.js'
import { reviewFile } from '../../src/commands/review.js'
import { templateFile } from '../../src/reply/templates.js'
import { openDb, replaceGlossary } from '../../src/storage/index.js'
import { App } from '../../src/tui/App.js'
import type { ReviewFile, ReviewFileOptions } from '../../src/tui/commands.js'
import { useLocaleFixture } from '../locale-fixture.js'
import { cleanup, fakeCommands, flat, keys, makeHome, openFromHome, render, reviewSummaryOf, tick, waitForText, type Home } from './helpers.js'

// A batch summary on a terminal too short for it. The summary's list has a
// cursor, which the body follows, and following a row turns the page keys off.
// The reply, its caution and "c to copy" are drawn under the list, so with the
// cursor row followed they sat below the window with no key to reach them:
// the reply the locale manager posts to a contributor, unreadable before it is
// copied. These run in the App, since the scrolling is the frame's.

// Never the developer's real clipboard (review.test.tsx says why).
vi.mock('../../src/tui/clipboard.js', () => ({
  copyToClipboard: vi.fn(() => true),
  clipboardCommands: vi.fn(() => []),
}))

const PO = `msgid ""
msgstr ""
"Language: tr\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=2; plural=(n > 1);\\n"

msgid "Open the sidebar"
msgstr "Yan menüyü aç"
`

const SIZE = { columns: 80, rows: 24 }
const FILES = Array.from({ length: 10 }, (_, i) => `f${String(i).padStart(2, '0')}.po`)

let home: Home
let cwd: string

beforeEach(async () => {
  home = await makeHome()
  saveConfig({ defaultLocale: 'tr' })
  cwd = join(home.path, 'work')
  await mkdir(cwd)
  // Newest first in the picker, so f00.po is the first row.
  for (const [i, name] of FILES.entries()) {
    await writeFile(join(cwd, name), PO)
    await utimes(join(cwd, name), 9000 - i, 9000 - i)
  }
  const db = openDb()
  replaceGlossary(db, 'tr', [{ locale: 'tr', sourceTerm: 'sidebar', translation: 'kenar çubuğu', partOfSpeech: 'noun' }])
  db.close()
})

useLocaleFixture('tr_TR.yaml')

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

async function template(name: string, text: string) {
  const file = templateFile('tr', name)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}

const fakeReview = vi.fn(async (opts: ReviewFileOptions) => reviewSummaryOf(opts.file, { repaired: 2, problems: 2, written: 2, byGroup: { glossary: 2 } }))

type View = ReturnType<typeof render>

async function press(view: View, ...sequence: string[]) {
  for (const k of sequence) {
    view.stdin.write(k)
    await tick()
  }
}

const frame = (view: View) => flat(view.lastFrame())

// Every file marked, then Start. With a template the options are locale,
// requester, parallel, batch size, start over, skip AI, start; without one
// there is no requester field.
async function runBatch(view: View, withRequester: boolean) {
  await openFromHome(view.stdin, 'review')
  await waitForText(view.lastFrame, 'f00.po')
  await press(view, '*', keys.down, keys.enter)
  await waitForText(view.lastFrame, /Parallel/)
  await press(view, ...Array.from({ length: withRequester ? 6 : 5 }, () => keys.down), keys.enter)
  await waitForText(() => frame(view), /enter open a file/)
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i + 1} of the reply.`).join('\n')

describe('a batch summary taller than the body', () => {
  it('keeps the reply in view as the cursor moves', async () => {
    await template('approved', `Hello,\n${lines(6)}\nCheers!\n`)
    const view = render(<App commands={fakeCommands({ reviewFile: fakeReview })} cwd={cwd} />, SIZE)
    await runBatch(view, true)
    await waitForText(() => frame(view), 'Cheers!')
    await press(view, keys.down)
    await waitForText(() => frame(view), /Reply 2 of 10 · f01\.po/)
    expect(frame(view)).toContain('Cheers!')
    expect(frame(view)).toContain('c to copy')
    await press(view, keys.up)
    await waitForText(() => frame(view), /Reply 1 of 10 · f00\.po/)
    expect(frame(view)).toContain('Cheers!')
  })

  // A reply taller than the whole body cannot be followed into view at once,
  // so it starts at its top and page down reads the rest of it.
  it('starts a reply taller than the body at its top, and page down reaches its end', async () => {
    await template('approved', `Hello,\n${lines(30)}\nCheers!\n`)
    const view = render(<App commands={fakeCommands({ reviewFile: fakeReview })} cwd={cwd} />, SIZE)
    await runBatch(view, true)
    await waitForText(() => frame(view), /Reply 1 of 10 · f00\.po/)
    expect(frame(view)).not.toContain('Cheers!')
    for (let i = 0; i < 4 && !frame(view).includes('Cheers!'); i++) await press(view, keys.pageDown)
    expect(frame(view)).toContain('Cheers!')
    await press(view, keys.down)
    await waitForText(() => frame(view), /Reply 2 of 10 · f01\.po/)
  })
})

// The offer is a question under the summary, followed into view so it is
// seen. Once the cursor is moved, the cursor is where the reader looks: the
// offer used to be followed still, as the last target drawn, and the row the
// cursor moved to went out of view above it.
describe('a batch summary with the problem report offer', () => {
  it('follows the cursor once it moves, not the offer', async () => {
    saveConfig({ defaultLocale: 'tr', reviewProvider: 'claude' })
    // f09.po gives its batch up, so the batch ends with an offer; the rest
    // run on the rules alone.
    const failingReview: ReviewFile = (opts) =>
      reviewFile({
        ...opts,
        ...(opts.file.endsWith('f09.po')
          ? {
              adjudicate: async () => {
                throw new Error('claude exited with exit code 1')
              },
            }
          : { noAi: true }),
        mcpConfigPath: join(home.path, 'mcp.json'),
      })
    const view = render(<App commands={fakeCommands({ reviewFile: failingReview })} cwd={cwd} />, SIZE)
    await runBatch(view, false)
    await waitForText(() => frame(view), /Send a problem report/)
    for (let i = 0; i < FILES.length; i++) await press(view, keys.up)
    await waitForText(() => frame(view), /❯ f00\.po/)
  })
})
