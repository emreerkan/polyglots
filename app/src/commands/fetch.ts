import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Locale } from '../types.js'
import { httpGet, type HttpGet, type HttpResponse } from '../wporg/http.js'
import {
  exportUrl,
  localePageUrl,
  projectFileName,
  readSubProjects,
  type FetchStatus,
  type ProjectRef,
  type ProjectType,
  type SubProject,
} from '../wporg/projects.js'

export type Resolution =
  | { input: string; state: 'ready'; type: ProjectType; slug: string; branch?: string; count: number }
  | { input: string; state: 'empty' | 'not-found' | 'unreachable'; reason: string }

export type Ready = Extract<Resolution, { state: 'ready' }>

export type Fetched =
  | { input: string; file: string; state: 'fetched' | 'kept' }
  | { input: string; state: 'failed'; reason: string }

// When each line of the list is worked on, for a screen that shows it. A list
// of thirty projects takes minutes to check and longer to download, and a
// single "Checking..." line over all of it read as a hung screen. Results are
// keyed by the line as given: a plugin's readme arrives with its plugin.
export type CheckProgress = { input: string; state: 'checking' } | { input: string; state: 'checked'; results: Resolution[] }
export type DownloadProgress = { input: string; state: 'downloading' } | { input: string; state: 'downloaded'; result: Fetched }

// Between requests. Half a second was enough for a handful of projects and not
// for a list of twenty-odd, which wp.org answered with 429s part way through
// resolving. A bare slug can cost two page requests, theme then plugin, so a
// long list is a long burst. An export is generated on request and is far
// heavier than a page, so the gap before each one is longer.
const PAGE_PAUSE_MS = 1_500
const EXPORT_PAUSE_MS = 3_000

// What to wait after a 429 or 503 that names no time, one step per retry. Three
// retries spread over about a minute: long enough to outlast a burst limit,
// short enough that a real outage is reported while the person is still there.
const BACKOFF_MS = [5_000, 15_000, 45_000]
// A Retry-After is honoured up to this. A server asking for an hour would park
// the whole batch with no sign of life; better to report the project and let a
// re-run pick it up.
const MAX_RETRY_AFTER_MS = 120_000

// A locale page answers in a second or two, but an export of a project the size
// of WooCommerce is generated on request and takes minutes, not seconds.
const EXPORT_TIMEOUT_MS = 300_000

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>
// Cut short by the signal, so leaving the screen during a 45-second backoff
// does not hold the next screen up for the rest of it.
const realSleep: Sleep = (ms, signal) =>
  ms > 0
    ? new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, ms)
        function done() {
          signal?.removeEventListener('abort', abort)
          resolve()
        }
        function abort() {
          clearTimeout(timer)
          reject(signal!.reason)
        }
        signal?.addEventListener('abort', abort, { once: true })
      })
    : Promise.resolve()

// Seconds, or an HTTP date. Anything unreadable falls back to the backoff step.
function retryAfterMs(raw: string | undefined, now = Date.now()): number | undefined {
  if (raw === undefined) return undefined
  const ms = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) * 1000 : Date.parse(raw) - now
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined
}

interface Polite {
  http: HttpGet
  sleep: Sleep
  onWait?: (ms: number, url: string) => void
  // The person leaving the screen. Checked after every pause as well as
  // handed to the request, since an injected sleep may not watch it.
  signal?: AbortSignal
}

const pause = async (p: Polite, ms: number) => {
  p.signal?.throwIfAborted()
  await p.sleep(ms, p.signal)
  p.signal?.throwIfAborted()
}

/**
 * A GET that waits out wp.org asking it to slow down.
 *
 * A 429 or 503 is retried after the server's Retry-After, or the backoff step
 * when it names none. Giving up on the first refusal reported real projects as
 * unreachable in the middle of a list, which is the failure this exists for.
 * The last answer is returned as it came, so the caller still decides what a
 * refusal that never lifted means.
 */
