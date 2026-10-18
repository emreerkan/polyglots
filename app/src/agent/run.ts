import { spawn } from 'node:child_process'
import { findOnPath, killTree, spawnPlan, type SpawnPlan } from '../spawn-plan.js'
import { currentRunLog } from '../logs/run-log.js'
import { trackAgent } from './children.js'
import {
  AgentError,
  providerSpec,
  schemaArgument,
  type AgentRunOptions,
  type ProviderSpec,
} from './providers.js'

export {
  AgentError,
  configuredModel,
  MCP_TOOLS,
  PROVIDERS,
  DEFAULT_PROVIDER,
  isReviewProvider,
  providerSpec,
  schemaArgument,
  type AgentRunOptions,
  type ProviderSpec,
} from './providers.js'

const STDERR_EXCERPT = 500
const DEFAULT_KILL_GRACE_MS = 2_000

// The id an agent prints for its conversation, so a line here can be matched to
// the agent's own log. Absent when stdout is not a whole envelope.
function sessionOf(stdout: string): string | null {
  try {
    const env = JSON.parse(stdout) as Record<string, unknown>
    const id = env.conversation_id ?? env.session_id
    return typeof id === 'string' ? id : null
  } catch {
    return null
  }
}

export function buildAgentArgs(jsonSchema: unknown, opts: AgentRunOptions): string[] {
  const spec = providerSpec(opts.provider)
  return spec.buildArgs(schemaArgument(spec, jsonSchema), opts)
}

// A claude started from inside a Claude Code session inherits the variables
// that session exported to describe itself: that it is nested, how it was
// entered, its session id, the IDE port and the messaging socket it listens
// on. A child holding them thinks it belongs to the parent, so they are
// stripped and the child starts as a fresh CLI.
//
// This used to drop every name under the CLAUDE_CODE_ prefix, on the theory
// that the prefix meant "set by the parent". It does not. The same prefix
// carries what a user sets on purpose to make claude work at all:
// CLAUDE_CODE_USE_BEDROCK and CLAUDE_CODE_USE_VERTEX route requests to a cloud
// provider, CLAUDE_CODE_OAUTH_TOKEN is the headless credential from
// setup-token, and limits such as CLAUDE_CODE_MAX_OUTPUT_TOKENS tune it.
// Stripping those sent Bedrock and Vertex users to the first-party API and left
// token users with no credentials, so every batch failed with an auth error
// that pointed away from polyglots. The list below is the markers only, read
// off a live session's environment. A marker missing from it costs a child that
// can tell it is nested; a config variable wrongly on it costs a run that
// cannot authenticate, so the list errs towards being short.
//
// The prefix was never the whole story in the other direction either. claude
// exports CLAUDE_PID, AI_AGENT and CLAUDE_EFFORT to its children from the same
// place it sets CLAUDE_CODE_CHILD_SESSION, and none of them carries the
// prefix, so all three used to reach the reviewer: the parent's pid, a claim
// that an agent invoked it, and the effort the parent turn happened to run at.
const SESSION_MARKERS: ReadonlySet<string> = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'AI_AGENT',
  'CLAUDE_EFFORT',
])

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) {
    if (SESSION_MARKERS.has(k)) continue
    out[k] = v
  }
  return out
}

export interface AgentOutput {
  stdout: string
  stderr: string
}

/**
 * How the agent CLI is started. Elsewhere the bin is spawned as named. On
 * Windows it is looked up first: an npm-installed claude is claude.cmd, and
 * Node, given the bare name, looks only for claude.com and claude.exe, so
 * every batch failed to spawn. A .cmd then goes through the shell (see
 * spawnPlan). A bin that is not found is left as named, so the spawn error
 * names what was asked for.
 */
export function agentSpawnPlan(bin: string, argv: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform): SpawnPlan {
  const command = platform === 'win32' ? (findOnPath(bin, env, platform) ?? bin) : bin
  return spawnPlan(command, argv, platform)
}

/**
 * Runs the agent CLI to completion, prompt on stdin.
 *
 * Returns stderr alongside stdout rather than discarding it, because both
 * providers have a failure mode that exits zero and explains itself only
 * there: antigravity soft-denies a tool it was not permitted to call, and a
 * quota message arrives without a non-zero status.
 */
