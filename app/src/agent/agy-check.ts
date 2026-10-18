import type { ProbeExec, ProbeResult } from './providers.js'
import { resolveAgentBin } from './providers.js'
import { childEnv } from './run.js'
import { excerpt as cut } from '../logs/excerpt.js'

/**
 * Whether antigravity can take a batch at all, asked before the first one.
 *
 * A signed-out agy does not fail. Asked for anything that needs the account it
 * prints a Google sign-in link, waits sixty seconds for a code nobody is going
 * to type, then exits 1, and a review batch does the same once per attempt.
 * An exhausted quota fails batches with nothing on screen to say why. Both are
 * cheap to see in advance, in two steps measured on agy 1.4.0:
 *
 * 1. `agy models` never prompts. Signed in it lists the models and exits 0;
 *    signed out it exits 1 saying "Please sign in". Anything else, another
 *    code, a timeout, a binary that is not there, is unknown.
 * 2. `agy -p /usage` prints the quota, but signed out it is the command that
 *    opens the sign-in flow. So it runs only after step 1 said signed in, and
 *    never on an unknown: the cost of guessing wrong is the minute this whole
 *    check exists to save.
 *
 * Unknown never blocks a run. The output belongs to another program and can
 * change in any release, and a check that misreads a working provider as a
 * broken one would stop runs that would have finished.
 */

export interface SignIn {
  state: 'signed-in' | 'signed-out' | 'unknown'
  detail?: string
  ms: number
}

export interface QuotaLine {
  group: string
  limit: string
  remaining: number
  resetsAt: string
}

export interface Quota {
  lines: QuotaLine[]
  ms: number
}

export interface ProviderCheck {
  signIn: SignIn
  quota?: Quota
  // When the check finished, so a caller can tell how stale a kept result is.
  at: number
}

// Each step answers in about three seconds when agy is healthy. Fifteen is
// room for a slow network, and short enough that a hung agy is unknown well
// before anyone wonders whether the run started.
const STEP_TIMEOUT_MS = 15_000
const DETAIL_MAX = 200
const LOW_PERCENT = 10

function defaultBin(): string {
  return resolveAgentBin('antigravity', process.env).bin
}

/**
 * Runs one step without ever rejecting. ProbeExec promises not to, but this
 * sits in front of every run, so an exec that throws anyway is read as a
 * result with no exit code rather than allowed to fail the run it was meant
 * to protect.
 */
async function run(exec: ProbeExec, bin: string, args: string[], timeoutMs: number): Promise<ProbeResult> {
  try {
    return await exec(bin, args, { timeoutMs, env: childEnv(process.env) })
  } catch (err) {
    return { code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err), timedOut: false }
  }
}

function excerpt(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^Fetching available models/i.test(l))
    .at(-1)
  return line === undefined ? undefined : cut(line, DETAIL_MAX)
}

export async function agySignIn(exec: ProbeExec, bin: string = defaultBin(), timeoutMs = STEP_TIMEOUT_MS): Promise<SignIn> {
  const started = Date.now()
  const result = await run(exec, bin, ['models'], timeoutMs)
  const ms = Date.now() - started
  if (result.code === 0) return { state: 'signed-in', ms }
  const output = `${result.stdout}\n${result.stderr}`
  // Exit 1 alone is not enough: a network failure exits 1 too, and calling
  // that signed out would send someone to sign in again for nothing.
  if (result.code === 1 && /sign in/i.test(output)) {
    const detail = excerpt(output)
    return { state: 'signed-out', ms, ...(detail === undefined ? {} : { detail }) }
  }
  const detail = result.timedOut
    ? `agy models did not answer within ${Math.round(timeoutMs / 1000)} s`
    : (excerpt(output) ?? (result.code === null ? 'agy models did not start' : `agy models exited ${result.code}`))
  return { state: 'unknown', detail, ms }
}

/** Undefined when the quota cannot be read, which is unknown and never blocks. */
export async function agyQuota(exec: ProbeExec, bin: string = defaultBin(), timeoutMs = STEP_TIMEOUT_MS): Promise<Quota | undefined> {
  const started = Date.now()
  const result = await run(exec, bin, ['-p', '/usage'], timeoutMs)
  const ms = Date.now() - started
  if (result.code !== 0) return undefined
  const lines = parseUsage(result.stdout)
  return lines.length === 0 ? undefined : { lines, ms }
}

