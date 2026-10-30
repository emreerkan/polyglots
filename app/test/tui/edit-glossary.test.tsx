import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { saveConfig } from '../../src/config.js'
import { App } from '../../src/tui/App.js'
import type { GlossaryEditorOptions, GlossaryEditorServer } from '../../src/glossary/editor/server.js'
import { cleanup, fakeCommands, flat, makeHome, openFromHome, render, tick, waitFor, waitForText, type Home } from './helpers.js'

let home: Home

beforeEach(async () => {
  home = await makeHome()
  saveConfig({ defaultLocale: 'tr' })
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

// A server that is up until the test ends it, the way the page's close or
// the idle wait would.
function fakeEditor() {
  let finish!: () => void
  const close = vi.fn(async () => finish())
  const starts: GlossaryEditorOptions[] = []
  const startGlossaryEditor = vi.fn(async (opts: GlossaryEditorOptions): Promise<GlossaryEditorServer> => {
    starts.push(opts)
    const done = new Promise<void>((resolve) => (finish = resolve))
    return { url: 'http://127.0.0.1:4555/g10ss/', port: 4555, done, close }
  })
  return { startGlossaryEditor, close, starts, end: () => finish() }
}

async function open(commands = fakeCommands()) {
  const view = render(<App commands={commands} cwd={home.path} />)
  await tick()
  await openFromHome(view.stdin, 'edit-glossary')
  await waitForText(view.lastFrame, 'Edit glossary')
  return view
}

describe('the glossary editor screen', () => {
  it('starts the editor on the configured locale and shows where it is', async () => {
    const editor = fakeEditor()
    const view = await open(fakeCommands({ startGlossaryEditor: editor.startGlossaryEditor }))
    await waitForText(view.lastFrame, 'http://127.0.0.1:4555/g10ss/')
    expect(editor.starts.map((o) => o.source)).toEqual([{ kind: 'db', locale: 'tr' }])
    expect(flat(view.lastFrame())).toContain('polyglots, tr')
  })

  it('opens the browser on entry, and again on o', async () => {
    const openInBrowser = vi.fn(async () => true)
    const editor = fakeEditor()
    const view = await open(fakeCommands({ startGlossaryEditor: editor.startGlossaryEditor, openInBrowser }))
    await waitForText(view.lastFrame, 'http://127.0.0.1:4555/g10ss/')
    await waitFor(() => openInBrowser.mock.calls.length === 1)
    view.stdin.write('o')
    await waitFor(() => openInBrowser.mock.calls.length === 2)
    expect(openInBrowser).toHaveBeenLastCalledWith('http://127.0.0.1:4555/g10ss/')
  })

  it('stops the editor on x, and serves it again on s', async () => {
    const editor = fakeEditor()
    const view = await open(fakeCommands({ startGlossaryEditor: editor.startGlossaryEditor }))
    await waitForText(view.lastFrame, 'http://127.0.0.1:4555/g10ss/')
    view.stdin.write('x')
    await waitForText(view.lastFrame, 'Stopped')
    expect(editor.close).toHaveBeenCalledTimes(1)
    view.stdin.write('s')
    await waitFor(() => editor.startGlossaryEditor.mock.calls.length === 2)
  })

  it('says the editor closed when the page ends it', async () => {
    const editor = fakeEditor()
    const view = await open(fakeCommands({ startGlossaryEditor: editor.startGlossaryEditor }))
    await waitForText(view.lastFrame, 'http://127.0.0.1:4555/g10ss/')
    editor.end()
    await waitForText(view.lastFrame, 'The editor closed')
    expect(editor.close).toHaveBeenCalled()
  })

  it('stops the editor when the screen is left', async () => {
    const editor = fakeEditor()
    const view = await open(fakeCommands({ startGlossaryEditor: editor.startGlossaryEditor }))
    await waitForText(view.lastFrame, 'http://127.0.0.1:4555/g10ss/')
    view.stdin.write('q')
    await waitFor(() => editor.close.mock.calls.length === 1)
  })

  it('shows why the editor could not start', async () => {
    const startGlossaryEditor = vi.fn(async () => {
      throw new Error('no such table: glossary')
    })
    const view = await open(fakeCommands({ startGlossaryEditor }))
    await waitForText(view.lastFrame, 'no such table: glossary')
  })
})
