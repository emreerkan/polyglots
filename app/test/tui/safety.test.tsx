import { mkdir, writeFile } from 'node:fs/promises'
import { saveConfig } from '../../src/config.js'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranslateEvent, TranslateOptions, TranslateSummary } from '../../src/commands/translate.js'
import { App } from '../../src/tui/App.js'
import { createActivity } from '../../src/tui/hooks/activity.js'
import { DEFAULT_TUI_STATE } from '../../src/tui/state.js'
import { cleanup, ESC_DELAY, fakeCommands, flat, keys, makeHome, memoryTuiState, openFromHome, render, tick, waitFor, waitForText, type Home } from './helpers.js'

// The claims the frame makes about runs: nothing it draws on top, no resize
// and no navigation may cost a run its screen, and nothing may quit past one
// without asking. Each is driven at App level with a translate held open.

let home: Home
let cwd: string

beforeEach(async () => {
  home = await makeHome()
  // Named rather than assumed: polyglots has no default locale (no-locale.test.tsx).
  saveConfig({ defaultLocale: 'tr' })
  cwd = join(home.path, 'work')
  await mkdir(cwd)
  await writeFile(join(cwd, 'plugin.po'), '')
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

/** A translate that starts, then waits for the test to feed it events and let it finish. */
function heldTranslate() {
  let opts!: TranslateOptions
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const translateFile = vi.fn(async (o: TranslateOptions): Promise<TranslateSummary> => {
    opts = o
    o.onProgress?.({ type: 'start', file: o.file, total: 4, pending: 2 })
    await gate
    const summary = { file: o.file, total: 4, pending: 2, fromTm: 0, translated: 2, fuzzy: 0, skipped: 0 }
    o.onProgress?.({ type: 'done', summary })
    return summary
  })
  return {
    translateFile,
    emit: (e: TranslateEvent) => opts.onProgress?.(e),
    control: () => opts.control,
    release: () => release(),
  }
}

async function startTranslate(view: ReturnType<typeof render>) {
  await openFromHome(view.stdin, 'translate')
  await waitForText(view.lastFrame, 'plugin.po')
  view.stdin.write(keys.down)
  await tick()
  view.stdin.write(keys.enter)
  await waitForText(view.lastFrame, /Draft engine/)
  for (let i = 0; i < 5; i++) {
    view.stdin.write(keys.down)
    await tick()
  }
  view.stdin.write(keys.enter)
  await waitForText(view.lastFrame, /0\/2/)
}

async function type(stdin: { write(s: string): void }, text: string) {
  for (const ch of text) {
    stdin.write(ch)
    await tick()
  }
}

describe('a run in flight', () => {
  // Leaving the screen would unmount it while the run carried on: its pause
  // and stop keys and its progress gone, and a second run on the same file
  // one keypress away.
  it('cannot be left through the palette', async () => {
    const run = heldTranslate()
    const view = render(<App commands={fakeCommands({ translateFile: run.translateFile })} cwd={cwd} />)
    await startTranslate(view)
    view.stdin.write('\u000b')
    await waitForText(view.lastFrame, 'Go to')
    await type(view.stdin, 'about')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'A run is in progress')
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(view.lastFrame, /0\/2/)
    // The About page, which the palette was asked for.
    expect(view.lastFrame()).not.toContain('licence')
    run.release()
  })

  it('drops the warning once the run is over, so the next palette is clean', async () => {
    const run = heldTranslate()
    const view = render(<App commands={fakeCommands({ translateFile: run.translateFile })} cwd={cwd} />)
    await startTranslate(view)
    view.stdin.write('\u000b')
    await waitForText(view.lastFrame, 'Go to')
    await type(view.stdin, 'about')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'A run is in progress')
    // Sync and import are runs too, and their screens do not all stop on q,
    // so the warning does not promise a key.
    expect(view.lastFrame()).not.toMatch(/with q/)
    run.release()
    await waitFor(() => !/A run is in progress/.test(view.lastFrame()))
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'licence')
    view.stdin.write('\u000b')
    await waitForText(view.lastFrame, 'Go to')
    expect(view.lastFrame()).not.toContain('A run is in progress')
  })

  it('makes q on home ask first, like Ctrl+C does', async () => {
    const activity = createActivity()
    const release = activity.begin()
    const onExit = vi.fn()
    const view = render(<App commands={fakeCommands()} cwd={cwd} activity={activity} onExit={onExit} />)
    await waitForText(view.lastFrame, 'Translate a .po file')
    view.stdin.write('q')
    await waitForText(view.lastFrame, 'A run is still going')
    expect(onExit).not.toHaveBeenCalled()
    view.stdin.write('y')
    await tick()
    expect(onExit).toHaveBeenCalledTimes(1)
    release()
  })

  it('keeps its keys away from the screen while an overlay is open', async () => {
    const run = heldTranslate()
    const view = render(<App commands={fakeCommands({ translateFile: run.translateFile })} cwd={cwd} />)
    await startTranslate(view)
    view.stdin.write('\u000b')
    await waitForText(view.lastFrame, 'Go to')
    // p pauses a run and q stops one; typed here they are search text.
    await type(view.stdin, 'pq')
    expect(run.control()?.state).toBe('running')
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    view.stdin.write('p')
    await tick()
    expect(run.control()?.state).toBe('paused')
    run.release()
  })

  it('keeps running and updating through a resize below the minimum', async () => {
    const run = heldTranslate()
    const view = render(<App commands={fakeCommands({ translateFile: run.translateFile })} cwd={cwd} />)
    await startTranslate(view)
    view.resize(50, 15)
    await waitForText(view.lastFrame, 'Enlarge the terminal')
    run.emit({ type: 'batch-start', index: 1, of: 2, size: 1, at: Date.now() })
    run.emit({ type: 'batch-done', index: 1, translated: 1, fuzzy: 0, at: Date.now() })
    await tick()
    view.resize(120, 40)
    await waitForText(view.lastFrame, /1\/2/)
    expect(run.translateFile).toHaveBeenCalledTimes(1)
    run.release()
    await waitForText(view.lastFrame, /Done\./)
  })
})

