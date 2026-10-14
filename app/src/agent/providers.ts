import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { docsUrl } from '../docs-links.js'
import type { ReviewChoice, ReviewProvider } from '../types.js'

// The only tools a review is allowed to reach for. Both providers restrict to
// these, by different means: Claude takes a flag, antigravity takes allow-rules
// in its own settings file, which is why it needs a documented setup step.
export const MCP_TOOLS = [
  'mcp__polyglots__glossary_lookup',
  'mcp__polyglots__consistency_lookup',
  'mcp__polyglots__tm_lookup',
] as const

// Enough for the agent to notice its own deadline and report it before the
// caller's timer gives up on it.
const GRACE_SECONDS = 30

export const PROVIDERS: readonly ReviewProvider[] = ['claude', 'antigravity']

// Claude stays the default. It is the faster of the two and the more
// conservative, and it is what every cached verdict was formed under.
export const DEFAULT_PROVIDER: ReviewProvider = 'claude'

export function isReviewProvider(value: string): value is ReviewProvider {
  return (PROVIDERS as readonly string[]).includes(value)
}

/**
 * A failure from the agent CLI, carrying whatever account of itself it gave.
 *
 * Deliberately without a notion of which failures are worth retrying. 0.12.0
 * added one, marking a refused batch settled so the retry would not replay it,
 * and it was wrong: see the retry loop in audit.ts for what that cost and why
 * every failure here is worth a second attempt.
 */
export class AgentError extends Error {
  override readonly name: string = 'AgentError'
  readonly stderr: string

  constructor(message: string, details: { stderr?: string } = {}) {
    super(message)
    this.stderr = details.stderr ?? ''
  }
}

export interface AgentRunOptions {
  mcpConfigPath: string
  // Which CLI to drive. Absent means the default, so every existing caller that
  // passed nothing keeps driving Claude.
  provider?: ReviewProvider
  // Overrides the provider's binary, for tests and for an install that is not
  // on PATH.
  bin?: string
  model?: string
  cwd?: string
  timeoutMs?: number
  killGraceMs?: number
}

/** Where the binary a provider runs came from. */
export type BinSource = 'default' | 'POLYGLOTS_AGENT_BIN' | 'POLYGLOTS_CLAUDE_BIN'

/**
 * Whether the CLI is signed in, as far as can be told without asking it to do
 * any work. `unknown` is a real answer, not a failure: it is what another
 * tool's state looks like when it cannot be read, and it never hides a
 * provider.
 */
export interface AuthStatus {
  state: 'signed-in' | 'signed-out' | 'unknown'
  detail?: string
}

/** Whether the one-off setup a provider needs is in place. */
export interface SetupStatus {
  state: 'ok' | 'missing' | 'unknown'
  detail?: string
}

export interface ProbeResult {
  // null when the process never started or was killed.
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * Runs one probe to completion. Never rejects: a spawn error is `code: null`,
 * so every check can be written as a reading of a result rather than a
 * try/catch around a process.
 *
 * The env is passed in rather than read, because the caller has already
 * stripped the Claude Code session markers from it, and a fake needs to be
 * able to see that it did.
 */
export type ProbeExec = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; env: NodeJS.ProcessEnv; input?: string },
) => Promise<ProbeResult>

export interface ProbeContext {
  // The resolved path of the binary, so a probe runs what discovery found.
  bin: string
  home: string
  env: NodeJS.ProcessEnv
  exec: ProbeExec
  timeoutMs: number
}

