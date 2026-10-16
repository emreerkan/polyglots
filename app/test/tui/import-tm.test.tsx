import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import React from 'react'
import { saveConfig } from '../../src/config.js'
import { CommandsProvider } from '../../src/tui/commands.js'
import { ImportTm } from '../../src/tui/screens/ImportTm.js'
import { fakeCommands, keys, makeHome, tick, waitForText, render, cleanup, type Home } from './helpers.js'

let home: Home
let cwd: string
let tmxFile: string

beforeEach(async () => {
  home = await makeHome()
  // Named rather than assumed: polyglots has no default locale (no-locale.test.tsx).
  saveConfig({ defaultLocale: 'tr' })
  cwd = join(home.path, 'work')
  await mkdir(cwd)
  tmxFile = join(cwd, 'poedit.tmx')
  await writeFile(tmxFile, '')
  await writeFile(join(cwd, 'plugin-tr.po'), '')
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

// The default fake manifest lists no memory, so the menu holds the file
// choice alone; enter on it opens the picker (import-tm-fetch.test.tsx has
// the fetch).
function mount(commands = fakeCommands(), onBack: () => void = () => undefined) {
  const view = render(
    <CommandsProvider value={commands}>
      <ImportTm cwd={cwd} onBack={onBack} />
    </CommandsProvider>,
  )
  return view
}

async function openPicker(view: ReturnType<typeof mount>) {
  await waitForText(view.lastFrame, 'Import a file')
  view.stdin.write(keys.enter)
}

describe('ImportTm', () => {
  // tm import reads translate.wordpress.org's .po exports as well as TMX, so
  // the picker has to offer both or the menu can import less than the CLI.
  it('lists .tmx and .po files, imports the picked one with the configured locale and reports', async () => {
    saveConfig({ defaultLocale: 'de' })
    await writeFile(join(cwd, 'notes.txt'), '')
    const commands = fakeCommands()
    let back = 0
    const view = mount(commands, () => back++)
    const { lastFrame, stdin } = view
    await openPicker(view)
    await waitForText(lastFrame, 'poedit.tmx')
    expect(lastFrame()).toContain('plugin-tr.po')
    expect(lastFrame()).not.toContain('notes.txt')

    // Rows: .., plugin-tr.po, poedit.tmx.
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.enter)
    await waitForText(lastFrame, /Imported 3 entries \(2 new or updated\) from 1 file/)
    expect(lastFrame()).toContain('poedit.tmx')
    expect(commands.importTmx).toHaveBeenCalledTimes(1)
    const [files, opts] = vi.mocked(commands.importTmx).mock.calls[0]!
    expect(files).toEqual([tmxFile])
    expect(opts.locale).toBe('de')

    stdin.write(keys.enter)
    await tick()
    expect(back).toBe(1)
  })

  it('shows the error when the import fails', async () => {
    const commands = fakeCommands({
      importTmx: vi.fn(async () => {
        throw new Error('Invalid TMX: missing <tmx> root element')
      }),
    })
    const view = mount(commands)
    const { lastFrame, stdin } = view
    await openPicker(view)
    await waitForText(lastFrame, 'poedit.tmx')
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'Invalid TMX: missing <tmx> root element')
  })
})
