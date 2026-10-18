import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { translateFile, type TranslateOptions } from '../../../src/commands/translate.js'
import { openJobsDb } from '../../../src/jobs/db.js'
import { ProviderRefusal, type ProviderCheck } from '../../../src/agent/agy-check.js'
import type { ProbeExec } from '../../../src/agent/providers.js'
import { fakeEngine, fakeReview, makeWorkspace, type Workspace } from './helpers.js'
import { saveConfig } from '../../../src/config.js'

// Translate's review pass is the part that reaches antigravity, so the same
// gate stands in front of its first batch as in front of a review's.

let ws: Workspace

beforeEach(async () => {
  ws = await makeWorkspace()
})

afterEach(async () => {
  await ws.cleanup()
})

const logsDir = () => join(process.env.POLYGLOTS_HOME!, 'data', 'logs')

function logLines(): Array<Record<string, unknown>> {
  const [file] = readdirSync(logsDir()).filter((n) => n.endsWith('.jsonl') && !n.startsWith('mcp-'))
  return readFileSync(join(logsDir(), file!), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

function fakeExec() {
  const calls: string[][] = []
  const exec: ProbeExec = async (_cmd, args) => {
    calls.push(args)
    return { code: 0, stdout: 'Gemini Models\tGemini Weekly Limit\t0%\t2026-10-24T17:13:13Z', stderr: '', timedOut: false }
  }
  return { exec, calls }
}

function base(overrides: Partial<TranslateOptions> = {}): TranslateOptions {
  return {
    file: ws.file,
    locale: 'tr',
    mode: 'pending',
    draftEngine: 'deepl',
    mcpConfigPath: join(ws.home, 'mcp.json'),
    batchSize: 25,
    engine: fakeEngine(),
    review: fakeReview(),
    provider: 'antigravity',
    model: 'Gemini 4 Argon (Low)',
    providerExec: fakeExec().exec,
    onWarn: () => {},
    ...overrides,
  }
}

describe('translateFile: the provider check', () => {
  it('stops before the first review when signed out, and ends the run stopped', async () => {
    const review = fakeReview()
    const refused = translateFile(base({ review, preflight: Promise.resolve<ProviderCheck>({ signIn: { state: 'signed-out', ms: 2 }, at: Date.now() }) }))
    await expect(refused).rejects.toBeInstanceOf(ProviderRefusal)
    expect(review.calls).toHaveLength(0)
    const jobs = openJobsDb()
    try {
      expect(jobs.prepare('SELECT state, ended FROM run ORDER BY id DESC LIMIT 1').get()).toEqual({ state: 'stopped', ended: 'stopped' })
    } finally {
      jobs.close()
    }
    expect(logLines().at(-1)).toMatchObject({ kind: 'run-end', ended: 'stopped', reason: 'provider' })
  })

  // The gate is awaited before the first batch opens when it has a draft to
  // write: a refused run must not have paid the engine for a batch, nor show
  // a batch that started and never ended.
  it('pays for no draft and opens no batch when refused with nothing cached', async () => {
    const engine = fakeEngine()
    const refused = translateFile(base({ engine, preflight: Promise.resolve<ProviderCheck>({ signIn: { state: 'signed-out', ms: 2 }, at: Date.now() }) }))
    await expect(refused).rejects.toBeInstanceOf(ProviderRefusal)
    expect(engine.calls).toHaveLength(0)
    expect(logLines().some((l) => l.kind === 'batch-start')).toBe(false)
  })

  it('checks the quota once more after a batch is given up', async () => {
    const { exec, calls } = fakeExec()
    const review = fakeReview()
    const failing = Object.assign(async () => {
      throw new Error('quota exhausted')
    }, { calls: review.calls, fuzzyKeys: review.fuzzyKeys }) as unknown as TranslateOptions['review']
    const signedIn: ProviderCheck = { signIn: { state: 'signed-in', ms: 2 }, at: Date.now() }
    const summary = await translateFile(base({ review: failing, providerExec: exec, preflight: Promise.resolve(signedIn) }))
    expect(summary.skipped).toBeGreaterThan(0)
    expect(calls).toEqual([['-p', '/usage']])
    const lines = logLines()
    const quota = lines.findIndex((l) => l.kind === 'quota')
    expect(lines[quota]).toMatchObject({ lines: [{ group: 'Gemini Models', remaining: 0 }] })
    expect(quota).toBeLessThan(lines.findIndex((l) => l.kind === 'run-end'))
  })

  // As in review: the read a failed batch started lands before run-end even
  // when the run throws after it.
  it('settles the quota read before run-end when the run throws after a failed batch', async () => {
    const calls: string[][] = []
    const slowUsage: ProbeExec = async (_cmd, args) => {
      calls.push(args)
      await new Promise((r) => setTimeout(r, 50))
      return { code: 0, stdout: 'Gemini Models\tGemini Weekly Limit\t0%\t2026-10-24T17:13:13Z', stderr: '', timedOut: false }
    }
    const review = fakeReview()
    review.failWith = () => new Error('agy exited 1')
    const signedIn: ProviderCheck = { signIn: { state: 'signed-in', ms: 2 }, at: Date.now() }
    const thrown = translateFile(
      base({
        review,
        providerExec: slowUsage,
        preflight: Promise.resolve(signedIn),
        onProgress: (e) => {
          if (e.type === 'batch-skipped') throw new Error('progress handler broke')
        },
      }),
    )
    await expect(thrown).rejects.toThrow('progress handler broke')
    expect(calls).toEqual([['-p', '/usage']])
    await new Promise((r) => setTimeout(r, 100))
    const kinds = logLines().map((l) => l.kind)
    expect(kinds.at(-1)).toBe('run-end')
    expect(kinds).toContain('quota')
  })

  // /usage opens the sign-in flow on a signed-out agy, so only a start check
  // that said signed in earns the read after a failed batch.
  describe('makes no /usage call after a failed batch unless the check said signed in', () => {
    const failingReview = () => {
      const review = fakeReview()
      review.failWith = () => new Error('agy exited 1')
      return review
    }

    it('when the check was unknown', async () => {
      const { exec, calls } = fakeExec()
      const unknown: ProviderCheck = { signIn: { state: 'unknown', detail: 'agy models exited 2', ms: 2 }, at: Date.now() }
      const summary = await translateFile(base({ review: failingReview(), providerExec: exec, preflight: Promise.resolve(unknown) }))
      expect(summary.skipped).toBeGreaterThan(0)
      expect(calls).toEqual([])
    })

    it('when the check did not answer within the wait', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      try {
        const { exec, calls } = fakeExec()
        const late = {
          then: (resolve: (c: ProviderCheck) => void) => setTimeout(() => resolve({ signIn: { state: 'signed-in', ms: 2 }, at: Date.now() }), 11_000),
        }
        let settled = false
        const done = translateFile(
          base({ review: failingReview(), providerExec: exec, preflight: late as unknown as Promise<ProviderCheck> }),
        ).finally(() => (settled = true))
        while (!settled) {
          await vi.advanceTimersByTimeAsync(250)
          await new Promise((r) => setImmediate(r))
        }
        expect((await done).skipped).toBeGreaterThan(0)
        expect(calls).toEqual([])
      } finally {
        vi.useRealTimers()
      }
    })

    it('when no check was passed at all', async () => {
      const { exec, calls } = fakeExec()
      const summary = await translateFile(base({ review: failingReview(), providerExec: exec }))
      expect(summary.skipped).toBeGreaterThan(0)
      expect(calls).toEqual([])
    })
  })

  // Awaited just before the first review that reaches the agent: a resume
  // whose every review the cache answers asks antigravity nothing, so a
  // signed-out check has nothing to stop.
  it('lets a resume the cache answers in full finish when the check says signed out', async () => {
    // A dry run fills both caches and leaves the file as it was, so the next
    // pass takes the same entries and finds every draft and review cached.
    const signedIn = Promise.resolve<ProviderCheck>({ signIn: { state: 'signed-in', ms: 2 }, at: Date.now() })
    await translateFile(base({ dryRun: true, preflight: signedIn }))
    const review = fakeReview()
    const out = Promise.resolve<ProviderCheck>({ signIn: { state: 'signed-out', ms: 2 }, at: Date.now() })
    const summary = await translateFile(base({ review, preflight: out }))
    expect(summary.translated).toBe(7)
    expect(review.calls).toHaveLength(0)
  })

  // Not only is a cached resume never refused, it never waits for the check:
  // a check that never answers would otherwise hold it for the whole wait.
  // No timer is advanced, so a run that waited would never finish.
  it('does not wait for a check that never answers on a resume the cache answers in full', async () => {
    const signedIn = Promise.resolve<ProviderCheck>({ signIn: { state: 'signed-in', ms: 2 }, at: Date.now() })
    await translateFile(base({ dryRun: true, preflight: signedIn }))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const review = fakeReview()
      const summary = await translateFile(base({ review, preflight: new Promise<ProviderCheck>(() => {}) }))
      expect(summary.translated).toBe(7)
      expect(review.calls).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
    // Two runs, two logs: only the second, the newest by name, is this one's.
    const logs = readdirSync(logsDir()).filter((n) => n.endsWith('.jsonl') && !n.startsWith('mcp-')).sort()
    expect(logs).toHaveLength(2)
    const second = readFileSync(join(logsDir(), logs[1]!), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string })
    expect(second.some((l) => l.kind === 'provider-check')).toBe(false)
  })

  it('reads the check once, however many batches ask the reviewer', async () => {
    const signedIn = Promise.resolve<ProviderCheck>({ signIn: { state: 'signed-in', ms: 2 }, at: Date.now() })
    const review = fakeReview()
    await translateFile(base({ batchSize: 2, review, preflight: signedIn }))
    expect(review.calls.length).toBeGreaterThan(1)
    expect(logLines().filter((l) => l.kind === 'provider-check')).toHaveLength(1)
  })

  it('asks nothing when the drafts go unreviewed', async () => {
    const out = Promise.resolve<ProviderCheck>({ signIn: { state: 'signed-out', ms: 2 }, at: Date.now() })
    await expect(translateFile(base({ provider: 'none', preflight: out }))).resolves.toMatchObject({ translated: 7 })
    expect(logLines().some((l) => l.kind === 'provider-check')).toBe(false)
  })
})

