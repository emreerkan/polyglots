import { describe, expect, it, vi } from 'vitest'
import { agyQuota, agySignIn, checkAgy, judge, parseUsage, quotaFor, quotaRecheck } from '../../src/agent/agy-check.js'
import type { ProbeExec, ProbeResult } from '../../src/agent/discover.js'
import { checkCodex, checkFor, gateRun, hasProviderCheck, CODEX_PREFLIGHT_WAIT_MS, PREFLIGHT_WAIT_MS, ProviderRefusal, type ProviderCheck } from '../../src/agent/agy-check.js'
import { CODEX_DISABLED_FEATURES } from '../../src/agent/codex.js'
import { DEFAULT_CONFIG } from '../../src/config.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

// codex's check, against the same kind of fake exec. The real codex is never
// started: step two spends a request on the person's plan.

const ev = (o: unknown): string => `${JSON.stringify(o)}\n`
const LOGGED_IN: ProbeResult = { code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n', timedOut: false }
const LOGGED_OUT: ProbeResult = { code: 1, stdout: 'Not logged in\n', stderr: '', timedOut: false }
const turnFailed = (message: string): ProbeResult => ({
  code: 1,
  stdout: ev({ type: 'thread.started', thread_id: 't' }) + ev({ type: 'turn.started' }) + ev({ type: 'turn.failed', error: { message } }),
  stderr: '',
  timedOut: false,
})
const ANSWERED: ProbeResult = {
  code: 0,
  stdout: ev({ type: 'thread.started', thread_id: 't' }) + ev({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'OK' } }) + ev({ type: 'turn.completed', usage: {} }),
  stderr: '',
  timedOut: false,
}

interface CodexCall { cmd: string; args: string[]; timeoutMs: number; input?: string }
function fakeCodex(answers: { login?: ProbeResult; exec?: ProbeResult }) {
  const calls: CodexCall[] = []
  const exec: ProbeExec = async (cmd, args, opts) => {
    calls.push({ cmd, args, timeoutMs: opts.timeoutMs, ...(opts.input === undefined ? {} : { input: opts.input }) })
    const answer = args[0] === 'login' ? answers.login : args[0] === 'exec' ? answers.exec : undefined
    return answer ?? { code: null, stdout: '', stderr: 'spawn ENOENT', timedOut: false }
  }
  return Object.assign(exec, { calls })
}

