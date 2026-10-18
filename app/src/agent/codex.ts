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

// codex relays a refused request as the server's JSON body in the message
// field, so a stop message quoted a page of braces with the sentence that
// mattered buried inside, and the 200-character excerpt could cut it off
// altogether. The inner message is taken before anything is shortened.
function messageOf(v: unknown): string | undefined {
  if (!isObject(v) || typeof v.message !== 'string') return undefined
  const raw = v.message
  if (!raw.trimStart().startsWith('{')) return raw
  try {
    const body: unknown = JSON.parse(raw)
    if (!isObject(body)) return raw
    const inner = isObject(body.error) && typeof body.error.message === 'string' ? body.error.message : body.message
    return typeof inner === 'string' && inner !== '' ? inner : raw
  } catch {
    return raw
  }
}

/**
 * What every failure the stream itself reported starts with. The provider
 * check tells codex's own verdict from a crash or a garbled answer by it, so
 * it is exported rather than written twice.
 */
export const CODEX_FAILED_PREFIX = 'codex failed: '

// The agent's last message as text, or the failure the stream reported. Kept
// apart from readCodexStream for the live probe, which asks for a word, not
// for JSON, and so wants the stream's error rules without the parse.
//
// turn.failed always wins: a turn can fail after it said something. An error
// event is weaker. codex writes its retry notices that way ("Reconnecting...
// 1/5 (stream disconnected ...)") and then often finishes the turn, and
// reading those as fatal failed a batch that had in fact recovered and
// answered. So an error counts only when no turn.completed followed it.
export function codexAnswerText(stdout: string): string {
  let answer: string | undefined
  let failed: string | undefined
  let error: string | undefined
  let completed = false
  for (const e of events(stdout)) {
    if (e.type === 'item.completed' && isObject(e.item) && e.item.type === 'agent_message') {
      if (typeof e.item.text === 'string') answer = e.item.text
    } else if (e.type === 'turn.completed') {
      completed = true
    } else if (failed === undefined && e.type === 'turn.failed') {
      failed = messageOf(e.error) ?? 'turn failed'
    } else if (error === undefined && e.type === 'error') {
      error = messageOf(e) ?? 'codex reported an error'
    }
  }
  const failure = failed ?? (completed ? undefined : error)
  if (failure !== undefined) throw new AgentError(`${CODEX_FAILED_PREFIX}${excerpt(failure, 200)}`)
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
//
// Only the last complete line is read. The caller asks on every chunk, and
// parsing the whole stdout each time made a long stream quadratic; the turn's
// ending is the last event codex writes, so nothing before it can decide.
export function codexAnswerComplete(stdout: string): boolean {
  const end = stdout.lastIndexOf('\n')
  if (end === -1) return false
  const last = stdout.slice(stdout.lastIndexOf('\n', end - 1) + 1, end)
  try {
    const e: unknown = JSON.parse(last)
    return isObject(e) && (e.type === 'turn.completed' || e.type === 'turn.failed')
  } catch {
    return false
  }
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
//
// A top-level profile makes both unset. The profile's table decides what codex
// would use, and this reader does not follow it; passing the top-level values
// back would hand codex a model the person had moved away from.
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
    if (/^profile\s*=/.test(l)) return {}
    const m = /^(model|model_reasoning_effort)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(l)
    if (m === null) continue
    const value = m[2] ?? m[3] ?? ''
    if (m[1] === 'model') out.model = value
    else out.effort = value
  }
  return out
}

/**
 * Stops codex reading AGENTS.md (and its fallbacks) from the folder it runs
 * in. --ignore-user-config does not cover it: checked against codex-cli
 * 0.155.1, a folder whose AGENTS.md said "reply BANANA" got BANANA back from a
 * prompt asking for OK, and OK once this was added. A run's prompt is
 * otherwise whatever the folder it starts in happens to hold, and the verdict
 * cache keys on what polyglots renders, so a cached verdict would stand for
 * a prompt the key never saw.
 */
export const CODEX_NO_PROJECT_DOC = ['-c', 'project_doc_max_bytes=0'] as const

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
    ...CODEX_NO_PROJECT_DOC,
    ...CODEX_DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
    '-c',
    'web_search="disabled"',
    '-',
  ]
}

// `codex login status` writes to stderr on some versions and stdout on
// others, so both are read. Signed in needs exit 0 as well as the words: a
// failing command that happened to print them is not a verdict.
//
// An API-key login prints the key's masked tail after " - ", and the detail
// goes to the run log, doctor and problem reports, so only the method is kept.
export function readLoginStatus(result: {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}): { state: 'signed-in' | 'signed-out' | 'unknown'; detail?: string } {
  if (result.timedOut) return { state: 'unknown', detail: 'login status timed out' }
  const text = `${result.stdout}\n${result.stderr}`
  if (/Not logged in/i.test(text)) return { state: 'signed-out', detail: 'not logged in (run: codex login)' }
  const m = result.code === 0 ? /Logged in(?: using ([^\r\n]+))?/.exec(text) : null
  if (m !== null) {
    const detail = m[1]?.split(' - ')[0]?.trim()
    return { state: 'signed-in', ...(detail === undefined || detail === '' ? {} : { detail }) }
  }
  return { state: 'unknown' }
}
