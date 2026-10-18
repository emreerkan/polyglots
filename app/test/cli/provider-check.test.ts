import { mkdir, mkdtemp, rm, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main, type CliDeps } from '../../src/cli.js'
import { reviewFile, type ReviewOptions } from '../../src/commands/review.js'
import { translateFile } from '../../src/commands/translate.js'
import { openDb, replaceGlossary } from '../../src/storage/index.js'
import type { ProviderCheck } from '../../src/agent/agy-check.js'
import type { Fetched, Ready, Resolution } from '../../src/commands/fetch.js'
import { fakeEngine, fakeReview } from '../commands/translate/helpers.js'
import { useLocaleFixture } from '../locale-fixture.js'

// The command line starts the antigravity check the moment a review or a
// translate begins and hands it to the run, which waits for it only before
// its first batch. checkProvider is the seam: never the real agy here.

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

function stdin() {
  const stream = new PassThrough() as PassThrough & { isTTY?: boolean }
  stream.isTTY = false
  stream.end()
  return stream
}

const PO = `msgid ""
msgstr ""
"Language: tr\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=2; plural=(n > 1);\\n"

msgid "Open the sidebar"
msgstr "Yan menüyü aç"
`

const samplePo = fileURLToPath(new URL('../fixtures/po/sample.po', import.meta.url))
const signedOut = (): Promise<ProviderCheck> => Promise.resolve({ signIn: { state: 'signed-out', ms: 3 }, at: Date.now() })
const STOP = 'antigravity is signed out. Run agy once to sign in, then start again.'

let home: string
let file: string

async function config(values: Record<string, unknown>) {
  await mkdir(join(home, 'config'), { recursive: true })
  await writeFile(join(home, 'config', 'config.json'), JSON.stringify(values))
}

let savedKey: string | undefined

beforeEach(async () => {
  // A dummy key, so translate's key check passes; the fake engine never uses it.
  savedKey = process.env.DEEPL_API_KEY
  process.env.DEEPL_API_KEY = 'dpl-test-key-0123456789:fx'
  home = await mkdtemp(join(tmpdir(), 'polyglots-cli-provider-check-'))
  process.env.POLYGLOTS_HOME = home
  file = join(home, 'plugin-tr.po')
  await writeFile(file, PO)
  const db = openDb()
  replaceGlossary(db, 'tr', [{ locale: 'tr', sourceTerm: 'sidebar', translation: 'kenar çubuğu', partOfSpeech: 'noun' }])
  db.close()
})

useLocaleFixture('tr_TR.yaml')

afterEach(async () => {
  if (savedKey === undefined) delete process.env.DEEPL_API_KEY
  else process.env.DEEPL_API_KEY = savedKey
  await rm(home, { recursive: true, force: true })
})

async function run(argv: string[], deps: Omit<CliDeps, 'streams'>) {
  const stdout = sink()
  const stderr = sink()
  const code = await main(argv, { env: {}, ...deps, streams: { stdin: stdin(), stdout, stderr } })
  return { code, stdout: stdout.text, stderr: stderr.text }
}

