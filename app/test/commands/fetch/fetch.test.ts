import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultOutDir, fetchProjects, resolveProjects } from '../../../src/commands/fetch.js'
import type { HttpGet } from '../../../src/wporg/http.js'
import { exportUrl, localePageUrl, parseProjectLines } from '../../../src/wporg/projects.js'
import { translationsUrl } from '../../../src/review/message.js'

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'wporg', name), 'utf8')

// A plugin page with chosen counts per sub-project, built in the shape the real
// page has so the scraper reads it the same way.
function pluginPage(slug: string, rows: Record<string, { untranslated: number; waiting: number }>): string {
  const cells = Object.entries(rows)
    .map(
      ([branch, c]) => `<tr><td class="set-name"><a href="/projects/wp-plugins/${slug}/${branch}/tr/default/">${branch}</a></td>
        <td class="stats untranslated"><a>${c.untranslated}</a></td><td class="stats waiting"><a>${c.waiting}</a></td></tr>`,
    )
    .join('')
  return `<table>${cells}</table>`
}

// Answers by URL; anything not listed is a 404, which is what wp.org says for a
// project that does not exist.
function serve(routes: Record<string, { status: number; body: string }>): HttpGet {
  return async (url) => routes[url] ?? { status: 404, body: 'Not found' }
}

const PO = `msgid ""
msgstr ""
"Language: tr\\n"

msgid "Read more"
msgstr "Devamını oku"
`

