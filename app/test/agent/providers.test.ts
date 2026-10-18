import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentModel,
  agentSpawnModel,
  AgentError,
  codexEngineLabel,
  configuredModel,
  DEFAULT_PROVIDER,
  isReviewProvider,
  MCP_TOOLS,
  PROVIDERS,
  providerSpec,
  resolveAgentBin,
  schemaArgument,
} from '../../src/agent/providers.js'
import { buildAgentArgs, readAgentOutput } from '../../src/agent/run.js'
import { CODEX_DISABLED_FEATURES, codexMcpArgs, codexProbeArgs, strictSchema } from '../../src/agent/codex.js'
import { auditBatchJsonSchema } from '../../src/audit/schema.js'
import { DEFAULT_CONFIG } from '../../src/config.js'

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } } }
const base = { mcpConfigPath: '/tmp/mcp.json' }

describe('provider registry', () => {
  it('defaults to claude, which is what every cached verdict was formed under', () => {
    expect(DEFAULT_PROVIDER).toBe('claude')
    expect(providerSpec().name).toBe('claude')
    expect(providerSpec(undefined).name).toBe('claude')
  })

  // Discovery reads these off the spec, so a provider added later brings its
  // own checks instead of being silently skipped.
  it('gives every provider the facts discovery probes with', () => {
    for (const name of PROVIDERS) {
      const spec = providerSpec(name)
      expect(spec.versionArgs).toEqual(['--version'])
      expect(typeof spec.checkAuth).toBe('function')
      expect(typeof spec.liveProbe.args).toBe('function')
      expect(typeof spec.liveProbe.read).toBe('function')
    }
  })

  it('knows its own names and rejects anything else', () => {
    expect([...PROVIDERS]).toEqual(['claude', 'antigravity', 'codex'])
    expect(isReviewProvider('codex')).toBe(true)
    expect(isReviewProvider('antigravity')).toBe(true)
    expect(isReviewProvider('gemini')).toBe(false)
  })
})

describe('claude arguments', () => {
  const args = buildAgentArgs(SCHEMA, base)

  it('restricts the run to the three polyglots tools', () => {
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('--restricted')
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(MCP_TOOLS.join(','))
  })

  it('passes the schema as argv text', () => {
    expect(args[args.indexOf('--json-schema') + 1]).toBe(JSON.stringify(SCHEMA))
  })

  // Each variadic flag is followed by another flag, so it cannot swallow a
  // later value.
  it('never leaves a variadic flag last', () => {
    for (const flag of ['--mcp-config', '--allowedTools']) {
      expect(args.indexOf(flag)).toBeLessThan(args.length - 2)
    }
  })
})

