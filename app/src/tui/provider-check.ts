import { createContext, useContext } from 'react'
import { hasProviderCheck, providerOf, quotaFor, type ProviderCheck } from '../agent/agy-check.js'
import type { AgentStatus } from '../agent/discover.js'
import { agentModel } from '../agent/providers.js'
import type { PolyglotsConfig } from '../types.js'

// The provider check as the app holds it: asked once in the background at
// launch, shown beside the provider, and handed to a run started soon after
// instead of being asked again. Held above the screens, so the review, the
// translate and the batch screens all read the one answer.
//
// One answer per key, and the key names what the check asked: the provider,
// and for codex the model and effort. antigravity's answer says nothing about
// codex, and codex's verdict on one model says nothing about another, so a
// run started after a provider or model change is never handed the old one.

// The spec's five minutes: long enough that a run started from the menu a
// moment after launch costs nothing, short enough that a quota spent in
// another window since is read again before the next run leans on it.
const MAX_AGE_MS = 5 * 60_000

export interface ProviderCheckCache {
  /**
   * The latest answer for `key` when it is under five minutes old, the one in
   * flight for it when there is one, otherwise a new check. Never rejects: a
   * check that throws is no answer, and no answer never blocks a run. An
   * answer that turns out to be for another key is kept under its own and
   * hands this caller nothing. With no key, any answer will do.
   */
  get(key?: string): Promise<ProviderCheck | undefined>
  latest(): ProviderCheck | undefined
  subscribe(listener: (check: ProviderCheck) => void): () => void
}

/** The key an answer is kept under: what it asked about. */
export function answerKey(check: ProviderCheck): string {
  if (providerOf(check) === 'antigravity') return 'antigravity'
  return codexKey(check.asked?.model, check.asked?.effort)
}

function codexKey(model: string | undefined, effort: string | undefined): string {
  return `codex|${model ?? ''}|${effort ?? ''}`
}

/**
 * The key a run under `config` asks with, or undefined for a provider with no
 * check. codex's is resolved as a run resolves it, from polyglots config and
 * then codex's own, so the two keys agree on what the run will use.
 */
export function providerCheckKey(config: PolyglotsConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const provider = config.reviewProvider
  if (!hasProviderCheck(provider)) return undefined
  if (provider === 'antigravity') return 'antigravity'
  const resolved = agentModel('codex', config, undefined, env)
  return codexKey(resolved.model, resolved.effort)
}

/**
 * The preflight a screen hands its run: the cache's answer for the config's
 * provider, or undefined when the run reaches no agent, the provider has no
 * check, or there is no cache (a screen rendered on its own in a test).
 */
export function preflightFor(
  cache: ProviderCheckCache | undefined,
  config: PolyglotsConfig,
  reachesAgent: boolean,
): Promise<ProviderCheck | undefined> | undefined {
  if (cache === undefined || !reachesAgent) return undefined
  const key = providerCheckKey(config)
  return key === undefined ? undefined : cache.get(key)
}

export function createProviderCheckCache(
  check: () => Promise<ProviderCheck>,
  opts: { now?: () => number; maxAgeMs?: number } = {},
): ProviderCheckCache {
  const now = opts.now ?? Date.now
  const maxAge = opts.maxAgeMs ?? MAX_AGE_MS
  const answers = new Map<string, ProviderCheck>()
  let newest: ProviderCheck | undefined
  // By the key asked for, '' for "any": a check in flight for codex is not
  // the answer to a question about antigravity.
  const inflight = new Map<string, Promise<ProviderCheck | undefined>>()
  const listeners = new Set<(check: ProviderCheck) => void>()
  return {
    get(key) {
      const slot = key ?? ''
      const pending = inflight.get(slot)
      if (pending) return pending
      const kept = key === undefined ? newest : answers.get(key)
      if (kept && now() - kept.at < maxAge) return Promise.resolve(kept)
      let started: Promise<ProviderCheck>
      try {
        started = check()
      } catch {
        return Promise.resolve(undefined)
      }
      const run: Promise<ProviderCheck | undefined> = started
        .then(
          (answer) => {
            answers.set(answerKey(answer), answer)
            newest = answer
            for (const listener of listeners) listener(answer)
            return key === undefined || answerKey(answer) === key ? answer : undefined
          },
          () => undefined,
        )
        .finally(() => {
          if (inflight.get(slot) === run) inflight.delete(slot)
        })
      inflight.set(slot, run)
      return run
    },
    latest: () => newest,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

// Undefined outside the app, so a screen rendered on its own in a test starts
// its runs without a check, exactly as before the check existed.
const ProviderCheckContext = createContext<ProviderCheckCache | undefined>(undefined)

export const ProviderCheckProvider = ProviderCheckContext.Provider

export function useProviderCheck(): ProviderCheckCache | undefined {
  return useContext(ProviderCheckContext)
}

/**
 * What the provider line says after the model: the selected model's quota
 * ("90% weekly"), or, signed out, what to do about it in place of the model.
 * Undefined when there is nothing to add, which is every unknown answer.
 */
export function providerNote(check: ProviderCheck | undefined, model: string | undefined): { text: string; replacesModel?: true; warn?: true } | undefined {
  // antigravity's alone: the quota is its, and codex's sign-out is shown on
  // its discovery row through withSignIn instead.
  if (check === undefined || providerOf(check) !== 'antigravity') return undefined
  if (check.signIn.state === 'signed-out') return { text: 'signed out: run agy once to sign in', replacesModel: true, warn: true }
  const line = check.quota === undefined ? undefined : quotaFor(check.quota.lines, model)
  if (line === undefined) return undefined
  const period = /\b(hourly|daily|weekly|monthly)\b/i.exec(line.limit)?.[1]?.toLowerCase()
  return { text: `${line.remaining}% ${period ?? 'left'}`, ...(line.remaining < 10 ? { warn: true as const } : {}) }
}

/**
 * Discovery's row for the checked provider corrected by the check, so setup
 * and home do not call ready an agent the check found signed out. Discovery
 * at launch reads only agy's token file, which outlives a sign-out; the check
 * asked agy itself. For codex only a sign-out is taken: discovery already
 * asks codex login status, and a signed-in answer adds nothing to it. An
 * unknown answer changes nothing.
 */
export function withSignIn(agents: AgentStatus[] | undefined, check: ProviderCheck | undefined): AgentStatus[] | undefined {
  if (agents === undefined || check === undefined || check.signIn.state === 'unknown') return agents
  const state = check.signIn.state
  const provider = providerOf(check)
  if (provider === 'codex' && state !== 'signed-out') return agents
  return agents.map((a) => {
    if (a.provider !== provider || !a.path) return a
    if (provider === 'codex') {
      return { ...a, auth: { state: 'signed-out', detail: 'is signed out: run codex login' }, usable: false, reason: 'codex is signed out: run codex login' }
    }
    if (state === 'signed-in') {
      if (a.auth.state === 'signed-in') return a
      return { ...a, auth: { state: 'signed-in' }, notes: a.notes.filter((n) => !n.startsWith('sign-in unknown')) }
    }
    return { ...a, auth: { state: 'signed-out', detail: 'is signed out: run agy once to sign in' }, usable: false, reason: 'antigravity is signed out: run agy once to sign in' }
  })
}
