import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgent } from '../../src/agent/run.js'
import { openRunLog, withRunLog } from '../../src/logs/run-log.js'

// A stand-in codex driven end to end through runAgent, as the antigravity
// fakes are. The real one is never run: it spends a request on a plan.
const ANSWER = { results: [{ id: 1, problem: false, categories: [], reason: 'ok' }] }
const line = (o: unknown): string => `${JSON.stringify(o)}\n`
const USAGE = { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3, reasoning_output_tokens: 2 }
// codex writes the strict form, so an optional field comes back as null and
// is dropped on the way in.
const MESSAGE = line({
  type: 'item.completed',
  item: { id: 'i1', type: 'agent_message', text: JSON.stringify({ results: [{ ...ANSWER.results[0], fix: null }] }) },
})
const SUCCESS = line({ type: 'thread.started', thread_id: 't1' }) + line({ type: 'turn.started' }) + MESSAGE + line({ type: 'turn.completed', usage: USAGE })

let dir: string
let mcpConfigPath: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'polyglots-codex-run-'))
  mcpConfigPath = join(dir, 'mcp.json')
  writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { polyglots: { command: 'node', args: ['server.js'], env: {} } } }))
  process.env.POLYGLOTS_HOME = dir
})
afterEach(() => {
  delete process.env.POLYGLOTS_HOME
  rmSync(dir, { recursive: true, force: true })
})

// Records its argv and stdin, prints `output` once stdin ends, then exits or,
// with `hang`, ignores SIGTERM and never exits.
function fakeCodex(output: string, hang = false): string {
  const bin = join(dir, 'codex')
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs')",
      `fs.writeFileSync(${JSON.stringify(join(dir, 'argv.json'))}, JSON.stringify(process.argv.slice(2)))`,
      "process.on('SIGTERM', () => {})",
      "let input = ''",
      "process.stdin.setEncoding('utf8').on('data', (c) => (input += c))",
      "process.stdin.on('end', () => {",
      `  fs.writeFileSync(${JSON.stringify(join(dir, 'stdin.txt'))}, input)`,
      `  process.stdout.write(${JSON.stringify(output)})`,
      hang ? '  setInterval(() => {}, 1000)' : '',
      '})',
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  return bin
}

// The agent-exit line of a run log, polled for: close follows the answer and
// the log write follows close, and a fixed sleep failed on a loaded machine.
async function exitLine(path: string, waitMs = 5_000): Promise<Record<string, unknown> | undefined> {
  const read = (): Record<string, unknown> | undefined =>
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l !== '')
      // The writer may be part way through the last line when this reads.
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Record<string, unknown>]
        } catch {
          return []
        }
      })
      .find((l) => l.kind === 'agent-exit')
  const deadline = Date.now() + waitMs
  let exit = read()
  while (exit === undefined && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
    exit = read()
  }
  return exit
}

describe('codex through runAgent', () => {
  it('returns the parsed answer, with prompt on stdin and the exec argv', async () => {
    const bin = fakeCodex(SUCCESS)
    const out = await runAgent('the prompt', { type: 'object' }, { provider: 'codex', bin, mcpConfigPath, cwd: dir, timeoutMs: 30_000 })
    expect(out).toEqual(ANSWER)
    expect(readFileSync(join(dir, 'stdin.txt'), 'utf8')).toBe('the prompt')
    const argv = JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8')) as string[]
    expect(argv.slice(0, 2)).toEqual(['exec', '--ignore-user-config'])
    expect(argv.at(-1)).toBe('-')
  }, 40_000)

  it('stops waiting once the turn has completed, even if codex never exits', async () => {
    const bin = fakeCodex(SUCCESS, true)
    const started = Date.now()
    const out = await runAgent('p', { type: 'object' }, { provider: 'codex', bin, mcpConfigPath, cwd: dir, timeoutMs: 30_000 })
    expect(out).toEqual(ANSWER)
    expect(Date.now() - started).toBeLessThan(2_000)
  }, 40_000)

  // codex says why a turn failed only in the stream; stderr stays empty.
  it('rejects with the message of a failed turn', async () => {
    const bin = fakeCodex(line({ type: 'turn.started' }) + line({ type: 'turn.failed', error: { message: 'usage limit reached' } }))
    await expect(runAgent('p', { type: 'object' }, { provider: 'codex', bin, mcpConfigPath, cwd: dir, timeoutMs: 30_000 })).rejects.toThrow(
      /usage limit reached/,
    )
  }, 40_000)

  // codex exits by itself once the turn is done. Killing it the moment
  // turn.completed arrived logged every answered call as killed by SIGKILL,
  // which read as a hang in every run log, and cut codex's own shutdown short.
  it('logs a codex that exits right after its turn as an exit, not a kill', async () => {
    const bin = fakeCodex(SUCCESS)
    const log = openRunLog({ runId: 1, startedAt: 0, debug: false })
    await withRunLog(log, () => runAgent('p', { type: 'object' }, { provider: 'codex', bin, mcpConfigPath, cwd: dir, timeoutMs: 30_000 }))
    expect(await exitLine(log.path)).toMatchObject({ code: 0, signal: null, killed: null })
  }, 40_000)

  it('still ends a codex that hangs after its turn, once the grace has run out', async () => {
    const bin = fakeCodex(SUCCESS, true)
    const log = openRunLog({ runId: 1, startedAt: 0, debug: false })
    await withRunLog(log, () => runAgent('p', { type: 'object' }, { provider: 'codex', bin, mcpConfigPath, cwd: dir, timeoutMs: 30_000 }))
    expect(await exitLine(log.path, 10_000)).toMatchObject({ killed: 'answered', signal: 'SIGKILL' })
  }, 40_000)

  // The token counts are the one cost signal codex gives.
  it('writes the usage of the turn into agent-exit', async () => {
    const bin = fakeCodex(SUCCESS)
    const log = openRunLog({ runId: 1, startedAt: 0, debug: false })
    await withRunLog(log, () => runAgent('p', { type: 'object' }, { provider: 'codex', bin, mcpConfigPath, cwd: dir, timeoutMs: 30_000 }))
    // close follows the answer and the log write follows close. A fixed sleep
    // made this fail on a loaded machine and waste 300 ms on a fast one, so
    // poll for the line with a deadline.
    const read = (): Record<string, unknown> | undefined =>
      readFileSync(log.path, 'utf8')
        .trim()
        .split('\n')
        .filter((l) => l !== '')
        // The writer may be part way through the last line when this reads,
        // and a half line must read as not yet there rather than throw out
        // of the poll that exists to wait for it.
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as Record<string, unknown>]
          } catch {
            return []
          }
        })
        .find((l) => l.kind === 'agent-exit')
    const deadline = Date.now() + 5_000
    let exit = read()
    while (exit === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
      exit = read()
    }
    expect(exit?.usage).toEqual({ input: 10, cached: 4, output: 3, reasoning: 2 })
  }, 40_000)
})
