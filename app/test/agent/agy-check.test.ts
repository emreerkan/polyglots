import { describe, expect, it } from 'vitest'
import { agyQuota, agySignIn, checkAgy, judge, parseUsage, quotaFor, quotaRecheck } from '../../src/agent/agy-check.js'
import type { ProbeExec, ProbeResult } from '../../src/agent/discover.js'

// Every case runs against a fake exec. The real agy is never started: signed
// out, `agy -p /usage` opens a sign-in flow and waits a minute for a code.

const MODELS_OK: ProbeResult = { code: 0, stdout: 'Fetching available models...\ngemini-4-argon-low\tGemini 4 Argon (Low)\n', stderr: '', timedOut: false }
const MODELS_OUT: ProbeResult = { code: 1, stdout: '', stderr: 'Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.\n', timedOut: false }
const USAGE = [
  'Gemini Models\tWeekly Limit Remaining\t98%\t2026-10-24T03:48:07Z',
  'Gemini Models\tFive Hour Limit Remaining\t98%\t2026-10-17T20:30:30Z',
  'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-24T18:00:45Z',
  'Claude and GPT models\tFive Hour Limit Remaining\t0%\t2026-10-17T23:00:45Z',
  'Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t90%\t2026-10-24T17:13:13Z',
].join('\n')
const USAGE_OK: ProbeResult = { code: 0, stdout: USAGE + '\n', stderr: '', timedOut: false }

interface Call { cmd: string; args: string[]; timeoutMs: number }
type FakeExec = ProbeExec & { calls: Call[] }

function fakeExec(answers: { models?: ProbeResult; usage?: ProbeResult }): FakeExec {
  const calls: Call[] = []
  const exec: ProbeExec = async (cmd, args, opts) => {
    calls.push({ cmd, args, timeoutMs: opts.timeoutMs })
    const answer = args.includes('/usage') ? answers.usage : args[0] === 'models' ? answers.models : undefined
    return answer ?? { code: null, stdout: '', stderr: 'spawn ENOENT', timedOut: false }
  }
  return Object.assign(exec, { calls })
}

describe('agySignIn', () => {
  it('reads agy models exit 0 as signed in', async () => {
    const exec = fakeExec({ models: MODELS_OK })
    const signIn = await agySignIn(exec, '/opt/agy')
    expect(signIn.state).toBe('signed-in')
    expect(exec.calls).toEqual([{ cmd: '/opt/agy', args: ['models'], timeoutMs: 15_000 }])
  })

  it('reads exit 1 with "sign in" as signed out, and never runs /usage', async () => {
    const exec = fakeExec({ models: MODELS_OUT })
    const check = await checkAgy(exec)
    expect(check.signIn.state).toBe('signed-out')
    expect(exec.calls.some((c) => c.args.includes('/usage'))).toBe(false)
    expect(check.quota).toBeUndefined()
  })

  it('reads a timeout or another code as unknown, and never runs /usage', async () => {
    const answers: ProbeResult[] = [
      { code: null, stdout: '', stderr: '', timedOut: true },
      { code: 2, stdout: '', stderr: 'boom', timedOut: false },
      // Exit 1 without the words is a failure of some other kind, not a sign-in.
      { code: 1, stdout: '', stderr: 'Error: network unreachable', timedOut: false },
      // Not installed: the probe runner reports a spawn error as code null.
      { code: null, stdout: '', stderr: 'spawn agy ENOENT', timedOut: false },
    ]
    for (const models of answers) {
      const exec = fakeExec({ models, usage: USAGE_OK })
      const check = await checkAgy(exec)
      expect(check.signIn.state).toBe('unknown')
      expect(check.signIn.detail).toBeTruthy()
      expect(exec.calls.some((c) => c.args.includes('/usage'))).toBe(false)
    }
  })

  it('reads an exec that throws as unknown rather than failing the run', async () => {
    const exec = (async () => {
      throw new Error('kaboom')
    }) as unknown as ProbeExec
    const signIn = await agySignIn(exec)
    expect(signIn).toMatchObject({ state: 'unknown', detail: 'kaboom' })
  })

  it('passes the given timeout to both steps', async () => {
    const exec = fakeExec({ models: MODELS_OK, usage: USAGE_OK })
    await checkAgy(exec, { bin: 'agy', timeoutMs: 3_000 })
    expect(exec.calls.map((c) => c.timeoutMs)).toEqual([3_000, 3_000])
  })
})

describe('agyQuota', () => {
  it('runs agy -p /usage and reads its lines', async () => {
    const exec = fakeExec({ usage: USAGE_OK })
    const quota = await agyQuota(exec, 'agy')
    expect(exec.calls[0]).toEqual({ cmd: 'agy', args: ['-p', '/usage'], timeoutMs: 15_000 })
    expect(quota?.lines).toHaveLength(5)
  })

  it('is undefined when the output cannot be read or the command fails', async () => {
    expect(await agyQuota(fakeExec({ usage: { code: 0, stdout: 'nothing useful\n', stderr: '', timedOut: false } }))).toBeUndefined()
    expect(await agyQuota(fakeExec({ usage: { code: 1, stdout: USAGE, stderr: '', timedOut: false } }))).toBeUndefined()
    expect(await agyQuota(fakeExec({ usage: { code: null, stdout: '', stderr: '', timedOut: true } }))).toBeUndefined()
  })

  it('checkAgy runs /usage after a sign-in and keeps the quota', async () => {
    const exec = fakeExec({ models: MODELS_OK, usage: USAGE_OK })
    const check = await checkAgy(exec)
    expect(check.signIn.state).toBe('signed-in')
    expect(check.quota?.lines).toHaveLength(5)
    expect(exec.calls.map((c) => c.args)).toEqual([['models'], ['-p', '/usage']])
  })
})

