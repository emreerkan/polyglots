import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main, type CliDeps } from '../../src/cli.js'
import type { ReviewOptions } from '../../src/commands/review.js'
import type { TranslateOptions, TranslateSummary } from '../../src/commands/translate.js'
import type { ReviewSummary } from '../../src/types.js'

// --debug, POLYGLOTS_DEBUG=1 and config debug all reach reviewFile and
// translateFile as one boolean; what a debug run then keeps is theirs.

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

const reviewSummary = (file: string): ReviewSummary => ({
  file,
  locale: 'tr',
  total: 1,
  skipped: 0,
  reviewed: 1,
  problems: 0,
  needsReview: 0,
  approvable: 1,
  unreviewed: 0,
  repaired: 0,
  written: 0,
  pending: 0,
  byRule: {},
  byGroup: {},
})

const translateSummary = (file: string): TranslateSummary => ({ file, total: 1, pending: 1, fromTm: 0, translated: 1, fuzzy: 0, skipped: 0 })

const po = `msgid ""
msgstr ""
"Language: tr\\n"
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Save"
msgstr "Kaydet"
`

let home: string
let a: string
let b: string

async function config(values: Record<string, unknown>) {
  await mkdir(join(home, 'config'), { recursive: true })
  await writeFile(join(home, 'config', 'config.json'), JSON.stringify(values))
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyglots-cli-debug-'))
  process.env.POLYGLOTS_HOME = home
  await config({ defaultLocale: 'tr' })
  a = join(home, 'a-tr.po')
  b = join(home, 'b-tr.po')
  await writeFile(a, po)
  await writeFile(b, po)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function run(argv: string[], deps: Omit<CliDeps, 'streams'> = {}) {
  const stdout = sink()
  const stderr = sink()
  const reviews: ReviewOptions[] = []
  const translations: TranslateOptions[] = []
  const code = await main(argv, {
    env: {},
    reviewFile: async (opts) => {
      reviews.push(opts)
      return reviewSummary(opts.file)
    },
    translate: async (opts) => {
      translations.push(opts)
      return translateSummary(opts.file)
    },
    ...deps,
    streams: { stdin: stdin(), stdout, stderr },
  })
  return { code, stdout: stdout.text, stderr: stderr.text, reviews, translations }
}

describe('debug mode on the command line', () => {
  it('review --debug passes debug: true, with a warning channel for the notice', async () => {
    const r = await run(['review', a, '--debug'])
    expect(r.code).toBe(0)
    expect(r.reviews[0]).toMatchObject({ debug: true })
    expect(typeof r.reviews[0]!.onWarn).toBe('function')
  })

  it('review without it passes debug: false', async () => {
    const r = await run(['review', a])
    expect(r.reviews[0]).toMatchObject({ debug: false })
  })

  it('POLYGLOTS_DEBUG=1 turns it on without the flag', async () => {
    const r = await run(['review', a], { env: { POLYGLOTS_DEBUG: '1' } })
    expect(r.reviews[0]).toMatchObject({ debug: true })
  })

  it('config debug: true turns it on without the flag', async () => {
    await config({ defaultLocale: 'tr', debug: true })
    const r = await run(['review', a])
    expect(r.reviews[0]).toMatchObject({ debug: true })
  })

  it('reaches every file of a review of several', async () => {
    const r = await run(['review', a, b, '--debug'])
    expect(r.reviews.map((o) => o.debug)).toEqual([true, true])
  })

  it('translate --debug passes debug: true', async () => {
    const r = await run(['translate', a, '--draft-engine', 'none', '--debug'])
    expect(r.code).toBe(0)
    expect(r.translations[0]).toMatchObject({ debug: true })
    expect(typeof r.translations[0]!.onWarn).toBe('function')
  })

  it('config set debug takes on and off, and config get lists it', async () => {
    expect((await run(['config', 'set', 'debug', 'on'])).stdout).toContain('debug = on')
    expect((await run(['config', 'get'])).stdout).toContain('debug = on')
    expect((await run(['config', 'set', 'debug', 'off'])).stdout).toContain('debug = off')
    expect((await run(['config', 'set', 'debug', 'maybe'])).code).toBe(2)
  })
})
