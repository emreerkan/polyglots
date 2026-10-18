import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { flushDebugCaptures, runAgent } from '../../src/agent/run.js'
import { stopOnSignal } from '../../src/jobs/stop-on-signal.js'
import { agyLogName } from '../../src/logs/debug.js'
import { logRunEvent, openRunLog, withRunLog } from '../../src/logs/run-log.js'

const ANSWER = { results: [{ id: 1, problem: false, categories: [], reason: 'ok' }] }
const ENVELOPE = JSON.stringify({ conversation_id: 'c1', status: 'SUCCESS', response: JSON.stringify(ANSWER), structured_output: ANSWER })
const CLAUDE_ENVELOPE = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's1', result: '', structured_output: ANSWER })

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'polyglots-debug-capture-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// A stand-in agent: reads the prompt, prints to stderr and stdout, then exits
// or hangs ignoring SIGTERM, like the real agy does.
let bins = 0
function fakeAgent(output: string, opts: { exit?: boolean; stderr?: string } = {}): string {
  const bin = join(dir, `agent-${++bins}`)
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env node',
      "process.on('SIGTERM', () => {})",
      "process.stdin.resume(); process.stdin.on('end', () => {",
      `  process.stderr.write(${JSON.stringify(opts.stderr ?? '')})`,
      `  process.stdout.write(${JSON.stringify(output)})`,
      opts.exit ? '  process.exitCode = 0' : '  setInterval(() => {}, 1000)',
      '})',
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  return bin
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))

describe('debug capture in spawnAgent', () => {
  it('saves the prompt, stdout and stderr of each call, named by batch and attempt', async () => {
    const log = openRunLog({ runId: 7, startedAt: 0, debug: true })
    logRunEvent(log, { type: 'batch-start', index: 2, of: 3, size: 1, at: 0 } as never)
    const bin = fakeAgent(CLAUDE_ENVELOPE + '\n', { exit: true, stderr: 'a warning on stderr\n' })
    await withRunLog(log, () => runAgent('the whole prompt', { type: 'object' }, { provider: 'claude', bin, mcpConfigPath: '', timeoutMs: 10_000, cwd: dir }))
    await settle()
    const stem = join(log.debugDir!, 'batch-002-attempt-1')
    expect(readFileSync(`${stem}.prompt.txt`, 'utf8')).toBe('the whole prompt')
    expect(readFileSync(`${stem}.stdout.txt`, 'utf8')).toBe(CLAUDE_ENVELOPE + '\n')
    expect(readFileSync(`${stem}.stderr.txt`, 'utf8')).toBe('a warning on stderr\n')
  }, 20_000)

  it('keeps what a timed-out agent printed before it was killed', async () => {
    const log = openRunLog({ runId: 7, startedAt: 0, debug: true })
    const partial = ENVELOPE.slice(0, 40)
    await expect(
      withRunLog(log, () => runAgent('p', { type: 'object' }, { provider: 'antigravity', bin: fakeAgent(partial), mcpConfigPath: '', timeoutMs: 1_500, killGraceMs: 200, cwd: dir })),
    ).rejects.toThrow(/timed out/)
    await settle(600)
    expect(readFileSync(join(log.debugDir!, 'batch-000-attempt-1.stdout.txt'), 'utf8')).toBe(partial)
  }, 20_000)

  it('copies the agy log that started during an antigravity call', async () => {
    const agyDir = join(homedir(), '.gemini', 'antigravity-cli', 'log')
    mkdirSync(agyDir, { recursive: true })
    const name = agyLogName(Date.now())
    writeFileSync(join(agyDir, name), 'agy said this')
    // One from an hour ago belongs to some other call.
    writeFileSync(join(agyDir, agyLogName(Date.now() - 3_600_000)), 'old')
    const log = openRunLog({ runId: 7, startedAt: 0, debug: true })
    await withRunLog(log, () => runAgent('p', { type: 'object' }, { provider: 'antigravity', bin: fakeAgent(ENVELOPE + '\n'), mcpConfigPath: '', timeoutMs: 10_000, cwd: dir }))
    await settle()
    const copies = readdirSync(log.debugDir!).filter((n) => n.includes('.agy-'))
    expect(copies).toEqual([`batch-000-attempt-1.agy-${name}`])
    expect(readFileSync(join(log.debugDir!, copies[0]!), 'utf8')).toBe('agy said this')
  }, 20_000)

  it('writes no debug files when debug is off', async () => {
    const log = openRunLog({ runId: 7, startedAt: 0, debug: false })
    await withRunLog(log, () => runAgent('p', { type: 'object' }, { provider: 'claude', bin: fakeAgent(CLAUDE_ENVELOPE + '\n', { exit: true }), mcpConfigPath: '', timeoutMs: 10_000, cwd: dir }))
    await settle()
    const logs = join(process.env.POLYGLOTS_HOME!, 'data', 'logs')
    expect(log.debugDir).toBeUndefined()
    expect(readdirSync(logs).filter((n) => !n.endsWith('.jsonl'))).toEqual([])
    expect(existsSync(log.path.replace(/\.jsonl$/, ''))).toBe(false)
  }, 20_000)

  // Ctrl+C and SIGTERM end the process by the signal's default action, and
  // the app quits through process.exit(); either way the agent is killed and
  // the process gone before the child's close event, which is where the
  // output used to be written. A hung call the person gave up on is the one
  // debug mode is for, so its output is flushed on the way out.
  it('keeps what a hung agent printed when the run is stopped by a signal', async () => {
    const log = openRunLog({ runId: 7, startedAt: 0, debug: true })
    const partial = ENVELOPE.slice(0, 40)
    const call = withRunLog(log, () =>
      runAgent('p', { type: 'object' }, { provider: 'antigravity', bin: fakeAgent(partial), mcpConfigPath: '', timeoutMs: 60_000, cwd: dir }),
    ).catch(() => {})
    const stdout = join(log.debugDir!, 'batch-000-attempt-1.stdout.txt')
    await settle(800)
    expect(existsSync(stdout)).toBe(false)
    const unwatch = stopOnSignal({ busy: () => false, stop: () => {}, raise: () => {} })
    try {
      process.emit('SIGTERM', 'SIGTERM')
      // Read before yielding: the real signal leaves no turn for close to run.
      expect(readFileSync(stdout, 'utf8')).toBe(partial)
    } finally {
      unwatch()
    }
    await call
  }, 20_000)

  it('flushes a call still in flight when the process exits', async () => {
    const log = openRunLog({ runId: 7, startedAt: 0, debug: true })
    const partial = ENVELOPE.slice(0, 30)
    const bin = fakeAgent(partial, { stderr: 'still waiting\n' })
    const call = withRunLog(log, () =>
      runAgent('p', { type: 'object' }, { provider: 'antigravity', bin, mcpConfigPath: '', timeoutMs: 1_500, killGraceMs: 200, cwd: dir }),
    ).catch(() => {})
    await settle(800)
    expect(process.listeners('exit')).toContain(flushDebugCaptures)
    flushDebugCaptures()
    const stem = join(log.debugDir!, 'batch-000-attempt-1')
    expect(readFileSync(`${stem}.stdout.txt`, 'utf8')).toBe(partial)
    expect(readFileSync(`${stem}.stderr.txt`, 'utf8')).toBe('still waiting\n')
    await call
    await settle(600)
  }, 20_000)
})
