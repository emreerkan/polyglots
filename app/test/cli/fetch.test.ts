import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main, type CliDeps } from '../../src/cli.js'
import type { Fetched, Ready, Resolution } from '../../src/commands/fetch.js'
import type { ReviewOptions } from '../../src/commands/review.js'
import type { TranslateOptions, TranslateSummary } from '../../src/commands/translate.js'
import type { ProjectRef } from '../../src/wporg/projects.js'
import type { ReviewSummary } from '../../src/types.js'
import type { ModelCheck } from '../../src/draft/discover.js'

function sink() {
  return {
    isTTY: false,
    text: '',
    write(chunk: string) {
      this.text += chunk
      return true
    },
  }
}

function stdinWith(input: string | undefined, isTTY: boolean) {
  const stream = new PassThrough() as PassThrough & { isTTY?: boolean }
  stream.isTTY = isTTY
  if (input !== undefined) stream.write(input)
  stream.end()
  return stream
}

const reviewSummary = (file: string, patch: Partial<ReviewSummary> = {}): ReviewSummary => ({
  file,
  locale: 'tr',
  total: 20,
  skipped: 0,
  reviewed: 20,
  problems: 3,
  needsReview: 0,
  approvable: 17,
  unreviewed: 0,
  repaired: 2,
  written: 3,
  pending: 0,
  byRule: {},
  byGroup: {},
  problemsFile: file.replace(/\.po$/, '-repaired.po'),
  ...patch,
})

const translateSummary = (file: string): TranslateSummary => ({
  file,
  total: 10,
  pending: 4,
  fromTm: 1,
  translated: 3,
  fuzzy: 0,
  skipped: 0,
})

let home: string
let savedEnv: NodeJS.ProcessEnv

beforeEach(async () => {
  savedEnv = { ...process.env }
  home = await mkdtemp(join(tmpdir(), 'polyglots-cli-fetch-'))
  process.env.POLYGLOTS_HOME = home
  // Named rather than assumed: polyglots has no default locale.
  await mkdir(join(home, 'config'), { recursive: true })
  await writeFile(join(home, 'config', 'config.json'), JSON.stringify({ defaultLocale: 'tr' }))
  process.env.DEEPL_API_KEY = 'dpl-test-key-0123456789:fx'
})

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  await rm(home, { recursive: true, force: true })
})

// Resolves every slug except "missing" and "quiet" (nothing waiting), and
// fetches every ready one except "broken".
function fakeWporg() {
  const resolved: ProjectRef[][] = []
  const resolveProjects: CliDeps['resolveProjects'] = async (refs) => {
    resolved.push(refs)
    return refs.map((r): Resolution => {
      if (r.slug === 'missing') return { input: r.slug, state: 'not-found', reason: 'no theme or plugin' }
      if (r.slug === 'quiet') return { input: r.slug, state: 'empty', reason: 'nothing waiting' }
      return { input: r.slug, state: 'ready', type: 'wp-themes', slug: r.slug, count: 5 }
    })
  }
  const fetchOpts: Array<{ outDir: string; force?: boolean }> = []
  const fetchProjects: CliDeps['fetchProjects'] = async (ready: Ready[], opts) => {
    fetchOpts.push({ outDir: opts.outDir, ...(opts.force === undefined ? {} : { force: opts.force }) })
    return ready.map(
      (p): Fetched =>
        p.slug === 'broken'
          ? { input: p.input, state: 'failed', reason: 'export answered 500' }
          : { input: p.input, state: 'fetched', file: join(opts.outDir, `wp-themes-${p.slug}-tr.po`) },
    )
  }
  return { resolveProjects, fetchProjects, resolved, fetchOpts }
}

async function run(argv: string[], deps: Omit<CliDeps, 'streams'> & { stdin?: ReturnType<typeof stdinWith> } = {}) {
  const stdout = sink()
  const stderr = sink()
  const { stdin, ...rest } = deps
  const code = await main(argv, { env: {}, ...rest, streams: { stdin: stdin ?? stdinWith(undefined, false), stdout, stderr } })
  return { code, stdout: stdout.text, stderr: stderr.text }
}

