import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { dirname, join } from 'node:path'
import { dataDir, dbFile } from '../paths.js'
import { glossarySyncTimes } from '../storage/glossary.js'
import { readOnly } from '../storage/read-only.js'
import { CHECK_EVERY_MS, RETRY_AFTER_MS } from '../update/index.js'
import { USER_AGENT } from '../wporg/http.js'
import { glossaryExportUrl } from '../wporg/glossary.js'

// Whether a synced glossary has changed on translate.wordpress.org since. The
// glossary decides how terms are translated and reviewed, so a stale copy
// quietly holds every run to wordings the locale team has since replaced: the
// tr copy synced on 19 September missed a change made twelve hours later and
// went on suggesting it for a month.
//
// Asked like the update check (src/update): at most once a day per locale, in
// the background, said at the end of a command, switched off by the same
// setting.

// The fallback when wp.org cannot say: a month, the maintainer's own rule of
// thumb from before the export's date was known.
export const STALE_AFTER_MS = 30 * 86_400_000
// Past this, a copy is reminded whatever wp.org says. The export's
// Last-Modified has been seen to follow an entry edit once (the tr change of
// 19 September), which is not yet proof that every edit moves it; a header
// that lagged would otherwise hide a change forever. Remove this once more
// changes have confirmed the date.
export const LONG_STALE_AFTER_MS = 90 * 86_400_000
const CHECK_TIMEOUT_MS = 3000

export interface StaleGlossary {
  locale: string
  // When the local copy was synced, from the rows themselves.
  syncedAt: number
  // When wp.org says the glossary last changed. Absent when it could not
  // say and the copy is reported only for its age.
  changedAt?: number
}

export interface GlossaryCheckOptions {
  now?: () => number
  timeoutMs?: number
  // The synced locales and when each was synced. Read from polyglots.db by
  // default, read-only: this runs at the start of commands that may write it.
  synced?: () => Array<{ locale: string; syncedAt: number }>
  urlFor?: (locale: string) => string
}

// Beside update.json, for the same reasons: not a setting, and not in either
// database. Keyed by locale.
interface LocaleState {
  // Of the last answer. An answer without the header still sets it.
  checkedAt?: number
  // Of the last request, answered or not. Written before the request goes.
  attemptedAt?: number
  changedAt?: number
}
type State = Record<string, LocaleState>

export function glossaryCheckFile(): string {
  return join(dataDir(), 'glossary-check.json')
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function readState(): State {
  try {
    const raw: unknown = JSON.parse(readFileSync(glossaryCheckFile(), 'utf8'))
    if (raw === null || typeof raw !== 'object') return {}
    const state: State = {}
    for (const [locale, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue
      const v = value as Record<string, unknown>
      const checkedAt = num(v.checkedAt)
      const attemptedAt = num(v.attemptedAt)
      const changedAt = num(v.changedAt)
      state[locale] = {
        ...(checkedAt === undefined ? {} : { checkedAt }),
        ...(attemptedAt === undefined ? {} : { attemptedAt }),
        ...(changedAt === undefined ? {} : { changedAt }),
      }
    }
    return state
  } catch {
    return {}
  }
}

// Read, changed and written per update rather than once at the end, so two
// locales answering at different times do not overwrite each other.
function updateState(locale: string, change: (s: LocaleState) => LocaleState): void {
  const state = readState()
  state[locale] = change(state[locale] ?? {})
  const path = glossaryCheckFile()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(state) + '\n')
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

interface Answer {
  answered: boolean
  changedAt?: number
}

/**
 * The export's Last-Modified, from a GET whose body is never read: the
 * response is destroyed once its headers arrive. A GET rather than a HEAD
 * because the GET is the request known to carry the header. Only a 200 is an
 * answer; a 429, a redirect or an error is not, and is tried again an hour
 * later. The socket and timer are unreferenced, so a command that ends first
 * exits at once. Never rejects.
 */
function lastModified(url: string, timeoutMs: number): Promise<Answer> {
  return new Promise((resolve) => {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      return resolve({ answered: false })
    }
    const request = target.protocol === 'https:' ? httpsRequest : target.protocol === 'http:' ? httpRequest : undefined
    if (!request) return resolve({ answered: false })
    const req = request(target, { headers: { 'user-agent': USER_AGENT } })
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs)
    timer.unref()
    let settled = false
    const done = (answer: Answer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(answer)
    }
    req.on('socket', (socket) => socket.unref())
    req.on('response', (res) => {
      const header = res.headers['last-modified']
      const changedAt = header === undefined ? NaN : Date.parse(header)
      done(res.statusCode !== 200 ? { answered: false } : Number.isNaN(changedAt) ? { answered: true } : { answered: true, changedAt })
      res.destroy()
    })
    req.on('error', () => done({ answered: false }))
    req.end()
  })
}

const defaultSynced = () => readOnly(dbFile(), glossarySyncTimes, [])

async function checkOne(locale: string, syncedAt: number, now: number, opts: GlossaryCheckOptions): Promise<StaleGlossary | undefined> {
  let saved = readState()[locale] ?? {}
  const fresh = saved.checkedAt !== undefined && now - saved.checkedAt < CHECK_EVERY_MS
  const tried = saved.attemptedAt !== undefined && now - saved.attemptedAt < RETRY_AFTER_MS
  if (!fresh && !tried) {
    updateState(locale, (s) => ({ ...s, attemptedAt: now }))
    const url = (opts.urlFor ?? glossaryExportUrl)(locale)
    const answer = await lastModified(url, opts.timeoutMs ?? CHECK_TIMEOUT_MS)
    if (answer.answered) {
      updateState(locale, ({ changedAt: _old, ...s }) => ({
        ...s,
        checkedAt: now,
        ...(answer.changedAt === undefined ? {} : { changedAt: answer.changedAt }),
      }))
    }
    saved = readState()[locale] ?? {}
  }
  if (saved.changedAt !== undefined && saved.changedAt > syncedAt) return { locale, syncedAt, changedAt: saved.changedAt }
  const limit = saved.changedAt === undefined ? STALE_AFTER_MS : LONG_STALE_AFTER_MS
  return now - syncedAt > limit ? { locale, syncedAt } : undefined
}

/**
 * The synced glossaries that are out of date: changed on wp.org after the
 * copy was synced; older than a month when wp.org has never said; older than
 * three months in any case. Never rejects and prints nothing, like the update
 * check.
 */
export async function checkGlossaries(opts: GlossaryCheckOptions = {}): Promise<StaleGlossary[]> {
  try {
    const now = (opts.now ?? Date.now)()
    const synced = (opts.synced ?? defaultSynced)()
    const results = await Promise.all(
      synced.map(({ locale, syncedAt }) => checkOne(locale, syncedAt, now, opts).catch(() => undefined)),
    )
    return results.filter((r): r is StaleGlossary => r !== undefined)
  } catch {
    return []
  }
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** The line said at the end of a command for one stale glossary. */
export function glossaryNotice(stale: StaleGlossary, now: number = Date.now()): string {
  const command = `polyglots glossary sync --locale ${stale.locale}`
  if (stale.changedAt !== undefined) {
    return `The ${stale.locale} glossary on translate.wordpress.org changed after your copy (synced ${day(stale.syncedAt)}). Update with: ${command}`
  }
  const days = Math.floor((now - stale.syncedAt) / 86_400_000)
  return `Your ${stale.locale} glossary was synced ${days} days ago. Update with: ${command}`
}