async function politeGet(p: Polite, url: string, opts?: { timeoutMs?: number }): Promise<HttpResponse & { refusals: number }> {
  for (let attempt = 0; ; attempt++) {
    p.signal?.throwIfAborted()
    const res = await p.http(url, { ...opts, ...(p.signal ? { signal: p.signal } : {}) })
    const refused = res.status === 429 || res.status === 503
    if (!refused || attempt >= BACKOFF_MS.length) return { ...res, refusals: refused ? attempt + 1 : attempt }
    const wait = retryAfterMs(res.retryAfter) ?? BACKOFF_MS[attempt]!
    p.onWait?.(wait, url)
    await pause(p, wait)
  }
}

const refusedReason = (url: string, status: number, refusals: number) =>
  status === 429
    ? `rate limited by translate.wordpress.org (${refusals} refusals); try again in a few minutes`
    : `GET ${url} answered ${status}`

export function defaultOutDir(): string {
  return join(homedir(), 'Downloads', 'polyglots')
}

// How the line was written, for the tables. A resolved slug says less than the
// URL the person pasted, and they recognise their own input fastest.
export const projectInput = (ref: ProjectRef) =>
  ref.type ? [ref.type, ref.slug, ref.branch].filter(Boolean).join('/') : ref.slug

type PageLookup =
  | { kind: 'rows'; rows: SubProject[] }
  | { kind: 'missing' }
  | { kind: 'unreachable'; reason: string }

/**
 * Picks the sub-project a run should work on.
 *
 * A theme has one. A plugin from a bare slug is dev or stable, whichever has
 * more strings in the chosen status, because that is where the work is; a tie
 * goes to dev, where new strings land first. The readme sub-projects are left
 * to `pickReadme`, which adds the readme as an entry of its own.
 */
function pickRow(
  type: ProjectType,
  rows: SubProject[],
  branch: string | undefined,
  status: FetchStatus,
): SubProject | undefined {
  if (type === 'wp-themes') return rows[0]
  if (branch !== undefined) return rows.find((r) => r.branch === branch)
  const dev = rows.find((r) => r.branch === 'dev')
  const stable = rows.find((r) => r.branch === 'stable')
  if (!dev || !stable) return dev ?? stable
  return stable[status] > dev[status] ? stable : dev
}

/**
 * The readme sub-project fetched beside a plugin's code (#33), or undefined
 * when neither readme has strings in the chosen status.
 *
 * It used to be skipped as the plugin directory's copy rather than the
 * interface, but a PTE review covers everything the contributor submitted for
 * the plugin, and the readme is what users see first. One readme, not both:
 * dev-readme and stable-readme hold largely the same text, so reviewing both
 * would report the same problems twice. The one with more strings, because
 * that is where the work is; stable-readme on a tie, because the directory
 * page shows the readme from the stable tag.
 */
function pickReadme(rows: SubProject[], status: FetchStatus): (SubProject & { branch: string }) | undefined {
  const dev = rows.find((r) => r.branch === 'dev-readme')
  const stable = rows.find((r) => r.branch === 'stable-readme')
  const pick = !dev || !stable ? (stable ?? dev) : dev[status] > stable[status] ? dev : stable
  return pick && pick[status] > 0 ? (pick as SubProject & { branch: string }) : undefined
}

/**
 * Turns each line of input into a project that exists and has work, or a
 * reason it does not.
 *
 * A bare slug is tried as a theme first and as a plugin second. The order only
 * matters for a slug wp.org has as both, which is rare and resolves to the theme
 * because this tool's daily use is themes.
 *
 * Only a 404 is "not found". A server error, a timeout or a network failure is
 * "unreachable" and stops the lookup for that line there: trying the plugin
 * after the theme page failed to answer could resolve a theme as a same-named
 * plugin, and reporting an outage as a missing project would quietly drop real
 * work from the batch.
 *
 * Requests are sequential with a pause between them. Resolution is a handful of
 * small pages against a volunteer-run server, and finishing it a few seconds
 * sooner is not worth being the reason it rate limits.
 */