describe('checkCodex', () => {
  it('stops at signed out and never spends the model request', async () => {
    const exec = fakeCodex({ login: LOGGED_OUT, exec: ANSWERED })
    const check = await checkCodex(exec, { bin: '/opt/codex', model: 'gpt-x' })
    expect(check.provider).toBe('codex')
    expect(check.signIn.state).toBe('signed-out')
    expect(check.model).toBeUndefined()
    expect(exec.calls.map((c) => c.args)).toEqual([['login', 'status']])
    expect(exec.calls[0]!.cmd).toBe('/opt/codex')
  })

  it('runs one model check after a sign-in, with the model and effort, the prompt on stdin and no MCP', async () => {
    const exec = fakeCodex({ login: LOGGED_IN, exec: ANSWERED })
    const check = await checkCodex(exec, { bin: 'codex', model: 'gpt-x', effort: 'low' })
    expect(check).toMatchObject({ provider: 'codex', signIn: { state: 'signed-in' }, model: { state: 'ok' }, asked: { model: 'gpt-x', effort: 'low' } })
    expect(check.quota).toBeUndefined()
    expect(exec.calls).toHaveLength(2)
    const step = exec.calls[1]!
    expect(step.input).toBe('Reply with OK.')
    expect(step.args.slice(0, 2)).toEqual(['exec', '--ignore-user-config'])
    expect(step.args).toContain('-m')
    expect(step.args[step.args.indexOf('-m') + 1]).toBe('gpt-x')
    expect(step.args).toContain('model_reasoning_effort="low"')
    for (const f of CODEX_DISABLED_FEATURES) expect(step.args).toContain(f)
    expect(step.args.some((a) => a.includes('mcp_servers'))).toBe(false)
  })

  it('leaves -m and the effort off when neither resolved', async () => {
    const exec = fakeCodex({ login: LOGGED_IN, exec: ANSWERED })
    const check = await checkCodex(exec, { bin: 'codex' })
    const step = exec.calls[1]!.args
    expect(step).not.toContain('-m')
    expect(step.some((a) => a.startsWith('model_reasoning_effort'))).toBe(false)
    expect(check.asked).toEqual({})
  })

  it('reads a model the plan lacks as refused, keeping codex\'s message', async () => {
    const message = "The 'gpt-x' model is not supported when using Codex with a ChatGPT account."
    const check = await checkCodex(fakeCodex({ login: LOGGED_IN, exec: turnFailed(message) }), { bin: 'codex', model: 'gpt-x' })
    expect(check.model).toMatchObject({ state: 'refused', detail: message })
    for (const m of ['model gpt-x does not exist', 'Unknown model: gpt-x', 'You have no access to gpt-x', 'gpt-x is not available on your plan']) {
      const c = await checkCodex(fakeCodex({ login: LOGGED_IN, exec: turnFailed(m) }), { bin: 'codex', model: 'gpt-x' })
      expect(c.model?.state).toBe('refused')
    }
  })

  // The exact stream codex-cli 0.155.1 wrote for a model a ChatGPT plan
  // lacks: the message is the server's JSON body, both as an error event and
  // as the failed turn. The stop names the inner sentence only.
  it('stops on the live refusal with its inner message, not the JSON body', async () => {
    const body =
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.3-codex\' model is not supported when using Codex with a ChatGPT account."}}'
    const live: ProbeResult = {
      code: 1,
      stdout: ev({ type: 'thread.started', thread_id: 't' }) + ev({ type: 'turn.started' }) + ev({ type: 'error', message: body }) + ev({ type: 'turn.failed', error: { message: body } }),
      stderr: '',
      timedOut: false,
    }
    const check = await checkCodex(fakeCodex({ login: LOGGED_IN, exec: live }), { bin: 'codex', model: 'gpt-5.3-codex' })
    expect(check.model?.state).toBe('refused')
    expect(judge(check, 'gpt-5.3-codex').stop).toBe(
      "codex cannot use the model gpt-5.3-codex: The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account. Choose one your plan has: polyglots config set codex.model <name>",
    )
  })

  // A bare 429 inside a longer number (a request id, a token count) is not
  // a rate limit.
  it('does not read 429 inside another number as a rate limit', async () => {
    const c = await checkCodex(fakeCodex({ login: LOGGED_IN, exec: turnFailed('request 14290 failed: stream closed') }), { bin: 'codex' })
    expect(c.model?.state).toBe('unknown')
  })

  it('reads a rate limit as rate-limited', async () => {
    for (const m of ['Rate limit reached for requests', "You've hit your usage limit.", 'unexpected status 429 Too Many Requests']) {
      const c = await checkCodex(fakeCodex({ login: LOGGED_IN, exec: turnFailed(m) }), { bin: 'codex' })
      expect(c.model).toMatchObject({ state: 'rate-limited', detail: m })
    }
  })

  it('reads a timeout, garbage, another failure or a throw as unknown', async () => {
    const answers: ProbeResult[] = [
      { code: null, stdout: '', stderr: '', timedOut: true },
      { code: 0, stdout: 'not json at all\n', stderr: '', timedOut: false },
      { code: 2, stdout: '', stderr: 'error: unexpected argument', timedOut: false },
      turnFailed('stream disconnected before completion'),
    ]
    for (const answer of answers) {
      const c = await checkCodex(fakeCodex({ login: LOGGED_IN, exec: answer }), { bin: 'codex' })
      expect(c.model?.state).toBe('unknown')
      expect(c.model?.detail).toBeTruthy()
    }
    let n = 0
    const throwing = (async () => {
      if (n++ === 0) return LOGGED_IN
      throw new Error('kaboom')
    }) as unknown as ProbeExec
    expect((await checkCodex(throwing, { bin: 'codex' })).model).toMatchObject({ state: 'unknown', detail: 'kaboom' })
  })

  it('never runs the model check on an unknown sign-in', async () => {
    const exec = fakeCodex({ login: { code: null, stdout: '', stderr: '', timedOut: true }, exec: ANSWERED })
    const check = await checkCodex(exec, { bin: 'codex' })
    expect(check.signIn.state).toBe('unknown')
    expect(exec.calls).toHaveLength(1)
  })
})