describe('fetch', () => {
  it('reviews every waiting project with the same database handles', async () => {
    const wporg = fakeWporg()
    const calls: ReviewOptions[] = []
    const r = await run(['fetch', 'koji', 'sydney', '--get', 'waiting', '--out-dir', home], {
      ...wporg,
      reviewFile: async (opts) => {
        calls.push(opts)
        return reviewSummary(opts.file)
      },
    })
    expect(r.code).toBe(0)
    expect(calls.map((c) => c.file)).toEqual([join(home, 'wp-themes-koji-tr.po'), join(home, 'wp-themes-sydney-tr.po')])
    const dbs = new Set<Database.Database | undefined>(calls.map((c) => c.db))
    const jobsDbs = new Set<Database.Database | undefined>(calls.map((c) => c.jobsDb))
    expect(dbs.size).toBe(1)
    expect(jobsDbs.size).toBe(1)
    expect([...dbs][0]).toBeDefined()
    expect([...jobsDbs][0]).toBeDefined()
    // And the same control, so one key stops the whole batch.
    expect(new Set(calls.map((c) => c.control)).size).toBe(1)
  })

  // Every project's run is this process's, so one signal stops them all as
  // stopped. Emitted, not sent: the real one ends the worker.
  it('records a signal during the batch as a stop, then sends it on', async () => {
    const wporg = fakeWporg()
    const order: string[] = []
    await run(['fetch', 'koji', '--get', 'waiting', '--out-dir', home], {
      ...wporg,
      stopOwnRuns: () => (order.push('stop'), 1),
      raiseSignal: (s) => void order.push(`raise ${s}`),
      reviewFile: async (opts) => {
        process.emit('SIGTERM', 'SIGTERM')
        return reviewSummary(opts.file)
      },
    })
    expect(order).toEqual(['stop', 'raise SIGTERM'])
  })

  it('passes review its own options', async () => {
    const wporg = fakeWporg()
    const calls: ReviewOptions[] = []
    await run(['fetch', 'koji', '--get', 'waiting', '--out-dir', home, '--no-ai', '--fresh', '--batch-size', '40'], {
      ...wporg,
      reviewFile: async (opts) => {
        calls.push(opts)
        return reviewSummary(opts.file)
      },
    })
    expect(calls[0]).toMatchObject({ noAi: true, fresh: true, batchSize: 40, locale: 'tr' })
  })

  // The strings were fetched as untranslated, so there is nothing for --all to
  // re-translate: mode is always pending.
  it('translates untranslated projects in pending mode with translate options', async () => {
    const wporg = fakeWporg()
    const calls: TranslateOptions[] = []
    const r = await run(
      ['fetch', 'koji', '--get', 'untranslated', '--out-dir', home, '--draft-engine', 'deepl', '--batch-size', '30'],
      {
        ...wporg,
        translate: async (opts) => {
          calls.push(opts)
          return translateSummary(opts.file)
        },
      },
    )
    expect(r.code).toBe(0)
    expect(calls[0]).toMatchObject({ mode: 'pending', draftEngine: 'deepl', batchSize: 30 })
    expect(calls[0]!.db).toBeDefined()
    expect(calls[0]!.jobsDb).toBeDefined()
  })

  it('reads names from stdin as well as from the arguments', async () => {
    const wporg = fakeWporg()
    await run(['fetch', 'koji', '--get', 'waiting', '--out-dir', home], {
      ...wporg,
      stdin: stdinWith('sydney\r\nhttps://translate.wordpress.org/locale/tr/default/wp-themes/loose/\n', false),
      reviewFile: async (opts) => reviewSummary(opts.file),
    })
    expect(wporg.resolved[0]!.map((r) => r.slug)).toEqual(['koji', 'sydney', 'loose'])
  })

  it('refuses a run without --get, naming the choices', async () => {
    const r = await run(['fetch', 'koji'], fakeWporg())
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/--get.*waiting.*untranslated/)
  })

  it('refuses an unknown --get value', async () => {
    const r = await run(['fetch', 'koji', '--get', 'fuzzy'], fakeWporg())
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('got "fuzzy"')
  })

  it('refuses --parallel above 8 and says why', async () => {
    const r = await run(['fetch', 'koji', '--get', 'waiting', '--parallel', '12'], fakeWporg())
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/--parallel.*8/)
  })

  it('refuses a run with no names at all', async () => {
    const r = await run(['fetch', '--get', 'waiting'], fakeWporg())
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/no projects/i)
  })

  it('prints how each project resolved before running anything', async () => {
    const wporg = fakeWporg()
    const r = await run(['fetch', 'koji', 'missing', 'quiet', '--get', 'waiting', '--out-dir', home], {
      ...wporg,
      reviewFile: async (opts) => reviewSummary(opts.file),
    })
    const out = r.stdout.replace(/\s+/g, ' ')
    expect(out).toMatch(/koji .*5 waiting/)
    expect(out).toMatch(/missing .*not found/)
    expect(out).toMatch(/quiet .*nothing waiting/)
  })

  it('carries on past failures and ends with the tally and exit 1', async () => {
    const wporg = fakeWporg()
    const r = await run(['fetch', 'koji', 'broken', 'missing', 'boom', '--get', 'waiting', '--out-dir', home], {
      ...wporg,
      reviewFile: async (opts) => {
        if (opts.file.includes('boom')) throw new Error('quota exhausted')
        return reviewSummary(opts.file)
      },
    })
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('✗ Fetched with failures')
    expect(r.stdout).toMatch(/done\s+1/)
    expect(r.stdout).toMatch(/failed\s+2/)
    expect(r.stdout).toMatch(/skipped\s+1/)
    expect(r.stdout).toMatch(/boom.*quota exhausted/)
    expect(r.stdout).toMatch(/broken.*export answered 500/)
  })

  // Each review's message goes back to a different contributor, so every one is
  // printed, not just the last.
  it('prints the requester message of every reviewed project', async () => {
    const wporg = fakeWporg()
    const r = await run(['fetch', 'koji', 'sydney', '--get', 'waiting', '--out-dir', home], {
      ...wporg,
      reviewFile: async (opts) => reviewSummary(opts.file),
    })
    expect(r.stdout.match(/Message for the requester/g)?.length).toBe(2)
  })

  it('passes --force through to the download for translate', async () => {
    const wporg = fakeWporg()
    await run(['fetch', 'koji', '--get', 'untranslated', '--out-dir', home, '--force'], {
      ...wporg,
      translate: async (opts) => translateSummary(opts.file),
    })
    expect(wporg.fetchOpts[0]).toEqual({ outDir: home, force: true })
  })

  it('asks for the readme unless --no-readme says otherwise', async () => {
    const readme: Array<boolean | undefined> = []
    const wporg = fakeWporg()
    const resolveProjects: CliDeps['resolveProjects'] = async (refs, opts) => {
      readme.push(opts.readme)
      return wporg.resolveProjects!(refs, opts)
    }
    const deps = { ...wporg, resolveProjects, reviewFile: async (opts: ReviewOptions) => reviewSummary(opts.file) }
    await run(['fetch', 'koji', '--get', 'waiting', '--out-dir', home], deps)
    await run(['fetch', 'koji', '--get', 'waiting', '--out-dir', home, '--no-readme'], deps)
    expect(readme).toEqual([true, false])
  })

  // A 45-second backoff with nothing on screen looks like a hang.
  it('says when wp.org asked it to wait, and for how long', async () => {
    const wporg = fakeWporg()
    const resolveProjects: CliDeps['resolveProjects'] = async (refs, opts) => {
      opts.onWait?.(15_000, 'https://translate.wordpress.org/locale/tr/default/wp-themes/koji/')
      return wporg.resolveProjects!(refs, opts)
    }
    const r = await run(['fetch', 'koji', '--get', 'waiting', '--out-dir', home], {
      ...wporg,
      resolveProjects,
      reviewFile: async (opts) => reviewSummary(opts.file),
    })
    expect(r.stderr).toMatch(/asked to slow down.*waiting 15s/)
  })
})

