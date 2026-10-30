import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import React from 'react'
import { saveConfig } from '../../src/config.js'
import { CommandsProvider } from '../../src/tui/commands.js'
import { SyncGlossary } from '../../src/tui/screens/SyncGlossary.js'
import { fakeCommands, flat, keys, makeHome, tick, waitFor, waitForText, render, cleanup, type Home } from './helpers.js'

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
      <SyncGlossary onBack={onBack} />
    </CommandsProvider>,
  )
}

// The field exists only for someone with no locale configured: with one, the
// header names it and l changes it. saveConfig merges, so no locale is written
// over the file instead.
async function noLocale() {
  await mkdir(join(home.path, 'config'), { recursive: true })
  await writeFile(join(home.path, 'config', 'config.json'), '{}')
}

describe('SyncGlossary with no locale configured', () => {
  beforeEach(noLocale)

  it('starts with an empty field, lets the user type a locale and reports the count', async () => {
    const commands = fakeCommands()
    let back = 0
    const { lastFrame, stdin } = mount(commands, () => back++)
    await waitForText(lastFrame, /Locale/)

    stdin.write('de-at')
    await waitForText(lastFrame, 'de-at')
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'Synced 42 glossary entries for de-at; kept 0 local edits.')
    expect(vi.mocked(commands.syncGlossary).mock.calls[0]![0]).toMatchObject({ locale: 'de-at' })

    stdin.write(keys.enter)
    await tick()
    expect(back).toBe(1)
  })

  it('normalizes the locale before syncing', async () => {
    const commands = fakeCommands()
    const { lastFrame, stdin } = mount(commands)
    await waitForText(lastFrame, /Locale/)
    stdin.write('tr_TR ')
    await waitForText(lastFrame, 'tr_TR')
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'Synced 42 glossary entries for tr; kept 0 local edits.')
    expect(vi.mocked(commands.syncGlossary).mock.calls[0]![0]).toMatchObject({ locale: 'tr' })
  })

  it('shows a failure and lets the user fix the locale and retry without leaving the screen', async () => {
    let back = 0
    const syncGlossary = vi.fn(async ({ locale }: { locale: string }) => {
      if (locale !== 'de') throw new Error(`No glossary entries found for locale "${locale}"; existing cache left untouched`)
      return { entries: 7, kept: 0, removed: [] }
    })
    const commands = fakeCommands({ syncGlossary })
    const { lastFrame, stdin } = mount(commands, () => back++)
    await waitForText(lastFrame, /Locale/)
    stdin.write('trx')
    await waitForText(lastFrame, 'trx')
    stdin.write(keys.enter)
    await waitForText(lastFrame, /No glossary entries found for locale "trx"/)
    expect(back).toBe(0)

    stdin.write(keys.enter)
    await waitForText(lastFrame, 'enter to sync')
    expect(back).toBe(0)
    for (let i = 0; i < 3; i++) {
      stdin.write(keys.backspace)
      await tick()
    }
    stdin.write('de')
    await waitForText(lastFrame, /Locale:\s+de\s*$/m)
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'Synced 7 glossary entries for de; kept 0 local edits.')
    expect(syncGlossary).toHaveBeenCalledTimes(2)
  })
})

describe('SyncGlossary with a locale configured', () => {
  // With no field to edit, a failed sync has nothing to fix on this screen, so
  // enter runs the same locale again instead of opening a field.
  it('retries the configured locale on enter after a failure', async () => {
    saveConfig({ defaultLocale: 'de' })
    let calls = 0
    const syncGlossary = vi.fn(async (_: { locale: string }) => {
      if (++calls === 1) throw new Error('network down')
      return { entries: 7, kept: 0, removed: [] }
    })
    const { lastFrame, stdin } = mount(fakeCommands({ syncGlossary }))
    await waitForText(lastFrame, 'enter to sync')
    stdin.write(keys.enter)
    await waitForText(lastFrame, /Sync failed: network down/)
    await waitForText(lastFrame, 'enter to retry')
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'Synced 7 glossary entries for de; kept 0 local edits.')
    expect(syncGlossary.mock.calls.map((c) => c[0].locale)).toEqual(['de', 'de'])
  })
})

describe('SyncGlossary with local edits', () => {
  it('counts the kept edits and lists every removed one', async () => {
    const syncGlossary = vi.fn(async (_: { locale: string }) => ({
      entries: 42,
      kept: 3,
      removed: [
        {
          kind: 'add' as const,
          term: 'archive',
          pos: 'noun',
          local: { term: 'archive', pos: 'noun', translation: 'arşivim', notes: '' },
          wporg: [{ term: 'archive', pos: 'noun', translation: 'arşiv', notes: '' }],
        },
      ],
    }))
    const { lastFrame, stdin } = mount(fakeCommands({ syncGlossary }))
    await waitForText(lastFrame, 'enter to sync')
    stdin.write(keys.enter)
    await waitFor(() => flat(lastFrame()).includes('kept 3 local edits'))
    expect(flat(lastFrame())).toContain('Synced 42 glossary entries for tr; kept 3 local edits.')
    expect(flat(lastFrame())).toContain('removed local edit: archive (noun): arşivim → wp.org: arşiv')
  })
})
