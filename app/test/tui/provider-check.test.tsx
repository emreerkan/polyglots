import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import React from 'react'
import { App } from '../../src/tui/App.js'
import { saveConfig } from '../../src/config.js'
import { ProviderRefusal, type ProviderCheck } from '../../src/agent/agy-check.js'
import type { ReviewFile } from '../../src/tui/commands.js'
import { createProviderCheckCache, withSignIn } from '../../src/tui/provider-check.js'
import {
  agentStatus,
  cleanup,
  ESC_DELAY,
  fakeCommands,
  flat,
  keys,
  makeHome,
  openFromHome,
  render,
  reviewSummaryOf,
  tick,
  waitFor,
  waitForText,
  type Home,
} from './helpers.js'

// The app asks antigravity in the background at launch, never holding home
// for it, names the answer beside the provider, and hands the same answer to
// a run started within five minutes rather than asking again.

let home: Home
let cwd: string

beforeEach(async () => {
  home = await makeHome()
  saveConfig({ defaultLocale: 'tr', reviewProvider: 'antigravity' })
  cwd = join(home.path, 'work')
  await mkdir(cwd)
  await writeFile(join(cwd, 'submission.po'), '')
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

const argon = agentStatus('antigravity', { model: 'Gemini 4 Argon' })
const quota = (remaining: number): ProviderCheck => ({
  signIn: { state: 'signed-in', ms: 2000 },
  quota: {
    ms: 3000,
    lines: [
      { group: 'Gemini Models', limit: 'Gemini Weekly Limit', remaining: 95, resetsAt: '2026-10-24T17:13:13Z' },
      { group: 'Gemini 4 Argon', limit: 'Gemini 4 Argon Weekly Limit', remaining, resetsAt: '2026-10-24T17:13:13Z' },
    ],
  },
  at: Date.now(),
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('the provider check in the app', () => {
  it('draws home before the check answers, then names the quota beside the provider', async () => {
    const answer = deferred<ProviderCheck>()
    const checkProvider = vi.fn(() => answer.promise)
    const { lastFrame } = render(
      <App commands={fakeCommands({ checkProvider, discoverAgents: vi.fn(async () => [agentStatus('claude'), argon]) })} cwd={cwd} />,
    )
    await waitForText(lastFrame, 'review antigravity · Gemini 4 Argon')
    expect(lastFrame()).toContain('Review a submitted .po')
    expect(lastFrame()).not.toContain('% weekly')
    answer.resolve(quota(90))
    await waitForText(lastFrame, 'review antigravity · Gemini 4 Argon · 90% weekly')
  })

  it('says how to sign in when antigravity is signed out', async () => {
    const checkProvider = vi.fn(async (): Promise<ProviderCheck> => ({ signIn: { state: 'signed-out', ms: 900 }, at: Date.now() }))
    const { lastFrame } = render(
      <App commands={fakeCommands({ checkProvider, discoverAgents: vi.fn(async () => [agentStatus('claude'), argon]) })} cwd={cwd} />,
    )
    await waitForText(lastFrame, 'review antigravity · signed out: run agy once to sign in')
  })

  it('never asks when another provider reviews', async () => {
    saveConfig({ defaultLocale: 'tr', reviewProvider: 'claude' })
    const checkProvider = vi.fn(async () => quota(90))
    const { lastFrame } = render(<App commands={fakeCommands({ checkProvider })} cwd={cwd} />)
    await waitForText(lastFrame, 'review claude')
    await tick(20)
    expect(checkProvider).not.toHaveBeenCalled()
  })

  it('hands the check from launch to a review started soon after, without asking again', async () => {
    const checkProvider = vi.fn(async () => quota(90))
    const reviewFile = vi.fn<ReviewFile>(async (opts) => {
      opts.onProgress?.({ type: 'start', file: opts.file, total: 1, reviewable: 1 })
      opts.onProgress?.({ type: 'done', summary: reviewSummaryOf(opts.file) })
      return reviewSummaryOf(opts.file)
    })
    const view = render(
      <App commands={fakeCommands({ checkProvider, reviewFile, discoverAgents: vi.fn(async () => [agentStatus('claude'), argon]) })} cwd={cwd} />,
    )
    await waitForText(view.lastFrame, '90% weekly')
    await openFromHome(view.stdin, 'review')
    await waitForText(view.lastFrame, 'submission.po')
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Locale/)
    for (let i = 0; i < 4; i++) {
      view.stdin.write(keys.down)
      await tick()
    }
    view.stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length > 0)
    const preflight = reviewFile.mock.calls[0]![0].preflight
    expect(preflight).toBeDefined()
    await expect(preflight).resolves.toMatchObject({ quota: { lines: expect.any(Array) } })
    expect(checkProvider).toHaveBeenCalledTimes(1)
    expect(flat(view.lastFrame())).not.toContain('signed out')
  })
})

// Checked at launch and on a provider change alone, the header's note kept
// the launch answer for as long as the app stayed open. Home asks again on
// each visit, and the cache's five minutes keep that from costing a spawn.
describe('the header note on going back to home', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks again once the answer is over five minutes old, and not before', async () => {
    // Only the clock: Ink's own timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] })
    const checkProvider = vi.fn(async () => quota(90))
    const view = render(
      <App commands={fakeCommands({ checkProvider, discoverAgents: vi.fn(async () => [agentStatus('claude'), argon]) })} cwd={cwd} />,
    )
    await waitForText(view.lastFrame, '90% weekly')
    expect(checkProvider).toHaveBeenCalledTimes(1)
    const visit = async () => {
      await openFromHome(view.stdin, 'review')
      await waitForText(view.lastFrame, 'submission.po')
      view.stdin.write(keys.esc)
      await tick(ESC_DELAY)
      await waitForText(view.lastFrame, 'Review a submitted .po')
      await tick(20)
    }
    vi.setSystemTime(Date.now() + 60_000)
    await visit()
    expect(checkProvider).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 6 * 60_000)
    await visit()
    expect(checkProvider).toHaveBeenCalledTimes(2)
  })
})

