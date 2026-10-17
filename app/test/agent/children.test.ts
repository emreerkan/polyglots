import { afterEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { killAgents, liveAgents, trackAgent } from '../../src/agent/children.js'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const exited = (child: ReturnType<typeof spawn>) =>
  new Promise<NodeJS.Signals | null>((done) => child.once('exit', (_code, signal) => done(signal)))
// A process that ignores SIGTERM, as antigravity does while it waits on its
// own shutdown: only SIGKILL ends it.
const STUBBORN = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"

describe('agent children', () => {
  afterEach(() => killAgents())

  it('kills a tracked agent that is still running, even one that ignores SIGTERM', async () => {
    const child = spawn(process.execPath, ['-e', STUBBORN], { stdio: 'ignore' })
    trackAgent(child)
    expect(liveAgents()).toBe(1)
    const ended = exited(child)
    killAgents()
    expect(await ended).toBe('SIGKILL')
    expect(liveAgents()).toBe(0)
  })

  it('forgets an agent once it exits by itself', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    trackAgent(child)
    await exited(child)
    expect(liveAgents()).toBe(0)
    expect(() => killAgents()).not.toThrow()
  })

  // The bug itself: the app quits with process.exit(), and on POSIX a child is
  // not ended with its parent. A hung agy was found alive with pid 1 as its
  // parent after the run that started it had gone.
  it('kills the agents of a process that exits, so none is left behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polyglots-children-'))
    try {
      const script = join(dir, 'parent.ts')
      writeFileSync(
        script,
        [
          `import { spawn } from 'node:child_process'`,
          `import { trackAgent } from ${JSON.stringify(resolve('src/agent/children.ts'))}`,
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(STUBBORN)}], { stdio: 'ignore' })`,
          `trackAgent(child)`,
          `process.stdout.write(String(child.pid))`,
          `setTimeout(() => process.exit(0), 200)`,
        ].join('\n'),
      )
      const run = spawnSync(resolve('node_modules/.bin/tsx'), [script], { encoding: 'utf8', timeout: 20_000 })
      const pid = Number(run.stdout.trim())
      expect(pid).toBeGreaterThan(0)
      expect(alive(pid)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
