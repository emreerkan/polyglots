import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgent } from '../../src/agent/run.js'
import { providerSpec } from '../../src/agent/providers.js'

// antigravity 1.4.0, run on a captured 25-entry review prompt four times,
// wrote its complete answer to stdout every time and did not exit three times
// out of four. Waiting for the exit lost every such batch to the twenty-minute
// limit, twice, and left its entries unreviewed.
const ANSWER = { results: [{ id: 1, problem: false, categories: [], reason: 'ok' }] }
const ENVELOPE = JSON.stringify({ conversation_id: 'c1', status: 'SUCCESS', response: JSON.stringify(ANSWER), structured_output: ANSWER })

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'polyglots-hung-agent-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// A stand-in agy: reads the prompt, prints what it is given, then ignores
// SIGTERM and never exits, as the real one does while it hangs.
function fakeAgy(output: string): string {
  const pidFile = join(dir, 'pid')
  const bin = join(dir, 'agy')
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env node',
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
      "process.on('SIGTERM', () => {})",
      "process.stdin.resume(); process.stdin.on('end', () => {",
      `  process.stdout.write(${JSON.stringify(output)})`,
      '  setInterval(() => {}, 1000)',
      '})',
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  return bin
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const pidOf = () => Number(readFileSync(join(dir, 'pid'), 'utf8'))

describe('an antigravity that answers and then hangs', () => {
  it('takes the complete answer without waiting for the exit, and kills the process', async () => {
    const bin = fakeAgy(ENVELOPE + '\n')
    const started = Date.now()
    const out = await runAgent('prompt', { type: 'object' }, { provider: 'antigravity', bin, mcpConfigPath: '', timeoutMs: 30_000, cwd: dir })
    expect(out).toEqual(ANSWER)
    expect(Date.now() - started).toBeLessThan(10_000)
    await new Promise((r) => setTimeout(r, 200))
    expect(alive(pidOf())).toBe(false)
  }, 40_000)

  it('still waits, and times out, on an answer that is not complete', async () => {
    const bin = fakeAgy(ENVELOPE.slice(0, 40))
    await expect(
      runAgent('prompt', { type: 'object' }, { provider: 'antigravity', bin, mcpConfigPath: '', timeoutMs: 1_500, killGraceMs: 200, cwd: dir }),
    ).rejects.toThrow(/timed out/)
    // SIGTERM is ignored, so the kill grace has to end in SIGKILL.
    await new Promise((r) => setTimeout(r, 600))
    expect(alive(pidOf())).toBe(false)
  }, 20_000)
})

describe('antigravity answerComplete', () => {
  const done = providerSpec('antigravity').answerComplete!
  it('is true for one whole envelope line, whatever its status', () => {
    expect(done(ENVELOPE + '\n')).toBe(true)
    expect(done(JSON.stringify({ status: 'ERROR', error: 'quota' }) + '\n')).toBe(true)
  })
  it('is false until the line ends, and for anything that is not an envelope', () => {
    expect(done(ENVELOPE)).toBe(false)
    expect(done(ENVELOPE.slice(0, 50) + '\n')).toBe(false)
    expect(done('Loading...\n')).toBe(false)
    expect(done('{"conversation_id":"c1"}\n')).toBe(false)
  })
  it('is not offered for claude, which exits on its own', () => {
    expect(providerSpec('claude').answerComplete).toBeUndefined()
  })
})
