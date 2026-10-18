import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { findOnPath, killTree, spawnPlan } from '../spawn-plan.js'
import type { ReviewProvider } from '../types.js'
import {
  configuredModel,
  PROVIDERS,
  providerSpec,
  resolveAgentBin,
  type AuthStatus,
  type BinSource,
  type ProbeExec,
  type ProbeResult,
  type SetupStatus,
} from './providers.js'
import { childEnv } from './run.js'
import { agyQuota, agySignIn, type Quota } from './agy-check.js'
import { excerpt } from '../logs/excerpt.js'

export { findOnPath }

export type { AuthStatus, BinSource, ProbeExec, ProbeResult, SetupStatus } from './providers.js'

/**
 * What polyglots can tell about one agent CLI without spending anything.
 *
 * Read-only by design. Nothing here is ever passed into a review or a
 * translate run: the provider a run uses is still read from config inside
 * the run, so discovery cannot change a cache key, and the pinned hashes in
 * test/rules/integration.test.ts stay where they are.
 */
export interface AgentStatus {
  provider: ReviewProvider
  bin: string
  binSource: BinSource
  // The resolved absolute path, when found.
  path?: string
  // First non-empty line of the version output.
  version?: string
  auth: AuthStatus
  setup: SetupStatus
  // From configuredModel itself, so the display is what the engine id records.
  model?: string
  usable: boolean
  // The one line the menu shows when the provider is not usable.
  reason?: string
  // Unknown sign-in or setup, and an override in use. Never a reason.
  notes: string[]
  // Only with `live`.
  live?: { ok: boolean; ms: number; error?: string }
  // Antigravity's remaining quota by group, only with `account` and only when
  // agy said it is signed in.
  quota?: Quota
}

export interface DiscoverDeps {
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
  exec?: ProbeExec
  now?: () => number
}

export interface DiscoverOptions extends DiscoverDeps {
  refresh?: boolean
  live?: boolean
  // Ask antigravity itself whether it is signed in, and how much quota is
  // left, instead of reading its token file. A few seconds of `agy models`
  // and `/usage`, so doctor asks and launch does not.
  account?: boolean
}

const PROBE_TIMEOUT_MS = 5_000
const LIVE_TIMEOUT_MS = 90_000
const STDERR_EXCERPT = 500
// As small as an answer gets, so the one request --live spends is the
// cheapest one the provider offers.
const LIVE_PROMPT = 'Reply with the single word OK and nothing else.'

/**
 * The default probe runner. Never rejects: a spawn error is `code: null`. A
 * timeout kills outright, because a probe that hangs has already answered
 * the only question asked of it.
 */
