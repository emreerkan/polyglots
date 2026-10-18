// Pure helpers for driving `codex exec`: shaping the output schema it accepts,
// reading its --json event stream, and turning the MCP config file into the -c
// flags it takes. Nothing here spawns a process, so all of it is tested on
// canned text and never needs the real binary.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { excerpt } from '../logs/excerpt.js'
import { AgentError } from './providers.js'

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

// Features switched off for every codex run. A review needs no shell, no
// sub-agents, no plugins and no web; each one left on is a tool the model can
// spend a turn on, and a way for a .po string to steer it somewhere.
// buildArgs and the probe share this list so the two never drift.
export const CODEX_DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'multi_agent',
  'plugins',
  'apps',
  'image_generation',
  'browser_use',
  'computer_use',
  'view_image',
  'skill_search',
  'tool_suggest',
] as const

// Strict structured output wants every object closed and every property
// required. Our schemas leave optional properties out of `required`, which the
// zod side relies on, so this rewrites a copy for codex: an optional property
// stays optional in meaning by becoming nullable, and the null is dropped again
// on the way back (dropNulls). minItems goes on a nullable property because a
// null has no length to check, and the zod schema is the one that enforces it.
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema)
  if (!isObject(schema)) return schema
  const out: Json = { ...schema }
  if (isObject(schema.properties)) {
    const original = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
    const props: Json = {}
    for (const [key, value] of Object.entries(schema.properties)) {
      const next = strictSchema(value)
      if (!original.has(key) && isObject(next)) {
        const copy: Json = { ...next }
        const t = copy.type
        copy.type = Array.isArray(t) ? [...t, 'null'] : [t, 'null']
        delete copy.minItems
        props[key] = copy
      } else props[key] = next
    }
    out.properties = props
    out.required = Object.keys(props)
    out.additionalProperties = false
  }
  if ('items' in schema) out.items = strictSchema(schema.items)
  return out
}

export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls)
  if (!isObject(value)) return value
  const out: Json = {}
  for (const [k, v] of Object.entries(value)) if (v !== null) out[k] = dropNulls(v)
  return out
}

function events(stdout: string, completeOnly = false): Json[] {
  const lines = stdout.split('\n')
  // The last piece has no newline after it, so it may be half a line.
  if (completeOnly || lines[lines.length - 1] === '') lines.pop()
  const out: Json[] = []
  for (const l of lines) {
    try {
      const v: unknown = JSON.parse(l)
      if (isObject(v)) out.push(v)
    } catch {
      // codex and its plugins print plain warnings between events.
    }
  }
  return out
}

const messageOf = (v: unknown): string | undefined =>
  isObject(v) && typeof v.message === 'string' ? v.message : undefined

// The agent's last message as text, or the failure the stream reported. Kept
// apart from readCodexStream for the live probe, which asks for a word, not
// for JSON, and so wants the stream's error rules without the parse.
export function codexAnswerText(stdout: string): string {
  let answer: string | undefined
  let failure: string | undefined
  for (const e of events(stdout)) {
    if (e.type === 'item.completed' && isObject(e.item) && e.item.type === 'agent_message') {
      if (typeof e.item.text === 'string') answer = e.item.text
    } else if (failure === undefined && e.type === 'turn.failed') {
      failure = messageOf(e.error) ?? 'turn failed'
    } else if (failure === undefined && e.type === 'error') {
      failure = messageOf(e) ?? 'codex reported an error'
    }
  }
  // An error wins over an answer: a turn can fail after it said something.
  if (failure !== undefined) throw new AgentError(`codex failed: ${excerpt(failure, 200)}`)
  if (answer === undefined) throw new AgentError('codex gave no answer (no agent message in its output)')
  return answer
}

export function readCodexStream(stdout: string): unknown {
  const answer = codexAnswerText(stdout)
  try {
    return dropNulls(JSON.parse(answer))
  } catch {
    throw new AgentError(`codex answer was not JSON: ${excerpt(answer, 200)}`)
  }
}

// True once the turn has ended, so a caller waiting on a process that does not
// exit can stop waiting. Only a line already ended by a newline counts: a
// turn.completed cut half way through is not yet the whole event.
export function codexAnswerComplete(stdout: string): boolean {
  return events(stdout, true).some((e) => e.type === 'turn.completed' || e.type === 'turn.failed')
}