describe('resolveProjects', () => {
  const opts = { locale: 'tr', status: 'waiting' as const, pauseMs: 0 }

  it('finds a bare slug as a theme', async () => {
    const http = serve({ [localePageUrl('wp-themes', 'koji', 'tr')]: { status: 200, body: fixture('theme-page.html') } })
    const [r] = await resolveProjects(parseProjectLines('koji'), { ...opts, http })
    expect(r).toMatchObject({ state: 'ready', type: 'wp-themes', slug: 'koji', count: 111 })
  })

  it('falls back to a plugin when no theme has the slug', async () => {
    const http = serve({
      [localePageUrl('wp-plugins', 'acme', 'tr')]: {
        status: 200,
        body: pluginPage('acme', { dev: { untranslated: 0, waiting: 12 }, stable: { untranslated: 0, waiting: 3 } }),
      },
    })
    const [r] = await resolveProjects(parseProjectLines('acme'), { ...opts, http })
    expect(r).toMatchObject({ state: 'ready', type: 'wp-plugins', slug: 'acme' })
  })

  it('reports a slug that is neither as not found', async () => {
    const [r] = await resolveProjects(parseProjectLines('nope'), { ...opts, http: serve({}) })
    expect(r).toMatchObject({ state: 'not-found' })
  })

  /**
   * A server that did not answer is not a project that does not exist. Saying
   * "not found" during an outage would quietly drop real work from the batch.
   */
  it('keeps a server failure apart from not found', async () => {
    const http = serve({ [localePageUrl('wp-themes', 'koji', 'tr')]: { status: 503, body: 'busy' } })
    const waits: number[] = []
    const sleep = async (ms: number) => void waits.push(ms)
    const [r] = await resolveProjects(parseProjectLines('koji'), { ...opts, http, sleep })
    expect(r).toMatchObject({ state: 'unreachable', reason: expect.stringMatching(/answered 503/) })
    // Retried like a 429 before it was given up on.
    expect(waits).toHaveLength(3)
  })

  it('reports a network error as unreachable, not as a crash', async () => {
    const http: HttpGet = async () => {
      throw new Error('getaddrinfo ENOTFOUND translate.wordpress.org')
    }
    const [r] = await resolveProjects(parseProjectLines('koji'), { ...opts, http })
    expect(r).toMatchObject({ state: 'unreachable', reason: expect.stringMatching(/ENOTFOUND/) })
  })

  it('takes the plugin branch with more strings in the chosen status', async () => {
    const http = serve({
      [localePageUrl('wp-plugins', 'acme', 'tr')]: {
        status: 200,
        body: pluginPage('acme', { dev: { untranslated: 0, waiting: 3 }, stable: { untranslated: 0, waiting: 40 } }),
      },
    })
    const [r] = await resolveProjects([{ type: 'wp-plugins', slug: 'acme' }], { ...opts, http })
    expect(r).toMatchObject({ state: 'ready', branch: 'stable', count: 40 })
  })

  // A tie goes to dev, where new strings land first.
  it('takes dev on a tie', async () => {
    const http = serve({
      [localePageUrl('wp-plugins', 'acme', 'tr')]: {
        status: 200,
        body: pluginPage('acme', { dev: { untranslated: 0, waiting: 5 }, stable: { untranslated: 0, waiting: 5 } }),
      },
    })
    const [r] = await resolveProjects([{ type: 'wp-plugins', slug: 'acme' }], { ...opts, http })
    expect(r).toMatchObject({ branch: 'dev' })
  })

  // The readme is part of the same request: a PTE review covers everything the
  // contributor submitted for the plugin, and the readme is what the
  // directory shows first (#33). It comes as its own entry, so the download,
  // the batch and the summary count it as a file of its own.
  describe('the readme', () => {
    const page = (rows: Record<string, number>) =>
      serve({
        [localePageUrl('wp-plugins', 'acme', 'tr')]: {
          status: 200,
          body: pluginPage('acme', Object.fromEntries(Object.entries(rows).map(([b, waiting]) => [b, { untranslated: 0, waiting }]))),
        },
      })

    it('comes after the code as an entry of its own, named by its path', async () => {
      const http = page({ dev: 4, stable: 1, 'dev-readme': 0, 'stable-readme': 7 })
      const results = await resolveProjects(parseProjectLines('acme'), { ...opts, http })
      expect(results).toEqual([
        { input: 'acme', state: 'ready', type: 'wp-plugins', slug: 'acme', branch: 'dev', count: 4 },
        { input: 'wp-plugins/acme/stable-readme', state: 'ready', type: 'wp-plugins', slug: 'acme', branch: 'stable-readme', count: 7 },
      ])
    })

    it('is the readme with more strings in the chosen status', async () => {
      const http = page({ dev: 4, 'dev-readme': 9, 'stable-readme': 3 })
      const [, readme] = await resolveProjects([{ type: 'wp-plugins', slug: 'acme' }], { ...opts, http })
      expect(readme).toMatchObject({ branch: 'dev-readme', count: 9 })
    })

    // The directory page shows the readme from the stable tag.
    it('is stable-readme on a tie', async () => {
      const http = page({ dev: 4, 'dev-readme': 5, 'stable-readme': 5 })
      const [, readme] = await resolveProjects([{ type: 'wp-plugins', slug: 'acme' }], { ...opts, http })
      expect(readme).toMatchObject({ branch: 'stable-readme' })
    })

    // An "empty" line for every plugin whose readme has nothing would be noise.
    it('adds nothing when no readme has strings in the chosen status', async () => {
      const http = page({ dev: 4, 'dev-readme': 0, 'stable-readme': 0 })
      expect(await resolveProjects([{ type: 'wp-plugins', slug: 'acme' }], { ...opts, http })).toHaveLength(1)
    })

    it('is fetched even when the code has nothing to do', async () => {
      const http = page({ dev: 0, stable: 0, 'stable-readme': 2 })
      const results = await resolveProjects([{ type: 'wp-plugins', slug: 'acme' }], { ...opts, http })
      expect(results.map((r) => r.state)).toEqual(['empty', 'ready'])
      expect(results[1]).toMatchObject({ branch: 'stable-readme', count: 2 })
    })

    it('is left out when a URL names one sub-project, readme or code', async () => {
      const http = page({ dev: 4, 'dev-readme': 9, 'stable-readme': 3 })
      const code = await resolveProjects([{ type: 'wp-plugins', slug: 'acme', branch: 'dev' }], { ...opts, http })
      expect(code).toEqual([expect.objectContaining({ branch: 'dev' })])
      const named = await resolveProjects([{ type: 'wp-plugins', slug: 'acme', branch: 'stable-readme' }], { ...opts, http })
      expect(named).toEqual([expect.objectContaining({ branch: 'stable-readme', count: 3 })])
    })

    it('is left out when the caller turns it off', async () => {
      const http = page({ dev: 4, 'stable-readme': 7 })
      expect(await resolveProjects([{ type: 'wp-plugins', slug: 'acme' }], { ...opts, readme: false, http })).toHaveLength(1)
    })

    // Named on its own line as well, it would otherwise be downloaded and
    // reviewed twice, and two rows would share one input.
    it('is not added twice when the list also names it', async () => {
      const http = page({ dev: 4, 'stable-readme': 7 })
      const results = await resolveProjects(
        [{ type: 'wp-plugins', slug: 'acme' }, { type: 'wp-plugins', slug: 'acme', branch: 'stable-readme' }],
        { ...opts, http },
      )
      expect(results.map((r) => r.input)).toEqual(['wp-plugins/acme', 'wp-plugins/acme/stable-readme'])
    })

    it('never applies to a theme', async () => {
      const http = serve({ [localePageUrl('wp-themes', 'koji', 'tr')]: { status: 200, body: fixture('theme-page.html') } })
      expect(await resolveProjects(parseProjectLines('koji'), { ...opts, http })).toHaveLength(1)
    })
  })

  it('marks a project with nothing in the chosen status as empty', async () => {
    // The theme fixture has 3 untranslated; zero them and ask for untranslated.
    const page = fixture('theme-page.html').replace(/(stats untranslated[\s\S]*?>)3</, '$10<')
    const http = serve({ [localePageUrl('wp-themes', 'koji', 'tr')]: { status: 200, body: page } })
    const [r] = await resolveProjects(parseProjectLines('koji'), { ...opts, status: 'untranslated', http })
    expect(r).toMatchObject({ state: 'empty' })
  })

  // The spec orders the attempt, so a slug wp.org has as both resolves to the theme.
  it('resolves a slug that is both a theme and a plugin to the theme', async () => {
    const http = serve({
      [localePageUrl('wp-themes', 'twin', 'tr')]: {
        status: 200,
        body: fixture('theme-page.html').replaceAll('/wp-themes/koji/', '/wp-themes/twin/'),
      },
      [localePageUrl('wp-plugins', 'twin', 'tr')]: {
        status: 200,
        body: pluginPage('twin', { dev: { untranslated: 0, waiting: 500 } }),
      },
    })
    const [r] = await resolveProjects(parseProjectLines('twin'), { ...opts, http })
    expect(r).toMatchObject({ type: 'wp-themes' })
  })
})

