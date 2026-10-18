import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import React from 'react'
import { saveConfig } from '../../src/config.js'
import type { RunControl } from '../../src/run-control.js'
import { CommandsProvider, type ReviewFileOptions } from '../../src/tui/commands.js'
import { Review } from '../../src/tui/screens/Review.js'
import type { ReviewEvent } from '../../src/types.js'
import { ProviderRefusal } from '../../src/agent/agy-check.js'
import { cleanup, ESC_DELAY, fakeCommands, flat, keys, makeHome, render, reviewSummaryOf, tick, waitForText, type Home } from './helpers.js'

// The batch screen while a batch of marked files runs: the overall lines, each
// file's time and open batch, and one file's own progress screen opened from
// the list. The jobs are scripted, and a.po holds its second batch open until
// the test lets it go, so the running screen can be looked at for as long as
// a test needs.

let home: Home
let cwd: string

const PO = `msgid ""
msgstr ""
"Language: tr\\n"
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Save"
msgstr "Kaydet"
`

beforeEach(async () => {
  home = await makeHome()
  saveConfig({ defaultLocale: 'tr' })
  cwd = join(home.path, 'work')
  await mkdir(cwd)
  await writeFile(join(cwd, 'a.po'), PO)
  await writeFile(join(cwd, 'b.po'), PO)
  await utimes(join(cwd, 'a.po'), 5000, 5000)
  await utimes(join(cwd, 'b.po'), 4000, 4000)
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

interface Script {
  // How long a.po's second batch has been open when it starts.
  openFor: number
  // a.po's first batch fails rather than finishing.
  failFirst?: boolean
}

// The handles a test reaches into while a.po is held open.
interface Held {
  emit: Partial<Record<string, (e: ReviewEvent) => void>>
  control?: RunControl
  release: () => void
  // Set when the test closed a.po's second batch itself, so the script does
  // not close it a second time.
  closed?: boolean
}

function scripted(script: Script) {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const held: Held = { emit: {}, release: () => release() }
  const reviewFile = vi.fn(async (opts: ReviewFileOptions) => {
    const emit = opts.onProgress!
    const name = basename(opts.file)
    held.emit[name] = emit
    held.control = opts.control
    emit({ type: 'start', file: opts.file, total: 10, reviewable: 10 })
    if (name === 'a.po') {
      const now = Date.now()
      emit({ type: 'rules-done', flagged: 0, suspects: 0 })
      emit({ type: 'batch-start', index: 1, of: 2, size: 5, at: now - script.openFor - 60_000 })
      if (script.failFirst) emit({ type: 'batch-failed', index: 1, size: 5, reason: 'agent timed out after 300s', at: now - script.openFor })
      else emit({ type: 'batch-done', index: 1, problems: 0, at: now - script.openFor })
      emit({ type: 'batch-start', index: 2, of: 2, size: 5, at: now - script.openFor })
      await gate
      if (!held.closed) emit({ type: 'batch-done', index: 2, problems: 1, at: Date.now() })
    }
    const summary = reviewSummaryOf(opts.file, script.failFirst && name === 'a.po' ? { unreviewed: 5 } : {})
    emit({ type: 'done', summary })
    return summary
  })
  return { reviewFile, held }
}

function mount(script: Script) {
  const { reviewFile, held } = scripted(script)
  const view = render(
    <CommandsProvider value={fakeCommands({ reviewFile })}>
      <Review cwd={cwd} onBack={vi.fn()} />
    </CommandsProvider>,
  )
  return { ...view, held }
}

type View = ReturnType<typeof mount>

async function press(view: View, ...sequence: string[]) {
  for (const k of sequence) {
    view.stdin.write(k)
    await tick()
  }
}

async function escape(view: View) {
  view.stdin.write(keys.esc)
  await tick(ESC_DELAY + 20)
}

// Mark both, open the options, then Locale → parallel → batch size → start
// over → skip AI → start, on one slot so b.po waits in the queue.
async function startBatch(view: View) {
  await waitForText(view.lastFrame, 'a.po')
  await press(view, '*', keys.down, keys.enter)
  await waitForText(view.lastFrame, /Parallel/)
  await press(view, keys.down, keys.down, keys.down, keys.down, keys.down, keys.enter)
  await waitForText(view.lastFrame, /in this batch/)
}

const frame = (view: View) => flat(view.lastFrame())

describe('the running batch screen', () => {
  it('shows the overall lines above the files', async () => {
    const view = mount({ openFor: 5_000 })
    await startBatch(view)
    expect(frame(view)).toMatch(/0 of 2 files done · 1 running · 1 queued · \d+s elapsed/)
    // A batch has closed and b.po is still queued, so the estimate is a ceiling.
    expect(frame(view)).toMatch(/up to ~\S+ left, done by/)
    view.held.release()
    await waitForText(view.lastFrame, /2 done, 0 failed/)
  })

  it('shows how long the running file has been in its open batch', async () => {
    const view = mount({ openFor: 5_000 })
    await startBatch(view)
    expect(frame(view)).toMatch(/a\.po running · batch 2\/2 · [56]s in this batch/)
    expect(frame(view)).toMatch(/b\.po queued/)
    expect(frame(view)).not.toContain('near the time limit')
    view.held.release()
    await waitForText(view.lastFrame, /2 done, 0 failed/)
  })

  // Claude's agent gives a batch 300 s, so 4 m 30 s open is within the last minute.
  it('marks a batch open past its agent timeout less a minute', async () => {
    const view = mount({ openFor: 270_000 })
    await startBatch(view)
    expect(frame(view)).toMatch(/a\.po running · batch 2\/2 · 4m 3\ds in this batch · near the time limit/)
    view.held.release()
    await waitForText(view.lastFrame, /2 done, 0 failed/)
  })

  // The fake runs never see the pause in their own events, as the real ones
  // in a batch do not either: the line has to read it from the screen's
  // control, or it goes on counting an estimate down through a pause.
  it('says there is no estimate while a pause or a stop is pending', async () => {
    const view = mount({ openFor: 5_000 })
    await startBatch(view)
    await press(view, 'p')
    await waitForText(view.lastFrame, /no estimate while paused/)
    expect(frame(view)).not.toMatch(/left, done by|estimating…/)
    await press(view, 'r')
    await waitForText(view.lastFrame, /up to ~\S+ left, done by/)
    await press(view, 'q')
    await waitForText(view.lastFrame, /no estimate while stopping/)
    expect(frame(view)).not.toMatch(/left, done by|estimating…|while paused/)
    view.held.release()
    await waitForText(view.lastFrame, /1 done, 0 failed, 0 skipped, 1 stopped/)
  })

  it('counts failed batches across the files on the overall line', async () => {
    const view = mount({ openFor: 5_000, failFirst: true })
    await startBatch(view)
    expect(frame(view)).toMatch(/· 1 batch failed/)
    view.held.release()
    await waitForText(view.lastFrame, /2 done/)
  })
})

describe('inspecting one file', () => {
  it('opens the running file’s own progress with enter, and follows its events', async () => {
    const view = mount({ openFor: 5_000 })
    await startBatch(view)
    await press(view, keys.enter)
    await waitForText(view.lastFrame, /reviewing \d+s/)
    // The file's own clock counts from when its batch opened, not from when
    // the screen was opened, so it agrees with the line above it.
    expect(frame(view)).toMatch(/batch 2\/2 · reviewing [56]s/)
    expect(frame(view)).toContain('esc back to all files · p pause · r resume · q stop the whole batch')
    expect(frame(view)).not.toMatch(/b\.po queued/)
    view.held.closed = true
    view.held.emit['a.po']!({ type: 'batch-done', index: 2, problems: 1, at: Date.now() })
    await waitForText(view.lastFrame, /2\/2 batches/)
    // The opened file stays open through the end of the batch, now its final
    // screen, and esc goes back to the summary.
    view.held.release()
    await waitForText(view.lastFrame, /esc back to the summary/)
    expect(frame(view)).toMatch(/a\.po finished · \d+s/)
    await escape(view)
    await waitForText(view.lastFrame, /2 done, 0 failed/)
  })

  // The opened file's screen reduces that file's own events, and the batch's
  // runs never report the pause in them: the screen has to put it there, or
  // the file's estimate counts down under the "Paused." line.
  it('drops the opened file’s estimate while the batch is paused, and brings it back on resume', async () => {
    const view = mount({ openFor: 5_000 })
    await startBatch(view)
    await press(view, keys.enter)
    await waitForText(view.lastFrame, /reviewing \d+s/)
    expect(frame(view)).toMatch(/left, done by/)
    await press(view, 'p')
    await waitForText(view.lastFrame, /will pause after this batch/)
    expect(frame(view)).not.toMatch(/left, done by/)
    await press(view, 'r')
    await waitForText(view.lastFrame, /left, done by/)
    expect(frame(view)).not.toMatch(/will pause after this batch/)
    // A stop is pushed the same way, and outranks the estimate as a pause does.
    await press(view, 'q')
    await waitForText(view.lastFrame, /will stop after this batch/)
    expect(frame(view)).not.toMatch(/left, done by/)
    view.held.release()
    await waitForText(view.lastFrame, /esc back to the summary/)
  })

  it('returns to the list with esc, the cursor on the file it opened', async () => {
    const view = mount({ openFor: 5_000 })
    await startBatch(view)
    await press(view, keys.down, keys.enter)
    await waitForText(view.lastFrame, /Queued: starts when a slot frees\./)
    await escape(view)
    await waitForText(view.lastFrame, /in this batch/)
    expect(frame(view)).toMatch(/❯ b\.po\s+queued/)
    expect(frame(view)).not.toMatch(/❯ a\.po/)
    view.held.release()
    await waitForText(view.lastFrame, /2 done, 0 failed/)
  })

  it('stops the whole batch with q from inside one file', async () => {
    const view = mount({ openFor: 5_000 })
    await startBatch(view)
    await press(view, keys.enter)
    await waitForText(view.lastFrame, /reviewing \d+s/)
    const stop = vi.spyOn(view.held.control!, 'stop')
    await press(view, 'q')
    expect(stop).toHaveBeenCalled()
    expect(view.held.control!.state).toBe('stopping')
    view.held.release()
    await waitForText(view.lastFrame, /esc back to the summary/)
    await escape(view)
    // b.po was still queued, so the stop kept it from starting.
    await waitForText(view.lastFrame, /1 done, 0 failed, 0 skipped, 1 stopped/)
  })
})

describe('after the batch', () => {
  it('opens a finished file’s final screen from the summary with its time and failure reasons', async () => {
    const view = mount({ openFor: 5_000, failFirst: true })
    await startBatch(view)
    view.held.release()
    await waitForText(view.lastFrame, /2 done/)
    await press(view, keys.enter)
    await waitForText(view.lastFrame, /Not reviewed/)
    expect(frame(view)).toMatch(/a\.po finished · \d+s · 1 batch failed/)
    expect(frame(view)).toContain('Batch 1 failed (5 entries): agent timed out after 300s')
    expect(frame(view)).toMatch(/Done\. \d+ problems/)
    await escape(view)
    await waitForText(view.lastFrame, /2 done/)
  })
})

// A refusal stops the batch through the same control as q, but nobody pressed
// it: the operator's stopping line would read as if they had.
describe('a batch the provider check refused', () => {
  it('names the refusal instead of the stopping line while the other file winds down', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const reviewFile = vi.fn(async (opts: ReviewFileOptions) => {
      if (basename(opts.file) === 'a.po') throw new ProviderRefusal('antigravity is signed out. Run agy once to sign in, then start again.')
      opts.onProgress!({ type: 'start', file: opts.file, total: 10, reviewable: 10 })
      await gate
      const summary = reviewSummaryOf(opts.file)
      opts.onProgress!({ type: 'done', summary })
      return summary
    })
    const view = render(
      <CommandsProvider value={fakeCommands({ reviewFile })}>
        <Review cwd={cwd} onBack={vi.fn()} />
      </CommandsProvider>,
    )
    await waitForText(view.lastFrame, 'a.po')
    await press(view, '*', keys.down, keys.enter)
    await waitForText(view.lastFrame, /Parallel/)
    // Two at once, so b.po is still running when a.po is refused.
    await press(view, keys.down, keys.right, keys.down, keys.down, keys.down, keys.down, keys.enter)
    await waitForText(view.lastFrame, 'Stopped: antigravity is signed out.')
    expect(frame(view)).not.toContain('Stopping after')
    release()
    await waitForText(view.lastFrame, /1 done/)
  })
})