describe('the provider check on the command line', () => {
  it('stops a review with antigravity signed out, says why, and exits 1', async () => {
    await config({ defaultLocale: 'tr', reviewProvider: 'antigravity' })
    const adjudicate = vi.fn(async () => [])
    const checkProvider = vi.fn(signedOut)
    const r = await run(['review', file], {
      checkProvider,
      // The real review, with only the agent and its MCP file swapped out, so
      // the refusal is the one reviewFile raises.
      reviewFile: (opts) => reviewFile({ ...opts, model: 'Gemini 4 Argon (Low)', adjudicate, mcpConfigPath: join(home, 'mcp.json') }),
    })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(STOP)
    expect(checkProvider).toHaveBeenCalledTimes(1)
    expect(adjudicate).not.toHaveBeenCalled()
  })

  // A refusal the command line can make on its own comes before the check,
  // which would otherwise spawn agy for a run that never starts.
  it('makes no check when --template names nothing', async () => {
    await config({ defaultLocale: 'tr', reviewProvider: 'antigravity' })
    const checkProvider = vi.fn(signedOut)
    const reviewFile = vi.fn()
    const r = await run(['review', file, '--template', 'no-such-template'], { checkProvider, reviewFile })
    expect(r.code).not.toBe(0)
    expect(reviewFile).not.toHaveBeenCalled()
    expect(checkProvider).not.toHaveBeenCalled()
  })

  it('makes no check when --batch-size is refused', async () => {
    await config({ defaultLocale: 'tr', reviewProvider: 'antigravity' })
    const checkProvider = vi.fn(signedOut)
    const reviewFile = vi.fn()
    const r = await run(['review', file, '--batch-size', '0'], { checkProvider, reviewFile })
    expect(r.code).not.toBe(0)
    expect(reviewFile).not.toHaveBeenCalled()
    expect(checkProvider).not.toHaveBeenCalled()
  })

  it('makes no check when a translate\'s --batch-size is refused', async () => {
    await config({ defaultLocale: 'tr', reviewProvider: 'antigravity' })
    const checkProvider = vi.fn(signedOut)
    const translate = vi.fn()
    const r = await run(['translate', file, '--draft-engine', 'deepl', '--batch-size', '0'], { checkProvider, translate })
    expect(r.code).not.toBe(0)
    expect(translate).not.toHaveBeenCalled()
    expect(checkProvider).not.toHaveBeenCalled()
  })

  it('never checks when claude reviews', async () => {
    await config({ defaultLocale: 'tr', reviewProvider: 'claude' })
    const checkProvider = vi.fn(signedOut)
    const seen: ReviewOptions[] = []
    const r = await run(['review', file], {
      checkProvider,
      reviewFile: async (opts) => {
        seen.push(opts)
        return { file, locale: 'tr', total: 1, skipped: 0, reviewed: 1, problems: 0, needsReview: 0, approvable: 1, unreviewed: 0, repaired: 0, written: 0, pending: 0, byRule: {}, byGroup: {} }
      },
    })
    expect(r.code).toBe(0)
    expect(checkProvider).not.toHaveBeenCalled()
    expect(seen[0]!.preflight).toBeUndefined()
  })

  it('never checks a rules-only review', async () => {
    await config({ defaultLocale: 'tr', reviewProvider: 'antigravity' })
    const checkProvider = vi.fn(signedOut)
    const r = await run(['review', file, '--no-ai'], { checkProvider, reviewFile: (opts) => reviewFile(opts) })
    expect(r.code).toBe(0)
    expect(checkProvider).not.toHaveBeenCalled()
  })

  it('stops a translate with antigravity signed out, and does not go on to the next file', async () => {
    await config({ defaultLocale: 'tr', reviewProvider: 'antigravity' })
    const a = join(home, 'a.po')
    const b = join(home, 'b.po')
    await copyFile(samplePo, a)
    await copyFile(samplePo, b)
    const checkProvider = vi.fn(signedOut)
    const files: string[] = []
    const r = await run(['translate', a, b, '--draft-engine', 'deepl'], {
      checkProvider,
      translate: (opts) => {
        files.push(opts.file)
        return translateFile({ ...opts, model: 'Gemini 4 Argon (Low)', engine: fakeEngine(), review: fakeReview(), mcpConfigPath: join(home, 'mcp.json') })
      },
    })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(STOP)
    expect(files).toEqual([a])
    expect(checkProvider).toHaveBeenCalledTimes(1)
    expect(r.stderr).not.toContain('Stopping after')
  })

  it('stops a review of several files on the first refusal, says it once, and records no failure', async () => {
    await config({ defaultLocale: 'tr', reviewProvider: 'antigravity' })
    const a = join(home, 'a-tr.po')
    const b = join(home, 'b-tr.po')
    await writeFile(a, PO)
    await writeFile(b, PO)
    const adjudicate = vi.fn(async () => [])
    const checkProvider = vi.fn(signedOut)
    const files: string[] = []
    const r = await run(['review', a, b], {
      checkProvider,
      reviewFile: (opts) => {
        files.push(opts.file)
        return reviewFile({ ...opts, model: 'Gemini 4 Argon (Low)', adjudicate, mcpConfigPath: join(home, 'mcp.json') })
      },
    })
    expect(r.code).toBe(1)
    expect(files).toEqual([a])
    expect(checkProvider).toHaveBeenCalledTimes(1)
    expect(adjudicate).not.toHaveBeenCalled()
    expect(r.stderr.split(STOP).length - 1).toBe(1)
    // The refusal stops the batch through the same control a person's q
    // uses, but the operator's stopping notice would misread it.
    expect(r.stderr).not.toContain('Stopping after')
    const out = r.stdout.replace(/\s+/g, ' ')
    expect(out).toContain(`stopped ${STOP}`)
    expect(out).toContain('stopped not started')
    expect(out).toContain('failed 0')
    expect(out).toContain('stopped 2')
  })

  it('checks before fetch reviews the downloads, and stops on a refusal', async () => {
    await config({ defaultLocale: 'tr', reviewProvider: 'antigravity' })
    const outDir = join(home, 'out')
    await mkdir(outDir, { recursive: true })
    const resolveProjects: CliDeps['resolveProjects'] = async (refs) =>
      refs.map((ref): Resolution => ({ input: ref.slug, state: 'ready', type: 'wp-themes', slug: ref.slug, count: 1 }))
    const fetchProjects: CliDeps['fetchProjects'] = async (ready: Ready[], opts) =>
      Promise.all(
        ready.map(async (p): Promise<Fetched> => {
          const target = join(opts.outDir, `wp-themes-${p.slug}-tr.po`)
          await writeFile(target, PO)
          return { input: p.input, state: 'fetched', file: target }
        }),
      )
    const adjudicate = vi.fn(async () => [])
    const checkProvider = vi.fn(signedOut)
    const files: string[] = []
    const r = await run(['fetch', 'koji', 'sydney', '--get', 'waiting', '--out-dir', outDir], {
      checkProvider,
      resolveProjects,
      fetchProjects,
      reviewFile: (opts) => {
        files.push(opts.file)
        return reviewFile({ ...opts, model: 'Gemini 4 Argon (Low)', adjudicate, mcpConfigPath: join(home, 'mcp.json') })
      },
    })
    expect(checkProvider).toHaveBeenCalledTimes(1)
    expect(adjudicate).not.toHaveBeenCalled()
    expect(files).toHaveLength(1)
    expect(r.code).toBe(1)
    expect(r.stderr.split(STOP).length - 1).toBe(1)
    const out = r.stdout.replace(/\s+/g, ' ')
    expect(out).toContain(`koji stopped ${STOP}`)
    expect(out).toContain('sydney stopped not started')
    expect(out).toContain('failed 0')
  })

  it('never checks a rules-only fetch', async () => {
    await config({ defaultLocale: 'tr', reviewProvider: 'antigravity' })
    const checkProvider = vi.fn(signedOut)
    const resolveProjects: CliDeps['resolveProjects'] = async () => []
    await run(['fetch', 'koji', '--get', 'waiting', '--no-ai', '--out-dir', home], { checkProvider, resolveProjects })
    expect(checkProvider).not.toHaveBeenCalled()
  })
})