describe('fetchProjects', () => {
  let out: string

  beforeEach(async () => {
    out = await mkdtemp(join(tmpdir(), 'polyglots-fetch-'))
  })

  afterEach(async () => {
    await rm(out, { recursive: true, force: true })
  })

  const theme = { input: 'koji', state: 'ready' as const, type: 'wp-themes' as const, slug: 'koji', count: 1 }

  it('saves an export under the name the requester link reads back', async () => {
    const http = serve({ [exportUrl('wp-themes', 'koji', undefined, 'tr', 'waiting')]: { status: 200, body: PO } })
    const [f] = await fetchProjects([theme], { locale: 'tr', status: 'waiting', outDir: out, http, pauseMs: 0 })
    expect(f).toMatchObject({ state: 'fetched', file: join(out, 'wp-themes-koji-tr.po') })
    expect(await readFile(join(out, 'wp-themes-koji-tr.po'), 'utf8')).toBe(PO)
  })

  // Review writes its output elsewhere, and waiting strings keep arriving, so a
  // stale export is replaced rather than reused.
  // The readme added beside a plugin's code (#33) goes through the same name,
  // so its review's requester link opens the readme's own page.
  it("saves a plugin's readme under a name that links to the readme", async () => {
    const readme = { input: 'wp-plugins/acme/stable-readme', state: 'ready' as const, type: 'wp-plugins' as const, slug: 'acme', branch: 'stable-readme', count: 2 }
    const http = serve({ [exportUrl('wp-plugins', 'acme', 'stable-readme', 'tr', 'waiting')]: { status: 200, body: PO } })
    const [f] = await fetchProjects([readme], { locale: 'tr', status: 'waiting', outDir: out, http, pauseMs: 0 })
    expect(f).toMatchObject({ state: 'fetched', file: join(out, 'wp-plugins-acme-stable-readme-tr.po') })
    expect(translationsUrl(join(out, 'wp-plugins-acme-stable-readme-tr.po'), 'tr', 'emre')).toMatch(
      /\/wp-plugins\/acme\/stable-readme\/tr\/default\/\?/,
    )
  })

  it('replaces an existing export for review', async () => {
    await writeFile(join(out, 'wp-themes-koji-tr.po'), 'old', 'utf8')
    const http = serve({ [exportUrl('wp-themes', 'koji', undefined, 'tr', 'waiting')]: { status: 200, body: PO } })
    const [f] = await fetchProjects([theme], { locale: 'tr', status: 'waiting', outDir: out, http, pauseMs: 0 })
    expect(f).toMatchObject({ state: 'fetched' })
    expect(await readFile(join(out, 'wp-themes-koji-tr.po'), 'utf8')).toBe(PO)
  })

  // Translate writes into the file, so an existing one is somebody's work.
  it('keeps an existing file for translate unless forced', async () => {
    const file = join(out, 'wp-themes-koji-tr-untranslated.po')
    await writeFile(file, 'my edits', 'utf8')
    const http = serve({ [exportUrl('wp-themes', 'koji', undefined, 'tr', 'untranslated')]: { status: 200, body: PO } })
    const [kept] = await fetchProjects([theme], { locale: 'tr', status: 'untranslated', outDir: out, http, pauseMs: 0 })
    expect(kept).toMatchObject({ state: 'kept', file })
    expect(await readFile(file, 'utf8')).toBe('my edits')

    const [forced] = await fetchProjects([theme], {
      locale: 'tr',
      status: 'untranslated',
      outDir: out,
      http,
      pauseMs: 0,
      force: true,
    })
    expect(forced).toMatchObject({ state: 'fetched' })
    expect(await readFile(file, 'utf8')).toBe(PO)
  })

  // A waiting export has no empty entries. Kept as the file to translate, it
  // would make translate do nothing and still report the project done.
  it('never mistakes a waiting export for the file to translate', async () => {
    await writeFile(join(out, 'wp-themes-koji-tr.po'), 'waiting export', 'utf8')
    const http = serve({ [exportUrl('wp-themes', 'koji', undefined, 'tr', 'untranslated')]: { status: 200, body: PO } })
    const [f] = await fetchProjects([theme], { locale: 'tr', status: 'untranslated', outDir: out, http, pauseMs: 0 })
    expect(f).toMatchObject({ state: 'fetched', file: join(out, 'wp-themes-koji-tr-untranslated.po') })
    expect(await readFile(join(out, 'wp-themes-koji-tr.po'), 'utf8')).toBe('waiting export')
  })

  // wp.org can answer 200 with a page, for a login or an error. Saving that as a
  // catalogue would hand review a file it cannot read.
  it('refuses a 200 that is not a catalogue, and writes nothing', async () => {
    const http = serve({
      [exportUrl('wp-themes', 'koji', undefined, 'tr', 'waiting')]: { status: 200, body: '<html>Log in</html>' },
    })
    const [f] = await fetchProjects([theme], { locale: 'tr', status: 'waiting', outDir: out, http, pauseMs: 0 })
    expect(f).toMatchObject({ state: 'failed', reason: expect.stringMatching(/not a catalogue/) })
    await expect(readFile(join(out, 'wp-themes-koji-tr.po'), 'utf8')).rejects.toThrow()
  })

  it('reports a failed download and carries on', async () => {
    const other = { ...theme, input: 'sydney', slug: 'sydney' }
    const http = serve({ [exportUrl('wp-themes', 'sydney', undefined, 'tr', 'waiting')]: { status: 200, body: PO } })
    const results = await fetchProjects([theme, other], { locale: 'tr', status: 'waiting', outDir: out, http, pauseMs: 0 })
    expect(results.map((r) => r.state)).toEqual(['failed', 'fetched'])
  })

  it('defaults to the Downloads folder the rest of the workflow uses', () => {
    expect(defaultOutDir()).toMatch(/Downloads[/\\]polyglots$/)
  })
})

