import { createContext, useContext } from 'react'
import { quotaFor, type ProviderCheck } from '../agent/agy-check.js'
import type { AgentStatus } from '../agent/discover.js'

// The antigravity check as the app holds it: asked once in the background at
// launch, shown beside the provider, and handed to a run started soon after
// instead of being asked again. Held above the screens, so the review, the
// translate and the batch screens all read the one answer.

// The spec's five minutes: long enough that a run started from the menu a
// moment after launch costs nothing, short enough that a quota spent in
// another window since is read again before the next run leans on it.
const MAX_AGE_MS = 5 * 60_000

export interface ProviderCheckCache {
  /**
   * The latest answer when it is under five minutes old, the one in flight
   * when there is one, otherwise a new check. Never rejects: a check that
   * throws is no answer, and no answer never blocks a run.
   */
  get(): Promise<ProviderCheck | undefined>
  latest(): ProviderCheck | undefined
  subscribe(listener: (check: ProviderCheck) => void): () => void
}

export function createProviderCheckCache(
  check: () => Promise<ProviderCheck>,
  opts: { now?: () => number; maxAgeMs?: number } = {},
): ProviderCheckCache {
  const now = opts.now ?? Date.now
  const maxAge = opts.maxAgeMs ?? MAX_AGE_MS
  let latest: ProviderCheck | undefined
  let inflight: Promise<ProviderCheck | undefined> | undefined
  const listeners = new Set<(check: ProviderCheck) => void>()
  return {
    get() {
      if (inflight) return inflight
      if (latest && now() - latest.at < maxAge) return Promise.resolve(latest)
      let started: Promise<ProviderCheck>
      try {
        started = check()
      } catch {
        return Promise.resolve(undefined)
      }
      const run: Promise<ProviderCheck | undefined> = started
        .then(
          (answer) => {
            latest = answer
            for (const listener of listeners) listener(answer)
            return answer
          },
          () => undefined,
        )
        .finally(() => {
          if (inflight === run) inflight = undefined
        })
      inflight = run
      return run
    },
    latest: () => latest,
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
  if (check === undefined) return undefined
  if (check.signIn.state === 'signed-out') return { text: 'signed out: run agy once to sign in', replacesModel: true, warn: true }
  const line = check.quota === undefined ? undefined : quotaFor(check.quota.lines, model)
  if (line === undefined) return undefined
  const period = /\b(hourly|daily|weekly|monthly)\b/i.exec(line.limit)?.[1]?.toLowerCase()
  return { text: `${line.remaining}% ${period ?? 'left'}`, ...(line.remaining < 10 ? { warn: true as const } : {}) }
}

/**
 * Discovery's antigravity row corrected by the check, so setup and home do
 * not call ready an agy the check found signed out. Discovery at launch reads
 * only the token file, which outlives a sign-out; the check asked agy itself.
 * An unknown answer changes nothing.
 */
export function withSignIn(agents: AgentStatus[] | undefined, check: ProviderCheck | undefined): AgentStatus[] | undefined {
  if (agents === undefined || check === undefined || check.signIn.state === 'unknown') return agents
  const state = check.signIn.state
  return agents.map((a) => {
    if (a.provider !== 'antigravity' || !a.path) return a
    if (state === 'signed-in') {
      if (a.auth.state === 'signed-in') return a
      return { ...a, auth: { state: 'signed-in' }, notes: a.notes.filter((n) => !n.startsWith('sign-in unknown')) }
    }
    return { ...a, auth: { state: 'signed-out', detail: 'is signed out: run agy once to sign in' }, usable: false, reason: 'antigravity is signed out: run agy once to sign in' }
  })
}