/**
 * Tab-separated: group, limit, remaining percent, reset time. A line that is
 * not exactly that is skipped rather than guessed at, so a banner or a changed
 * format reads as less quota information, never as a wrong number.
 */
export function parseUsage(text: string): QuotaLine[] {
  const out: QuotaLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const fields = raw.split('\t').map((f) => f.trim())
    if (fields.length !== 4) continue
    const [group, limit, percent, resetsAt] = fields as [string, string, string, string]
    const match = /^(\d{1,3})%$/.exec(percent)
    if (!match || group === '' || limit === '') continue
    out.push({ group, limit, remaining: Number(match[1]), resetsAt })
  }
  return out
}

/** The group Claude and GPT models share in /usage. */
const SHARED_GROUP = /claude|gpt/i

function words(text: string): string {
  return text.toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The line that limits a model: the lowest remaining among the groups it
 * draws on. /usage reports by group, not by model, and the model name comes
 * from agy's settings ("Gemini 4 Argon (Low)"), so the two are matched by
 * name. A Claude or GPT model reads the shared Claude and GPT group. A Gemini
 * model reads the general Gemini group plus any group naming its family,
 * which is why Argon reads both: either running out stops it.
 */
export function quotaFor(lines: QuotaLine[], model: string | undefined): QuotaLine | undefined {
  if (model === undefined) return undefined
  // agy may hand back the display name or the id form (gemini-4-argon-low),
  // so both sides are compared with dashes and underscores read as spaces.
  const name = words(model)
  const matches = SHARED_GROUP.test(name)
    ? lines.filter((l) => SHARED_GROUP.test(l.group))
    : lines.filter((l) => {
        const group = words(l.group)
        if (group === 'gemini models') return true
        const family = group.replace(/\bmodels\b/g, '').replace(/\s+/g, ' ').trim()
        // An empty family would be contained in every name; the Claude and
        // GPT group must never count against a Gemini model. The family must
        // match as whole words: a plain substring let a "Gemini 4" group
        // stop "Gemini 4.5 Flash" on a quota it does not draw on.
        return family !== '' && !SHARED_GROUP.test(family) && new RegExp(`(^|\\s)${escapeRegExp(family)}(\\s|\\(|$)`).test(name)
      })
  let lowest: QuotaLine | undefined
  for (const line of matches) if (lowest === undefined || line.remaining < lowest.remaining) lowest = line
  return lowest
}

/** Never runs /usage unless agy said signed in. */
export async function checkAgy(exec: ProbeExec, opts: { bin?: string; timeoutMs?: number } = {}): Promise<ProviderCheck> {
  const bin = opts.bin ?? defaultBin()
  const timeoutMs = opts.timeoutMs ?? STEP_TIMEOUT_MS
  const signIn = await agySignIn(exec, bin, timeoutMs)
  const quota = signIn.state === 'signed-in' ? await agyQuota(exec, bin, timeoutMs) : undefined
  return { signIn, ...(quota === undefined ? {} : { quota }), at: Date.now() }
}

/**
 * What the check means for a run about to start. Signed out and an empty
 * quota stop it before the first batch, since every batch would fail the same
 * way; a low quota is worth one line and no more. Unknown, in either step,
 * says nothing at all.
 */
export function judge(check: ProviderCheck, model: string | undefined): { stop?: string; warn?: string } {
  if (check.signIn.state === 'signed-out') {
    return { stop: 'antigravity is signed out. Run agy once to sign in, then start again.' }
  }
  if (check.quota === undefined || model === undefined) return {}
  const line = quotaFor(check.quota.lines, model)
  if (line === undefined) return {}
  if (line.remaining === 0) {
    return { stop: `antigravity has no quota left for ${model} (${line.group}: 0%, resets ${line.resetsAt}).` }
  }
  if (line.remaining < LOW_PERCENT) {
    return { warn: `antigravity quota is low for ${model}: ${line.group} ${line.remaining}% left.` }
  }
  return {}
}

/**
 * A run that the provider check stopped before its first batch. Its own class
 * so every caller can tell it from a failure: the run ends `stopped`, as a
 * person stopping it would, because nothing went wrong in polyglots and
 * nothing was spent. Recorded as `failed`, a signed-out agy would count
 * against the tool in history and offer a problem report about the person's
 * own sign-in.
 */
export class ProviderRefusal extends Error {
  override name = 'ProviderRefusal'
}

// How long a run waits for a check started beside it before going on without
// it. The check costs about five seconds when agy is healthy; past ten it is
// already slower than the minute a signed-out batch would waste, and a run
// that waited longer would be held up by the thing meant to save it time.
export const PREFLIGHT_WAIT_MS = 10_000
// How long the end of a run waits for the quota read a failed batch started,
// so its line reaches the log before run-end does. One /usage step.
export const RECHECK_WAIT_MS = STEP_TIMEOUT_MS

type LogWrite = (kind: string, fields: Record<string, unknown>) => void

/** Resolves with what `promise` gave, or undefined once `ms` has passed. Never rejects. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
    timer.unref?.()
  })
  return Promise.race([Promise.resolve(promise).catch(() => undefined), late]).finally(() => clearTimeout(timer))
}

/**
 * The gate in front of a run's first agent batch, shared by review and
 * translate so the two cannot read the check differently.
 *
 * Waits for the check for at most PREFLIGHT_WAIT_MS, logs what it found as
 * `provider-check`, warns once on a low quota and throws ProviderRefusal on a
 * stop. A check that never answered is logged with null fields and lets the
 * run go on, exactly as an unknown answer does.
 *
 * Returns the check it read, or undefined past the wait, so the caller can
 * tell a confirmed sign-in from a run that merely was not stopped: only the
 * first earns the quota read after a failed batch (see quotaRecheck).
 */
export async function gateRun(opts: {
  preflight: Promise<ProviderCheck | undefined>
  model: string | undefined
  log: LogWrite
  warn: (line: string) => void
  waitMs?: number
}): Promise<ProviderCheck | undefined> {
  const started = Date.now()
  const check = await within(opts.preflight, opts.waitMs ?? PREFLIGHT_WAIT_MS)
  opts.log('provider-check', {
    signIn: check?.signIn ?? null,
    quota: check?.quota ?? null,
    waitedMs: Date.now() - started,
  })
  if (check === undefined) return undefined
  const verdict = judge(check, opts.model)
  if (verdict.stop !== undefined) throw new ProviderRefusal(verdict.stop)
  if (verdict.warn !== undefined) opts.warn(verdict.warn)
  return check
}

/**
 * The quota read again after a batch was given up, so the run log, and the
 * problem report built from it, say whether the quota ran out part way.
 * Only /usage: sign-in passed at the start, and asking `agy models` again
 * would spend seconds on the one answer the run already has. That premise is
 * the caller's to keep: create this only after gateRun returned a check whose
 * sign-in is `signed-in`. An unknown check, one past the wait, or no check at
 * all confirms nothing, and on a signed-out agy /usage opens the sign-in
 * flow, the very minute the check exists to save.
 *
 * Started without waiting, so the next batch is not held up by it; `settle`
 * waits for what is still out, capped, before the run writes run-end.
 *
 * One read at a time. A failure while a read is still out is skipped: that
 * read answers the same question, and failed batches can follow each other
 * faster than /usage does, which stacked one call per failure and filled the
 * log with the same line.
 */
export function quotaRecheck(exec: ProbeExec, log: LogWrite, bin?: string): { afterFailure(): void; settle(): Promise<void> } {
  let pending: Promise<void> | undefined
  return {
    afterFailure() {
      if (pending !== undefined) return
      const read: Promise<void> = agyQuota(exec, bin)
        .then((quota) => log('quota', { lines: quota?.lines ?? null }))
        .catch(() => undefined)
        .finally(() => {
          if (pending === read) pending = undefined
        })
      pending = read
    },
    async settle() {
      if (pending !== undefined) await within(pending, RECHECK_WAIT_MS)
    },
  }
}