describe('antigravity arguments', () => {
  const args = buildAgentArgs(SCHEMA, { ...base, provider: 'antigravity', timeoutMs: 90_000 })

  // Its -p requires the prompt inline, which would put a whole batch into argv.
  // Omitting it makes the CLI read stdin, which has no such ceiling.
  it('omits -p so the prompt goes on stdin', () => {
    expect(args).not.toContain('-p')
    expect(args).not.toContain('--print')
  })

  // It has no per-invocation MCP flags at all; the server is registered with it
  // once, out of band.
  it('passes no MCP flags, which it does not have', () => {
    expect(args).not.toContain('--mcp-config')
    expect(args).not.toContain('--allowedTools')
  })

  it('never auto-approves every tool', () => {
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  /**
   * Its limit sits just inside the caller's so that it, not the kill, decides a
   * timeout and gets to explain it. Given the same deadline both fired at once
   * and the process was signalled before it could write anything, so every
   * timeout arrived with an empty stderr. Its own default is 0, wait forever,
   * so the flag cannot simply be left off either.
   */
  it('takes a limit just inside the caller own, so it reports the timeout', () => {
    expect(args[args.indexOf('--print-timeout') + 1]).toBe('60s')
  })

  it('never asks for a nonsensical limit when the caller allows very little', () => {
    const tight = buildAgentArgs(SCHEMA, { ...base, provider: 'antigravity', timeoutMs: 5_000 })
    expect(tight[tight.indexOf('--print-timeout') + 1]).toBe('30s')
  })

  // Without a caller limit it still needs one, because waiting forever is its
  // own default and a stuck batch would never be reported.
  it('falls back to its own generous default rather than waiting forever', () => {
    const bare = buildAgentArgs(SCHEMA, { ...base, provider: 'antigravity' })
    expect(bare).toContain('--print-timeout')
    expect(providerSpec('antigravity').defaultTimeoutMs).toBeGreaterThan(providerSpec('claude').defaultTimeoutMs)
  })

  it('writes the schema out and passes the path', () => {
    const path = args[args.indexOf('--json-schema') + 1]!
    expect(path).not.toBe(JSON.stringify(SCHEMA))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(SCHEMA)
  })

  it('reuses one file per schema rather than writing one per batch', () => {
    const spec = providerSpec('antigravity')
    expect(schemaArgument(spec, SCHEMA)).toBe(schemaArgument(spec, { ...SCHEMA }))
  })
})

describe('reading a claude envelope', () => {
  const read = (stdout: string) => readAgentOutput({ stdout, stderr: '' }, base)

  it('prefers the validated structured output', () => {
    expect(read(JSON.stringify({ structured_output: { ok: true }, result: '{"ok":false}' }))).toEqual({ ok: true })
  })

  it('falls back to the result string older builds used', () => {
    expect(read(JSON.stringify({ result: '{"ok":true}' }))).toEqual({ ok: true })
  })

  it('raises what the CLI reported rather than a parse failure', () => {
    expect(() => read(JSON.stringify({ is_error: true, result: 'usage limit reached' }))).toThrow(/usage limit reached/)
  })
})

describe('reading an antigravity envelope', () => {
  const opts = { ...base, provider: 'antigravity' as const }
  const read = (stdout: string, stderr = '') => readAgentOutput({ stdout, stderr }, opts)

  it('reads the same structured_output field claude uses', () => {
    expect(read(JSON.stringify({ status: 'SUCCESS', structured_output: { ok: true } }))).toEqual({ ok: true })
  })

  // Its terminal state is a status string, not claude's is_error boolean.
  it('treats any status but SUCCESS as a failure, quoting its error', () => {
    expect(() => read(JSON.stringify({ status: 'ERROR', error: 'model unavailable' }))).toThrow(/model unavailable/)
  })

  it('parses the response string when no structured output came back', () => {
    expect(read(JSON.stringify({ status: 'SUCCESS', response: '{"ok":true}' }))).toEqual({ ok: true })
  })

  /**
   * The failure that actually happens in practice: a tool it was not permitted
   * to call is soft-denied, so it exits zero with a null structured_output and
   * explains itself only on stderr. Dropping stderr turns a fixable setup
   * problem into "no structured output".
   */
  it('carries the stderr that names the denied tool into the error', () => {
    const stdout = JSON.stringify({ status: 'SUCCESS', structured_output: null })
    const stderr = 'a tool required the "mcp" permission that headless mode cannot prompt for'
    expect(() => read(stdout, stderr)).toThrow(/mcp.*permission/)
  })

  // A cut marks itself, so a problem report can find a key's start before it
  // wherever the cut lands in the message (see excerpt and the redactor).
  it('marks where it cut a long stdout or stderr it quotes', () => {
    expect(() => read('x'.repeat(300))).toThrow(new RegExp(`not JSON: ${'x'.repeat(200)}…$`))
    const stdout = JSON.stringify({ status: 'SUCCESS', structured_output: null })
    expect(() => read(stdout, 'y'.repeat(600))).toThrow(new RegExp(`stderr: ${'y'.repeat(500)}…$`))
  })

  it('reports a non-JSON stdout as such, not as a missing field', () => {
    expect(() => read('command not found: agy')).toThrow(AgentError)
    expect(() => read('command not found: agy')).toThrow(/not JSON/)
  })

  /**
   * A denied tool leaves `response` an empty string rather than absent, so the
   * error read "response field is not JSON: " with nothing after the colon,
   * which says the one thing that is not the problem. There is no malformed
   * JSON here; there is no output at all, and the account of why is the stderr
   * the caller appends next.
   */
  it('says there was no output rather than blaming the JSON for being absent', () => {
    const denied = JSON.stringify({ status: 'SUCCESS', structured_output: null, response: '' })
    expect(() => read(denied)).toThrow(/no output/)
    expect(() => read(denied)).not.toThrow(/not JSON/)
  })

  it('still blames the JSON when there really is malformed JSON', () => {
    expect(() => read(JSON.stringify({ status: 'SUCCESS', response: '{oops' }))).toThrow(/not JSON.*oops/)
  })
})

/**
 * antigravity takes its model from its own settings file, and polyglots passes
 * no --model, so a verdict formed by Flash and one formed by Pro were both
 * recorded as plain `antigravity` and each would be served as the other. That
 * is the same shape as the bug where every `antigravity` row was Claude's
 * work: an engine id that does not name the engine.
 */
describe('the model a provider will actually use', () => {
  const home = mkdtempSync(join(tmpdir(), 'polyglots-home-'))
  const settings = join(home, '.gemini', 'antigravity-cli')
  mkdirSync(settings, { recursive: true })

  it('reads what antigravity is configured to run', () => {
    writeFileSync(join(settings, 'settings.json'), JSON.stringify({ model: 'Gemini 3.8 Flash (Medium)' }))
    expect(configuredModel('antigravity', home)).toBe('Gemini 3.8 Flash (Medium)')
  })

  // Claude is told its model by us or picks its own, and has no equivalent file.
  it('claims nothing about claude', () => {
    expect(configuredModel('claude', home)).toBeUndefined()
  })

  // Fails open, the way the build guard does: an unreadable setting must not
  // stop a review, and a bare provider name is what every earlier row used.
  it('says nothing rather than guessing when the file is missing or broken', () => {
    const empty = mkdtempSync(join(tmpdir(), 'polyglots-home-'))
    expect(configuredModel('antigravity', empty)).toBeUndefined()
    mkdirSync(join(empty, '.gemini', 'antigravity-cli'), { recursive: true })
    writeFileSync(join(empty, '.gemini', 'antigravity-cli', 'settings.json'), '{ not json')
    expect(configuredModel('antigravity', empty)).toBeUndefined()
    writeFileSync(join(empty, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ model: 42 }))
    expect(configuredModel('antigravity', empty)).toBeUndefined()
  })
})

describe('codex arguments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'polyglots-codex-args-'))
  // The same mcp.json Claude is given, so the locale and POLYGLOTS_HOME reach
  // codex's server exactly as they reach Claude's.
  const mcpConfigPath = join(dir, 'mcp.json')
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({ mcpServers: { polyglots: { command: '/usr/bin/node', args: ['/x/server.js'], env: { POLYGLOTS_LOCALE: 'tr' } } } }),
  )
  const mcp = codexMcpArgs(readFileSync(mcpConfigPath, 'utf8'))
  const disabled = CODEX_DISABLED_FEATURES.flatMap((f) => ['--disable', f])

  it('builds the exact flag list, model and effort included when given', () => {
    const args = buildAgentArgs(SCHEMA, { mcpConfigPath, provider: 'codex', model: 'gpt-5.6-luna', effort: 'low' })
    const schemaFile = args[args.indexOf('--output-schema') + 1]!
    expect(args).toEqual([
      'exec',
      '--ignore-user-config',
      '--ephemeral',
      '--skip-git-repo-check',
      '--json',
      '--sandbox',
      'read-only',
      '--output-schema',
      schemaFile,
      '-m',
      'gpt-5.6-luna',
      '-c',
      'model_reasoning_effort="low"',
      '-c',
      'project_doc_max_bytes=0',
      ...mcp,
      ...disabled,
      '-c',
      'web_search="disabled"',
      '-',
    ])
    expect(mcp.at(-1)).toBe('mcp_servers.polyglots.default_tools_approval_mode="approve"')
  })

  // Nothing resolved means codex picks; a model of ours could be one the
  // person's plan refuses.
  it('passes neither -m nor an effort when neither resolved', () => {
    const args = buildAgentArgs(SCHEMA, { mcpConfigPath, provider: 'codex' })
    expect(args).not.toContain('-m')
    expect(args.some((a) => a.startsWith('model_reasoning_effort'))).toBe(false)
    const at = args.indexOf('--output-schema') + 2
    expect(args.slice(at, at + 2)).toEqual(['-c', 'project_doc_max_bytes=0'])
    expect(args.slice(at + 2, at + 2 + mcp.length)).toEqual(mcp)
  })

  it('writes the strict form of the schema, and leaves claude its own', () => {
    const args = buildAgentArgs(auditBatchJsonSchema, { mcpConfigPath, provider: 'codex' })
    const file = args[args.indexOf('--output-schema') + 1]!
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(strictSchema(auditBatchJsonSchema))
    const claudeArgs = buildAgentArgs(auditBatchJsonSchema, { mcpConfigPath })
    expect(JSON.parse(claudeArgs[claudeArgs.indexOf('--json-schema') + 1]!)).toEqual(auditBatchJsonSchema)
  })

  // npm on Windows writes backslash paths; JSON.stringify writes them as a
  // TOML basic string reads them back.
  it('carries a Windows path into the MCP flags', () => {
    const winPath = join(dir, 'mcp-win.json')
    writeFileSync(winPath, JSON.stringify({ mcpServers: { polyglots: { command: 'C:\\Program Files\\nodejs\\node.exe', args: [] } } }))
    const args = buildAgentArgs(SCHEMA, { mcpConfigPath: winPath, provider: 'codex' })
    expect(args).toContain('mcp_servers.polyglots.command="C:\\\\Program Files\\\\nodejs\\\\node.exe"')
  })

  it('has a ten-minute default and no setup step', () => {
    const spec = providerSpec('codex')
    expect(spec.defaultTimeoutMs).toBe(600_000)
    expect(spec.schemaAs).toBe('file')
    expect(spec.checkSetup).toBeUndefined()
  })

  it('probes with the no-MCP exec argv', () => {
    expect(providerSpec('codex').liveProbe.args(60_000)).toEqual(codexProbeArgs({}))
  })

  // The probe asks for the word OK, not for JSON, so only the stream's error
  // rules apply: a plain-text answer is a success.
  it('reads a plain-text probe answer as a success, and a failed turn as a failure', () => {
    const line = (o: unknown) => `${JSON.stringify(o)}\n`
    const read = providerSpec('codex').liveProbe.read
    expect(() => read(line({ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } }) + line({ type: 'turn.completed' }))).not.toThrow()
    expect(() => read(line({ type: 'turn.failed', error: { message: 'model not supported' } }))).toThrow(/model not supported/)
    expect(() => read(line({ type: 'turn.completed' }))).toThrow(AgentError)
  })

  it('names the MCP config it could not read, as an agent failure', () => {
    expect(() => buildAgentArgs(SCHEMA, { mcpConfigPath: join(dir, 'missing.json'), provider: 'codex' })).toThrow(AgentError)
    expect(() => buildAgentArgs(SCHEMA, { mcpConfigPath: join(dir, 'missing.json'), provider: 'codex' })).toThrow(/missing\.json/)
  })

  it('runs codex unless told otherwise', () => {
    expect(resolveAgentBin('codex', {})).toEqual({ bin: 'codex', source: 'default' })
  })
})