// review and translate say these things before a run; fetch runs the same
// jobs, so it has to say them too, and before the first request to wp.org
// rather than after the downloads.
describe('fetch, before anything is downloaded', () => {
  async function writeConfig(config: Record<string, unknown>): Promise<void> {
    await writeFile(join(home, 'config', 'config.json'), JSON.stringify({ defaultLocale: 'tr', ...config }))
  }

  // Never the real check: no test may send a request to a real local server.
  function fakeCheck(state: ModelCheck['state'] = 'installed') {
    const calls: Array<{ kind?: string; baseUrl: string; model: string }> = []
    const fn: NonNullable<CliDeps['checkLocalModel']> = async (o) => {
      calls.push(o)
      return {
        state,
        kind: o.kind ?? 'ollama',
        baseUrl: o.baseUrl,
        model: o.model,
        ...(state === 'installed' ? {} : { message: `${o.model} is not pulled; run ollama pull ${o.model}` }),
      }
    }
    return { fn, calls }
  }

  // Records what stderr held when wp.org was first asked, so "before" is
  // checked rather than assumed.
  async function runWatched(argv: string[], deps: Omit<CliDeps, 'streams'>) {
    const stdout = sink()
    const stderr = sink()
    const wporg = fakeWporg()
    const seen: string[] = []
    const resolveProjects: CliDeps['resolveProjects'] = async (refs, opts) => {
      seen.push(stderr.text)
      return wporg.resolveProjects!(refs, opts)
    }
    const code = await main(argv, {
      env: {},
      ...wporg,
      resolveProjects,
      ...deps,
      streams: { stdin: stdinWith(undefined, false), stdout, stderr },
    })
    return { code, stderr: stderr.text, seen }
  }

  it('says when only the universal checks will run', async () => {
    const r = await runWatched(['fetch', 'koji', '--get', 'waiting', '--out-dir', home, '--locale', 'de'], {
      reviewFile: async (opts) => reviewSummary(opts.file),
    })
    expect(r.seen[0]).toContain('No locale rules for de; only the universal checks run')
  })

  it('checks the local reviewer model and warns when it is missing', async () => {
    await writeConfig({ reviewProvider: 'local' })
    const check = fakeCheck('missing')
    const r = await runWatched(['fetch', 'koji', '--get', 'waiting', '--out-dir', home], {
      reviewFile: async (opts) => reviewSummary(opts.file),
      checkLocalModel: check.fn,
    })
    expect(check.calls).toHaveLength(1)
    expect(r.seen[0]).toContain('Local review is experimental')
    expect(r.seen[0]).toContain('is not pulled')
  })

  it('does not check a local model for a rules-only review', async () => {
    await writeConfig({ reviewProvider: 'local' })
    const check = fakeCheck()
    await runWatched(['fetch', 'koji', '--get', 'waiting', '--out-dir', home, '--no-ai'], {
      reviewFile: async (opts) => reviewSummary(opts.file),
      checkLocalModel: check.fn,
    })
    expect(check.calls).toHaveLength(0)
  })

  it('checks a local draft model before translating, once when it also reviews', async () => {
    await writeConfig({ reviewProvider: 'local' })
    const check = fakeCheck('missing')
    const r = await runWatched(['fetch', 'koji', '--get', 'untranslated', '--out-dir', home, '--draft-engine', 'local'], {
      translate: async (opts) => translateSummary(opts.file),
      checkLocalModel: check.fn,
    })
    expect(check.calls).toHaveLength(1)
    expect(r.seen[0]).toContain('is not pulled')
  })

  it('does not check anything local when an agent reviews', async () => {
    const check = fakeCheck()
    await runWatched(['fetch', 'koji', '--get', 'waiting', '--out-dir', home], {
      reviewFile: async (opts) => reviewSummary(opts.file),
      checkLocalModel: check.fn,
    })
    expect(check.calls).toHaveLength(0)
  })
})

