import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { liveAgents, trackAgent } from '../../src/agent/children.js'
import { stopOnSignal } from '../../src/jobs/stop-on-signal.js'

// Signals are emitted, never sent: emitting runs the listeners without the
// operating system's default action, which here would end the test worker.
describe('stopOnSignal', () => {
  let unwatch = () => {}
  afterEach(() => unwatch())

  it.each(['SIGINT', 'SIGTERM'] as const)('on %s records the stop, then sends the signal on', (sig) => {
    const order: string[] = []
    unwatch = stopOnSignal({
      busy: () => true,
      stop: () => void order.push('stop'),
      raise: (s) => void order.push(`raise ${s}`),
    })
    process.emit(sig, sig)
    expect(order).toEqual(['stop', `raise ${sig}`])
  })

  // Ctrl+C or a kill during a run ends this process by the default action,
  // which runs no exit handler, so the agents are killed here.
  it('kills the running agents before sending the signal on', async () => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' })
    trackAgent(child)
    const ended = new Promise((done) => child.once('exit', (_c, signal) => done(signal)))
    unwatch = stopOnSignal({ busy: () => false, stop: () => {}, raise: () => {} })
    process.emit('SIGTERM', 'SIGTERM')
    expect(await ended).toBe('SIGKILL')
    expect(liveAgents()).toBe(0)
  })

  it('records nothing when no run is going, and still sends the signal on', () => {
    const stop = vi.fn()
    const raise = vi.fn()
    unwatch = stopOnSignal({ busy: () => false, stop, raise })
    process.emit('SIGINT', 'SIGINT')
    expect(stop).not.toHaveBeenCalled()
    expect(raise).toHaveBeenCalledWith('SIGINT')
  })

  it('sends the signal on even when recording the stop throws', () => {
    const raise = vi.fn()
    unwatch = stopOnSignal({ busy: () => true, stop: () => { throw new Error('locked') }, raise })
    process.emit('SIGTERM', 'SIGTERM')
    expect(raise).toHaveBeenCalledWith('SIGTERM')
  })

  it('detaches before sending the signal on, so the second delivery is not caught again', () => {
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') }
    let during = -1
    unwatch = stopOnSignal({ busy: () => true, stop: () => {}, raise: () => (during = process.listenerCount('SIGINT')) })
    expect(process.listenerCount('SIGINT')).toBe(before.int + 1)
    process.emit('SIGINT', 'SIGINT')
    expect(during).toBe(before.int)
    expect(process.listenerCount('SIGTERM')).toBe(before.term)
  })

  it('does not listen for SIGHUP, which is the terminal going away', () => {
    const before = process.listenerCount('SIGHUP')
    unwatch = stopOnSignal({ busy: () => true, stop: () => {}, raise: () => {} })
    expect(process.listenerCount('SIGHUP')).toBe(before)
  })
})
