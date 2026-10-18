import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A child that closes the way a Windows shell-path agent does after an answered
// kill: taskkill /F ends the tree, and close reports exit code 1 with no
// signal. taskkill cannot run here, so spawn is replaced by a child that is
// driven by hand, and the test plays that close itself.
const children: FakeChild[] = []
class FakeChild extends EventEmitter {
  pid = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn(() => true)
}
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    spawn: vi.fn(() => {
      const child = new FakeChild()
      children.push(child)
      return child
    }),
  }
})

const { runAgent } = await import('../../src/agent/run.js')
const { openRunLog, withRunLog } = await import('../../src/logs/run-log.js')

const ANSWER = { results: [{ id: 1, problem: false, categories: [], reason: 'ok' }] }
const ENVELOPE = JSON.stringify({ conversation_id: 'c1', status: 'SUCCESS', response: JSON.stringify(ANSWER), structured_output: ANSWER })

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'polyglots-answered-kill-home-'))
  process.env.POLYGLOTS_HOME = home
  children.length = 0
})
afterEach(() => {
  delete process.env.POLYGLOTS_HOME
  rmSync(home, { recursive: true, force: true })
})

const exitLine = (path: string): Record<string, unknown> | undefined =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((l) => l.kind === 'agent-exit')

async function answeredThenClosed(code: number | null, signal: NodeJS.Signals | null): Promise<Record<string, unknown> | undefined> {
  const log = openRunLog({ runId: 1, startedAt: 0, debug: false })
  const pending = withRunLog(log, () => runAgent('p', { type: 'object' }, { provider: 'antigravity', bin: 'agy', mcpConfigPath: '', timeoutMs: 10_000 }))
  const child = children[0]!
  child.stdout.write(ENVELOPE + '\n')
  await pending
  expect(child.kill).toHaveBeenCalled()
  child.emit('close', code, signal)
  return exitLine(log.path)
}

describe('agent-exit after an answered kill', () => {
  it('keeps killed: answered when the kill ends the agent with a code and no signal', async () => {
    expect(await answeredThenClosed(1, null)).toMatchObject({ code: 1, signal: null, killed: 'answered' })
  })

  it('records an agent that exited cleanly before the kill landed as not killed', async () => {
    expect(await answeredThenClosed(0, null)).toMatchObject({ code: 0, signal: null, killed: null })
  })

  it('keeps killed: answered for a SIGKILL', async () => {
    expect(await answeredThenClosed(null, 'SIGKILL')).toMatchObject({ code: null, signal: 'SIGKILL', killed: 'answered' })
  })
})