describe('parseUsage and quotaFor', () => {
  it('parses /usage lines and ignores lines it cannot read', () => {
    expect(parseUsage(USAGE + '\nsomething else\n')).toHaveLength(5)
    expect(parseUsage(USAGE)[4]).toEqual({ group: 'Gemini 4 Argon', limit: 'Gemini 4 Argon Weekly Limit', remaining: 90, resetsAt: '2026-10-24T17:13:13Z' })
    expect(parseUsage('a\tb\tninety\tc\na\tb\t90%\n')).toEqual([])
  })

  it('reads Windows line endings', () => {
    expect(parseUsage(USAGE.replaceAll('\n', '\r\n'))[0]?.resetsAt).toBe('2026-10-24T03:48:07Z')
  })

  it('matches a model to its groups and takes the lowest', () => {
    const lines = parseUsage(USAGE)
    expect(quotaFor(lines, 'Gemini 4 Argon (Low)')?.remaining).toBe(90)
    expect(quotaFor(lines, 'Gemini 3.8 Flash (Low)')?.remaining).toBe(98)
    expect(quotaFor(lines, 'Claude Opus 5.5 (Low)')?.remaining).toBe(0)
    expect(quotaFor(lines, 'GPT-6 (High)')?.group).toBe('Claude and GPT models')
    expect(quotaFor(lines, undefined)).toBeUndefined()
  })

  it('matches a family as whole words, so Gemini 4 does not limit Gemini 4.5', () => {
    const lines = parseUsage('Gemini 4 Models\tGemini 4 Weekly Limit\t0%\t2026-10-24T00:00:00Z\n' + USAGE)
    expect(quotaFor(lines, 'Gemini 4.5 Flash (Low)')?.group).not.toBe('Gemini 4 Models')
    expect(quotaFor(lines, 'Gemini 4 Argon (Low)')?.group).toBe('Gemini 4 Models')
  })

  it('matches the id form of a model name', () => {
    const lines = parseUsage(USAGE)
    expect(quotaFor(lines, 'gemini-4-argon-low')?.group).toBe('Gemini 4 Argon')
    expect(quotaFor(lines, 'claude_opus_5.5')?.group).toBe('Claude and GPT models')
  })
})

describe('judge', () => {
  it('judges: signed out stops, 0% stops naming the group and reset, under 10% warns, unknown passes', () => {
    expect(judge({ signIn: { state: 'signed-out', ms: 1 }, at: 0 }, 'x').stop).toMatch(/signed out\. Run agy once to sign in/)
    expect(judge({ signIn: { state: 'signed-in', ms: 1 }, quota: { lines: parseUsage(USAGE), ms: 1 }, at: 0 }, 'Claude Opus 5.5').stop).toMatch(/Claude and GPT models.*0%.*2026-10-17T23:00:45Z/)
    expect(judge({ signIn: { state: 'unknown', ms: 1 }, at: 0 }, 'x')).toEqual({})
  })

  it('uses the exact wording', () => {
    expect(judge({ signIn: { state: 'signed-out', ms: 1 }, at: 0 }, undefined)).toEqual({
      stop: 'antigravity is signed out. Run agy once to sign in, then start again.',
    })
    const quota = { lines: parseUsage(USAGE), ms: 1 }
    expect(judge({ signIn: { state: 'signed-in', ms: 1 }, quota, at: 0 }, 'Claude Opus 5.5 (Low)')).toEqual({
      stop: 'antigravity has no quota left for Claude Opus 5.5 (Low) (Claude and GPT models: 0%, resets 2026-10-17T23:00:45Z).',
    })
    const low = { lines: parseUsage(USAGE.replace('\t90%\t', '\t7%\t')), ms: 1 }
    expect(judge({ signIn: { state: 'signed-in', ms: 1 }, quota: low, at: 0 }, 'Gemini 4 Argon (Low)')).toEqual({
      warn: 'antigravity quota is low for Gemini 4 Argon (Low): Gemini 4 Argon 7% left.',
    })
  })

  it('passes at 10% and above, without a quota, or without a model', () => {
    const quota = { lines: parseUsage(USAGE.replace('\t90%\t', '\t10%\t')), ms: 1 }
    expect(judge({ signIn: { state: 'signed-in', ms: 1 }, quota, at: 0 }, 'Gemini 4 Argon (Low)')).toEqual({})
    expect(judge({ signIn: { state: 'signed-in', ms: 1 }, at: 0 }, 'Claude Opus 5.5')).toEqual({})
    expect(judge({ signIn: { state: 'signed-in', ms: 1 }, quota, at: 0 }, undefined)).toEqual({})
  })
})

describe('quotaRecheck', () => {
  // Failed batches can follow each other faster than /usage answers. A read
  // still out already answers the question the next failure asks, and
  // stacking more only fills the log with the same line.
  it('starts no second /usage while one is still out', async () => {
    let answer: ((r: ProbeResult) => void) | undefined
    const calls: string[][] = []
    const exec: ProbeExec = (_cmd, args) => {
      calls.push(args)
      return new Promise((resolve) => (answer = resolve))
    }
    const logged: Array<Record<string, unknown>> = []
    const recheck = quotaRecheck(exec, (_kind, fields) => logged.push(fields), '/opt/agy')
    recheck.afterFailure()
    recheck.afterFailure()
    recheck.afterFailure()
    expect(calls).toHaveLength(1)
    answer!(USAGE_OK)
    await recheck.settle()
    expect(logged).toHaveLength(1)
    // Once the read has answered, the next failure asks again.
    recheck.afterFailure()
    expect(calls).toHaveLength(2)
    answer!(USAGE_OK)
    await recheck.settle()
    expect(logged).toHaveLength(2)
  })
})
