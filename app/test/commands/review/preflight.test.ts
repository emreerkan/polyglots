import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDb, replaceGlossary } from '../../../src/storage/index.js'
import { reviewFile, type ReviewOptions } from '../../../src/commands/review.js'
import { openJobsDb } from '../../../src/jobs/db.js'
import { ProviderRefusal, type ProviderCheck } from '../../../src/agent/agy-check.js'
import type { ProbeExec } from '../../../src/agent/providers.js'
import { useLocaleFixture } from '../../locale-fixture.js'
import { saveConfig } from '../../../src/config.js'

// The provider check gates a review before its first agent batch: signed out
// or out of quota stops it as a refusal, never as a fault, and a check that
// has not answered in ten seconds is passed over rather than waited on.

const PO = `msgid ""
msgstr ""
"MIME-Version: 1.0\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Language: tr\\n"
"Plural-Forms: nplurals=2; plural=(n > 1);\\n"

msgid "Save all changes"
msgstr "Tüm değişiklikleri kaydet"

msgid "Open the sidebar"
msgstr "Yan menüyü aç"
`

const MODEL = 'Gemini 4 Argon (Low)'
const logsDir = () => join(process.env.POLYGLOTS_HOME!, 'data', 'logs')

// Every run's lines, oldest log first: a test that runs twice reads both.
function logLines(): Array<Record<string, unknown>> {
  return readdirSync(logsDir())
    .filter((n) => n.endsWith('.jsonl') && !n.startsWith('mcp-'))
    .sort()
    .flatMap((n) => readFileSync(join(logsDir(), n), 'utf8').trim().split('\n'))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

const signedIn = (lines: ProviderCheck['quota'] = undefined): ProviderCheck => ({
  signIn: { state: 'signed-in', ms: 5 },
  ...(lines === undefined ? {} : { quota: lines }),
  at: Date.now(),
})

// Records every agy call and answers /usage with one line. Never the real agy.
function fakeExec(usage = 'Gemini Models\tGemini Weekly Limit\t40%\t2026-10-24T17:13:13Z') {
  const calls: string[][] = []
  const exec: ProbeExec = async (_cmd, args) => {
    calls.push(args)
    return args.includes('/usage')
      ? { code: 0, stdout: usage, stderr: '', timedOut: false }
      : { code: 0, stdout: '', stderr: '', timedOut: false }
  }
  return { exec, calls }
}

describe('reviewFile: the provider check', () => {
  let home: string
  let file: string
  let db: Database.Database
  let jobs: Database.Database

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'polyglots-review-preflight-'))
    file = join(home, 'plugin-tr.po')
    await writeFile(file, PO, 'utf8')
    db = openDb(join(home, 'polyglots.db'))
    replaceGlossary(db, 'tr', [{ locale: 'tr', sourceTerm: 'sidebar', translation: 'kenar çubuğu', partOfSpeech: 'noun' }])
    jobs = openJobsDb(join(home, 'jobs.db'))
  })

  useLocaleFixture('tr_TR.yaml')

  afterEach(async () => {
    vi.useRealTimers()
    jobs.close()
    db.close()
    await rm(home, { recursive: true, force: true })
  })

  // A plain function, not a mock: vi.fn(clearAll) on a mock hands back that
  // same mock's call history, so a test asserting its own spy was never
  // called would count every call clearAll took as the default.
  const clearAll = async (batch: { id: number }[]) =>
    batch.map((c) => ({ id: c.id, problem: false, categories: [] as never[], reason: 'ok' }))

  function run(overrides: Partial<ReviewOptions> = {}) {
    return reviewFile({
      file,
      locale: 'tr',
      db,
      jobsDb: jobs,
      provider: 'antigravity',
      model: MODEL,
      mcpConfigPath: join(home, 'mcp.json'),
      adjudicate: clearAll,
      providerExec: fakeExec().exec,
      onWarn: () => {},
      ...overrides,
    })
  }

  it('stops before the first batch when signed out, as a refusal and not a fault', async () => {
    const adjudicate = vi.fn(clearAll)
    const refused = run({ adjudicate, preflight: Promise.resolve({ signIn: { state: 'signed-out', ms: 3 }, at: Date.now() }) })
    await expect(refused).rejects.toBeInstanceOf(ProviderRefusal)
    await expect(refused).rejects.toThrow('antigravity is signed out. Run agy once to sign in, then start again.')
    expect(adjudicate).not.toHaveBeenCalled()
    const row = jobs.prepare('SELECT state, ended FROM run ORDER BY id DESC LIMIT 1').get() as { state: string; ended: string }
    expect(row).toEqual({ state: 'stopped', ended: 'stopped' })
    const lines = logLines()
    expect(lines.find((l) => l.kind === 'provider-check')).toMatchObject({ signIn: { state: 'signed-out' } })
    expect(lines.at(-1)).toMatchObject({ kind: 'run-end', ended: 'stopped', reason: 'provider' })
  })

  // The quota read a failed batch starts must land before run-end even when
  // the run throws after it: the log's last line says how the run ended.
  it('settles the quota read before run-end when the run throws after a failed batch', async () => {
    const calls: string[][] = []
    const slowUsage: ProbeExec = async (_cmd, args) => {
      calls.push(args)
      await new Promise((r) => setTimeout(r, 50))
      return { code: 0, stdout: 'Gemini Models\tGemini Weekly Limit\t0%\t2026-10-24T17:13:13Z', stderr: '', timedOut: false }
    }
    const failing = vi.fn(async () => {
      throw new Error('agy exited 1')
    })
    const thrown = run({
      adjudicate: failing,
      providerExec: slowUsage,
      preflight: Promise.resolve(signedIn()),
      onProgress: (e) => {
        if (e.type === 'batch-failed') throw new Error('progress handler broke')
      },
    })
    await expect(thrown).rejects.toThrow('progress handler broke')
    expect(calls).toEqual([['-p', '/usage']])
    await new Promise((r) => setTimeout(r, 100))
    const kinds = logLines().map((l) => l.kind)
    expect(kinds.at(-1)).toBe('run-end')
    expect(kinds).toContain('quota')
  })

  it('goes on without the check when it has not answered in ten seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    // Its clock starts when the review asks for it, so it lands a second after
    // the ten the review waits, however long the run took to get there.
    const late = { then: (resolve: (c: ProviderCheck) => void) => setTimeout(() => resolve(signedIn()), 11_000) }
    let settled = false
    const done = run({ preflight: late as unknown as Promise<ProviderCheck> }).finally(() => (settled = true))
    while (!settled) {
      await vi.advanceTimersByTimeAsync(250)
      await new Promise((r) => setImmediate(r))
    }
    const summary = await done
    expect(summary.reviewed).toBe(2)
    expect(logLines().find((l) => l.kind === 'provider-check')).toMatchObject({ waitedMs: 10_000, signIn: null, quota: null })
  })

  it('warns once when the quota is low, and goes on', async () => {
    const warned: string[] = []
    const check = signedIn({ lines: [{ group: 'Gemini Models', limit: 'Gemini Weekly Limit', remaining: 6, resetsAt: '2026-10-24T17:13:13Z' }], ms: 4 })
    const summary = await run({ preflight: Promise.resolve(check), onWarn: (l) => warned.push(l) })
    expect(summary.reviewed).toBe(2)
    expect(warned).toEqual([`antigravity quota is low for ${MODEL}: Gemini Models 6% left.`])
  })

  it('checks the quota once more after a batch is given up, and logs it', async () => {
    const { exec, calls } = fakeExec()
    const failing = vi.fn(async () => {
      throw new Error('quota exhausted')
    })
    await run({ adjudicate: failing, providerExec: exec, preflight: Promise.resolve(signedIn()) })
    expect(calls).toEqual([['-p', '/usage']])
    const lines = logLines()
    const quota = lines.find((l) => l.kind === 'quota')
    expect(quota).toMatchObject({ lines: [{ group: 'Gemini Models', remaining: 40 }] })
    // Before run-end, so the log says how the quota stood before saying how the run ended.
    expect(lines.indexOf(quota!)).toBeLessThan(lines.findIndex((l) => l.kind === 'run-end'))
  })

  // /usage opens the sign-in flow on a signed-out agy, so the read after a
  // failed batch is earned only by a start check that said signed in. An
  // unknown answer, a check past the wait, and no check at all each leave the
  // sign-in unconfirmed, and the failing batches may be exactly why.
  describe('makes no /usage call after a failed batch unless the check said signed in', () => {
    const failing = () =>
      vi.fn(async () => {
        throw new Error('agy exited 1')
      })

    it('when the check was unknown', async () => {
      const { exec, calls } = fakeExec()
      const unknown: ProviderCheck = { signIn: { state: 'unknown', detail: 'agy models exited 2', ms: 4 }, at: Date.now() }
      await run({ adjudicate: failing(), providerExec: exec, preflight: Promise.resolve(unknown) })
      expect(calls).toEqual([])
      expect(logLines().some((l) => l.kind === 'quota')).toBe(false)
    })

    it('when the check did not answer within the wait', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const { exec, calls } = fakeExec()
      const late = { then: (resolve: (c: ProviderCheck) => void) => setTimeout(() => resolve(signedIn()), 11_000) }
      let settled = false
      const done = run({ adjudicate: failing(), providerExec: exec, preflight: late as unknown as Promise<ProviderCheck> }).finally(
        () => (settled = true),
      )
      while (!settled) {
        await vi.advanceTimersByTimeAsync(250)
        await new Promise((r) => setImmediate(r))
      }
      await done
      expect(calls).toEqual([])
    })

    it('when no check was passed at all', async () => {
      const { exec, calls } = fakeExec()
      await run({ adjudicate: failing(), providerExec: exec })
      expect(calls).toEqual([])
    })
  })

  // The check is awaited just before the first agent batch, not before the
  // rules pass: the rules run beside it, and a run with nothing left to ask
  // the agent never waits on it or is refused by it.
  it('runs the rules pass before it waits on the check', async () => {
    const events: string[] = []
    const refused = run({
      onProgress: (e) => events.push(e.type),
      preflight: Promise.resolve({ signIn: { state: 'signed-out', ms: 3 }, at: Date.now() }),
    })
    await expect(refused).rejects.toBeInstanceOf(ProviderRefusal)
    expect(events).toContain('rules-done')
    expect(events).not.toContain('batch-start')
  })

  it('lets a fully cached resume finish when the check says signed out', async () => {
    await run({ preflight: Promise.resolve(signedIn()) })
    const adjudicate = vi.fn(async (batch: { id: number }[]) =>
      batch.map((c) => ({ id: c.id, problem: false, categories: [] as never[], reason: 'ok' })),
    )
    const summary = await run({ adjudicate, preflight: Promise.resolve({ signIn: { state: 'signed-out', ms: 3 }, at: Date.now() }) })
    expect(summary.reviewed).toBe(2)
    expect(adjudicate).not.toHaveBeenCalled()
  })

  // Not only is a cached resume never refused, it never waits for the check:
  // a check that never answers would otherwise hold it for the whole wait.
  // No timer is advanced, so a run that waited would never finish.
  it('does not wait for a check that never answers on a fully cached resume', async () => {
    await run({ preflight: Promise.resolve(signedIn()) })
    const before = logLines().filter((l) => l.kind === 'provider-check').length
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const summary = await run({ preflight: new Promise<ProviderCheck>(() => {}) })
    expect(summary.reviewed).toBe(2)
    expect(logLines().filter((l) => l.kind === 'provider-check')).toHaveLength(before)
  })

  it('never asks a provider other than antigravity, nor a rules-only run', async () => {
    const out = Promise.resolve<ProviderCheck>({ signIn: { state: 'signed-out', ms: 3 }, at: Date.now() })
    await expect(run({ provider: 'claude', preflight: out })).resolves.toMatchObject({ reviewed: 2 })
    await expect(run({ noAi: true, preflight: out })).resolves.toMatchObject({ reviewed: 2 })
    expect(logLines().some((l) => l.kind === 'provider-check')).toBe(false)
  })
})

