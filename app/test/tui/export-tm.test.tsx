import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import React from 'react'
import { saveConfig } from '../../src/config.js'
import type { ExportTmOptions } from '../../src/commands/tm-export.js'
import { App } from '../../src/tui/App.js'
import { CommandsProvider } from '../../src/tui/commands.js'
import { defaultTmName, ExportTm } from '../../src/tui/screens/ExportTm.js'
import { fakeCommands, flat, openFromHome, keys, makeHome, render, tick, waitForText, cleanup, type Home } from './helpers.js'

let home: Home

beforeEach(async () => {
  home = await makeHome()
  // Named rather than assumed: polyglots has no default locale (no-locale.test.tsx).
  saveConfig({ defaultLocale: 'tr' })
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

function mount(commands = fakeCommands(), onBack: () => void = () => undefined) {
  return render(
    <CommandsProvider value={commands}>
      <ExportTm onBack={onBack} />
    </CommandsProvider>,
  )
}

const downloads = join(homedir(), 'Downloads')

describe('defaultTmName', () => {
  it('dates the file and names it for the format', () => {
    const at = new Date(2026, 9, 3, 23, 30)
    expect(defaultTmName('tmx', at)).toBe('polyglots-tm-2026-10-03.tmx')
    expect(defaultTmName('po', at)).toBe('polyglots-tm-2026-10-03.po')
  })
})

describe('ExportTm', () => {
  it('writes TMX to Downloads by default, with the configured locale', async () => {
    saveConfig({ defaultLocale: 'de' })
    const commands = fakeCommands()
    const view = mount(commands)
    await waitForText(view.lastFrame, /TMX/)
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Write to/)
    expect(view.lastFrame()).toContain(defaultTmName('tmx'))
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Exported 120 entries/)
    const opts = vi.mocked(commands.exportTm).mock.calls[0]![0] as ExportTmOptions
    expect(opts).toEqual({ locale: 'de', file: join(downloads, defaultTmName('tmx')), format: 'tmx' })
  })

  // config set stores the slug, but a config.json edited by hand or written
  // by an older version can hold the wp code. The memory is keyed by the
  // slug, so exporting under tr_TR would write an empty file while Import TM,
  // which reads the same config as tr, shows the memory is there.
  it('exports the memory under the slug when config holds a wp code', async () => {
    saveConfig({ defaultLocale: 'tr_TR' })
    const commands = fakeCommands()
    const view = mount(commands)
    await waitForText(view.lastFrame, /TMX/)
    expect(flat(view.lastFrame())).toMatch(/· locale tr(?![_\w])/)
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Write to/)
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Exported 120 entries/)
    const opts = vi.mocked(commands.exportTm).mock.calls[0]![0] as ExportTmOptions
    expect(opts.locale).toBe('tr')
  })

  // The format is named for the tools that read it, not for one editor: a
  // team on OmegaT has as much use for the TMX as one on Poedit.
  it('says TMX is for CAT tools in general, not one editor', async () => {
    saveConfig({ defaultLocale: 'de' })
    const view = mount()
    await waitForText(view.lastFrame, /TMX/)
    expect(flat(view.lastFrame())).toContain('(Poedit, OmegaT and other CAT tools)')
  })

  // A .po holds one wording per source, so the person is told how many the
  // file could not carry; TMX is the default for that reason.
  it('writes .po when chosen and says how many wordings it dropped', async () => {
    const commands = fakeCommands()
    const view = mount(commands)
    await waitForText(view.lastFrame, /TMX/)
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Write to/)
    expect(view.lastFrame()).toContain(defaultTmName('po'))
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Exported/)
    expect(flat(view.lastFrame())).toMatch(/7 alternative wordings .* not carried/)
    const opts = vi.mocked(commands.exportTm).mock.calls[0]![0] as ExportTmOptions
    expect(opts).toMatchObject({ file: join(downloads, defaultTmName('po')), format: 'po' })
  })

  it('shows why an export failed', async () => {
    const commands = fakeCommands({
      exportTm: vi.fn(async () => {
        throw new Error('EACCES: permission denied')
      }),
    })
    const view = mount(commands)
    await waitForText(view.lastFrame, /TMX/)
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Write to/)
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'EACCES: permission denied')
  })

  it('goes back to the menu with escape', async () => {
    let back = 0
    const view = mount(fakeCommands(), () => back++)
    await waitForText(view.lastFrame, /TMX/)
    view.stdin.write(keys.esc)
    await tick(60)
    expect(back).toBe(1)
  })

  it('is reachable from the menu', async () => {
    const view = render(<App commands={fakeCommands()} />)
    await tick()
    await openFromHome(view.stdin, 'export-tm')
    await waitForText(view.lastFrame, /Export Translation Memory/)
    expect(view.lastFrame()).toMatch(/TMX/)
  })
})
