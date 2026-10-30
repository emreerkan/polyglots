import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import Database from 'better-sqlite3'
import { main, type CliDeps } from '../../src/cli.js'
import { loadConfig } from '../../src/config.js'
import { headerLanguageOtherThan } from '../../src/cli/locale.js'
import type { ReviewSummary } from '../../src/types.js'

// No locale is assumed any more. These pin down what a person without one is
// told, that the file's own Language header is used where it can be trusted,
// and that someone who set a locale sees nothing new.

interface Sink {
  isTTY?: boolean
  text: string
  write(chunk: string): boolean
}

function sink(): Sink {
  return {
    text: '',
    write(chunk: string) {
      this.text += chunk
      return true
    },
  }
}

function stdin(): PassThrough & { isTTY?: boolean } {
  const stream = new PassThrough() as PassThrough & { isTTY?: boolean }
  stream.isTTY = false
  stream.end()
  return stream
}

let home: string
let stdout: Sink
let stderr: Sink

const run = (argv: string[], deps: Omit<CliDeps, 'streams'> = {}) =>
  main(argv, { env: {}, ...deps, streams: { stdin: stdin(), stdout, stderr } })

const po = (language: string | undefined) =>
  [
    'msgid ""',
    'msgstr ""',
    '"MIME-Version: 1.0\\n"',
    '"Content-Type: text/plain; charset=UTF-8\\n"',
    ...(language === undefined ? [] : [`"Language: ${language}\\n"`]),
    '"Plural-Forms: nplurals=2; plural=(n != 1);\\n"',
    '',
    'msgid "Settings"',
    'msgstr ""',
    '',
  ].join('\n')

async function poFile(name: string, language: string | undefined): Promise<string> {
  const path = join(home, name)
  await writeFile(path, po(language))
  return path
}

async function setConfig(config: Record<string, unknown>): Promise<void> {
  await mkdir(join(home, 'config'), { recursive: true })
  await writeFile(join(home, 'config', 'config.json'), JSON.stringify(config))
}

