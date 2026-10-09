import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { dataDir } from '../paths.js'
import type { PolyglotsConfig } from '../types.js'
import { VERSION } from '../version.js'

// Whether npm holds a newer polyglots than the one running. Asked at most once
// a day, in the background, and said at the end of a command or on the way out
// of the TUI, never in the middle of a run.

export const DEFAULT_UPDATE_URL = 'https://registry.npmjs.org/polyglots/latest'

// Once a day: a release is not urgent news, and the registry should not see a
// request per command from someone running a batch of fifty files.
export const CHECK_EVERY_MS = 86_400_000
// After a request that got no answer: offline, a timeout, the registry down.
// Soon enough that a lost request does not hide a release for a day, and long
// enough that a laptop on a train does not try at the start of every command.
export const RETRY_AFTER_MS = 3_600_000
// Short, because nothing waits on the answer: a command that ends first exits
// at once, and the next one reads what this one saved.
const CHECK_TIMEOUT_MS = 3000
// A version manifest is a few kilobytes. Anything far larger is not one.
const MAX_BODY = 1_000_000

/**
 * On unless the setting, NO_UPDATE_NOTIFIER (the convention other npm CLIs
 * follow) or CI turns it off. DO_NOT_TRACK is deliberately not read: asking
 * the registry for a version number reports nothing about the person, and
 * the setting is the switch for anyone who wants it off.
 */
export function updateCheckEnabled(config: Pick<PolyglotsConfig, 'updateCheck'>, env: NodeJS.ProcessEnv): boolean {
  if (config.updateCheck === false) return false
  if (set(env.NO_UPDATE_NOTIFIER)) return false
  return !set(env.CI)
}

const set = (value: string | undefined): boolean => {
  const v = value?.trim().toLowerCase()
  return v !== undefined && v !== '' && v !== '0' && v !== 'false'
}

/** Where the check asks. Overridable so tests never reach the registry. */
export function updateUrl(env: NodeJS.ProcessEnv): string {
  const value = env.POLYGLOTS_UPDATE_URL?.trim()
  return value ? value : DEFAULT_UPDATE_URL
}

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/
const ANY = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/

/**
 * Whether `latest` is a release newer than `current`. A pre-release on the
 * latest tag is never offered; a running pre-release counts as its release,
 * so a build of 0.27.0-rc.1 is not told about 0.27.0's own publication but is
 * told about 0.27.1.
 */
export function isNewer(latest: string, current: string): boolean {
  const l = RELEASE.exec(latest)
  const c = ANY.exec(current)
  if (!l || !c) return false
  for (let i = 1; i <= 3; i++) {
    const diff = Number(l[i]) - Number(c[i])
    if (diff !== 0) return diff > 0
  }
  return false
}

// The package root, the directory holding package.json, from src and dist alike.
const PACKAGE_ROOT = dirname(createRequire(import.meta.url).resolve('../../package.json'))

/**
 * How to update this install. A checkout linked with npm link sits one level
 * below the repository root; telling it to npm install -g would leave a second
 * copy beside the link rather than updating the one that runs.
 */
export function updateCommand(packageRoot: string = PACKAGE_ROOT): string {
  return existsSync(join(packageRoot, '..', '.git')) ? 'git pull && npm ci && npm run build' : 'npm install -g polyglots'
}

/** The line said once a newer version is known. */
export function updateNotice(latest: string, current: string = VERSION, command: string = updateCommand()): string {
  return `polyglots ${latest} is available (you have ${current}). Update with: ${command}`
}

// Beside usage.json, for the same reasons: not a setting to copy between
// machines, and not in jobs.db, whose deletion should cost a re-review only.
interface UpdateState {
  // Of the last answer the registry gave. Only an answer sets it.
  checkedAt?: number
  // Of the last request, answered or not. Written before the request goes,
  // so two commands started together ask once.
  attemptedAt?: number
  latest?: string
}

export function updateStateFile(): string {
  return join(dataDir(), 'update.json')
}

function readState(): UpdateState | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(updateStateFile(), 'utf8'))
    if (raw === null || typeof raw !== 'object') return undefined
    const { checkedAt, attemptedAt, latest } = raw as Record<string, unknown>
    return {
      ...(typeof checkedAt === 'number' ? { checkedAt } : {}),
      ...(typeof attemptedAt === 'number' ? { attemptedAt } : {}),
      ...(typeof latest === 'string' ? { latest } : {}),
    }
  } catch {
    return undefined
  }
}

function writeState(state: UpdateState): void {
  const path = updateStateFile()
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

/**
 * GETs the URL and settles on the body of a 200, or undefined. Never rejects.
 * node:http rather than fetch for the same reason as the usage send: the
 * socket and the timer are unreferenced, so a command that finishes while the
 * request is out exits at once instead of waiting on the registry.
 */
function get(url: string, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      return resolve(undefined)
    }
    const request = target.protocol === 'https:' ? httpsRequest : target.protocol === 'http:' ? httpRequest : undefined
    if (!request) return resolve(undefined)
    const req = request(target, { headers: { accept: 'application/json', 'user-agent': `polyglots/${VERSION}` } })
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs)
    timer.unref()
    const done = (body: string | undefined) => {
      clearTimeout(timer)
      resolve(body)
    }
    req.on('socket', (socket) => socket.unref())
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        return done(undefined)
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
        if (body.length > MAX_BODY) req.destroy(new Error('too large'))
      })
      res.on('end', () => done(body))
      res.on('error', () => done(undefined))
    })
    req.on('error', () => done(undefined))
    req.end()
  })
}

export interface CheckOptions {
  url?: string
  version?: string
  now?: () => number
  timeoutMs?: number
}

/**
 * The newer version npm holds, or undefined. Asks the registry when the saved
 * answer is a day old or missing, and no request has gone out in the last
 * hour; otherwise answers from what is saved. Never
 * rejects and prints nothing: an update notice that broke a review would be
 * worse than none.
 */
export async function checkForUpdate(opts: CheckOptions = {}): Promise<string | undefined> {
  const version = opts.version ?? VERSION
  const newer = (latest: string | undefined) => (latest !== undefined && isNewer(latest, version) ? latest : undefined)
  try {
    const now = (opts.now ?? Date.now)()
    const saved = readState()
    const fresh = saved?.checkedAt !== undefined && now - saved.checkedAt < CHECK_EVERY_MS
    const tried = saved?.attemptedAt !== undefined && now - saved.attemptedAt < RETRY_AFTER_MS
    if (fresh || tried) return newer(saved?.latest)
    writeState({ ...saved, attemptedAt: now })
    const body = await get(opts.url ?? updateUrl(process.env), opts.timeoutMs ?? CHECK_TIMEOUT_MS)
    const latest = body === undefined ? undefined : manifestVersion(body)
    // No answer leaves the last one, and when it came, as they were.
    if (latest === undefined) return newer(saved?.latest)
    writeState({ ...readState(), checkedAt: now, latest })
    return newer(latest)
  } catch {
    return undefined
  }
}

function manifestVersion(body: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(body)
    const version = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>).version : undefined
    return typeof version === 'string' && ANY.test(version) ? version : undefined
  } catch {
    return undefined
  }
}