describe('a terminal below the minimum', () => {
  it('ignores ? and : instead of saving an overlay for after the resize', async () => {
    const view = render(<App commands={fakeCommands()} cwd={cwd} />, { columns: 59, rows: 20 })
    await waitForText(view.lastFrame, 'Enlarge the terminal')
    view.stdin.write('?')
    await tick()
    view.stdin.write(':')
    await tick()
    view.stdin.write('\u000b')
    await tick()
    view.resize(120, 40)
    await waitForText(view.lastFrame, 'Translate a .po file')
    expect(view.lastFrame()).not.toContain('Keys on this screen')
    expect(view.lastFrame()).not.toContain('Go to')
  })
})

describe('setup facts', () => {
  // Counting the glossary opens polyglots.db; doing it on every screen
  // change is a file open per keypress for an answer that only a sync or
  // the wizard can change.
  it('counts the glossary at launch and after a sync, not on every navigation', async () => {
    const glossaryCount = vi.fn(() => 0)
    const view = render(<App commands={fakeCommands({ glossaryCount })} cwd={cwd} />)
    await waitForText(view.lastFrame, 'Translate a .po file')
    const atLaunch = glossaryCount.mock.calls.length
    view.stdin.write('a')
    await waitForText(view.lastFrame, 'Version, paths')
    view.stdin.write('q')
    await waitForText(view.lastFrame, 'Translate a .po file')
    expect(glossaryCount.mock.calls.length).toBe(atLaunch)
    await openFromHome(view.stdin, 'sync-glossary')
    await waitForText(view.lastFrame, 'Locale:')
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(view.lastFrame, 'Setup wizard')
    await waitFor(() => glossaryCount.mock.calls.length > atLaunch)
  })

  // Two screens write tui.json: Interface settings and the wizard. A stale
  // copy in one would put back what the other just changed.
  it('keeps an exit-summary toggle when the wizard records a step afterwards', async () => {
    const state = memoryTuiState({ ...DEFAULT_TUI_STATE, wizard: { ...DEFAULT_TUI_STATE.wizard, dismissed: true } })
    const view = render(<App commands={fakeCommands({ ...state })} cwd={cwd} />)
    await waitForText(view.lastFrame, 'Translate a .po file')
    await openFromHome(view.stdin, 'interface')
    await waitForText(view.lastFrame, 'Interface settings')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, '[ ]')
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(view.lastFrame, 'Setup wizard')
    view.stdin.write('w')
    await waitForText(view.lastFrame, 'Step 1 of 5')
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(view.lastFrame, 'Step 2 of 5')
    const last = state.saveTuiState.mock.calls.at(-1)![0]
    expect(last.wizard.skipped).toContain('locale')
    expect(last.settings.exitSummary).toBe(false)
  })
})

describe('the stats server reporting trouble', () => {
  it('shows a server error in the header after its screen is left', async () => {
    let onError: ((err: Error) => void) | undefined
    const commands = fakeCommands({
      startStatsServer: vi.fn(async (opts?: { onError?: (err: Error) => void }) => {
        onError = opts?.onError
        return { url: 'http://127.0.0.1:9/x/', port: 9, close: vi.fn(async () => {}) }
      }),
    })
    const view = render(<App commands={commands} cwd={cwd} />)
    await openFromHome(view.stdin, 'stats')
    await waitForText(view.lastFrame, 'Serving at')
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(view.lastFrame, 'Translate a .po file')
    onError?.(new Error('EPIPE on a request'))
    await waitForText(() => flat(view.lastFrame()), 'stats: EPIPE on a request')
  })
})
