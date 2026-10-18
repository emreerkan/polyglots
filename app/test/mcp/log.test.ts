import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { openDb, upsertTm } from '../../src/storage/index.js'
import { registerTools } from '../../src/mcp/tools.js'
import { logsDir, mcpLogPath } from '../../src/logs/paths.js'

type Handler = (args: Record<string, unknown>) => unknown

// Records the handlers rather than serving them, so a test can call one
// directly and see what reaches the caller without a transport in between.
function fakeServer(): { server: McpServer; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  const server = {
    registerTool(name: string, _schema: unknown, handler: Handler) {
      handlers.set(name, handler)
    },
  } as unknown as McpServer
  return { server, handlers }
}

function logLines(): Record<string, unknown>[] {
  return readFileSync(mcpLogPath(), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('mcp log', () => {
  it('appends one line per tool call with sizes and counts, never the text', async () => {
    const db = openDb(':memory:')
    upsertTm(db, [
      { source: 'Secret source', target: 'Gizli kaynak', locale: 'tr' },
      { source: 'Secret sources', target: 'Gizli kaynaklar', locale: 'tr' },
    ])
    const { server, handlers } = fakeServer()
    registerTools(server, { db, locale: 'tr', ttlDays: 30 })
    const args = { text: 'Secret source', locale: 'tr' }

    const result = (await handlers.get('tm_lookup')!(args)) as { isError?: boolean; content: { text: string }[] }

    expect(result.isError).not.toBe(true)
    const matches = JSON.parse(result.content[0]!.text) as unknown[]
    const lines = logLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      tool: 'tm_lookup',
      argBytes: Buffer.byteLength(JSON.stringify(args)),
      pid: process.pid,
      ppid: process.ppid,
      results: matches.length,
      error: null,
    })
    expect(typeof lines[0]!.t).toBe('number')
    expect(typeof lines[0]!.ms).toBe('number')
    expect(readFileSync(mcpLogPath(), 'utf8')).not.toContain('Secret source')
    expect(readFileSync(mcpLogPath(), 'utf8')).not.toContain('Gizli')
    db.close()
  })

  it('records a failed call and still hands the caller its tool error', async () => {
    const db = openDb(':memory:')
    const { server, handlers } = fakeServer()
    registerTools(server, { db, locale: 'tr', ttlDays: 30 })
    db.close()

    const result = (await handlers.get('tm_lookup')!({ text: 'Secret source' })) as {
      isError?: boolean
      content: { text: string }[]
    }

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).not.toBe('')
    const lines = logLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ tool: 'tm_lookup', results: null, error: result.content[0]!.text })
    expect(readFileSync(mcpLogPath(), 'utf8')).not.toContain('Secret source')
  })

  it('keeps the source string a failed wp.org lookup carries in its URL out of the log', async () => {
    const db = openDb(':memory:')
    const { server, handlers } = fakeServer()
    const message = 'GET https://translate.wordpress.org/consistency/?search=Secret%20source&set=tr%2Fdefault failed: 429 Too Many Requests'
    registerTools(server, {
      db,
      locale: 'tr',
      ttlDays: 30,
      fetchConsistency: async () => {
        throw new Error(message)
      },
    })

    const result = (await handlers.get('consistency_lookup')!({ text: 'Secret source' })) as {
      isError?: boolean
      content: { text: string }[]
    }

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe(message)
    const lines = logLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ tool: 'consistency_lookup', results: null })
    expect(lines[0]!.error).toBe('GET https://translate.wordpress.org/consistency/?… failed: 429 Too Many Requests')
    expect(readFileSync(mcpLogPath(), 'utf8')).not.toContain('Secret')
    db.close()
  })

  it('logs every tool, not only the translation memory', async () => {
    const db = openDb(':memory:')
    const { server, handlers } = fakeServer()
    registerTools(server, { db, locale: 'tr', ttlDays: 30, fetchConsistency: async () => [] })

    await handlers.get('glossary_lookup')!({ term: 'Settings' })
    await handlers.get('consistency_lookup')!({ text: 'Settings' })

    expect(logLines().map((l) => [l.tool, l.results])).toEqual([
      ['glossary_lookup', 0],
      ['consistency_lookup', 0],
    ])
    db.close()
  })

  it('does not create the log until a tool is called', () => {
    const db = openDb(':memory:')
    registerTools(fakeServer().server, { db, locale: 'tr', ttlDays: 30 })
    expect(existsSync(mcpLogPath())).toBe(false)
    db.close()
  })

  it('answers the call even when the log cannot be written', async () => {
    const db = openDb(':memory:')
    // A file where the folder should be: every append fails.
    mkdirSync(join(logsDir(), '..'), { recursive: true })
    writeFileSync(logsDir(), '')
    const { server, handlers } = fakeServer()
    registerTools(server, { db, locale: 'tr', ttlDays: 30 })

    const result = (await handlers.get('tm_lookup')!({ text: 'Secret source' })) as { isError?: boolean }

    expect(result.isError).not.toBe(true)
    db.close()
  })

  it('prunes logs older than the retention when the tools are registered', () => {
    mkdirSync(logsDir(), { recursive: true })
    const old = join(logsDir(), 'mcp-2020-01-01.jsonl')
    writeFileSync(old, '{}\n')
    const ancient = new Date('2020-01-02T00:00:00Z')
    utimesSync(old, ancient, ancient)
    const db = openDb(':memory:')
    registerTools(fakeServer().server, { db, locale: 'tr', ttlDays: 30 })
    expect(existsSync(old)).toBe(false)
    db.close()
  })
})