export function spawnAgent(argv: string[], prompt: string, opts: AgentRunOptions): Promise<AgentOutput> {
  const spec: ProviderSpec = providerSpec(opts.provider)
  const command = opts.bin ?? spec.bin
  const timeoutMs = opts.timeoutMs ?? spec.defaultTimeoutMs
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  return new Promise((resolve, reject) => {
    const env = childEnv(process.env)
    const plan = agentSpawnPlan(command, argv, env, process.platform)
    const child = spawn(plan.file, plan.args, {
      cwd: opts.cwd,
      env,
      shell: plan.shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // Killed if this process ends first, so a hung agent is never left behind.
    trackAgent(child)
    // The run this call belongs to, found through AsyncLocalStorage rather than
    // an agent option (see run-log.ts). Outside a run, nothing is written.
    const log = currentRunLog()
    const call = log?.nextCall()
    const t0 = Date.now()
    log?.write('agent-spawn', { provider: spec.name, bin: command, pid: child.pid, timeoutMs, ...call })
    // Why polyglots ended the process, when it did. 'answered' is dropped when
    // close reports a clean exit (see below): an agent that printed its answer
    // and exited on its own an instant later was not killed by anyone.
    let killed: 'timeout' | 'answered' | null = null
    let stdout = ''
    let stderr = ''
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    const excerpt = (): string => stderr.slice(0, STDERR_EXCERPT)
    // An agent reports a usage limit on stdout and exits non-zero, so a failure
    // whose stderr is empty still has its reason in hand. Reporting only stderr
    // turned "your quota ran out" into a bare exit code.
    const why = (): string => {
      const out = stdout.trim().slice(0, STDERR_EXCERPT)
      const err = excerpt().trim()
      return [err && `stderr: ${err}`, out && `stdout: ${out}`].filter(Boolean).join('; ') || 'no output'
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killed = 'timeout'
      if (plan.shell) {
        killTree(child.pid)
      } else {
        child.kill('SIGTERM')
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }, killGraceMs)
        killTimer.unref()
      }
      reject(new AgentError(`${spec.name} timed out after ${timeoutMs}ms; stderr: ${excerpt()}`, { stderr: excerpt() }))
    }, timeoutMs)

    child.stdin.on('error', () => {})
    child.stdin.end(prompt)

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
      // An agent that has printed its whole answer is done, whether or not it
      // ever exits (see answerComplete). It is killed outright: the one that
      // needs this ignores SIGTERM while it hangs.
      if (settled || !spec.answerComplete || !chunk.endsWith('\n') || !spec.answerComplete(stdout)) return
      settled = true
      clearTimeout(timer)
      killed = 'answered'
      if (plan.shell) killTree(child.pid)
      else child.kill('SIGKILL')
      resolve({ stdout, stderr })
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new AgentError(`failed to spawn ${command}: ${err.message}`, { stderr: excerpt() }))
    })

    // close fires for every ending, a kill included, and after the promise has
    // settled for a timeout or an early answer, so the line is written before
    // the settled check rather than after it. A bin that failed to spawn closes
    // too, with no pid and Node's negative errno as the code.
    child.on('close', (code, signal) => {
      log?.write('agent-exit', {
        pid: child.pid,
        ...call,
        ms: Date.now() - t0,
        code,
        signal,
        // The kill raced the agent's own exit and lost: it was already gone.
        // That is told by a clean exit, not by a missing signal. On Windows a
        // .cmd agent runs through the shell and is ended by taskkill /F, and
        // close then reports exit code 1 with no signal; keying this on the
        // signal logged every answered antigravity call there as an agent that
        // had failed by itself.
        killed: killed === 'answered' && code === 0 && signal === null ? null : killed,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        session: sessionOf(stdout),
      })
      if (killTimer) clearTimeout(killTimer)
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        const how = code === null ? `signal ${signal}` : `exit code ${code}`
        reject(new AgentError(`${spec.name} exited with ${how}; ${why()}`, { stderr: excerpt() }))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/**
 * The structured object the agent was asked for.
 *
 * stderr is folded into the error rather than dropped: the failure that
 * produces a well-formed envelope with nothing in it is a denied tool, and the
 * only account of which tool is on stderr.
 */
export function readAgentOutput(output: AgentOutput, opts: AgentRunOptions): unknown {
  const spec = providerSpec(opts.provider)
  try {
    return spec.readEnvelope(output.stdout)
  } catch (err) {
    if (err instanceof AgentError && output.stderr.trim()) {
      throw new AgentError(`${err.message}; stderr: ${output.stderr.slice(0, STDERR_EXCERPT).trim()}`, {
        stderr: output.stderr,
      })
    }
    throw err
  }
}

export async function runAgent(prompt: string, jsonSchema: unknown, opts: AgentRunOptions): Promise<unknown> {
  return readAgentOutput(await spawnAgent(buildAgentArgs(jsonSchema, opts), prompt, opts), opts)
}