// codex's review pass is gated the same way, with its own words, and no
// quota is ever read for it.
describe('translateFile: the codex check', () => {
  beforeEach(() => {
    saveConfig({ reviewProvider: 'codex', codex: { model: 'gpt-x', effort: 'low' } })
  })

  const codex = (over: Partial<ProviderCheck> = {}): ProviderCheck => ({
    provider: 'codex',
    signIn: { state: 'signed-in', ms: 2 },
    asked: { model: 'gpt-x', effort: 'low' },
    at: Date.now(),
    ...over,
  })
  function codexBase(overrides: Partial<TranslateOptions> = {}): TranslateOptions {
    const { model: _flag, ...rest } = base({ provider: 'codex', ...overrides })
    return rest
  }

  it('stops before the first review when codex is signed out, and ends the run stopped', async () => {
    const review = fakeReview()
    const refused = translateFile(codexBase({ review, preflight: Promise.resolve(codex({ signIn: { state: 'signed-out', ms: 2 } })) }))
    await expect(refused).rejects.toThrow('codex is signed out. Run codex login, then start again.')
    expect(review.calls).toHaveLength(0)
    expect(logLines().at(-1)).toMatchObject({ kind: 'run-end', ended: 'stopped', reason: 'provider' })
  })

  it('stops on a model the plan lacks with the config hint', async () => {
    const engine = fakeEngine()
    const refused = translateFile(
      codexBase({ engine, preflight: Promise.resolve(codex({ model: { state: 'refused', detail: 'model not supported', ms: 2 } })) }),
    )
    await expect(refused).rejects.toBeInstanceOf(ProviderRefusal)
    await expect(refused).rejects.toThrow(
      'codex cannot use the model gpt-x: model not supported. Choose one your plan has: polyglots config set codex.model <name>',
    )
    expect(engine.calls).toHaveLength(0)
  })

  it('never reads a quota for codex, even after a failed batch', async () => {
    const { exec, calls } = fakeExec()
    const review = fakeReview()
    review.failWith = () => new Error('codex failed: stream disconnected')
    const summary = await translateFile(codexBase({ review, providerExec: exec, preflight: Promise.resolve(codex({ model: { state: 'ok', ms: 2 } })) }))
    expect(summary.skipped).toBeGreaterThan(0)
    expect(calls).toEqual([])
    expect(logLines().some((l) => l.kind === 'quota')).toBe(false)
  })
})

