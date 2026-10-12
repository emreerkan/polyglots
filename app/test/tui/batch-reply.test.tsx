import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import React from 'react'
import { saveConfig } from '../../src/config.js'
import { templateFile } from '../../src/reply/templates.js'
import { CommandsProvider, type ReviewFileOptions, type TuiCommands } from '../../src/tui/commands.js'
import { copyToClipboard } from '../../src/tui/clipboard.js'
import { Review } from '../../src/tui/screens/Review.js'
import { cleanup, fakeCommands, flat, keys, makeHome, render, reviewSummaryOf, tick, waitForText, type Home } from './helpers.js'

// The end of a batch of marked files: one reply per file, or one requester
// message per file without a template, shown one at a time and copied with c.

// Never the developer's real clipboard (review.test.tsx says why).
vi.mock('../../src/tui/clipboard.js', () => ({
  copyToClipboard: vi.fn(() => true),
  clipboardCommands: vi.fn(() => []),
}))

let home: Home
let cwd: string

const PO = `msgid ""
msgstr ""
"Language: tr\\n"
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Save"
msgstr "Kaydet"
`

async function template(name: string, text: string) {
  const file = templateFile('tr', name)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}

beforeEach(async () => {
  home = await makeHome()
  saveConfig({ defaultLocale: 'tr' })
  cwd = join(home.path, 'work')
  await mkdir(cwd)
  await writeFile(join(cwd, 'a.po'), PO)
  await writeFile(join(cwd, 'b.po'), PO)
  await utimes(join(cwd, 'a.po'), 5000, 5000)
  await utimes(join(cwd, 'b.po'), 4000, 4000)
  vi.mocked(copyToClipboard).mockClear()
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

// a.po had a repair, b.po was clean, so their replies differ.
const reviewFile = vi.fn(async (opts: ReviewFileOptions) =>
  opts.file.endsWith('a.po')
    ? reviewSummaryOf(opts.file, { repaired: 2, problems: 2, written: 2, byGroup: { glossary: 2 } })
    : reviewSummaryOf(opts.file, { repaired: 0, problems: 0, written: 0, byRule: {}, byGroup: {}, problemsFile: undefined }),
)

function mount(overrides: Partial<TuiCommands> = {}) {
  const commands = fakeCommands({ reviewFile, ...overrides })
  const onBack = vi.fn()
  const view = render(
    <CommandsProvider value={commands}>
      <Review cwd={cwd} onBack={onBack} />
    </CommandsProvider>,
  )
  return { ...view, onBack }
}

type View = ReturnType<typeof mount>

async function press(view: View, ...sequence: string[]) {
  for (const k of sequence) {
    view.stdin.write(k)
    await tick()
  }
}

async function toOptions(view: View) {
  await waitForText(view.lastFrame, 'a.po')
  await press(view, '*', keys.down, keys.enter)
  await waitForText(view.lastFrame, /Parallel/)
}

// Locale → Requester → parallel → batch size → start over → skip AI → start.
async function runWith(view: View, requester: string) {
  await toOptions(view)
  await press(view, keys.down, ...requester.split(''), keys.down, keys.down, keys.down, keys.down, keys.down, keys.enter)
  await waitForText(view.lastFrame, /2 done, 0 failed/)
}

const APPROVED = 'Hello @{username},\n\n{No problems.|I fixed a few.}\n\n{results}\n\nCheers!\n'

describe('batch options with a reply template', () => {
  it('offers a Requester field when the locale has a template', async () => {
    await template('approved', APPROVED)
    const view = mount()
    await toOptions(view)
    expect(flat(view.lastFrame())).toMatch(/Requester:\s+optional, fills \{username\} in every reply/)
  })

  // Both fields are text inputs, and a typed key once went into both.
  it('types into the Requester field alone, leaving the locale as it was', async () => {
    await template('approved', APPROVED)
    const view = mount()
    await toOptions(view)
    await press(view, keys.down, 'a', 'y', 's', 'e')
    const frame = flat(view.lastFrame())
    expect(frame).toMatch(/Requester:\s+ayse/)
    expect(frame).toMatch(/Locale:\s+tr\s+❯ Requester/)
  })

  it('offers no Requester field without a template', async () => {
    const view = mount()
    await toOptions(view)
    expect(flat(view.lastFrame())).not.toContain('Requester')
  })
})

describe('batch replies', () => {
  it('shows one reply at a time, the first file first, with the requester filled in', async () => {
    await template('approved', APPROVED)
    const view = mount()
    await runWith(view, 'ayse')
    const frame = flat(view.lastFrame())
    expect(frame).toContain('Reply 1 of 2 · a.po · approved template')
    expect(frame).toContain('Hello @ayse,')
    expect(frame).toContain('I fixed a few.')
    expect(frame).not.toContain('No problems.')
    expect(frame).not.toContain('Message for the requester')
  })

  it('moves to the next reply with ↓ and back with ↑', async () => {
    await template('approved', APPROVED)
    const view = mount()
    await runWith(view, 'ayse')
    await press(view, keys.down)
    expect(flat(view.lastFrame())).toContain('Reply 2 of 2 · b.po · approved template')
    expect(flat(view.lastFrame())).toContain('No problems.')
    await press(view, keys.up)
    expect(flat(view.lastFrame())).toContain('Reply 1 of 2 · a.po')
  })

  it('copies only the reply it is on with c', async () => {
    await template('approved', APPROVED)
    const view = mount()
    await runWith(view, 'ayse')
    await press(view, keys.down, 'c')
    expect(vi.mocked(copyToClipboard).mock.calls.at(-1)?.[0]).toBe('Hello @ayse,\n\nNo problems.\n\nCheers!')
    expect(flat(view.lastFrame())).toMatch(/Reply copied to the clipboard/)
    // The confirmation belongs to the reply it copied.
    await press(view, keys.up)
    expect(flat(view.lastFrame())).not.toMatch(/copied to the clipboard/)
  })

  it('leaves {username} in every reply when no requester was typed', async () => {
    await template('approved', APPROVED)
    const view = mount()
    await runWith(view, '')
    expect(flat(view.lastFrame())).toContain('Hello @{username},')
  })

  it('switches the template of the reply it is on with t', async () => {
    await template('approved', APPROVED)
    await template('declined', 'Not yet, @{username}.')
    const view = mount()
    await runWith(view, 'ayse')
    await press(view, 't')
    expect(flat(view.lastFrame())).toContain('Reply 1 of 2 · a.po · declined template')
    await press(view, 'c')
    expect(vi.mocked(copyToClipboard).mock.calls.at(-1)?.[0]).toBe('Not yet, @ayse.')
    await press(view, keys.down)
    expect(flat(view.lastFrame())).toContain('b.po · approved template')
  })

  it('shows the requester messages one at a time without a template, and copies the one it is on', async () => {
    const view = mount()
    await toOptions(view)
    await press(view, keys.down, keys.down, keys.down, keys.down, keys.down, keys.enter)
    await waitForText(view.lastFrame, /2 done, 0 failed/)
    // The clean file has no message, so there is only one.
    const frame = flat(view.lastFrame())
    expect(frame).toContain('Message 1 of 1 · a.po')
    expect(frame.match(/I fixed 2 entries/g)?.length).toBe(1)
    await press(view, 'c')
    expect(vi.mocked(copyToClipboard).mock.calls.at(-1)?.[0]).toMatch(/^I fixed 2 entries/)
  })

  it('does not offer another file after a batch', async () => {
    await template('approved', APPROVED)
    const view = mount()
    await runWith(view, '')
    await press(view, 'a')
    await tick(60)
    expect(flat(view.lastFrame())).toContain('2 done, 0 failed')
    expect(flat(view.lastFrame())).not.toContain('another file')
  })
})
