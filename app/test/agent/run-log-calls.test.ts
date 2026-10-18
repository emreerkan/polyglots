import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgent } from '../../src/agent/run.js'
import { logRunEvent, openRunLog, withRunLog } from '../../src/logs/run-log.js'

// The envelope antigravity prints: conversation_id is the id its own log uses.
const ANSWER = { results: [{ id: 1, problem: false, categories: [], reason: 'ok' }] }
const ENVELOPE = JSON.stringify({ conversation_id: 'c1', status: 'SUCCESS', response: JSON.stringify(ANSWER), structured_output: ANSWER })

let dir: string
let home: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'polyglots-agent-calls-'))
  home = mkdtempSync(join(tmpdir(), 'polyglots-agent-calls-home-'))
  process.env.POLYGLOTS_HOME = home
})
afterEach(() => {
  delete process.env.POLYGLOTS_HOME
  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

// A stand-in agy, as in hung-agent.test.ts: reads the prompt, waits, prints
// what it is given, then exits or, like the real one while it hangs, ignores
// SIGTERM and never exits. Each call gets its own script file, so two calls
// made at once never rewrite a script the other is about to exec.
let bins = 0
function fakeAgy(output: string, opts: { exit?: boolean; delayMs?: number } = {}): string {
  const bin = join(dir, `agy-${++bins}`)
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env node',
      "process.on('SIGTERM', () => {})",
      "process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => {",
      `  process.stdout.write(${JSON.stringify(output)})`,
      opts.exit ? '  process.exitCode = 0' : '  setInterval(() => {}, 1000)',
      `}, ${opts.delayMs ?? 0}))`,
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  return bin
}
const linesOf = (path: string): Array<Record<string, any>> =>
  readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

describe('agent call lines in the run log', () => {
  it('writes agent-spawn and agent-exit for a call made inside a run log', async () => {
    const log = openRunLog({ runId: 1, startedAt: 0, debug: false })
    logRunEvent(log, { type: 'batch-start', index: 2, of: 3, size: 1, at: 0 } as never)
    await withRunLog(log, () => runAgent('p', { type: 'object' }, { provider: 'antigravity', bin: fakeAgy(ENVELOPE + '\n', { exit: true }), mcpConfigPath: '', timeoutMs: 10_000, cwd: dir }))
    // The answer is read the moment its line is whole, before the agent's
    // close; the exit line is written on close.
    await new Promise((r) => setTimeout(r, 300))
    const [spawn, exit] = linesOf(log.path).filter((l) => l.kind.startsWith('agent-'))
    expect(spawn).toMatchObject({ kind: 'agent-spawn', provider: 'antigravity', batch: 2, attempt: 1, pid: expect.any(Number), timeoutMs: 10_000 })
    expect(exit).toMatchObject({ kind: 'agent-exit', pid: spawn!.pid, batch: 2, attempt: 1, session: 'c1', stdoutBytes: ENVELOPE.length + 1, stderrBytes: 0, ms: expect.any(Number) })
  }, 20_000)

  // antigravity's answer is taken, and the process killed, as soon as its line
  // is whole, so even one that would have exited by itself is usually killed
  // first. claude has no such shortcut and is always waited for, which makes it
  // the provider whose own clean exit can be pinned.
  it('records an agent that exits by itself as code 0, not killed, with claude\'s session_id', async () => {
    const log = openRunLog({ runId: 1, startedAt: 0, debug: false })
    const envelope = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's1', result: '', structured_output: ANSWER })
    await withRunLog(log, () => runAgent('p', { type: 'object' }, { provider: 'claude', bin: fakeAgy(envelope + '\n', { exit: true }), mcpConfigPath: '', timeoutMs: 10_000, cwd: dir }))
    const exit = linesOf(log.path).find((l) => l.kind === 'agent-exit')
    expect(exit).toMatchObject({ code: 0, signal: null, killed: null, session: 's1', batch: 0, attempt: 1 })
  }, 20_000)

  it('counts attempts within a batch and starts again at the next', async () => {
    const log = openRunLog({ runId: 1, startedAt: 0, debug: false })
    const call = () => runAgent('p', { type: 'object' }, { provider: 'antigravity', bin: fakeAgy(ENVELOPE + '\n'), mcpConfigPath: '', timeoutMs: 10_000, cwd: dir })
    logRunEvent(log, { type: 'batch-start', index: 1, of: 2, size: 1, at: 0 } as never)
    await withRunLog(log, call)
    await withRunLog(log, call)
    logRunEvent(log, { type: 'batch-start', index: 2, of: 2, size: 1, at: 0 } as never)
    await withRunLog(log, call)
    await new Promise((r) => setTimeout(r, 300))
    const pairs = (kind: string) => linesOf(log.path).filter((l) => l.kind === kind).map((l) => [l.batch, l.attempt])
    expect(pairs('agent-spawn')).toEqual([[1, 1], [1, 2], [2, 1]])
    expect(pairs('agent-exit')).toEqual([[1, 1], [1, 2], [2, 1]])
  }, 20_000)

  it('marks an answer read from a hung agent as killed: answered', async () => {
    const log = openRunLog({ runId: 1, startedAt: 0, debug: false })
    await withRunLog(log, () => runAgent('p', { type: 'object' }, { provider: 'antigravity', bin: fakeAgy(ENVELOPE + '\n'), mcpConfigPath: '', timeoutMs: 10_000, cwd: dir }))
    await new Promise((r) => setTimeout(r, 300)) // close fires after the SIGKILL
    const exit = linesOf(log.path).find((l) => l.kind === 'agent-exit')
    expect(exit).toMatchObject({ killed: 'answered', signal: 'SIGKILL' })
  }, 20_000)

  it('marks a timeout as killed: timeout', async () => {
    const log = openRunLog({ runId: 1, startedAt: 0, debug: false })
    await expect(
      withRunLog(log, () => runAgent('p', { type: 'object' }, { provider: 'antigravity', bin: fakeAgy(ENVELOPE.slice(0, 40)), mcpConfigPath: '', timeoutMs: 1_500, killGraceMs: 200, cwd: dir })),
    ).rejects.toThrow(/timed out/)
    await new Promise((r) => setTimeout(r, 600))
    expect(linesOf(log.path).find((l) => l.kind === 'agent-exit')).toMatchObject({ killed: 'timeout', stdoutBytes: 40, session: null })
  }, 20_000)

  it('writes nothing outside a run log', async () => {
    await runAgent('p', { type: 'object' }, { provider: 'antigravity', bin: fakeAgy(ENVELOPE + '\n', { exit: true }), mcpConfigPath: '', timeoutMs: 10_000, cwd: dir })
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(join(process.env.POLYGLOTS_HOME!, 'data', 'logs'))).toBe(false)
  }, 20_000)

  it('keeps two concurrent runs apart', async () => {
    const a = openRunLog({ runId: 1, startedAt: 0, debug: false })
    const b = openRunLog({ runId: 2, startedAt: 0, debug: false })
    const call = () => runAgent('p', { type: 'object' }, { provider: 'antigravity', bin: fakeAgy(ENVELOPE + '\n', { exit: true, delayMs: 50 }), mcpConfigPath: '', timeoutMs: 10_000, cwd: dir })
    await Promise.all([withRunLog(a, call), withRunLog(b, call)])
    await new Promise((r) => setTimeout(r, 300))
    const spawnsA = linesOf(a.path).filter((l) => l.kind === 'agent-spawn')
    const spawnsB = linesOf(b.path).filter((l) => l.kind === 'agent-spawn')
    expect(spawnsA).toHaveLength(1)
    expect(spawnsB).toHaveLength(1)
    expect(spawnsA[0]!.pid).not.toBe(spawnsB[0]!.pid)
    expect(linesOf(a.path).filter((l) => l.kind === 'agent-exit').map((l) => l.pid)).toEqual([spawnsA[0]!.pid])
    expect(linesOf(b.path).filter((l) => l.kind === 'agent-exit').map((l) => l.pid)).toEqual([spawnsB[0]!.pid])
  }, 20_000)
})
