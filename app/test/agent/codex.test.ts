import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CODEX_DISABLED_FEATURES,
  codexAnswerComplete,
  codexMcpArgs,
  codexProbeArgs,
  codexSettings,
  codexUsage,
  dropNulls,
  readCodexStream,
  readLoginStatus,
  strictSchema,
} from '../../src/agent/codex.js'
import { AgentError } from '../../src/agent/providers.js'
import { auditBatchJsonSchema } from '../../src/audit/schema.js'
import { reviewBatchJsonSchema } from '../../src/review/schema.js'

const line = (o: unknown): string => `${JSON.stringify(o)}\n`
const msg = (text: string): string =>
  line({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text } })
const ANSWER = '{"results":[{"id":1,"problem":false,"categories":[],"reason":"","fix":null}]}'
const usage = {
  input_tokens: 10,
  cached_input_tokens: 4,
  output_tokens: 3,
  reasoning_output_tokens: 2,
}
const head = line({ type: 'thread.started', thread_id: 't' }) + line({ type: 'turn.started' })
const good = head + msg(ANSWER) + line({ type: 'turn.completed', usage })

describe('strictSchema', () => {
  it('closes every object and requires every property, optional ones nullable', () => {
    const s = strictSchema(auditBatchJsonSchema) as any
    expect(s.additionalProperties).toBe(false)
    const item = s.properties.results.items
    expect(item.additionalProperties).toBe(false)
    expect([...item.required].sort()).toEqual(['categories', 'fix', 'id', 'problem', 'reason'])
    expect(item.properties.fix.type).toEqual(['array', 'null'])
    expect(item.properties.fix.minItems).toBeUndefined()
    expect(item.properties.id).toEqual({ type: 'integer', minimum: 1 })
  })
  it('leaves an already strict schema as it was', () => {
    expect(strictSchema(reviewBatchJsonSchema)).toEqual(reviewBatchJsonSchema)
  })
  it('does not change its input', () => {
    const before = structuredClone(auditBatchJsonSchema)
    strictSchema(auditBatchJsonSchema)
    expect(auditBatchJsonSchema).toEqual(before)
  })
})

describe('dropNulls', () => {
  it('removes null fields recursively and keeps the rest', () => {
    expect(dropNulls({ a: null, b: 0, c: [{ d: null, e: '' }], f: { g: null } })).toEqual({
      b: 0,
      c: [{ e: '' }],
      f: {},
    })
  })
})

describe('readCodexStream', () => {
  it('returns the last agent message parsed, nulls dropped', () => {
    expect(readCodexStream(good)).toEqual({
      results: [{ id: 1, problem: false, categories: [], reason: '' }],
    })
  })
  it('ignores other item types and takes the last agent message', () => {
    const s =
      head +
      msg('{"first":true}') +
      line({ type: 'item.completed', item: { id: 'm', type: 'mcp_tool_call' } }) +
      msg('{"second":true}')
    expect(readCodexStream(s)).toEqual({ second: true })
  })
  it('throws the turn.failed message, even after an agent message', () => {
    const s = head + msg(ANSWER) + line({ type: 'turn.failed', error: { message: 'model is not supported' } })
    expect(() => readCodexStream(s)).toThrow(/model is not supported/)
    expect(() => readCodexStream(s)).toThrow(AgentError)
  })
  it('throws an error event message', () => {
    const s = head + line({ type: 'error', message: 'stream broke' })
    expect(() => readCodexStream(s)).toThrow(/stream broke/)
  })
  it('throws naming the missing answer when no agent message came', () => {
    expect(() => readCodexStream(head)).toThrow(/no answer/)
  })
  it('skips lines that are not JSON', () => {
    expect(readCodexStream(`warning: hi\n${good}`)).toEqual({
      results: [{ id: 1, problem: false, categories: [], reason: '' }],
    })
  })
  it('throws when the agent message is not JSON', () => {
    expect(() => readCodexStream(head + msg('sorry, no'))).toThrow(/not JSON/)
  })
})

describe('codexAnswerComplete', () => {
  it('is false mid-stream and true once turn.completed or turn.failed ends a line', () => {
    expect(codexAnswerComplete(head + msg(ANSWER))).toBe(false)
    expect(codexAnswerComplete(good)).toBe(true)
    expect(codexAnswerComplete(head + line({ type: 'turn.failed', error: { message: 'x' } }))).toBe(true)
  })
  it('is false for a turn.completed line with no trailing newline', () => {
    expect(codexAnswerComplete(head + JSON.stringify({ type: 'turn.completed', usage }))).toBe(false)
  })
})

describe('codexUsage', () => {
  it('reads input, cached, output and reasoning tokens from turn.completed', () => {
    expect(codexUsage(good)).toEqual({ input: 10, cached: 4, output: 3, reasoning: 2 })
  })
  it('is undefined with no turn.completed', () => {
    expect(codexUsage(head)).toBeUndefined()
  })
})