describe('hasProviderCheck and checkFor', () => {
  it('names antigravity and codex, and nothing else', () => {
    expect(hasProviderCheck('antigravity')).toBe(true)
    expect(hasProviderCheck('codex')).toBe(true)
    for (const p of ['claude', 'local', 'none'] as const) expect(hasProviderCheck(p)).toBe(false)
  })

  it('asks antigravity agy, and codex with the model and effort polyglots resolved', async () => {
    const agy = fakeExec({ models: MODELS_OUT })
    expect(await checkFor('antigravity', agy)).toMatchObject({ signIn: { state: 'signed-out' } })
    expect(agy.calls[0]!.args).toEqual(['models'])
    const codexHome = mkdtempSync(join(tmpdir(), 'polyglots-checkfor-codex-'))
    writeFileSync(join(codexHome, 'config.toml'), 'model = "toml-model"\nmodel_reasoning_effort = "high"\n')
    const exec = fakeCodex({ login: LOGGED_IN, exec: ANSWERED })
    const check = await checkFor('codex', exec, { env: { CODEX_HOME: codexHome } })
    expect(check).toMatchObject({ provider: 'codex', asked: { model: 'toml-model', effort: 'high' }, model: { state: 'ok' } })
  })

  // A run's --model is the model it will use, so it is the one checked, over
  // whatever the config names.
  it('checks the run\'s --model for codex over the configured one', async () => {
    const exec = fakeCodex({ login: LOGGED_IN, exec: ANSWERED })
    const config = { ...DEFAULT_CONFIG, reviewProvider: 'codex' as const, codex: { model: 'model-a' } }
    const check = await checkFor('codex', exec, { config, model: 'model-b', env: { CODEX_HOME: mkdtempSync(join(tmpdir(), 'polyglots-checkfor-flag-')) } })
    const step = exec.calls[1]!.args
    expect(step[step.indexOf('-m') + 1]).toBe('model-b')
    expect(check.asked?.model).toBe('model-b')
  })
})

const codexCheck = (over: Partial<ProviderCheck> = {}): ProviderCheck => ({
  provider: 'codex',
  signIn: { state: 'signed-in', ms: 1 },
  asked: { model: 'gpt-x' },
  at: 0,
  ...over,
})