export interface ProviderSpec {
  name: ReviewProvider
  bin: string
  /** Arguments that make the CLI print its version and exit, doing nothing else. */
  versionArgs: string[]
  /** A local, free sign-in check. Must never send a prompt. */
  checkAuth(ctx: ProbeContext): Promise<AuthStatus>
  /** The one-off setup the provider needs, for a provider that needs any. */
  checkSetup?(home: string): SetupStatus
  /**
   * The one check that spends a request, behind `doctor --live` only. The
   * prompt goes on stdin; `read` throws AgentError when the answer is not a
   * success. It does not reuse readEnvelope, because no schema is involved
   * and the answer is plain text.
   */
  liveProbe: { args(timeoutMs: number): string[]; read(stdout: string): void }
  /**
   * How the JSON schema reaches the CLI.
   *
   * Claude takes it as argv text. antigravity accepts either, and a path is
   * chosen for it because argv is a shared budget with the prompt, and the
   * audit schema is the larger of the two constants.
   */
  schemaAs: 'inline' | 'file'
  /**
   * How long one batch may take, when the caller names no limit.
   *
   * A property of the agent, not of the work. Claude issues its tool calls
   * concurrently; antigravity issues one per planner turn, so the same batch
   * costs it twenty-odd sequential round trips and a shared 300s ceiling cut
   * its slower batches off mid-question.
   */
  defaultTimeoutMs: number
  buildArgs(schema: string, opts: AgentRunOptions): string[]
  /** The provider's own envelope, reduced to the object the schema asked for. */
  readEnvelope(stdout: string): unknown
}

