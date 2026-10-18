import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentRunLog, logRunEvent, openRunLog, withRunLog } from '../../src/logs/run-log.js'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'polyglots-runlog-')); process.env.POLYGLOTS_HOME = home })
afterEach(() => { delete process.env.POLYGLOTS_HOME; rmSync(home, { recursive: true, force: true }) })
const asRoot = process.getuid?.() === 0
const lines = (path: string) => readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l))

describe('run log', () => {
  it('writes one JSON line per call, with a time and a kind', () => {
    const log = openRunLog({ runId: 3, startedAt: 0, debug: false })
    log.write('run-start', { command: 'review' })
    const [line] = lines(log.path)
    expect(line).toMatchObject({ kind: 'run-start', command: 'review', t: expect.any(Number) })
  })
  it('keeps entries events out of the always-on log', () => {
    const log = openRunLog({ runId: 3, startedAt: 0, debug: false })
    logRunEvent(log, { type: 'batch-start', index: 1, of: 2, size: 5, at: 1 } as never)
    logRunEvent(log, { type: 'entries', index: 1, entries: [{ key: 'k', msgid: 'Secret text' }] } as never)
    expect(readFileSync(log.path, 'utf8')).not.toContain('Secret text')
    expect(lines(log.path).map((l) => l.kind)).toEqual(['batch-start'])
  })
  it('in debug mode writes entries to the debug folder instead', () => {
    const log = openRunLog({ runId: 3, startedAt: 0, debug: true })
    logRunEvent(log, { type: 'entries', index: 1, entries: [{ key: 'k', msgid: 'Text' }] } as never)
    expect(readFileSync(join(log.debugDir!, 'entries.jsonl'), 'utf8')).toContain('Text')
    expect(readFileSync(log.path, 'utf8')).not.toContain('Text')
  })
  it('keeps a warning\'s text out of the always-on log, and in the debug folder in debug mode', () => {
    // A draft engine's placeholder warning quotes the msgid it is about.
    const message = 'openai: draft for "Secret text %s" lost placeholder(s) %s'
    const quiet = openRunLog({ runId: 3, startedAt: 0, debug: false })
    logRunEvent(quiet, { type: 'warning', message } as never)
    expect(readFileSync(quiet.path, 'utf8')).not.toContain('Secret text')
    expect(lines(quiet.path)).toEqual([expect.objectContaining({ kind: 'warning', chars: message.length })])
    const loud = openRunLog({ runId: 4, startedAt: 0, debug: true })
    logRunEvent(loud, { type: 'warning', message } as never)
    expect(readFileSync(loud.path, 'utf8')).not.toContain('Secret text')
    expect(readFileSync(join(loud.debugDir!, 'warnings.jsonl'), 'utf8')).toContain('Secret text')
  })
  it('counts attempts within the current batch', () => {
    const log = openRunLog({ runId: 3, startedAt: 0, debug: false })
    logRunEvent(log, { type: 'batch-start', index: 4, of: 9, size: 1, at: 1 } as never)
    expect(log.nextCall()).toEqual({ batch: 4, attempt: 1 })
    expect(log.nextCall()).toEqual({ batch: 4, attempt: 2 })
    logRunEvent(log, { type: 'batch-start', index: 5, of: 9, size: 1, at: 2 } as never)
    expect(log.nextCall()).toEqual({ batch: 5, attempt: 1 })
  })
  // Root writes through a 0500 folder, so as root these would pass without
  // ever reaching the failure they are about.
  it.skipIf(asRoot)('never throws when the folder cannot be written, and warns once', () => {
    const dir = join(home, 'data', 'logs'); mkdirSync(dir, { recursive: true }); chmodSync(dir, 0o500)
    const warn = vi.fn()
    try {
      const log = openRunLog({ runId: 3, startedAt: 0, debug: false, warn })
      expect(() => { log.write('a'); log.write('b') }).not.toThrow()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      // Before the assertions could fail, not after: a read-only folder left
      // behind makes the next test's cleanup fail instead of this one.
      chmodSync(dir, 0o700)
    }
  })
  it('is current inside withRunLog, and only there, also across awaits', async () => {
    const log = openRunLog({ runId: 3, startedAt: 0, debug: false })
    expect(currentRunLog()).toBeUndefined()
    await withRunLog(log, async () => {
      await new Promise((r) => setTimeout(r, 5))
      expect(currentRunLog()).toBe(log)
    })
    expect(currentRunLog()).toBeUndefined()
  })
  it('keeps two concurrent runs apart', async () => {
    const a = openRunLog({ runId: 1, startedAt: 0, debug: false })
    const b = openRunLog({ runId: 2, startedAt: 0, debug: false })
    const seen: string[] = []
    await Promise.all([
      withRunLog(a, async () => { await new Promise((r) => setTimeout(r, 10)); seen.push(`a:${currentRunLog()?.path === a.path}`) }),
      withRunLog(b, async () => { await new Promise((r) => setTimeout(r, 1)); seen.push(`b:${currentRunLog()?.path === b.path}`) }),
    ])
    expect(seen.sort()).toEqual(['a:true', 'b:true'])
  })
  it('never throws on a field JSON cannot hold, and keeps writing the lines after it', () => {
    const warn = vi.fn()
    const log = openRunLog({ runId: 3, startedAt: 0, debug: true, warn })
    expect(() => log.write('odd', { n: 10n })).not.toThrow()
    expect(() => logRunEvent(log, { type: 'entries', index: 1, entries: [{ n: 10n }] } as never)).not.toThrow()
    log.write('after')
    expect(lines(log.path).map((l) => l.kind)).toEqual(['after'])
    expect(warn).toHaveBeenCalled()
  })
  it('keeps the run log going when the debug folder cannot be written, and names the file that failed', () => {
    const warn = vi.fn()
    const log = openRunLog({ runId: 3, startedAt: 0, debug: true, warn })
    // A file where the folder should be: every debug write fails, the log does not.
    mkdirSync(join(home, 'data', 'logs'), { recursive: true })
    writeFileSync(log.debugDir!, '')
    logRunEvent(log, { type: 'entries', index: 1, entries: [{ key: 'k', msgid: 'Text' }] } as never)
    logRunEvent(log, { type: 'entries', index: 2, entries: [{ key: 'k', msgid: 'Text' }] } as never)
    log.write('after')
    expect(lines(log.path).map((l) => l.kind)).toEqual(['after'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain(join(log.debugDir!, 'entries.jsonl'))
  })
  it.skipIf(asRoot)('names the run log in its warning when the log itself cannot be written', () => {
    const dir = join(home, 'data', 'logs'); mkdirSync(dir, { recursive: true }); chmodSync(dir, 0o500)
    const warn = vi.fn()
    try {
      const log = openRunLog({ runId: 3, startedAt: 0, debug: false, warn })
      expect(warn.mock.calls[0]![0]).toContain(log.path)
    } finally {
      chmodSync(dir, 0o700)
    }
  })
  it('does not serialize an entries event when debug is off', () => {
    const toJSON = vi.fn(() => 'x')
    const log = openRunLog({ runId: 3, startedAt: 0, debug: false })
    logRunEvent(log, { type: 'entries', index: 1, entries: [{ toJSON }] } as never)
    expect(toJSON).not.toHaveBeenCalled()
  })
  it('creates no debug folder when debug is off', () => {
    const log = openRunLog({ runId: 3, startedAt: 0, debug: false })
    expect(log.debugDir).toBeUndefined()
    expect(existsSync(log.path.replace(/\.jsonl$/, ''))).toBe(false)
  })
})