export async function resolveProjects(
  refs: ProjectRef[],
  opts: {
    locale: Locale
    status: FetchStatus
    http?: HttpGet
    pauseMs?: number
    sleep?: Sleep
    onWait?: (ms: number, url: string) => void
    onProgress?: (e: CheckProgress) => void
    // Stops the lookups: the page in flight is cancelled and the promise
    // rejects with the signal's reason. Nothing is returned part way, since
    // a half-checked list is not one a batch should run.
    signal?: AbortSignal
    // Whether a plugin named without a sub-project also brings its readme.
    // On unless turned off (--no-readme, or the Fetch screen's choice).
    readme?: boolean
  },
): Promise<Resolution[]> {
  const sleep = opts.sleep ?? realSleep
  const polite: Polite = {
    http: opts.http ?? httpGet,
    sleep,
    ...(opts.onWait ? { onWait: opts.onWait } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  }
  const pauseMs = opts.pauseMs ?? PAGE_PAUSE_MS
  let first = true

  const lookup = async (type: ProjectType, slug: string): Promise<PageLookup> => {
    if (!first) await pause(polite, pauseMs)
    first = false
    const url = localePageUrl(type, slug, opts.locale)
    let res
    try {
      res = await politeGet(polite, url)
    } catch (err) {
      // Leaving is not an outage, and must not be reported as one.
      opts.signal?.throwIfAborted()
      return { kind: 'unreachable', reason: err instanceof Error ? err.message : String(err) }
    }
    if (res.status === 404) return { kind: 'missing' }
    if (res.status !== 200) return { kind: 'unreachable', reason: refusedReason(url, res.status, res.refusals) }
    // A 200 without the sub-project table is not a project page, whatever
    // wp.org chose to show instead, so it counts as missing for this type.
    const rows = readSubProjects(res.body, type)
    return rows.length === 0 ? { kind: 'missing' } : { kind: 'rows', rows }
  }

  const results: Resolution[] = []
  for (const ref of refs) {
    const input = projectInput(ref)
    opts.onProgress?.({ input, state: 'checking' })
    const types: ProjectType[] = ref.type ? [ref.type] : ['wp-themes', 'wp-plugins']
    let resolution: Resolution | undefined
    let readme: Resolution | undefined
    for (const type of types) {
      const page = await lookup(type, ref.slug)
      if (page.kind === 'missing') continue
      if (page.kind === 'unreachable') {
        resolution = { input, state: 'unreachable', reason: page.reason }
        break
      }
      if (type === 'wp-plugins' && ref.branch === undefined && opts.readme !== false) {
        const row = pickReadme(page.rows, opts.status)
        if (row) {
          const path = `wp-plugins/${ref.slug}/${row.branch}`
          readme = { input: path, state: 'ready', type, slug: ref.slug, branch: row.branch, count: row[opts.status] }
        }
      }
      const row = pickRow(type, page.rows, ref.branch, opts.status)
      if (!row) {
        resolution = { input, state: 'not-found', reason: `${type}/${ref.slug} has no ${ref.branch} sub-project` }
        break
      }
      const count = row[opts.status]
      resolution =
        count === 0
          ? { input, state: 'empty', reason: `nothing ${opts.status}` }
          : {
              input,
              state: 'ready',
              type,
              slug: ref.slug,
              ...(row.branch === undefined ? {} : { branch: row.branch }),
              count,
            }
      break
    }
    const ended: Resolution[] = [resolution ?? { input, state: 'not-found', reason: `no theme or plugin named ${ref.slug}` }]
    if (readme) ended.push(readme)
    results.push(...ended)
    opts.onProgress?.({ input, state: 'checked', results: ended })
  }
  // A readme added beside its code and also named on a line of its own would
  // be downloaded and run twice, under one input. The first one stays.
  const seen = new Set<string>()
  return results.filter((r) => {
    if (r.state !== 'ready') return true
    const key = `${r.type}/${r.slug}/${r.branch ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Where an export is saved.
 *
 * A waiting export takes the name the requester link is read back from, since
 * only a review posts a message back. An untranslated export takes its own
 * name. Sharing one would let a translate run find a waiting export left by an
 * earlier review, keep it as somebody's work, and translate a file with no
 * empty entries: nothing done, and the project reported finished.
 */
export function exportFileName(r: Ready, locale: Locale, status: FetchStatus): string {
  const name = projectFileName(r.type, r.slug, r.branch, locale)
  return status === 'waiting' ? name : name.replace(/\.po$/, '-untranslated.po')
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

/**
 * Downloads each ready project's export under `exportFileName`, so a reviewed
 * file's requester message links to the right page without anyone renaming it.
 *
 * Review and translate treat an existing file differently, because they treat
 * the file differently. Review reads the export and writes its output beside
 * it, and waiting strings keep arriving, so an old export is only stale and is
 * replaced. Translate writes into the file it is given, so an existing one may
 * be a half-finished run or somebody's hand edits, and is kept unless `force`
 * says otherwise. Translate's own cache makes reusing it cheap.
 *
 * A 200 whose body has no msgid is refused. wp.org answers a logged-out or
 * broken export with an HTML page and a success status, and saving that as a
 * catalogue would fail later, in the run, with a parse error that names the
 * file and not the cause. Nothing is written in that case, and the write that
 * does happen goes through a temporary name so an interrupted download never
 * leaves half a catalogue under the real one.
 */
export async function fetchProjects(
  ready: Ready[],
  opts: {
    locale: Locale
    status: FetchStatus
    outDir: string
    force?: boolean
    http?: HttpGet
    pauseMs?: number
    sleep?: Sleep
    onWait?: (ms: number, url: string) => void
    onProgress?: (e: DownloadProgress) => void
    // Stops the downloads as it stops resolveProjects. An export already
    // saved stays on disk; the one in flight never reaches its real name.
    signal?: AbortSignal
  },
): Promise<Fetched[]> {
  const sleep = opts.sleep ?? realSleep
  const polite: Polite = {
    http: opts.http ?? httpGet,
    sleep,
    ...(opts.onWait ? { onWait: opts.onWait } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  }
  const pauseMs = opts.pauseMs ?? EXPORT_PAUSE_MS
  await mkdir(opts.outDir, { recursive: true })

  const results: Fetched[] = []
  const ended = (f: Fetched) => {
    results.push(f)
    opts.onProgress?.({ input: f.input, state: 'downloaded', result: f })
  }
  let first = true
  for (const p of ready) {
    const file = join(opts.outDir, exportFileName(p, opts.locale, opts.status))
    if (opts.status === 'untranslated' && !opts.force && (await exists(file))) {
      ended({ input: p.input, file, state: 'kept' })
      continue
    }
    if (!first) await pause(polite, pauseMs)
    first = false
    opts.onProgress?.({ input: p.input, state: 'downloading' })
    const url = exportUrl(p.type, p.slug, p.branch, opts.locale, opts.status)
    try {
      const res = await politeGet(polite, url, { timeoutMs: EXPORT_TIMEOUT_MS })
      if (res.status !== 200) {
        const reason = res.status === 429 ? refusedReason(url, 429, res.refusals) : `export answered ${res.status}`
        ended({ input: p.input, state: 'failed', reason })
        continue
      }
      if (!/^msgid /m.test(res.body)) {
        ended({ input: p.input, state: 'failed', reason: 'export is not a catalogue' })
        continue
      }
      const tmp = `${file}.part`
      await writeFile(tmp, res.body, 'utf8')
      await rename(tmp, file)
      ended({ input: p.input, file, state: 'fetched' })
    } catch (err) {
      opts.signal?.throwIfAborted()
      ended({ input: p.input, state: 'failed', reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return results
}