const summary = (file: string, locale: string): ReviewSummary => ({
  file,
  locale,
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

function fakeReview() {
  const locales: string[] = []
  const fn: NonNullable<CliDeps['reviewFile']> = async (opts) => {
    locales.push(opts.locale)
    return summary(opts.file, opts.locale)
  }
  return { fn, locales }
}

const NO_LOCALE = 'No locale set. Pass --locale <code>, or set one for every run: polyglots config set defaultLocale <code>'

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyglots-cli-locale-'))
  process.env.POLYGLOTS_HOME = home
  stdout = sink()
  stderr = sink()
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('no default locale', () => {
  it('leaves defaultLocale unset in a fresh config', () => {
    expect(loadConfig().defaultLocale).toBeUndefined()
  })

  it.each([
    ['glossary sync', ['glossary', 'sync']],
    ['glossary export', ['glossary', 'export']],
    ['tm export', ['tm', 'export']],
    ['config add-name', ['config', 'add-name', 'Ankara']],
  ])('refuses %s with exit 2 and names both ways to set one', async (_name, argv) => {
    const syncGlossary = vi.fn()
    const exportGlossary = vi.fn()
    const exportTm = vi.fn()
    const code = await run(argv, { syncGlossary, exportGlossary, exportTm })
    expect(code).toBe(2)
    expect(stderr.text).toContain(NO_LOCALE)
    expect(syncGlossary).not.toHaveBeenCalled()
    expect(exportGlossary).not.toHaveBeenCalled()
    expect(exportTm).not.toHaveBeenCalled()
  })

  it('refuses tm import before reading a file, so the memory is never filed under a guess', async () => {
    const file = await poFile('x.po', 'tr')
    const importTmx = vi.fn()
    expect(await run(['tm', 'import', file], { importTmx })).toBe(2)
    expect(stderr.text).toContain(NO_LOCALE)
    expect(importTmx).not.toHaveBeenCalled()
  })

  it('refuses fetch, which has no file to read a language from', async () => {
    const resolveProjects = vi.fn()
    expect(await run(['fetch', '--get', 'waiting', 'lunar-forms'], { resolveProjects })).toBe(2)
    expect(stderr.text).toContain(NO_LOCALE)
    expect(resolveProjects).not.toHaveBeenCalled()
  })

  it('tells the rules commands to name the locale, since they take it as an argument', async () => {
    expect(await run(['rules', 'path'])).toBe(2)
    expect(stderr.text).toContain(
      'No locale set. Name one, as in polyglots rules path <code>, or set one for every run: polyglots config set defaultLocale <code>',
    )
  })

  it('still runs the rules commands given a locale', async () => {
    expect(await run(['rules', 'path', 'de'])).toBe(0)
    expect(stdout.text).toContain('de')
  })

  it('keeps the commands that need no locale working', async () => {
    expect(await run(['config', 'get'])).toBe(0)
    expect(stdout.text).toContain('defaultLocale = (not set)')
  })

  it('prints nothing for config get defaultLocale, so a script reads an empty value', async () => {
    expect(await run(['config', 'get', 'defaultLocale'])).toBe(0)
    expect(stdout.text).toBe('\n')
  })

  it('still lets the locale be set, and then uses it', async () => {
    expect(await run(['config', 'set', 'defaultLocale', 'pt_BR'])).toBe(0)
    expect(JSON.parse(await readFile(join(home, 'config', 'config.json'), 'utf8')).defaultLocale).toBe('pt-br')
    const syncGlossary = vi.fn(async () => ({ entries: 3, kept: 0, removed: [] }))
    expect(await run(['glossary', 'sync'], { syncGlossary })).toBe(0)
    expect(syncGlossary).toHaveBeenCalledWith({ locale: 'pt-br' })
  })

  // Someone who wants each file's Language header to decide has to be able
  // to take the configured locale away again without editing config.json.
  it('unsets the locale with an empty value', async () => {
    expect(await run(['config', 'set', 'defaultLocale', 'pt_BR'])).toBe(0)
    expect(await run(['config', 'set', 'defaultLocale', ''])).toBe(0)
    expect(stdout.text).toContain('defaultLocale unset')
    expect(JSON.parse(await readFile(join(home, 'config', 'config.json'), 'utf8'))).not.toHaveProperty('defaultLocale')
  })

  it('says in help that there is no default yet', async () => {
    await run(['glossary', 'sync', '--help'])
    expect(stdout.text.replace(/\s+/g, ' ')).toContain('(default: defaultLocale, none set yet)')
  })

  it('names the configured locale in help when there is one', async () => {
    await setConfig({ defaultLocale: 'sv' })
    await run(['glossary', 'sync', '--help'])
    expect(stdout.text.replace(/\s+/g, ' ')).toContain('(default: sv)')
  })
})

// Earlier versions fell back to tr, and for a while the refusal named that
// fallback to anyone with tr work on disk. The hint was one locale's data in
// the code, and this version keeps no locale's data in the code, so it goes.
describe('earlier Turkish work', () => {
  it('says nothing about Turkish even when jobs.db holds tr runs', async () => {
    await mkdir(join(home, 'data'), { recursive: true })
    const db = new Database(join(home, 'data', 'jobs.db'))
    db.exec("CREATE TABLE run (id INTEGER PRIMARY KEY, locale TEXT NOT NULL); INSERT INTO run (locale) VALUES ('tr')")
    db.close()
    expect(await run(['glossary', 'sync'])).toBe(2)
    expect(stderr.text).toContain(NO_LOCALE)
    expect(stderr.text).not.toContain('Turkish')
  })

  it('says nothing about Turkish when the memory holds a tr glossary', async () => {
    await mkdir(join(home, 'data'), { recursive: true })
    const db = new Database(join(home, 'data', 'polyglots.db'))
    db.exec("CREATE TABLE glossary (term TEXT, locale TEXT); INSERT INTO glossary VALUES ('post', 'tr')")
    db.close()
    expect(await run(['tm', 'export'])).toBe(2)
    expect(stderr.text).not.toContain('Turkish')
  })
})

describe('the Language header', () => {
  it('reviews in the language the file declares when nothing else names one', async () => {
    const file = await poFile('x-sv.po', 'sv_SE')
    const review = fakeReview()
    expect(await run(['review', file, '--no-ai'], { reviewFile: review.fn })).toBe(0)
    expect(review.locales).toEqual(['sv'])
    expect(stderr.text).toContain("Locale sv, from the file's Language header. Pass --locale to choose another.")
  })

  it('lets the configured locale win over the header, so an existing setup sees no change', async () => {
    await setConfig({ defaultLocale: 'tr' })
    const file = await poFile('x-sv.po', 'sv_SE')
    const review = fakeReview()
    expect(await run(['review', file, '--no-ai'], { reviewFile: review.fn })).toBe(0)
    expect(review.locales).toEqual(['tr'])
    expect(stderr.text).not.toContain('Language header')
  })

  it('lets --locale win over both', async () => {
    await setConfig({ defaultLocale: 'tr' })
    const file = await poFile('x-sv.po', 'sv_SE')
    const review = fakeReview()
    expect(await run(['review', file, '--no-ai', '--locale', 'de'], { reviewFile: review.fn })).toBe(0)
    expect(review.locales).toEqual(['de'])
  })

  // Antigravity's lookup server is registered once and reads its locale from
  // POLYGLOTS_LOCALE or config when it starts; it never hears the locale a run
  // read from a header, and would answer glossary and memory lookups in
  // another language.
  it('does not take the header for an Antigravity review, which its lookup server never hears', async () => {
    await setConfig({ reviewProvider: 'antigravity' })
    const file = await poFile('x-sv.po', 'sv_SE')
    const review = fakeReview()
    expect(await run(['review', file], { reviewFile: review.fn })).toBe(2)
    expect(stderr.text).toMatch(/Antigravity/)
    expect(review.locales).toEqual([])
  })

  it('still takes the header for an Antigravity setup when no agent runs', async () => {
    await setConfig({ reviewProvider: 'antigravity' })
    const file = await poFile('x-sv.po', 'sv_SE')
    const review = fakeReview()
    expect(await run(['review', file, '--no-ai'], { reviewFile: review.fn })).toBe(0)
    expect(review.locales).toEqual(['sv'])
  })

  it('names the file with no Language header when several are given', async () => {
    const a = await poFile('a-sv.po', 'sv_SE')
    const b = await poFile('b.po', undefined)
    expect(await run(['translate', a, b], { translate: vi.fn() })).toBe(2)
    expect(stderr.text).toContain('b.po')
  })

  it('refuses a file with no Language header', async () => {
    const file = await poFile('x.po', undefined)
    const review = fakeReview()
    expect(await run(['review', file, '--no-ai'], { reviewFile: review.fn })).toBe(2)
    expect(stderr.text).toContain(NO_LOCALE)
    expect(review.locales).toEqual([])
  })

  it('refuses a language translate.wordpress.org splits into more than one locale, naming them', async () => {
    const file = await poFile('x-de.po', 'de_DE')
    const review = fakeReview()
    expect(await run(['review', file, '--no-ai'], { reviewFile: review.fn })).toBe(2)
    expect(stderr.text.replace(/\s+/g, ' ')).toContain('de_DE could be de or de/formal')
    expect(stderr.text).toContain('--locale <code>')
    expect(review.locales).toEqual([])
  })

  it('refuses translate over files that declare different languages', async () => {
    const a = await poFile('a.po', 'sv_SE')
    const b = await poFile('b.po', 'tr')
    const translate = vi.fn()
    expect(await run(['translate', a, b, '--draft-engine', 'local'], { translate })).toBe(2)
    expect(stderr.text).toContain('sv')
    expect(stderr.text).toContain('tr')
    expect(stderr.text).toContain(NO_LOCALE)
    expect(translate).not.toHaveBeenCalled()
  })
})

// The run forms say when a picked file was written for another locale than
// the configured one. de_DE names de or de/formal, so the language is what
// is compared, not one locale the header cannot settle.
describe('headerLanguageOtherThan', () => {
  const po = (language: string | undefined) => poFile('x.po', language)

  it('names the header of another language, as the header writes it', async () => {
    expect(await headerLanguageOtherThan(await po('nl_NL'), 'tr')).toBe('nl_NL')
  })

  it('is quiet for the same language in another variant or form', async () => {
    expect(await headerLanguageOtherThan(await po('tr_TR'), 'tr')).toBeUndefined()
    expect(await headerLanguageOtherThan(await po('de_DE'), 'de/formal')).toBeUndefined()
  })

  it('is quiet when there is no header, an unknown one, or no file', async () => {
    expect(await headerLanguageOtherThan(await po(undefined), 'tr')).toBeUndefined()
    expect(await headerLanguageOtherThan(await po('xx_YY'), 'tr')).toBeUndefined()
    expect(await headerLanguageOtherThan(join(home, 'missing.po'), 'tr')).toBeUndefined()
  })
})