// codex's check gates a review the same way: signed out and a model the plan
// lacks stop it as a refusal before batch 1, a rate limit is said once, and
// unknown never blocks. No quota is ever read for codex. The model and effort
// come from polyglots config here, and CODEX_HOME is the test's own.
describe('reviewFile: the codex check', () => {
  let home: string
  let file: string
  let db: Database.Database
  let jobs: Database.Database

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'polyglots-review-codex-preflight-'))
    file = join(home, 'plugin-tr.po')
    await writeFile(file, PO, 'utf8')
    db = openDb(join(home, 'polyglots.db'))
    replaceGlossary(db, 'tr', [{ locale: 'tr', sourceTerm: 'sidebar', translation: 'kenar çubuğu', partOfSpeech: 'noun' }])
    jobs = openJobsDb(join(home, 'jobs.db'))
    saveConfig({ reviewProvider: 'codex', codex: { model: 'gpt-x', effort: 'low' } })
  })

  useLocaleFixture('tr_TR.yaml')

  afterEach(async () => {
    jobs.close()
    db.close()
    await rm(home, { recursive: true, force: true })
  })

  const clearAll = async (batch: { id: number }[]) =>
    batch.map((c) => ({ id: c.id, problem: false, categories: [] as never[], reason: 'ok' }))
  const codex = (over: Partial<ProviderCheck> = {}): ProviderCheck => ({
    provider: 'codex',
    signIn: { state: 'signed-in', ms: 5 },
    asked: { model: 'gpt-x', effort: 'low' },
    at: Date.now(),
    ...over,
  })

  function run(overrides: Partial<ReviewOptions> = {}) {
    return reviewFile({
      file,
      locale: 'tr',
      db,
      jobsDb: jobs,
      provider: 'codex',
      mcpConfigPath: join(home, 'mcp.json'),
      adjudicate: clearAll,
      providerExec: fakeExec().exec,
      onWarn: () => {},
      ...overrides,
    })
  }

  const lastRun = () => jobs.prepare('SELECT state, ended FROM run ORDER BY id DESC LIMIT 1').get() as { state: string; ended: string }

  it('stops before the first batch when codex is signed out, as a refusal', async () => {
    const adjudicate = vi.fn(clearAll)
    const refused = run({ adjudicate, preflight: Promise.resolve(codex({ signIn: { state: 'signed-out', ms: 1 } })) })
    await expect(refused).rejects.toBeInstanceOf(ProviderRefusal)
    await expect(refused).rejects.toThrow('codex is signed out. Run codex login, then start again.')
    expect(adjudicate).not.toHaveBeenCalled()
    expect(lastRun()).toEqual({ state: 'stopped', ended: 'stopped' })
    expect(logLines().at(-1)).toMatchObject({ kind: 'run-end', ended: 'stopped', reason: 'provider' })
  })

  // The gate is handed the bare model, not the engine label "gpt-x (low)":
  // with the label the check's verdict, asked about gpt-x, would never match.
  it('stops on a model the plan lacks, naming it and the config key', async () => {
    const adjudicate = vi.fn(clearAll)
    const refused = run({
      adjudicate,
      preflight: Promise.resolve(codex({ model: { state: 'refused', detail: "The 'gpt-x' model is not supported when using Codex with a ChatGPT account.", ms: 900 } })),
    })
    await expect(refused).rejects.toThrow(
      "codex cannot use the model gpt-x: The 'gpt-x' model is not supported when using Codex with a ChatGPT account. Choose one your plan has: polyglots config set codex.model <name>",
    )
    expect(adjudicate).not.toHaveBeenCalled()
    expect(lastRun()).toEqual({ state: 'stopped', ended: 'stopped' })
    expect(logLines().find((l) => l.kind === 'provider-check')).toMatchObject({ provider: 'codex', model: { state: 'refused' } })
  })

  it('warns once on a rate limit, and runs', async () => {
    const warned: string[] = []
    const summary = await run({
      preflight: Promise.resolve(codex({ model: { state: 'rate-limited', detail: 'Rate limit reached', ms: 900 } })),
      onWarn: (l) => warned.push(l),
    })
    expect(summary.reviewed).toBe(2)
    expect(warned.filter((l) => l.includes('rate limit'))).toEqual(['codex is rate limited: Rate limit reached'])
  })

  it('goes on when the check is unknown, and never reads a quota, even after a failed batch', async () => {
    const { exec, calls } = fakeExec()
    const failing = vi.fn(async () => {
      throw new Error('codex failed: stream disconnected')
    })
    await run({ adjudicate: failing, providerExec: exec, preflight: Promise.resolve(codex({ model: { state: 'unknown', detail: 'x', ms: 1 } })) })
    expect(failing).toHaveBeenCalled()
    const ok = vi.fn(clearAll)
    await run({ adjudicate: ok, fresh: true, providerExec: exec, preflight: Promise.resolve(codex({ model: { state: 'ok', ms: 1 } })) })
    expect(ok).toHaveBeenCalled()
    expect(calls).toEqual([])
    expect(logLines().some((l) => l.kind === 'quota')).toBe(false)
  })

  // A check asked about another model, or a cached antigravity answer, says
  // nothing about this run.
  it('is not stopped by a check for another model or for antigravity', async () => {
    const other = codex({ asked: { model: 'gpt-y', effort: 'low' }, model: { state: 'refused', detail: 'not supported', ms: 1 } })
    await expect(run({ preflight: Promise.resolve(other) })).resolves.toMatchObject({ reviewed: 2 })
    const agy: ProviderCheck = { signIn: { state: 'signed-out', ms: 1 }, at: Date.now() }
    await expect(run({ fresh: true, preflight: Promise.resolve(agy) })).resolves.toMatchObject({ reviewed: 2 })
  })
})