// wp.org answers a burst of requests with 429. Giving up on the first one
// reported real projects as unreachable, so a refusal is waited out and asked
// again before anything is reported.
describe('rate limiting', () => {
  // Answers 429 for the first `refusals` requests to each URL, then serves.
  function throttled(routes: Record<string, string>, refusals: number, retryAfter?: string) {
    const seen = new Map<string, number>()
    const http: HttpGet = async (url) => {
      const n = (seen.get(url) ?? 0) + 1
      seen.set(url, n)
      if (n <= refusals) return { status: 429, body: 'Too Many Requests', ...(retryAfter ? { retryAfter } : {}) }
      return routes[url] === undefined ? { status: 404, body: '' } : { status: 200, body: routes[url]! }
    }
    return { http, seen }
  }
  const recorder = () => {
    const waits: number[] = []
    return { waits, sleep: async (ms: number) => void waits.push(ms) }
  }

  it('waits out a 429 on a page and asks again', async () => {
    const { http } = throttled({ [localePageUrl('wp-themes', 'koji', 'tr')]: fixture('theme-page.html') }, 1, '7')
    const { waits, sleep } = recorder()
    const [r] = await resolveProjects(parseProjectLines('koji'), { locale: 'tr', status: 'waiting', http, sleep })
    expect(r).toMatchObject({ state: 'ready', count: 111 })
    expect(waits).toContain(7_000)
  })

  it('backs off 5, 15 and 45 seconds when wp.org gives no Retry-After', async () => {
    const { http, seen } = throttled({}, 99)
    const { waits, sleep } = recorder()
    const [r] = await resolveProjects([{ type: 'wp-themes', slug: 'koji' }], { locale: 'tr', status: 'waiting', http, sleep })
    expect(waits).toEqual([5_000, 15_000, 45_000])
    expect(seen.get(localePageUrl('wp-themes', 'koji', 'tr'))).toBe(4)
    expect(r).toMatchObject({ state: 'unreachable', reason: expect.stringMatching(/rate limited/) })
  })

  // A server that asks for an hour would park the batch with no sign of life.
  it('caps a long Retry-After at two minutes', async () => {
    const { http } = throttled({ [localePageUrl('wp-themes', 'koji', 'tr')]: fixture('theme-page.html') }, 1, '3600')
    const { waits, sleep } = recorder()
    await resolveProjects(parseProjectLines('koji'), { locale: 'tr', status: 'waiting', http, sleep })
    expect(waits).toEqual([120_000])
  })

  it('waits out a 429 on an export and saves it', async () => {
    const out = await mkdtemp(join(tmpdir(), 'polyglots-fetch-'))
    try {
      const { http } = throttled({ [exportUrl('wp-themes', 'koji', undefined, 'tr', 'waiting')]: PO }, 2)
      const { waits, sleep } = recorder()
      const theme = { input: 'koji', state: 'ready' as const, type: 'wp-themes' as const, slug: 'koji', count: 1 }
      const [f] = await fetchProjects([theme], { locale: 'tr', status: 'waiting', outDir: out, http, sleep })
      expect(f).toMatchObject({ state: 'fetched' })
      expect(waits).toEqual([5_000, 15_000])
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })

  it('tells the caller it is waiting, and for how long', async () => {
    const { http } = throttled({ [localePageUrl('wp-themes', 'koji', 'tr')]: fixture('theme-page.html') }, 1)
    const { sleep } = recorder()
    const told: number[] = []
    await resolveProjects(parseProjectLines('koji'), {
      locale: 'tr',
      status: 'waiting',
      http,
      sleep,
      onWait: (ms) => told.push(ms),
    })
    expect(told).toEqual([5_000])
  })

  // The courtesy pause between requests, which is what keeps a long list from
  // being refused in the first place.
  it('pauses 1.5 seconds between pages and 3 seconds between exports by default', async () => {
    const routes = {
      [localePageUrl('wp-themes', 'koji', 'tr')]: fixture('theme-page.html'),
      [localePageUrl('wp-themes', 'twin', 'tr')]: fixture('theme-page.html').replaceAll('/wp-themes/koji/', '/wp-themes/twin/'),
    }
    const { http } = throttled(routes, 0)
    const pages = recorder()
    const ready = await resolveProjects(parseProjectLines('koji\ntwin'), { locale: 'tr', status: 'waiting', http, sleep: pages.sleep })
    expect(pages.waits).toEqual([1_500])

    const out = await mkdtemp(join(tmpdir(), 'polyglots-fetch-'))
    try {
      const exports = recorder()
      const serveAll: HttpGet = async () => ({ status: 200, body: PO })
      await fetchProjects(ready as any, { locale: 'tr', status: 'waiting', outDir: out, http: serveAll, sleep: exports.sleep })
      expect(exports.waits).toEqual([3_000])
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })
})

// A list of thirty projects takes minutes to check and longer to download, so
// the screens show which project is being worked on. The events carry nothing
// the results do not: only when each project starts and how it ended.
describe('progress', () => {
  let out: string

  beforeEach(async () => {
    out = await mkdtemp(join(tmpdir(), 'polyglots-fetch-'))
  })

  afterEach(async () => {
    await rm(out, { recursive: true, force: true })
  })

  it('reports each project as it is checked and how it ended', async () => {
    const http = serve({ [localePageUrl('wp-themes', 'koji', 'tr')]: { status: 200, body: fixture('theme-page.html') } })
    const events: unknown[] = []
    await resolveProjects(parseProjectLines('koji\nnope'), {
      locale: 'tr',
      status: 'waiting',
      pauseMs: 0,
      http,
      onProgress: (e) => events.push(e),
    })
    expect(events).toEqual([
      { input: 'koji', state: 'checking' },
      { input: 'koji', state: 'checked', results: [expect.objectContaining({ input: 'koji', state: 'ready' })] },
      { input: 'nope', state: 'checking' },
      { input: 'nope', state: 'checked', results: [expect.objectContaining({ input: 'nope', state: 'not-found' })] },
    ])
  })

  // A plugin's readme is a line of the results but not of the list, so it
  // arrives with its plugin rather than as a project of its own.
  it("reports a plugin's readme with the plugin it came from", async () => {
    const http = serve({
      [localePageUrl('wp-plugins', 'acme', 'tr')]: {
        status: 200,
        body: pluginPage('acme', { dev: { untranslated: 0, waiting: 4 }, 'stable-readme': { untranslated: 0, waiting: 2 } }),
      },
    })
    const events: Array<{ state: string; results?: unknown[] }> = []
    await resolveProjects(parseProjectLines('wp-plugins/acme'), {
      locale: 'tr',
      status: 'waiting',
      pauseMs: 0,
      http,
      onProgress: (e) => events.push(e),
    })
    expect(events.map((e) => e.state)).toEqual(['checking', 'checked'])
    expect(events[1]!.results).toHaveLength(2)
  })

  it('reports each export as it downloads and how it ended', async () => {
    const http = serve({ [exportUrl('wp-themes', 'koji', undefined, 'tr', 'waiting')]: { status: 200, body: PO } })
    const ready = [
      { input: 'koji', state: 'ready' as const, type: 'wp-themes' as const, slug: 'koji', count: 1 },
      { input: 'gone', state: 'ready' as const, type: 'wp-themes' as const, slug: 'gone', count: 1 },
    ]
    const events: unknown[] = []
    await fetchProjects(ready, { locale: 'tr', status: 'waiting', outDir: out, http, pauseMs: 0, onProgress: (e) => events.push(e) })
    expect(events).toEqual([
      { input: 'koji', state: 'downloading' },
      { input: 'koji', state: 'downloaded', result: expect.objectContaining({ state: 'fetched' }) },
      { input: 'gone', state: 'downloading' },
      { input: 'gone', state: 'downloaded', result: expect.objectContaining({ state: 'failed' }) },
    ])
  })

  // A file kept for translate is never requested, so it never downloads.
  it('reports a kept file as ended without downloading it', async () => {
    const theme = { input: 'koji', state: 'ready' as const, type: 'wp-themes' as const, slug: 'koji', count: 1 }
    await writeFile(join(out, 'wp-themes-koji-tr-untranslated.po'), PO)
    const events: unknown[] = []
    await fetchProjects([theme], { locale: 'tr', status: 'untranslated', outDir: out, http: serve({}), pauseMs: 0, onProgress: (e) => events.push(e) })
    expect(events).toEqual([{ input: 'koji', state: 'downloaded', result: expect.objectContaining({ state: 'kept' }) }])
  })
})

// The person can leave the screen part way through a long list. Nothing after
// that is asked of wp.org, and the request in flight is cancelled with it.
describe('abort', () => {
  let out: string

  beforeEach(async () => {
    out = await mkdtemp(join(tmpdir(), 'polyglots-fetch-'))
  })

  afterEach(async () => {
    await rm(out, { recursive: true, force: true })
  })

  // Answers every page after the first only once the test lets it, so the
  // abort lands while a request is in flight.
  function gated(controller: AbortController) {
    const asked: string[] = []
    const signals: Array<AbortSignal | undefined> = []
    const http: HttpGet = (url, opts) => {
      asked.push(url)
      signals.push(opts?.signal)
      return new Promise((resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(opts.signal!.reason))
        if (asked.length === 1) resolve({ status: 404, body: '' })
        else queueMicrotask(() => controller.abort())
      })
    }
    return { http, asked, signals }
  }

  it('stops checking the list and cancels the page in flight', async () => {
    const controller = new AbortController()
    const { http, asked, signals } = gated(controller)
    const run = resolveProjects(parseProjectLines('wp-themes/a\nwp-themes/b\nwp-themes/c'), {
      locale: 'tr',
      status: 'waiting',
      pauseMs: 0,
      http,
      signal: controller.signal,
    })
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(asked).toHaveLength(2)
    expect(signals[1]?.aborted).toBe(true)
  })

  it('stops the downloads and cancels the export in flight', async () => {
    const controller = new AbortController()
    const { http, asked, signals } = gated(controller)
    const ready = ['a', 'b', 'c'].map((slug) => ({ input: slug, state: 'ready' as const, type: 'wp-themes' as const, slug, count: 1 }))
    const run = fetchProjects(ready, {
      locale: 'tr',
      status: 'waiting',
      outDir: out,
      pauseMs: 0,
      http,
      signal: controller.signal,
    })
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(asked).toHaveLength(2)
    expect(signals[1]?.aborted).toBe(true)
  })

  it('asks nothing more once aborted during the pause between requests', async () => {
    const asked: string[] = []
    const http: HttpGet = async (url) => {
      asked.push(url)
      return { status: 404, body: '' }
    }
    const controller = new AbortController()
    const run = resolveProjects(parseProjectLines('wp-themes/a\nwp-themes/b'), {
      locale: 'tr',
      status: 'waiting',
      http,
      signal: controller.signal,
      sleep: async () => controller.abort(),
    })
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(asked).toHaveLength(1)
  })
})