export const defaultExec: ProbeExec = (cmd, args, { timeoutMs, env, input }) =>
  new Promise<ProbeResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    }
    let child: ReturnType<typeof spawn>
    const plan = spawnPlan(cmd, args, process.platform)
    try {
      child = spawn(plan.file, plan.args, { env, shell: plan.shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      stderr = err instanceof Error ? err.message : String(err)
      resolve({ code: null, stdout, stderr, timedOut })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      if (plan.shell) killTree(child.pid)
      else child.kill('SIGKILL')
      finish(null)
    }, timeoutMs)
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.stdin?.on('error', () => {})
    // Closed at once without input, so a CLI that would read stdin sees EOF
    // instead of waiting on a prompt nobody is going to type.
    child.stdin?.end(input ?? '')
    child.on('error', (err) => {
      stderr += err.message
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })

let cached: Promise<AgentStatus[]> | undefined

/**
 * Every provider polyglots can drive, probed in parallel.
 *
 * Memoised per process and keyed by nothing: one process has one
 * environment, and `refresh` is there for the rest. A live run neither reads
 * nor fills the cache, so a later plain call can never be served a result
 * that spent a request, or the other way round. A rejected discovery is not
 * kept, so the next call tries again.
 */
export function discoverAgents(opts: DiscoverOptions = {}): Promise<AgentStatus[]> {
  // Neither reads nor fills the cache, for the same reason as live: a later
  // quick call must not be served an answer that cost seconds of agy, nor an
  // account question answered from the token file.
  if (opts.live || opts.account) return probeAll(opts, opts.live === true)
  if (opts.refresh || !cached) {
    const run = probeAll(opts, false)
    cached = run
    run.catch(() => {
      if (cached === run) cached = undefined
    })
  }
  return cached
}

export function usableProviders(statuses: AgentStatus[]): ReviewProvider[] {
  return PROVIDERS.filter((p) => statuses.some((s) => s.provider === p && s.usable))
}

async function probeAll(opts: DiscoverDeps & { account?: boolean }, live: boolean): Promise<AgentStatus[]> {
  const env = childEnv(opts.env ?? process.env)
  const ctx = {
    rawEnv: opts.env ?? process.env,
    env,
    home: opts.home ?? homedir(),
    platform: opts.platform ?? process.platform,
    exec: opts.exec ?? defaultExec,
    now: opts.now ?? Date.now,
    account: opts.account === true,
  }
  const statuses = await Promise.all(PROVIDERS.map((p) => probeOne(p, ctx, live)))
  // POLYGLOTS_AGENT_BIN is one variable for every provider, so it can put a
  // single file behind two of them. Each would then look independently ready.
  for (const status of statuses) {
    const twin = statuses.find((other) => other !== status && other.path !== undefined && other.path === status.path)
    if (twin && PROVIDERS.indexOf(twin.provider) < PROVIDERS.indexOf(status.provider)) {
      status.notes.push(`same binary as ${twin.provider}`)
    }
  }
  return statuses
}

interface ProbeCtx {
  rawEnv: NodeJS.ProcessEnv
  env: NodeJS.ProcessEnv
  home: string
  platform: NodeJS.Platform
  exec: ProbeExec
  now: () => number
  account: boolean
}

async function probeOne(provider: ReviewProvider, ctx: ProbeCtx, live: boolean): Promise<AgentStatus> {
  const spec = providerSpec(provider)
  // Resolved from the env as given, not the stripped one: the override
  // variables are polyglots' own and childEnv leaves them alone, but reading
  // the original keeps that a fact about this function rather than about it.
  const { bin, source } = resolveAgentBin(provider, ctx.rawEnv)
  const notes: string[] = []
  if (source !== 'default') notes.push(`binary from ${source}`)
  const setup: SetupStatus = spec.checkSetup ? spec.checkSetup(ctx.home) : { state: 'ok' }
  const model = configuredModel(provider, ctx.home)
  const base = { provider, bin, binSource: source, setup, notes, ...(model === undefined ? {} : { model }) }
  const notChecked: AuthStatus = { state: 'unknown', detail: 'not checked' }

  const path = findOnPath(bin, ctx.env, ctx.platform)
  if (!path) {
    const reason =
      source === 'default' ? `${bin} not on PATH` : `${source}=${bin} does not exist or is not executable`
    return { ...base, auth: notChecked, usable: false, reason }
  }

  const v = await ctx.exec(path, spec.versionArgs, { timeoutMs: PROBE_TIMEOUT_MS, env: ctx.env })
  const versionFailure = v.timedOut
    ? `${bin} --version timed out after ${PROBE_TIMEOUT_MS / 1000}s`
    : v.code === null
      ? `${bin} --version could not start${v.stderr.trim() ? `: ${excerpt(v.stderr.trim(), 200)}` : ''}`
      : v.code !== 0
        ? `${bin} --version failed: exit ${v.code}`
        : undefined
  // A CLI that cannot print its version is not asked whether it is signed in:
  // that answer would be noise behind the real failure, and a second wait.
  if (versionFailure) return { ...base, path, auth: notChecked, usable: false, reason: versionFailure }
  const version = v.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0)

  const account = provider === 'antigravity' && ctx.account ? await askAgy(path, ctx) : undefined
  const auth =
    account?.auth ?? (await spec.checkAuth({ bin: path, home: ctx.home, env: ctx.env, exec: ctx.exec, timeoutMs: PROBE_TIMEOUT_MS }))
  if (auth.state === 'unknown') notes.push(`sign-in unknown: ${auth.detail ?? 'no answer'}`)
  if (setup.state === 'unknown') notes.push(`setup unknown: ${setup.detail ?? 'no answer'}`)

  const reason =
    auth.state === 'signed-out'
      ? `${provider} ${auth.detail ?? 'not signed in'}`
      : setup.state === 'missing'
        ? `${provider} is ${setup.detail ?? 'not set up'}`
        : undefined
  const status: AgentStatus = {
    ...base,
    path,
    ...(version === undefined ? {} : { version }),
    auth,
    usable: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
    ...(account?.quota === undefined ? {} : { quota: account.quota }),
  }
  if (live && status.usable) status.live = await liveProbe(provider, path, ctx)
  return status
}

/**
 * Antigravity's sign-in from `agy models`, and its quota from `/usage` once
 * that said signed in: the two steps a run's check takes, so doctor and a run
 * cannot disagree. An unknown answer falls back to the token file (no `auth`
 * here), the check that needs no process and stays the quick one at launch.
 */
async function askAgy(path: string, ctx: ProbeCtx): Promise<{ auth?: AuthStatus; quota?: Quota }> {
  const signIn = await agySignIn(ctx.exec, path)
  if (signIn.state === 'signed-out') return { auth: { state: 'signed-out', detail: 'is signed out: run agy once to sign in' } }
  if (signIn.state === 'unknown') return {}
  const quota = await agyQuota(ctx.exec, path)
  return { auth: { state: 'signed-in' }, ...(quota === undefined ? {} : { quota }) }
}

async function liveProbe(provider: ReviewProvider, path: string, ctx: ProbeCtx): Promise<NonNullable<AgentStatus['live']>> {
  const spec = providerSpec(provider)
  const started = ctx.now()
  const result = await ctx.exec(path, spec.liveProbe.args(LIVE_TIMEOUT_MS), {
    timeoutMs: LIVE_TIMEOUT_MS,
    env: ctx.env,
    input: LIVE_PROMPT,
  })
  const ms = ctx.now() - started
  const stderr = excerpt(result.stderr.trim(), STDERR_EXCERPT)
  // stderr folded in the way readAgentOutput does it, because a quota or a
  // denied tool explains itself there and nowhere else.
  const withStderr = (message: string) => (stderr ? `${message}; stderr: ${stderr}` : message)
  if (result.timedOut) return { ok: false, ms, error: `${provider} timed out after ${LIVE_TIMEOUT_MS / 1000}s` }
  try {
    spec.liveProbe.read(result.stdout)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, ms, error: withStderr(message) }
  }
  // An envelope that reads as success under a non-zero exit is still a
  // failure: the CLI said it was not.
  if (result.code !== 0) return { ok: false, ms, error: withStderr(`${provider} exited with ${result.code === null ? 'no exit code' : `exit code ${result.code}`}`) }
  return { ok: true, ms }
}