describe('codexSettings', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'codex-settings-'))
    dirs.push(d)
    return d
  }
  const homeWith = (toml: string): string => {
    const home = tmp()
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'config.toml'), toml)
    return home
  }

  it('reads model and model_reasoning_effort before the first table', () => {
    const home = homeWith(
      'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"\n[mcp_servers.x]\nmodel = "other"',
    )
    expect(codexSettings({}, home)).toEqual({ model: 'gpt-5.6-luna', effort: 'low' })
  })
  it('uses CODEX_HOME when set', () => {
    const ch = tmp()
    writeFileSync(join(ch, 'config.toml'), 'model = "x"\n')
    const home = homeWith('model = "wrong"\n')
    expect(codexSettings({ CODEX_HOME: ch }, home)).toEqual({ model: 'x' })
  })
  it('reads a missing or unreadable file, or keys only under a table, as unset', () => {
    expect(codexSettings({}, tmp())).toEqual({})
    const unreadable = tmp()
    mkdirSync(join(unreadable, '.codex', 'config.toml'), { recursive: true })
    expect(codexSettings({}, unreadable)).toEqual({})
    expect(codexSettings({}, homeWith('[a]\nmodel = "b"\n'))).toEqual({})
  })
  it('ignores comments and single-quoted values the same way', () => {
    const home = homeWith("# model = \"no\"\nmodel = 'a' # note\nmodel_reasoning_effort = \"high\" # hi\n")
    expect(codexSettings({}, home)).toEqual({ model: 'a', effort: 'high' })
  })
})

describe('codexMcpArgs', () => {
  it('turns command, args and env into -c flags and approves the tools', () => {
    const json = JSON.stringify({
      mcpServers: {
        polyglots: { command: '/usr/bin/node', args: ['/a b/server.js'], env: { POLYGLOTS_LOCALE: 'tr_TR' } },
      },
    })
    expect(codexMcpArgs(json)).toEqual([
      '-c', 'mcp_servers.polyglots.command="/usr/bin/node"',
      '-c', 'mcp_servers.polyglots.args=["/a b/server.js"]',
      '-c', 'mcp_servers.polyglots.env.POLYGLOTS_LOCALE="tr_TR"',
      '-c', 'mcp_servers.polyglots.default_tools_approval_mode="approve"',
    ])
  })
  it('writes a Windows path and a quote so each value reads back as written', () => {
    const command = 'C:\\Program Files\\nodejs\\node.exe'
    const home = 'C:\\Users\\a"b'
    const args = codexMcpArgs(
      JSON.stringify({ mcpServers: { polyglots: { command, args: [], env: { POLYGLOTS_HOME: home } } } }),
    )
    const values = args.filter((_, i) => i % 2 === 1)
    const read = (prefix: string): unknown => {
      const v = values.find((x) => x.startsWith(prefix))!
      return JSON.parse(v.slice(v.indexOf('=') + 1))
    }
    expect(read('mcp_servers.polyglots.command')).toBe(command)
    expect(read('mcp_servers.polyglots.env.POLYGLOTS_HOME')).toBe(home)
  })
  it('throws AgentError when the file has no polyglots server', () => {
    expect(() => codexMcpArgs('{"mcpServers":{}}')).toThrow(AgentError)
    expect(() => codexMcpArgs('nope')).toThrow(AgentError)
  })
})

describe('codexProbeArgs', () => {
  it('builds the no-MCP argv with model and effort', () => {
    const a = codexProbeArgs({ model: 'm', effort: 'low' })
    expect(a.slice(0, 7)).toEqual([
      'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--json', '--sandbox', 'read-only',
    ])
    expect(a.slice(7, 11)).toEqual(['-m', 'm', '-c', 'model_reasoning_effort="low"'])
    expect(a.slice(-3)).toEqual(['-c', 'web_search="disabled"', '-'])
    expect(a.filter((x) => x === '--disable')).toHaveLength(CODEX_DISABLED_FEATURES.length)
    expect(CODEX_DISABLED_FEATURES).toEqual([
      'shell_tool', 'unified_exec', 'multi_agent', 'plugins', 'apps', 'image_generation',
      'browser_use', 'computer_use', 'view_image', 'skill_search', 'tool_suggest',
    ])
  })
  it('omits model and effort when not given', () => {
    const a = codexProbeArgs({})
    expect(a).not.toContain('-m')
    expect(a.join(' ')).not.toContain('model_reasoning_effort')
    expect(a[7]).toBe('--disable')
  })
})

describe('readLoginStatus', () => {
  const r = (o: Partial<Parameters<typeof readLoginStatus>[0]>) =>
    readLoginStatus({ code: 0, stdout: '', stderr: '', timedOut: false, ...o })
  it('reads signed in from either stream', () => {
    expect(r({ stderr: 'Logged in using ChatGPT\n' })).toEqual({ state: 'signed-in', detail: 'ChatGPT' })
    expect(r({ stdout: 'Logged in using an API key' })).toEqual({ state: 'signed-in', detail: 'an API key' })
  })
  it('reads signed out', () => {
    expect(r({ code: 1, stderr: 'Not logged in' })).toEqual({
      state: 'signed-out',
      detail: 'not logged in (run: codex login)',
    })
  })
  it('reads a timeout and anything else as unknown', () => {
    expect(r({ timedOut: true, code: null })).toEqual({ state: 'unknown', detail: 'login status timed out' })
    expect(r({ stdout: 'weird' }).state).toBe('unknown')
  })
})