describe('judge for codex', () => {
  it('words the sign-in stop for codex', () => {
    expect(judge(codexCheck({ signIn: { state: 'signed-out', ms: 1 } }), 'gpt-x')).toEqual({
      stop: 'codex is signed out. Run codex login, then start again.',
    })
  })

  it('stops a refused model with codex\'s message and the config hint', () => {
    const check = codexCheck({ model: { state: 'refused', detail: 'The model is not supported.', ms: 1 } })
    expect(judge(check, 'gpt-x')).toEqual({
      stop: 'codex cannot use the model gpt-x: The model is not supported. Choose one your plan has: polyglots config set codex.model <name>',
    })
    const none = codexCheck({ asked: {}, model: { state: 'refused', detail: 'no access', ms: 1 } })
    expect(judge(none, undefined).stop).toBe(
      "codex cannot use codex's default model: no access. Choose one your plan has: polyglots config set codex.model <name>",
    )
  })

  // A model that refuses the effort is fixed by the effort, not by another
  // model; pointing at codex.model sent people to change the wrong setting.
  it('points a refused reasoning effort at codex.effort', () => {
    const detail = "Reasoning effort 'ultra' is not supported for this model. Supported reasoning efforts: low, medium, high."
    const check = codexCheck({ asked: { model: 'gpt-x', effort: 'ultra' }, model: { state: 'refused', detail, ms: 1 } })
    expect(judge(check, 'gpt-x', 'ultra').stop).toBe(
      `codex cannot use the effort ultra with the model gpt-x: Reasoning effort 'ultra' is not supported for this model. Supported reasoning efforts: low, medium, high. Choose one it supports: polyglots config set codex.effort <level>`,
    )
  })

  it('warns once on a rate limit, and says nothing on unknown or ok', () => {
    expect(judge(codexCheck({ model: { state: 'rate-limited', detail: 'Rate limit reached', ms: 1 } }), 'gpt-x')).toEqual({
      warn: 'codex is rate limited: Rate limit reached',
    })
    expect(judge(codexCheck({ model: { state: 'unknown', detail: 'x', ms: 1 } }), 'gpt-x')).toEqual({})
    expect(judge(codexCheck({ model: { state: 'ok', ms: 1 } }), 'gpt-x')).toEqual({})
    expect(judge(codexCheck({ signIn: { state: 'unknown', ms: 1 } }), 'gpt-x')).toEqual({})
  })

  // A check for another model or effort says nothing about this run's: the
  // command line's --model is not something the check could have known.
  it('reads a model verdict only for the model and effort it asked about', () => {
    const refused = codexCheck({ asked: { model: 'gpt-x', effort: 'low' }, model: { state: 'refused', detail: 'not supported', ms: 1 } })
    expect(judge(refused, 'gpt-y', 'low')).toEqual({})
    expect(judge(refused, 'gpt-x', 'high')).toEqual({})
    expect(judge(refused, 'gpt-x', 'low').stop).toMatch(/cannot use the model gpt-x/)
    // Signed out is true of every model.
    expect(judge(codexCheck({ asked: { model: 'gpt-x' }, signIn: { state: 'signed-out', ms: 1 } }), 'gpt-y').stop).toMatch(/codex is signed out/)
  })
})

describe('gateRun per provider', () => {
  const log = () => {}
  const warn = () => {}

  it('waits thirty seconds for codex and ten for antigravity', async () => {
    expect(CODEX_PREFLIGHT_WAIT_MS).toBe(30_000)
    vi.useFakeTimers()
    try {
      const never = new Promise<ProviderCheck | undefined>(() => {})
      let codexDone = false
      const codex = gateRun({ preflight: never, provider: 'codex', model: undefined, log, warn }).then(() => (codexDone = true))
      let agyDone = false
      const agy = gateRun({ preflight: never, model: undefined, log, warn }).then(() => (agyDone = true))
      await vi.advanceTimersByTimeAsync(PREFLIGHT_WAIT_MS)
      expect(agyDone).toBe(true)
      expect(codexDone).toBe(false)
      await vi.advanceTimersByTimeAsync(CODEX_PREFLIGHT_WAIT_MS - PREFLIGHT_WAIT_MS)
      expect(codexDone).toBe(true)
      await Promise.all([codex, agy])
    } finally {
      vi.useRealTimers()
    }
  })

  // A check carries the provider it asked. One for another provider says
  // nothing about this run and must never stop it.
  it('passes over a check for another provider', async () => {
    const agyOut: ProviderCheck = { signIn: { state: 'signed-out', ms: 1 }, at: 0 }
    await expect(gateRun({ preflight: Promise.resolve(agyOut), provider: 'codex', model: 'gpt-x', log, warn })).resolves.toBeUndefined()
    const codexOut = codexCheck({ signIn: { state: 'signed-out', ms: 1 } })
    await expect(gateRun({ preflight: Promise.resolve(codexOut), model: 'm', log, warn })).resolves.toBeUndefined()
    await expect(gateRun({ preflight: Promise.resolve(codexOut), provider: 'codex', model: 'gpt-x', log, warn })).rejects.toBeInstanceOf(ProviderRefusal)
  })
})
