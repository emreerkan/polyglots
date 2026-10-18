import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agyLogName, agyLogsBetween, debugEnabled } from '../../src/logs/debug.js'

describe('debugEnabled', () => {
  const off = { config: {} }
  it('is on for the flag, POLYGLOTS_DEBUG=1 or config debug: true', () => {
    expect(debugEnabled({ ...off, flag: true })).toBe(true)
    expect(debugEnabled({ ...off, env: { POLYGLOTS_DEBUG: '1' } })).toBe(true)
    expect(debugEnabled({ config: { debug: true }, env: {} })).toBe(true)
  })

  it('is off by default, for POLYGLOTS_DEBUG=0 and for config debug: false', () => {
    expect(debugEnabled({ ...off, env: {} })).toBe(false)
    expect(debugEnabled({ ...off, env: { POLYGLOTS_DEBUG: '0' } })).toBe(false)
    expect(debugEnabled({ config: { debug: false }, env: {} })).toBe(false)
    expect(debugEnabled({ ...off, flag: false, env: {} })).toBe(false)
  })
})

describe('agyLogsBetween', () => {
  let home: string
  let dir: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'polyglots-agy-logs-'))
    dir = join(home, '.gemini', 'antigravity-cli', 'log')
    mkdirSync(dir, { recursive: true })
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const at = (ms: number) => {
    const name = agyLogName(ms)
    writeFileSync(join(dir, name), 'x')
    return join(dir, name)
  }

  it('lists the logs whose name time is inside the call, allowing two seconds before it', () => {
    const from = new Date(2026, 9, 17, 22, 0, 10, 400).getTime()
    const to = from + 30_000
    const before = at(from - 5_000)
    const justBefore = at(from - 2_000)
    const inside = at(from + 1_000)
    const after = at(to + 5_000)
    writeFileSync(join(dir, 'notes.txt'), 'not a log')
    const found = agyLogsBetween(from, to, home)
    expect(found).toEqual([justBefore, inside].sort())
    expect(found).not.toContain(before)
    expect(found).not.toContain(after)
  })

  it('names files in local time, the way agy does', () => {
    expect(agyLogName(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('cli-20260102_030405.log')
  })

  it('is empty when there is no log folder', () => {
    expect(agyLogsBetween(0, Date.now(), join(home, 'nobody'))).toEqual([])
  })
})
