import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { translateFile, type TranslateEvent, type TranslateOptions } from '../../../src/commands/translate.js'
import { createRunControl } from '../../../src/run-control.js'
import { fakeEngine, fakeReview, makeWorkspace, type Workspace } from './helpers.js'

let ws: Workspace

beforeEach(async () => {
  ws = await makeWorkspace()
})

afterEach(async () => {
  await ws.cleanup()
})

function base(overrides: Partial<TranslateOptions> = {}): TranslateOptions {
  return {
    file: ws.file,
    locale: 'tr',
    mode: 'pending',
    draftEngine: 'deepl',
    mcpConfigPath: join(ws.home, 'mcp.json'),
    batchSize: 25,
    engine: fakeEngine(),
    review: fakeReview(),
    ...overrides,
  }
}

const logsDir = () => join(process.env.POLYGLOTS_HOME!, 'data', 'logs')

function runLogText(): string {
  const [file] = readdirSync(logsDir()).filter((n) => n.endsWith('.jsonl'))
  return readFileSync(join(logsDir(), file!), 'utf8')
}

describe('translateFile: the run log', () => {
  it('writes run-start, the batch events and run-end, and no draft text', async () => {
    await translateFile(base())
    const text = runLogText()
    const kinds = text.trim().split('\n').map((l) => JSON.parse(l).kind)
    expect(kinds[0]).toBe('run-start')
    expect(kinds).toContain('batch-start')
    expect(kinds).not.toContain('entries')
    expect(kinds.at(-1)).toBe('run-end')
    // The fake engine's drafts all start with this, and the always-on log
    // holds counts and reasons, never catalogue text.
    expect(text).not.toContain('[draft]')
    const start = JSON.parse(text.split('\n')[0]!)
    expect(start).toMatchObject({
      command: 'translate',
      locale: 'tr',
      engine: 'deepl',
      batchSize: 25,
      version: expect.any(String),
      node: process.version,
      platform: process.platform,
      pid: process.pid,
    })
    expect(JSON.parse(text.trim().split('\n').at(-1)!)).toMatchObject({ kind: 'run-end', ended: 'done', translated: 7 })
  })

  // Translate's start event is sent before the log is open, so unlike a
  // review's it never reaches the log, and a failed translate's log had no
  // file totals. run-start carries them instead.
  it('names the file total and the pending count in run-start', async () => {
    const summary = await translateFile(base())
    const start = JSON.parse(runLogText().split('\n')[0]!)
    expect(summary.pending).toBeGreaterThan(0)
    expect(start).toMatchObject({ kind: 'run-start', total: summary.total, pending: summary.pending })
  })

  it('records a run that threw as ended: failed', async () => {
    const onProgress = (e: TranslateEvent) => {
      if (e.type === 'batch-start') throw new Error('caller')
    }
    await expect(translateFile(base({ onProgress }))).rejects.toThrow('caller')
    const last = JSON.parse(runLogText().trim().split('\n').at(-1)!)
    expect(last).toMatchObject({ kind: 'run-end', ended: 'failed', error: 'caller' })
  })

  it('records a run the failure breaker stopped as reason: breaker', async () => {
    const engine = fakeEngine()
    engine.failWith = () => new Error('deepl exploded')
    const summary = await translateFile(base({ engine, batchSize: 1 }))
    expect(summary.stopped).toMatch(/batches failed in a row/)
    const last = JSON.parse(runLogText().trim().split('\n').at(-1)!)
    expect(last).toMatchObject({ kind: 'run-end', ended: 'stopped', reason: 'breaker' })
  })

  it('records a run the person stopped without a reason', async () => {
    const control = createRunControl()
    const review = fakeReview()
    review.failWith = () => {
      control.stop()
      return undefined
    }
    const summary = await translateFile(base({ review, batchSize: 1, control }))
    expect(summary.stopped).toMatch(/^stopped before batch/)
    const last = JSON.parse(runLogText().trim().split('\n').at(-1)!)
    expect(last).toMatchObject({ kind: 'run-end', ended: 'stopped' })
    expect(last.reason).toBeUndefined()
  })

  it('finishes with the same summary when the log folder cannot be written', async () => {
    const logs = logsDir()
    mkdirSync(logs, { recursive: true })
    chmodSync(logs, 0o500)
    const errs: string[] = []
    try {
      const summary = await translateFile(base({ onWarn: (l: string) => errs.push(l) }))
      expect(summary.translated).toBeGreaterThan(0)
    } finally {
      chmodSync(logs, 0o700)
    }
    expect(errs.filter((l) => /run log/.test(l))).toHaveLength(1)
  })

  it('says once, at the start, where a debug run keeps its files, and writes it in the log', async () => {
    const warned: string[] = []
    await translateFile(base({ debug: true, onWarn: (l: string) => warned.push(l) }))
    const notices = warned.filter((l) => l.startsWith('Debug mode: '))
    expect(notices).toHaveLength(1)
    const dir = notices[0]!.replace('Debug mode: prompts and agent output are saved in ', '')
    expect(dir.startsWith(logsDir())).toBe(true)
    const lines = runLogText().trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[1]).toMatchObject({ kind: 'debug', dir })
  })

  it('says nothing about debug mode when it is off', async () => {
    const warned: string[] = []
    await translateFile(base({ onWarn: (l: string) => warned.push(l) }))
    expect(warned).toEqual([])
    expect(runLogText()).not.toContain('"kind":"debug"')
  })
})
