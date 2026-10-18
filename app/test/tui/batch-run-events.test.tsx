import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import React from 'react'
import { saveConfig } from '../../src/config.js'
import { CommandsProvider, type ReviewFileOptions } from '../../src/tui/commands.js'
import { Review } from '../../src/tui/screens/Review.js'
import { cleanup, fakeCommands, keys, makeHome, render, reviewSummaryOf, tick, waitForText, type Home } from './helpers.js'

// The batch screen's own bookkeeping for a file's end runs in the pool's
// event handler, between files. A throw there is a bug in the screen, not in
// any run, and must cost the screen a line rather than fail the batch, as on
// the command line. The store's first finish throws here, or its first push
// when a test asks for that: a file's progress events go through the same
// store, from inside the run.
const breaks = { push: false }

vi.mock('../../src/tui/batch-progress.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/tui/batch-progress.js')>()
  return {
    ...real,
    createEventStore: (action: 'review' | 'translate') => {
      const store = real.createEventStore(action)
      let thrown = false
      let pushed = false
      return {
        ...store,
        push(input: string, e: Parameters<typeof store.push>[1]) {
          if (breaks.push && !pushed) {
            pushed = true
            throw new Error('store broke')
          }
          store.push(input, e)
        },
        finish(input: string, at: number) {
          if (!thrown) {
            thrown = true
            throw new Error('store broke')
          }
          store.finish(input, at)
        },
      }
    },
  }
})

let home: Home
let cwd: string

const po = `msgid ""
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
  await writeFile(join(cwd, 'a.po'), po)
  await writeFile(join(cwd, 'b.po'), po)
  await utimes(join(cwd, 'a.po'), 5000, 5000)
  await utimes(join(cwd, 'b.po'), 4000, 4000)
})

afterEach(async () => {
  breaks.push = false
  cleanup()
  await home.cleanup()
})

describe('the batch screen', () => {
  it('runs every file to its end when its own bookkeeping throws on one', async () => {
    const reviewFile = vi.fn(async (opts: ReviewFileOptions) => reviewSummaryOf(opts.file))
    const view = render(
      <CommandsProvider value={fakeCommands({ reviewFile })}>
        <Review cwd={cwd} onBack={() => undefined} />
      </CommandsProvider>,
    )
    await waitForText(view.lastFrame, 'a.po')
    for (const k of ['*', keys.down, keys.enter]) {
      view.stdin.write(k)
      await tick()
    }
    await waitForText(view.lastFrame, /Parallel/)
    for (const k of [keys.down, keys.down, keys.down, keys.down, keys.down, keys.enter]) {
      view.stdin.write(k)
      await tick()
    }
    await waitForText(view.lastFrame, /2 done, 0 failed, 0 skipped/)
    expect(reviewFile).toHaveBeenCalledTimes(2)
  })

  // A progress event runs inside the file's own run, so a throw from the
  // screen's store there used to fail that file, whose batches were paid for
  // and fine, over a line of the screen.
  it('keeps a file whose progress bookkeeping throws', async () => {
    breaks.push = true
    const reviewFile = vi.fn(async (opts: ReviewFileOptions) => {
      opts.onProgress!({ type: 'start', file: opts.file, total: 1, reviewable: 1 })
      return reviewSummaryOf(opts.file)
    })
    const view = render(
      <CommandsProvider value={fakeCommands({ reviewFile })}>
        <Review cwd={cwd} onBack={() => undefined} />
      </CommandsProvider>,
    )
    await waitForText(view.lastFrame, 'a.po')
    for (const k of ['*', keys.down, keys.enter]) {
      view.stdin.write(k)
      await tick()
    }
    await waitForText(view.lastFrame, /Parallel/)
    for (const k of [keys.down, keys.down, keys.down, keys.down, keys.down, keys.enter]) {
      view.stdin.write(k)
      await tick()
    }
    await waitForText(view.lastFrame, /2 done, 0 failed, 0 skipped/)
    expect(reviewFile).toHaveBeenCalledTimes(2)
  })
})
