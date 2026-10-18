import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOG_RETENTION_MS, logsDir, mcpLogPath, pruneLogs, runLogStem } from '../../src/logs/paths.js'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'polyglots-logs-')); process.env.POLYGLOTS_HOME = home })
afterEach(() => { delete process.env.POLYGLOTS_HOME; rmSync(home, { recursive: true, force: true }) })

describe('log paths', () => {
  it('lives under the data folder, so POLYGLOTS_HOME moves it', () => {
    expect(logsDir()).toBe(join(home, 'data', 'logs'))
  })
  it('names a run by its start time and id, with no colon or dot in the time', () => {
    expect(runLogStem(Date.UTC(2026, 9, 17, 20, 13, 8, 123), 306)).toBe('2026-10-17T20-13-08-123Z-run306')
  })
  it('names the MCP log by local date', () => {
    expect(mcpLogPath(new Date(2026, 9, 17, 23, 59).getTime())).toBe(join(home, 'data', 'logs', 'mcp-2026-10-17.jsonl'))
  })
  it('prunes its own files and folders older than 14 days, and nothing else', () => {
    const dir = logsDir(); mkdirSync(dir, { recursive: true })
    const now = Date.now(); const old = (now - LOG_RETENTION_MS - 60_000) / 1000
    const names = ['2026-01-01T00-00-00-000Z-run1.jsonl', 'mcp-2026-01-01.jsonl', 'report-2026-01-01T00-00-00-000Z-run1.json.gz', 'notes.txt']
    for (const n of names) { writeFileSync(join(dir, n), 'x'); utimesSync(join(dir, n), old, old) }
    mkdirSync(join(dir, '2026-01-01T00-00-00-000Z-run1')); utimesSync(join(dir, '2026-01-01T00-00-00-000Z-run1'), old, old)
    writeFileSync(join(dir, '2026-10-17T00-00-00-000Z-run9.jsonl'), 'fresh')
    pruneLogs(now)
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true)
    expect(existsSync(join(dir, '2026-10-17T00-00-00-000Z-run9.jsonl'))).toBe(true)
    for (const n of names.slice(0, 3)) expect(existsSync(join(dir, n))).toBe(false)
    expect(existsSync(join(dir, '2026-01-01T00-00-00-000Z-run1'))).toBe(false)
  })
  it('does nothing when the folder does not exist', () => {
    expect(() => pruneLogs()).not.toThrow()
  })
})