export function codexUsage(
  stdout: string,
): { input?: number; cached?: number; output?: number; reasoning?: number } | undefined {
  let usage: Json | undefined
  for (const e of events(stdout)) if (e.type === 'turn.completed' && isObject(e.usage)) usage = e.usage
  if (usage === undefined) return undefined
  const n = (k: string): number | undefined => (typeof usage![k] === 'number' ? (usage![k] as number) : undefined)
  const pick = (key: 'input' | 'cached' | 'output' | 'reasoning', from: string) => {
    const v = n(from)
    return v === undefined ? {} : { [key]: v }
  }
  return {
    ...pick('input', 'input_tokens'),
    ...pick('cached', 'cached_input_tokens'),
    ...pick('output', 'output_tokens'),
    ...pick('reasoning', 'reasoning_output_tokens'),
  }
}

// codex takes MCP servers as -c overrides, not as the JSON file Claude and
// Gemini read, so the file's polyglots entry is translated. A JSON string is
// a valid TOML basic string for the characters in a path or a locale
// (backslash and quote escape the same way), so JSON.stringify writes each
// value and a Windows path or a quote reads back as written.
export function codexMcpArgs(mcpJson: string): string[] {
  let server: unknown
  try {
    const parsed: unknown = JSON.parse(mcpJson)
    server = isObject(parsed) && isObject(parsed.mcpServers) ? parsed.mcpServers.polyglots : undefined
  } catch {
    server = undefined
  }
  if (!isObject(server) || typeof server.command !== 'string') {
    throw new AgentError('the MCP config has no polyglots server for codex to start')
  }
  const p = 'mcp_servers.polyglots'
  const out = ['-c', `${p}.command=${JSON.stringify(server.command)}`]
  if (Array.isArray(server.args)) out.push('-c', `${p}.args=${JSON.stringify(server.args)}`)
  if (isObject(server.env)) {
    for (const [k, v] of Object.entries(server.env)) out.push('-c', `${p}.env.${k}=${JSON.stringify(v)}`)
  }
  // Without this, exec has nobody to ask and cancels every tool call.
  out.push('-c', `${p}.default_tools_approval_mode="approve"`)
  return out
}

// Only the two top-level keys, read before the first table header: a line
// parser rather than a TOML dependency, since a `model` key under a table
// belongs to something else. A value is quoted with " or ', and a trailing
// comment is dropped.
export function codexSettings(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): { model?: string; effort?: string } {
  const dir = env.CODEX_HOME !== undefined && env.CODEX_HOME !== '' ? env.CODEX_HOME : join(home, '.codex')
  let text: string
  try {
    text = readFileSync(join(dir, 'config.toml'), 'utf8')
  } catch {
    return {}
  }
  const out: { model?: string; effort?: string } = {}
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim()
    if (l.startsWith('[')) break
    const m = /^(model|model_reasoning_effort)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(l)
    if (m === null) continue
    const value = m[2] ?? m[3] ?? ''
    if (m[1] === 'model') out.model = value
    else out.effort = value
  }
  return out
}

// The argv for a probe run that needs no MCP server: it only has to show the
// model answers.
export function codexProbeArgs(opts: { model?: string; effort?: string }): string[] {
  return [
    'exec',
    '--ignore-user-config',
    '--ephemeral',
    '--skip-git-repo-check',
    '--json',
    '--sandbox',
    'read-only',
    ...(opts.model === undefined ? [] : ['-m', opts.model]),
    ...(opts.effort === undefined ? [] : ['-c', `model_reasoning_effort="${opts.effort}"`]),
    ...CODEX_DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
    '-c',
    'web_search="disabled"',
    '-',
  ]
}

// `codex login status` writes to stderr on some versions and stdout on
// others, so both are read.
export function readLoginStatus(result: {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}): { state: 'signed-in' | 'signed-out' | 'unknown'; detail?: string } {
  if (result.timedOut) return { state: 'unknown', detail: 'login status timed out' }
  const text = `${result.stdout}\n${result.stderr}`
  if (/Not logged in/i.test(text)) return { state: 'signed-out', detail: 'not logged in (run: codex login)' }
  const m = /Logged in(?: using ([^\r\n]+))?/.exec(text)
  if (m !== null) {
    const detail = m[1]?.trim()
    return { state: 'signed-in', ...(detail === undefined || detail === '' ? {} : { detail }) }
  }
  return { state: 'unknown' }
}
