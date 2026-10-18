import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import React from 'react'
import { App } from '../../src/tui/App.js'
import { loadConfig, saveConfig } from '../../src/config.js'
import { ProviderRefusal, type ProviderCheck } from '../../src/agent/agy-check.js'
import type { ReviewFile } from '../../src/tui/commands.js'
import { createProviderCheckCache, providerCheckKey, withSignIn } from '../../src/tui/provider-check.js'
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
    await waitForText(view.lastFrame, /Start review/)
    for (let i = 0; i < 3; i++) {
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
    await waitForText(view.lastFrame, /Start review/)
    for (let i = 0; i < 3; i++) {
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

// codex has a check too, and the app keeps one answer per provider, model and
// effort: an answer is only ever handed to a run that would ask the same.
describe('the provider check per provider', () => {
  const codexAnswer = (model: string, over: Partial<ProviderCheck> = {}): ProviderCheck => ({
    provider: 'codex',
    signIn: { state: 'signed-in', ms: 1 },
    model: { state: 'ok', ms: 1 },
    asked: { model, effort: 'low' },
    at: Date.now(),
    ...over,
  })

  it('keys a check by provider, and for codex by model and effort', () => {
    expect(providerCheckKey({ ...loadConfig(), reviewProvider: 'antigravity' })).toBe('antigravity')
    const a = providerCheckKey({ ...loadConfig(), reviewProvider: 'codex', codex: { model: 'gpt-x', effort: 'low' } })
    const b = providerCheckKey({ ...loadConfig(), reviewProvider: 'codex', codex: { model: 'gpt-y', effort: 'low' } })
    const c = providerCheckKey({ ...loadConfig(), reviewProvider: 'codex', codex: { model: 'gpt-x', effort: 'high' } })
    expect(new Set([a, b, c, 'antigravity']).size).toBe(4)
    expect(providerCheckKey({ ...loadConfig(), reviewProvider: 'claude' })).toBeUndefined()
  })

  it('never hands an antigravity answer to codex, nor a codex answer for another model or effort', async () => {
    let next: ProviderCheck = quota(90)
    const check = vi.fn(async () => next)
    const cache = createProviderCheckCache(check)
    const config = (codex: { model: string; effort: 'low' | 'high' }) => ({ ...loadConfig(), reviewProvider: 'codex' as const, codex })
    await expect(cache.get('antigravity')).resolves.toMatchObject({ quota: expect.anything() })
    next = codexAnswer('gpt-x')
    await expect(cache.get(providerCheckKey(config({ model: 'gpt-x', effort: 'low' })))).resolves.toMatchObject({ provider: 'codex' })
    expect(check).toHaveBeenCalledTimes(2)
    // Each answer is kept for its own key.
    await cache.get('antigravity')
    await cache.get(providerCheckKey(config({ model: 'gpt-x', effort: 'low' })))
    expect(check).toHaveBeenCalledTimes(2)
    next = codexAnswer('gpt-y')
    await expect(cache.get(providerCheckKey(config({ model: 'gpt-y', effort: 'low' })))).resolves.toMatchObject({ asked: { model: 'gpt-y' } })
    expect(check).toHaveBeenCalledTimes(3)
    next = codexAnswer('gpt-x', { asked: { model: 'gpt-x', effort: 'high' } })
    await cache.get(providerCheckKey(config({ model: 'gpt-x', effort: 'high' })))
    expect(check).toHaveBeenCalledTimes(4)
  })

  // The check reads the config on its own. Should it answer for something
  // other than what the run asked for, the run gets no answer, not that one.
  it('hands a run nothing when the answer is for another key', async () => {
    const cache = createProviderCheckCache(async () => quota(90))
    await expect(cache.get('codex|gpt-x|low')).resolves.toBeUndefined()
  })

  it('does not hand the launch check to a codex review started after the provider changed', async () => {
    const checkProvider = vi.fn(async (): Promise<ProviderCheck> => (loadConfig().reviewProvider === 'codex' ? codexAnswer('gpt-x') : quota(90)))
    const reviewFile = vi.fn<ReviewFile>(async (opts) => {
      opts.onProgress?.({ type: 'start', file: opts.file, total: 1, reviewable: 1 })
      opts.onProgress?.({ type: 'done', summary: reviewSummaryOf(opts.file) })
      return reviewSummaryOf(opts.file)
    })
    const view = render(
      <App commands={fakeCommands({ checkProvider, reviewFile, discoverAgents: vi.fn(async () => [agentStatus('claude'), argon]) })} cwd={cwd} />,
    )
    await waitForText(view.lastFrame, '90% weekly')
    saveConfig({ defaultLocale: 'tr', reviewProvider: 'codex', codex: { model: 'gpt-x', effort: 'low' } })
    await openFromHome(view.stdin, 'review')
    await waitForText(view.lastFrame, 'submission.po')
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Start review/)
    for (let i = 0; i < 3; i++) {
      view.stdin.write(keys.down)
      await tick()
    }
    view.stdin.write(keys.enter)
    await waitFor(() => reviewFile.mock.calls.length > 0)
    const preflight = reviewFile.mock.calls[0]![0].preflight
    expect(preflight).toBeDefined()
    await expect(preflight).resolves.toMatchObject({ provider: 'codex', asked: { model: 'gpt-x' } })
    expect(checkProvider).toHaveBeenCalledTimes(2)
  })

  it('marks codex unusable when its check found it signed out, and leaves antigravity alone', () => {
    const codexRow = agentStatus('codex')
    const out = withSignIn([argon, codexRow], codexAnswer('gpt-x', { signIn: { state: 'signed-out', ms: 1 } }))!
    expect(out[0]).toBe(argon)
    expect(out[1]).toMatchObject({ usable: false, auth: { state: 'signed-out' }, reason: 'codex is signed out: run codex login' })
  })
})

