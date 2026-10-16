import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadLocaleRules, localeRulesFile, parseLocaleRules, RulesFileError } from '../../src/rules/load.js'

let home: string
let saved: string | undefined

beforeEach(async () => {
  saved = process.env.POLYGLOTS_HOME
  home = await mkdtemp(join(tmpdir(), 'polyglots-rules-'))
  process.env.POLYGLOTS_HOME = home
})

afterEach(async () => {
  if (saved === undefined) delete process.env.POLYGLOTS_HOME
  else process.env.POLYGLOTS_HOME = saved
  await rm(home, { recursive: true, force: true })
})

async function writeRules(locale: string, text: string) {
  const file = localeRulesFile(locale)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text, 'utf8')
  return file
}

const errorOf = (fn: () => unknown): RulesFileError => {
  try {
    fn()
  } catch (err) {
    if (err instanceof RulesFileError) return err
    throw err
  }
  throw new Error('expected a RulesFileError')
}

describe('localeRulesFile', () => {
  // Named by the WordPress code translators recognise, which is also always a
  // valid file name: nl/formal is not.
  it('lives under the config directory, named by the WordPress locale code', () => {
    expect(localeRulesFile('tr')).toBe(join(home, 'config', 'locales', 'tr_TR.yaml'))
    expect(localeRulesFile('nl/formal')).toBe(join(home, 'config', 'locales', 'nl_NL_formal.yaml'))
    expect(localeRulesFile('nl-be')).toBe(join(home, 'config', 'locales', 'nl_BE.yaml'))
  })
})

describe('parseLocaleRules', () => {
  it('reads every section and turns mistakes into hint patterns', () => {
    const rules = parseLocaleRules(
      `rules:
  enable: [title-case]
  disable: [punctuation]
glossaryStemRatio: 0.8
properNouns:
  always: [Türkiye]
mistakes:
  - wrong: önizleme
    right: ön izleme
    note: TDK writes it as two words
patterns:
  - find: '\\.\\.\\.'
    replace: '…'
    level: fix
guidance: |
  Button labels are imperative.
`,
      'tr.yaml',
    )
    expect(rules.rules).toEqual({ enable: ['title-case'], disable: ['punctuation'] })
    expect(rules.glossaryStemRatio).toBe(0.8)
    expect(rules.properNouns).toEqual({ always: ['Türkiye'] })
    expect(rules.patterns).toEqual([
      { kind: 'mistake', text: 'önizleme', replace: undefined, right: 'ön izleme', level: 'hint', ignoreCase: true, note: 'TDK writes it as two words' },
      { kind: 'pattern', find: '\\.\\.\\.', replace: '…', level: 'fix', ignoreCase: false },
    ])
    expect(rules.guidance).toBe('Button labels are imperative.')
  })

  it('accepts an empty file as no changes', () => {
    expect(parseLocaleRules('', 'tr.yaml')).toEqual({ schema: 1, patterns: [] })
  })

  it('names the file, line and column of a YAML syntax error', () => {
    const err = errorOf(() => parseLocaleRules('mistakes:\n  - wrong: [unclosed\n', '/x/tr.yaml'))
    expect(err.message).toMatch(/^\/x\/tr\.yaml:\d+:\d+ /)
  })

  // A typo in a rule name would otherwise silently leave the rule off.
  it('refuses an unknown rule name and lists the real ones', () => {
    const err = errorOf(() => parseLocaleRules('rules:\n  enable: [title-cse]\n', 'tr.yaml'))
    expect(err.message).toMatch(/title-cse/)
    expect(err.message).toMatch(/title-case/)
  })

  it('refuses a fix pattern with nothing to replace with', () => {
    const err = errorOf(() => parseLocaleRules('patterns:\n  - text: x\n    level: fix\n', 'tr.yaml'))
    expect(err.message).toMatch(/patterns\.0.*replace/)
  })

  it('refuses a pattern with both or neither of text and find', () => {
    expect(errorOf(() => parseLocaleRules('patterns:\n  - text: a\n    find: b\n', 'tr.yaml')).message).toMatch(/patterns\.0/)
    expect(errorOf(() => parseLocaleRules('patterns:\n  - note: lonely\n', 'tr.yaml')).message).toMatch(/patterns\.0/)
  })

  it('refuses a regex that does not compile, with its line', () => {
    const err = errorOf(() => parseLocaleRules('patterns:\n  - level: hint\n    find: "(unclosed"\n', 'tr.yaml'))
    expect(err.message).toMatch(/patterns\.0\.find/)
    expect(err.line).toBe(3)
  })

  it('refuses guidance longer than the cap', () => {
    const err = errorOf(() => parseLocaleRules(`guidance: "${'x'.repeat(1501)}"\n`, 'tr.yaml'))
    expect(err.message).toMatch(/guidance/)
    expect(err.message).toMatch(/1500/)
  })

  it('refuses a stem ratio outside (0, 1]', () => {
    expect(errorOf(() => parseLocaleRules('glossaryStemRatio: 1.5\n', 'tr.yaml')).message).toMatch(/glossaryStemRatio/)
  })
})

describe('loadLocaleRules', () => {
  it('has nothing to say when there is no file', () => {
    expect(loadLocaleRules('tr')).toBeUndefined()
  })

  it('reads the file for the locale', async () => {
    await writeRules('tr', 'guidance: Be brief.\n')
    expect(loadLocaleRules('tr')?.guidance).toBe('Be brief.')
  })

  // A file edited while a menu session is open must apply to the next run.
  it('reloads the file once it changes', async () => {
    const file = await writeRules('tr', 'guidance: First.\n')
    expect(loadLocaleRules('tr')?.guidance).toBe('First.')
    await writeFile(file, 'guidance: Second.\n', 'utf8')
    const later = new Date(Date.now() + 5000)
    await utimes(file, later, later)
    expect(loadLocaleRules('tr')?.guidance).toBe('Second.')
  })

  it('throws for an invalid file rather than falling back to the defaults', async () => {
    await writeRules('tr', 'rules:\n  enable: [nope]\n')
    expect(() => loadLocaleRules('tr')).toThrow(RulesFileError)
  })
})