describe('a review the provider check refused', () => {
  it('says the run stopped, and never that it failed', async () => {
    const reviewFile = vi.fn<ReviewFile>(async () => {
      throw new ProviderRefusal('antigravity is signed out. Run agy once to sign in, then start again.')
    })
    const checkProvider = vi.fn(async (): Promise<ProviderCheck> => ({ signIn: { state: 'signed-out', ms: 900 }, at: Date.now() }))
    const view = render(
      <App commands={fakeCommands({ checkProvider, reviewFile, discoverAgents: vi.fn(async () => [agentStatus('claude'), argon]) })} cwd={cwd} />,
    )
    await waitForText(view.lastFrame, 'signed out')
    await openFromHome(view.stdin, 'review')
    await waitForText(view.lastFrame, 'submission.po')
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Locale/)
    for (let i = 0; i < 4; i++) {
      view.stdin.write(keys.down)
      await tick()
    }
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, 'Stopped: antigravity is signed out.')
    expect(flat(view.lastFrame())).not.toContain('Review failed')
  })
})

describe('createProviderCheckCache', () => {
  it('reuses an answer under five minutes old, and asks again after that', async () => {
    let now = 1_000_000
    const check = vi.fn(async (): Promise<ProviderCheck> => ({ signIn: { state: 'signed-in', ms: 1 }, at: now }))
    const cache = createProviderCheckCache(check, { now: () => now })
    await cache.get()
    now += 4 * 60_000
    await cache.get()
    expect(check).toHaveBeenCalledTimes(1)
    now += 2 * 60_000
    await cache.get()
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('shares one check in flight, and reads a throw as no answer', async () => {
    const answer = deferred<ProviderCheck>()
    const check = vi.fn(() => answer.promise)
    const cache = createProviderCheckCache(check)
    const a = cache.get()
    const b = cache.get()
    expect(check).toHaveBeenCalledTimes(1)
    answer.resolve({ signIn: { state: 'unknown', ms: 1 }, at: Date.now() })
    await expect(a).resolves.toEqual(await b)
    const failing = createProviderCheckCache(() => Promise.reject(new Error('no agy')))
    await expect(failing.get()).resolves.toBeUndefined()
  })
})

// Discovery at launch reads only the token file, which outlives a sign-out,
// so setup and home take the check's word for antigravity's sign-in.
describe('withSignIn', () => {
  it('marks antigravity unusable when the check found it signed out, and leaves claude alone', () => {
    const out = withSignIn([agentStatus('claude'), argon], { signIn: { state: 'signed-out', ms: 1 }, at: 0 })!
    expect(out[0]).toEqual(agentStatus('claude'))
    expect(out[1]).toMatchObject({ usable: false, auth: { state: 'signed-out' }, reason: 'antigravity is signed out: run agy once to sign in' })
  })

  it('changes nothing on an unknown answer', () => {
    const agents = [agentStatus('claude'), argon]
    expect(withSignIn(agents, { signIn: { state: 'unknown', ms: 1 }, at: 0 })).toBe(agents)
  })
})
