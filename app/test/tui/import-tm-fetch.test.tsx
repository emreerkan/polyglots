import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import React from 'react'
import { saveConfig } from '../../src/config.js'
import type { TmFetchPlan, TmFetchProgress } from '../../src/commands/tm-fetch.js'
import { CommandsProvider, type TuiCommands } from '../../src/tui/commands.js'
import { ImportTm } from '../../src/tui/screens/ImportTm.js'
import { cleanup, fakeCommands, flat, keys, makeHome, manifestWith, render, tick, tmEntry, waitFor, waitForText, type Home } from './helpers.js'

let home: Home
let cwd: string

beforeEach(async () => {
  home = await makeHome()
  saveConfig({ defaultLocale: 'tr' })
  cwd = join(home.path, 'work')
  await mkdir(cwd)
  await writeFile(join(cwd, 'poedit.tmx'), '')
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

const SUMMARY = ['Turkish (tr): 1,002 strings, 98.1 KiB download, built 2026-10-15', '4 projects', 'Your memory has no tr strings yet.']

function plan(): TmFetchPlan {
  return { locale: 'tr', entry: tmEntry(), existing: 0, summary: SUMMARY }
}

function mount(overrides: Partial<TuiCommands> = {}, onBack: () => void = () => undefined) {
  const commands = fakeCommands(overrides)
  const view = render(
    <CommandsProvider value={commands}>
      <ImportTm cwd={cwd} onBack={onBack} />
    </CommandsProvider>,
  )
  return { ...view, commands }
}

const listed = () => ({ manifest: vi.fn(async () => manifestWith({ tm: [tmEntry()] })), download: vi.fn() })

describe('ImportTm: fetch from polyglots-data', () => {
  it('offers fetch before the file picker on Import TM', async () => {
    const view = mount({ dataClient: listed() })
    await waitForText(view.lastFrame, 'Fetch from polyglots-data')
    const frame = flat(view.lastFrame())
    expect(frame).toContain('Import a file')
    expect(frame.indexOf('Fetch from polyglots-data')).toBeLessThan(frame.indexOf('Import a file'))
    // The picker is a second step, not drawn under the menu.
    expect(frame).not.toContain('poedit.tmx')
  })

  // config.json is hand-editable, and tm fetch reads tr_TR as tr through
  // requireLocale; the menu has to read it the same way or it hides a fetch
  // the CLI would run.
  it('reads a wp code in config as its slug and still offers fetch', async () => {
    saveConfig({ defaultLocale: 'tr_TR' })
    const view = mount({ dataClient: listed() })
    await waitForText(view.lastFrame, 'Fetch from polyglots-data')
    expect(flat(view.lastFrame())).toContain('locale tr')
  })

  it('hides fetch when the manifest has no entry for the locale', async () => {
    const view = mount({ dataClient: { manifest: vi.fn(async () => manifestWith({ tm: [tmEntry({ slug: 'de', locale: 'de_DE' })] })), download: vi.fn() } })
    await waitForText(view.lastFrame, 'Import a file')
    await waitFor(() => vi.mocked(view.commands.dataClient.manifest).mock.calls.length > 0)
    await tick()
    expect(flat(view.lastFrame())).not.toContain('Fetch from polyglots-data')
  })

  it('hides fetch and says why when polyglots-data cannot be reached', async () => {
    const view = mount({
      dataClient: {
        manifest: vi.fn(async () => {
          throw new Error('GET https://example.invalid/index.json failed: getaddrinfo ENOTFOUND')
        }),
        download: vi.fn(),
      },
    })
    await waitForText(view.lastFrame, 'Could not reach polyglots-data')
    expect(flat(view.lastFrame())).not.toContain('Fetch from polyglots-data')
    expect(flat(view.lastFrame())).toContain('Import a file')
  })

  it('opens the file picker from the menu', async () => {
    const view = mount({ dataClient: listed() })
    await waitForText(view.lastFrame, 'Fetch from polyglots-data')
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'poedit.tmx')
  })

  it('shows the summary, imports on y with progress, then the result', async () => {
    let finish: () => void = () => undefined
    const runTmFetch = vi.fn(
      (_plan: TmFetchPlan, _client: unknown, opts: { onProgress?: (e: TmFetchProgress) => void } = {}) =>
        new Promise<{ units: number; added: number; present: number; projects: number; ms: number }>((resolve) => {
          opts.onProgress?.({ phase: 'downloading' })
          setTimeout(() => {
            opts.onProgress?.({ phase: 'importing', done: 500, total: 1002 })
            finish = () => resolve({ units: 1002, added: 1000, present: 2, projects: 4, ms: 2_340 })
          }, 10)
        }),
    )
    const planTmFetch = vi.fn(async () => plan())
    let back = 0
    const view = mount({ dataClient: listed(), planTmFetch, runTmFetch }, () => back++)
    await waitForText(view.lastFrame, 'Fetch from polyglots-data')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'Turkish (tr): 1,002 strings')
    expect(flat(view.lastFrame())).toContain('Your memory has no tr strings yet.')
    expect(runTmFetch).not.toHaveBeenCalled()
    // Read once, by the menu: the plan reuses that answer rather than asking again.
    expect(view.commands.dataClient.manifest).toHaveBeenCalledTimes(1)
    await planTmFetch.mock.results[0]!.value
    const client = (planTmFetch.mock.calls[0] as unknown[])[1] as TuiCommands['dataClient']
    await client.manifest()
    expect(view.commands.dataClient.manifest).toHaveBeenCalledTimes(1)

    view.stdin.write('y')
    await waitForText(view.lastFrame, 'Importing 500 of 1,002')
    finish()
    await waitForText(view.lastFrame, 'Imported 1,000 new strings (2 already present) from 4 projects in 2.3s.')
    expect(runTmFetch).toHaveBeenCalledTimes(1)
    view.stdin.write(keys.enter)
    await tick()
    expect(back).toBe(1)
  })

  it('shows Downloading while the file comes in', async () => {
    const runTmFetch = vi.fn((_p: TmFetchPlan, _c: unknown, opts: { onProgress?: (e: TmFetchProgress) => void } = {}) => {
      opts.onProgress?.({ phase: 'downloading' })
      return new Promise<never>(() => {})
    })
    const view = mount({ dataClient: listed(), planTmFetch: vi.fn(async () => plan()), runTmFetch })
    await waitForText(view.lastFrame, 'Fetch from polyglots-data')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, '1,002 strings')
    view.stdin.write('y')
    await waitForText(view.lastFrame, 'Downloading')
  })

  it('shows a refusal from the plan and imports nothing', async () => {
    const view = mount({
      dataClient: listed(),
      planTmFetch: vi.fn(async () => {
        throw new Error('The polyglots-data memory for tr claims more than 200 MiB; refusing it.')
      }),
    })
    await waitForText(view.lastFrame, 'Fetch from polyglots-data')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'claims more than 200 MiB')
    view.stdin.write('y')
    await tick()
    expect(view.commands.runTmFetch).not.toHaveBeenCalled()
  })
})