describe('codex sign-in', () => {
  const ctx = (result: { code: number | null; stdout: string; stderr?: string; timedOut?: boolean }) => {
    const calls: string[][] = []
    return {
      calls,
      ctx: {
        bin: 'codex',
        home: '/nowhere',
        env: {},
        timeoutMs: 5_000,
        exec: async (_cmd: string, args: string[]) => {
          calls.push(args)
          return { code: result.code, stdout: result.stdout, stderr: result.stderr ?? '', timedOut: result.timedOut ?? false }
        },
      },
    }
  }
  const check = providerSpec('codex').checkAuth

  it('reads a signed-in status and its method', async () => {
    const { ctx: c, calls } = ctx({ code: 0, stdout: 'Logged in using ChatGPT\n' })
    expect(await check(c)).toEqual({ state: 'signed-in', detail: 'ChatGPT' })
    expect(calls).toEqual([['login', 'status']])
  })

  it('reads a signed-out status from stderr too', async () => {
    expect((await check(ctx({ code: 1, stdout: '', stderr: 'Not logged in\n' }).ctx)).state).toBe('signed-out')
  })

  it('says unknown for anything else, a timeout included', async () => {
    expect((await check(ctx({ code: 2, stdout: 'error: unrecognized subcommand' }).ctx)).state).toBe('unknown')
    expect((await check(ctx({ code: null, stdout: '', timedOut: true }).ctx)).state).toBe('unknown')
  })
})