function envelopeOf(stdout: string, provider: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new AgentError(`${provider} stdout is not JSON: ${stdout.slice(0, 200)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AgentError(`${provider} stdout JSON is not an object`)
  }
  return parsed as Record<string, unknown>
}

// Both providers put the schema-validated object here, under the same name.
// It is preferred over the assistant's text in both cases because it is the
// only field either one guarantees has been checked against the schema.
function structuredOutput(env: Record<string, unknown>): unknown | undefined {
  const value = env.structured_output
  return typeof value === 'object' && value !== null ? value : undefined
}

const claude: ProviderSpec = {
  name: 'claude',
  bin: 'claude',
  schemaAs: 'inline',
  defaultTimeoutMs: 300_000,
  versionArgs: ['--version'],
  /**
   * `claude auth status --json` reads local state and costs nothing. Its exit
   * code is not trusted, because a signed-out CLI may exit non-zero while still
   * printing the answer, so stdout is read whatever the code. Anything that
   * does not parse, such as an older build printing usage for a subcommand it
   * lacks, is unknown rather than signed out: it says nothing about sign-in.
   */
  async checkAuth(ctx) {
    const result = await ctx.exec(ctx.bin, ['auth', 'status', '--json'], { timeoutMs: ctx.timeoutMs, env: ctx.env })
    if (result.timedOut) return { state: 'unknown', detail: 'auth status timed out' }
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout)
    } catch {
      return { state: 'unknown', detail: 'auth status gave no readable answer' }
    }
    const loggedIn = (parsed as { loggedIn?: unknown } | null)?.loggedIn
    if (loggedIn === false) return { state: 'signed-out', detail: 'not logged in (run: claude auth login)' }
    if (loggedIn !== true) return { state: 'unknown', detail: 'auth status gave no readable answer' }
    const method = (parsed as { authMethod?: unknown }).authMethod
    return typeof method === 'string' && method.length > 0 ? { state: 'signed-in', detail: method } : { state: 'signed-in' }
  },
  // No tools at all: strict MCP with no config means no servers, so the probe
  // is one model turn and nothing else.
  liveProbe: {
    args: () => [
      '-p',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--restricted',
      '--permission-prompts',
      'none',
    ],
    read(stdout) {
      const env = envelopeOf(stdout, 'claude')
      if (env.is_error === true) {
        throw new AgentError(`claude reported an error: ${String(env.result ?? env.subtype ?? 'unknown')}`)
      }
    },
  },
  // The prompt is sent on stdin, never as argv: --allowedTools and --mcp-config
  // are variadic on the real CLI and would swallow a trailing positional, and
  // a batch with long .po comments can exceed ARG_MAX. Each variadic flag is
  // still followed by a non-variadic flag so it cannot absorb a later value.
  buildArgs(schema, opts) {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      schema,
      '--mcp-config',
      opts.mcpConfigPath,
      '--strict-mcp-config',
      '--restricted',
      '--allowedTools',
      MCP_TOOLS.join(','),
      '--permission-prompts',
      'none',
      '--no-session-persistence',
    ]
    if (opts.model) args.push('--model', opts.model)
    return args
  },
  // { type: 'result', subtype, is_error, result: string, structured_output?: object }
  readEnvelope(stdout) {
    const env = envelopeOf(stdout, 'claude')
    if (env.is_error === true) {
      throw new AgentError(`claude reported an error: ${String(env.result ?? env.subtype ?? 'unknown')}`)
    }
    const output = structuredOutput(env)
    if (output !== undefined) return output
    // Older builds put the raw JSON string in `result` instead.
    if (typeof env.result === 'string') {
      try {
        return JSON.parse(env.result)
      } catch {
        throw new AgentError(`claude result field is not JSON: ${env.result.slice(0, 200)}`)
      }
    }
    throw new AgentError('claude envelope has neither structured_output nor a string result')
  },
}

const antigravity: ProviderSpec = {
  name: 'antigravity',
  bin: 'agy',
  schemaAs: 'file',
  // Measured: batches that finished took two to three and a half minutes, and
  // every one that needed more than about 28 tool calls hit the old 300s
  // ceiling. Twenty minutes is room for the tail rather than an expectation.
  defaultTimeoutMs: 1_200_000,
  versionArgs: ['--version'],
  /**
   * There is no status subcommand, so the token file stands in for one. Its
   * absence is unknown, not signed out: the storage is antigravity's, not
   * ours, and could move in any release. A missing file must not hide a
   * provider that works.
   */
  async checkAuth(ctx) {
    return existsSync(join(antigravityDir(ctx.home), 'antigravity-oauth-token'))
      ? { state: 'signed-in' }
      : { state: 'unknown', detail: 'no token file where antigravity used to keep it' }
  },
  /**
   * Checked because both failures are silent. Without the allow-rules every
   * tool call is denied; without a registered server that starts, there are no
   * tools to call. Either way the CLI exits zero and the run is worse than
   * useless (notes/antigravity.md). A missing rule or server is missing; a
   * file that cannot be read or has an unexpected shape is unknown, and fails
   * open the way configuredModel does.
   */
  checkSetup(home) {
    const parts = [antigravityServerSetup(home), antigravityRuleSetup(home)]
    const missing = parts.filter((part) => part.state === 'missing')
    if (missing.length > 0) {
      return { state: 'missing', detail: `${missing.map((part) => part.detail).join('; ')} (see ${docsUrl('antigravity')})` }
    }
    return parts.find((part) => part.state === 'unknown') ?? { state: 'ok' }
  },
  liveProbe: {
    args: (timeoutMs) => ['--output-format', 'json', '--print-timeout', printTimeout(timeoutMs)],
    read(stdout) {
      const env = envelopeOf(stdout, 'antigravity')
      const status = typeof env.status === 'string' ? env.status : 'unknown'
      if (status !== 'SUCCESS') {
        throw new AgentError(`antigravity reported ${status}: ${String(env.error ?? 'no error given')}`)
      }
    },
  },
  /**
   * No `-p`. Its `-p` requires its value inline, which would put a whole batch
   * of source strings and comments into argv; omitting it makes the CLI read
   * the prompt from stdin, which has no such ceiling.
   *
   * No MCP flags either. antigravity has no per-invocation equivalent of
   * --mcp-config, so the server is registered with it once and the tools are
   * permitted by allow-rules in its settings. That is the setup documented in
   * notes/antigravity.md, and without it every tool call is silently denied and
   * the run returns no structured output.
   */
  buildArgs(schema, opts) {
    const args = ['--output-format', 'json', '--json-schema', schema]
    // Its own limit is set just inside ours so that it, not the kill, decides a
    // timeout and gets to say why. Given the same deadline both fire at once,
    // the process is signalled before it can write anything, and every timeout
    // was reported with an empty stderr. Its own default is 0, meaning wait
    // forever, so leaving the flag off would put the whole burden on the kill.
    args.push('--print-timeout', printTimeout(opts.timeoutMs ?? antigravity.defaultTimeoutMs))
    if (opts.model) args.push('--model', opts.model)
    return args
  },
  // { conversation_id, status, response: string, error?, structured_output?, usage }
  readEnvelope(stdout) {
    const env = envelopeOf(stdout, 'antigravity')
    const status = typeof env.status === 'string' ? env.status : 'unknown'
    if (status !== 'SUCCESS') {
      throw new AgentError(`antigravity reported ${status}: ${String(env.error ?? 'no error given')}`)
    }
    const output = structuredOutput(env)
    if (output !== undefined) return output
    if (typeof env.response === 'string' && env.response.trim().length > 0) {
      try {
        return JSON.parse(env.response)
      } catch {
        throw new AgentError(`antigravity response field is not JSON: ${env.response.slice(0, 200)}`)
      }
    }
    // A soft-denied tool exits zero with a null structured_output and an empty
    // response string, and says why only on stderr, which the caller appends.
    // Reporting the empty string as malformed JSON printed a colon with
    // nothing after it and named the one thing that was not wrong: there is no
    // JSON here because there is no answer here.
    throw new AgentError('antigravity produced no output; a tool it needed was most likely denied')
  },
}

const SPECS: Record<ReviewProvider, ProviderSpec> = { claude, antigravity }

function antigravityDir(home: string): string {
  return join(home, '.gemini', 'antigravity-cli')
}

function antigravityRuleSetup(home: string): SetupStatus {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(antigravityDir(home), 'settings.json'), 'utf8'))
  } catch {
    return { state: 'unknown', detail: 'could not read antigravity settings.json' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { state: 'unknown', detail: 'antigravity settings.json is not an object' }
  }
  // No permissions block at all is a readable file that allows nothing,
  // which is the ordinary state before the documented setup step.
  const permissions = (parsed as { permissions?: unknown }).permissions ?? {}
  if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions)) {
    return { state: 'unknown', detail: 'permissions in antigravity settings.json is not an object' }
  }
  const allow = (permissions as { allow?: unknown }).allow ?? []
  if (!Array.isArray(allow)) return { state: 'unknown', detail: 'permissions.allow is not a list' }
  const rules = allow.filter((given): given is string => typeof given === 'string')
  const missing = ANTIGRAVITY_RULES.filter((rule) => !rules.some((given) => antigravityRuleCovers(given, rule)))
  if (missing.length === 0) return { state: 'ok' }
  return { state: 'missing', detail: `missing permission rules: ${missing.join(', ')}` }
}

/**
 * The server `agy mcp add polyglots` registered, in ~/.gemini/config, which
 * is shared with the other Gemini tools rather than kept in the CLI's folder.
 *
 * A checkout that moved left the registration pointing at a server.js that no
 * longer existed. agy started without the tools and logged nothing, so every
 * batch ran with no glossary or memory lookup, and a model with nothing to
 * call sometimes reached for a shell command instead, was denied, and ended
 * the batch with no answer. Only absolute paths are checked: a relative one
 * resolves against whatever folder agy is started in, which is not ours to
 * know.
 */
function antigravityServerSetup(home: string): SetupStatus {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8'))
  } catch {
    return { state: 'unknown', detail: 'could not read antigravity mcp_config.json' }
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    return { state: 'unknown', detail: 'mcpServers in antigravity mcp_config.json is not an object' }
  }
  const server = (servers as Record<string, unknown>).polyglots
  if (server === undefined) return { state: 'missing', detail: 'the polyglots MCP server is not registered' }
  if (typeof server !== 'object' || server === null) {
    return { state: 'unknown', detail: 'the polyglots entry in mcp_config.json is not an object' }
  }
  const { command, args, disabled } = server as { command?: unknown; args?: unknown; disabled?: unknown }
  if (disabled === true) return { state: 'missing', detail: 'the polyglots MCP server is disabled' }
  const paths = [command, ...(Array.isArray(args) ? args : [])].filter(
    (part): part is string => typeof part === 'string' && isAbsolute(part),
  )
  const gone = paths.find((path) => !existsSync(path))
  if (gone !== undefined) return { state: 'missing', detail: `the polyglots MCP server points at ${gone}, which does not exist` }
  return { state: 'ok' }
}

function printTimeout(budgetMs: number): string {
  return `${Math.max(30, Math.floor(budgetMs / 1000) - GRACE_SECONDS)}s`
}

// Derived from MCP_TOOLS rather than written out, so a fourth tool cannot be
// added to the review without discovery asking for its rule too. The target
// is server/tool: mcp__polyglots__tm_lookup becomes mcp(polyglots/tm_lookup).
export const ANTIGRAVITY_RULES: readonly string[] = MCP_TOOLS.map(
  (tool) => `mcp(${tool.replace(/^mcp__/, '').replace('__', '/')})`,
)

const MCP_RULE = /^mcp\((.*)\)$/

/**
 * Whether an allow-rule from antigravity's settings permits `wanted`, one of
 * ANTIGRAVITY_RULES.
 *
 * Comparing strings rejected rules antigravity honours. It matches each token
 * of a rule's target as an anchored regular expression (notes/antigravity.md),
 * so mcp(polyglots/(glossary|consistency|tm)_lookup) permits all three tools
 * and the setup check called it missing. Matching the same way is the only
 * reading that agrees with antigravity in both directions: anchoring is what
 * keeps mcp(polyglots/tm) from passing for tm_lookup, and the token count is
 * what keeps a server-wide mcp(polyglots), which does not work, from passing
 * at all. Nothing is trimmed or case-folded, because nothing says antigravity
 * does either, and passing a rule it then ignores is the failure this check is
 * for. A token that is not a valid expression matches nothing.
 */
export function antigravityRuleCovers(given: string, wanted: string): boolean {
  const target = MCP_RULE.exec(given)?.[1]
  const need = MCP_RULE.exec(wanted)?.[1]
  if (target === undefined || need === undefined) return false
  const tokens = target.split('/')
  const names = need.split('/')
  if (tokens.length !== names.length) return false
  return tokens.every((token, i) => {
    try {
      return new RegExp(`^(?:${token})$`).test(names[i]!)
    } catch {
      return false
    }
  })
}

/**
 * Which binary a provider runs, and why.
 *
 * POLYGLOTS_AGENT_BIN applies to whichever provider is in use.
 * POLYGLOTS_CLAUDE_BIN is the older name and applies to claude only: it used
 * to win for antigravity too, which drove the claude binary with
 * antigravity's argv and failed in a way that named neither variable. An
 * empty value counts as unset, as `||` treated it before this existed.
 */
export function resolveAgentBin(
  provider: ReviewProvider,
  env: NodeJS.ProcessEnv,
): { bin: string; source: BinSource } {
  if (env.POLYGLOTS_AGENT_BIN) return { bin: env.POLYGLOTS_AGENT_BIN, source: 'POLYGLOTS_AGENT_BIN' }
  if (provider === 'claude' && env.POLYGLOTS_CLAUDE_BIN) {
    return { bin: env.POLYGLOTS_CLAUDE_BIN, source: 'POLYGLOTS_CLAUDE_BIN' }
  }
  return { bin: SPECS[provider].bin, source: 'default' }
}

/**
 * The `bin` a run should be given: the override, or undefined so the spec's
 * own default applies. Undefined rather than the default name, so a run with
 * no override passes exactly what it passed before.
 */
export function agentBinOverride(provider: ReviewChoice, env: NodeJS.ProcessEnv): string | undefined {
  // A local model is not spawned, and with no reviewer nothing is, so there
  // is no binary to override.
  if (provider === 'local' || provider === 'none') return undefined
  const { bin, source } = resolveAgentBin(provider, env)
  return source === 'default' ? undefined : bin
}

/**
 * The model a provider will actually use, when the choice is not ours.
 *
 * antigravity reads its model from its own settings file and polyglots passes
 * no --model, so every verdict it has ever formed was recorded under a bare
 * `antigravity` whatever was behind it. Changing that setting from Flash to
 * Pro would then serve one engine's opinions as the other's, which is exactly
 * the failure that made every `antigravity` row before 0.9.8 Claude's work
 * under another name. An engine id has one job: to name the engine.
 *
 * Read rather than passed on to the CLI. Handing the name back as --model
 * would mean betting a run on our spelling of it matching theirs, and the
 * value is wanted for the key, not for the invocation.
 *
 * Reasoning effort rides along inside the name, as "Gemini 3.8 Flash
 * (Medium)", so this one field covers both and a change to either is visible.
 *
 * Fails open, the way the build guard does. A missing, unreadable or
 * surprising settings file yields undefined and the run is recorded under the
 * bare provider name, which is what every row written before this already
 * uses. A review must not stop because another tool's configuration moved.
 */
export function configuredModel(provider: ReviewProvider, home: string = homedir()): string | undefined {
  if (provider !== 'antigravity') return undefined
  try {
    const raw = readFileSync(join(antigravityDir(home), 'settings.json'), 'utf8')
    const model: unknown = (JSON.parse(raw) as { model?: unknown }).model
    return typeof model === 'string' && model.trim().length > 0 ? model : undefined
  } catch {
    return undefined
  }
}

export function providerSpec(name: ReviewProvider = DEFAULT_PROVIDER): ProviderSpec {
  return SPECS[name]
}

// Written once per distinct schema and reused, keyed by content: the two
// schemas in this tree are module constants, so this writes two files for the
// life of the process rather than one per batch.
const schemaFiles = new Map<string, string>()

export function schemaArgument(spec: ProviderSpec, jsonSchema: unknown): string {
  const text = JSON.stringify(jsonSchema)
  if (spec.schemaAs === 'inline') return text
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 16)
  const cached = schemaFiles.get(digest)
  if (cached) return cached
  const path = join(tmpdir(), `polyglots-schema-${digest}.json`)
  writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 })
  schemaFiles.set(digest, path)
  return path
}

/**
 * A warning about a batch size that will cost more than it saves, or undefined.
 *
 * Shrinking a batch is the obvious response to a timeout and it is the wrong
 * one here. Measured on real runs: a 25-entry batch drew 11 tool calls, while
 * 10-entry batches drew 22 to 31, so the smaller batch spent roughly six times
 * as many round trips per entry and still paid the same fixed cost of reading
 * the tool schemas at the start of each one. The agent grows more thorough as
 * it is given less to do.
 */
export function batchAdvice(provider: ReviewChoice | undefined, batchSize: number): string | undefined {
  // A local model's limit is its context, not tool round trips, and that
  // advice lives with the local reviewer (localBatchAdvice).
  if ((provider ?? DEFAULT_PROVIDER) !== 'antigravity') return undefined
  if (batchSize >= ANTIGRAVITY_MIN_BATCH) return undefined
  return `antigravity asks its tools one at a time, so a batch of ${batchSize} costs more round trips per entry than a batch of ${ANTIGRAVITY_MIN_BATCH}, not fewer. Raise the batch size rather than lowering it.`
}

// Below this, the per-entry cost climbs instead of falling.
export const ANTIGRAVITY_MIN_BATCH = 25