describe('the model and effort codex will run', () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'polyglots-codex-home-'))
  const env = { CODEX_HOME: codexHome }
  const toml = (text: string) => writeFileSync(join(codexHome, 'config.toml'), text)
  const none = { ...DEFAULT_CONFIG }
  const ours = { ...DEFAULT_CONFIG, codex: { model: 'ours-model', effort: 'high' as const } }

  it('takes the flag model first, our config next, then codex, each value on its own', () => {
    toml('model = "toml-model"\nmodel_reasoning_effort = "medium"\n')
    expect(agentModel('codex', ours, 'flag-model', env)).toEqual({
      model: 'flag-model',
      modelFrom: 'flag',
      effort: 'high',
      effortFrom: 'polyglots config',
    })
    expect(agentModel('codex', ours, undefined, env)).toEqual({
      model: 'ours-model',
      modelFrom: 'polyglots config',
      effort: 'high',
      effortFrom: 'polyglots config',
    })
    expect(agentModel('codex', { ...DEFAULT_CONFIG, codex: { model: 'ours-model' } }, undefined, env)).toEqual({
      model: 'ours-model',
      modelFrom: 'polyglots config',
      effort: 'medium',
      effortFrom: 'codex config',
    })
    expect(agentModel('codex', none, undefined, env)).toEqual({
      model: 'toml-model',
      modelFrom: 'codex config',
      effort: 'medium',
      effortFrom: 'codex config',
    })
  })

  it('leaves both to codex when nothing names them', () => {
    toml('[profiles.x]\nmodel = "not-top-level"\n')
    expect(agentModel('codex', none, undefined, env)).toEqual({ modelFrom: 'codex default', effortFrom: 'codex default' })
  })

  // config refuses an unknown effort, but config.toml is codex's file and
  // may hold a value a newer codex accepts and this one cannot name. codex
  // validates it, and the model check catches one it refuses.
  it('passes an effort outside the list through as it stands', () => {
    toml('model_reasoning_effort = "extreme"\n')
    expect(agentModel('codex', none, undefined, env)).toEqual({
      modelFrom: 'codex default',
      effort: 'extreme',
      effortFrom: 'codex config',
    })
  })

  it('gives claude the flag and antigravity its own settings', () => {
    const empty = mkdtempSync(join(tmpdir(), 'polyglots-agy-home-'))
    expect(agentModel('claude', ours, 'opus', env)).toEqual({ model: 'opus' })
    expect(agentModel('claude', ours, undefined, env)).toEqual({})
    expect(agentModel('antigravity', ours, 'flash', env, empty)).toEqual({ model: 'flash' })
    expect(agentModel('antigravity', ours, undefined, env, empty)).toEqual({})
  })

  // The home is passed through, so a caller never has to read the real one.
  it('reads antigravity settings and codex config.toml from the home it is given', () => {
    const home = mkdtempSync(join(tmpdir(), 'polyglots-agy-home-'))
    mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
    writeFileSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ model: 'Gemini X (Low)' }))
    expect(agentModel('antigravity', ours, undefined, {}, home)).toEqual({ model: 'Gemini X (Low)' })
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "home-model"\n')
    expect(agentModel('codex', none, undefined, {}, home)).toMatchObject({ model: 'home-model', modelFrom: 'codex config' })
  })

  it('treats an empty or blank --model as no flag', () => {
    const empty = mkdtempSync(join(tmpdir(), 'polyglots-agy-home-'))
    toml('model = "toml-model"\n')
    expect(agentModel('codex', none, '', env)).toMatchObject({ model: 'toml-model', modelFrom: 'codex config' })
    expect(agentModel('codex', none, '  ', env)).toMatchObject({ model: 'toml-model', modelFrom: 'codex config' })
    expect(agentModel('claude', ours, '', env)).toEqual({})
    expect(agentModel('antigravity', ours, ' ', env, empty)).toEqual({})
  })

  // The spawn and the engine id read the same flag. A blank one the engine id
  // ignored still reached a claude or antigravity spawn as --model ' ', and
  // padding the id kept but the spawn trimmed named two different models.
  it('puts on the spawn exactly the flag the engine id names', () => {
    const empty = mkdtempSync(join(tmpdir(), 'polyglots-agy-home-'))
    for (const provider of ['claude', 'antigravity'] as const) {
      expect(agentSpawnModel(provider, agentModel(provider, ours, '  ', env, empty), '  ')).toEqual({})
      expect(agentSpawnModel(provider, agentModel(provider, ours, '', env, empty), '')).toEqual({})
      const padded = agentModel(provider, ours, ' opus ', env, empty)
      expect(padded).toEqual({ model: 'opus' })
      expect(agentSpawnModel(provider, padded, ' opus ')).toEqual({ model: 'opus' })
    }
  })

  it('labels the engine with whatever resolved', () => {
    expect(codexEngineLabel('gpt-5.6-luna', 'low')).toBe('gpt-5.6-luna (low)')
    expect(codexEngineLabel('gpt-5.6-luna')).toBe('gpt-5.6-luna')
    expect(codexEngineLabel(undefined, 'low')).toBe('(low)')
    expect(codexEngineLabel()).toBeUndefined()
  })
})
