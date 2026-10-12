import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildRuleContext, runRules } from '../../src/audit/rules/index.js'
import { profileFor } from '../../src/audit/rules/profiles.js'
import { properNounsFor } from '../../src/audit/rules/proper-nouns.js'
import { buildAuditPrompt } from '../../src/audit/prompt.js'
import { configHash, translateConfigHash } from '../../src/jobs/hash.js'
import { buildReviewPrompt } from '../../src/review/prompt.js'
import { localeRulesFile } from '../../src/rules/load.js'
import { BUILT_IN_RULES } from '../../src/rules/names.js'

let home: string
let saved: string | undefined

beforeEach(async () => {
  saved = process.env.POLYGLOTS_HOME
  home = await mkdtemp(join(tmpdir(), 'polyglots-rules-int-'))
  process.env.POLYGLOTS_HOME = home
})

afterEach(async () => {
  if (saved === undefined) delete process.env.POLYGLOTS_HOME
  else process.env.POLYGLOTS_HOME = saved
  await rm(home, { recursive: true, force: true })
})

// Each write moves the mtime forward, so the loader's cache always sees it.
let tick = 0
async function writeRules(locale: string, text: string) {
  const file = localeRulesFile(locale)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text, 'utf8')
  const t = new Date(Date.now() + ++tick * 1000)
  await utimes(file, t, t)
}

const hashTr = () => configHash({ locale: 'tr', glossary: [], properNouns: [] })

// Captured without a rules file. Anyone who never writes one must keep every
// cached verdict between releases.
const BEFORE = {
  // Moved once, on purpose, by the control rule (a new universal rule) and
  // the prompt paragraphs on automatedChecks and control strings.
  trEmpty: '35c0131f7cc7515a',
  trGloss: '56423d5cfd39fbcc',
  // Moved by the universal-only note (#2): German runs only the universal
  // rules, and both review prompts now say so. Every universal-only locale
  // re-reviews once.
  de: '96f764d0e675cd3f',
  // Pinned with the note in place, which moved it too; it was not pinned
  // before (#2).
  deTranslate: '4675c41a315e6d33',
  trTranslate: '061889a3e01b0b39',
  // The Swedish pack, pinned when it was added (#2), so later drift in its
  // paragraph or register line is deliberate.
  sv: '5254d5918a0c6460',
  svTranslate: '8244647091197a1b',
}

describe('without a rules file', () => {
  it('keeps every hash exactly as it was', () => {
    expect(hashTr()).toBe(BEFORE.trEmpty)
    expect(
      configHash({ locale: 'tr', glossary: [{ locale: 'tr', sourceTerm: 'post', translation: 'yazı' }], properNouns: ['Acme'] }),
    ).toBe(BEFORE.trGloss)
    expect(configHash({ locale: 'de', glossary: [], properNouns: [] })).toBe(BEFORE.de)
    expect(translateConfigHash('de')).toBe(BEFORE.deTranslate)
    expect(translateConfigHash('tr')).toBe(BEFORE.trTranslate)
    expect(configHash({ locale: 'sv', glossary: [], properNouns: [] })).toBe(BEFORE.sv)
    expect(translateConfigHash('sv')).toBe(BEFORE.svTranslate)
  })

  it('keeps the built-in Turkish profile', () => {
    expect([...profileFor('tr').rules]).toEqual(expect.arrayContaining(['title-case', 'apostrophe', 'ampersand', 'number-format']))
    expect(profileFor('tr').glossaryStemRatio).toBe(0.7)
  })
})

describe('with a rules file', () => {
  it('switches built-in rules on and off from the universal set', async () => {
    await writeRules('de', 'rules:\n  enable: [title-case]\n  disable: [punctuation]\n')
    const rules = profileFor('de').rules
    expect(rules.has('title-case')).toBe(true)
    expect(rules.has('punctuation')).toBe(false)
    expect(rules.has('placeholder')).toBe(true)
  })

  // An explicit list replaces the built-in extras rather than adding to them,
  // so a locale can turn Turkish defaults off by leaving them out.
  it('starts from the universal set, not the built-in extras, when rules are listed', async () => {
    await writeRules('tr', 'rules:\n  enable: [apostrophe]\n')
    const rules = profileFor('tr').rules
    expect(rules.has('apostrophe')).toBe(true)
    expect(rules.has('title-case')).toBe(false)
  })

  it('keeps the built-in profile when the file says nothing about rules', async () => {
    await writeRules('tr', 'guidance: Be brief.\n')
    expect(profileFor('tr').rules.has('title-case')).toBe(true)
  })

  it('applies the glossary stem ratio', async () => {
    await writeRules('tr', 'glossaryStemRatio: 0.9\n')
    expect(profileFor('tr').glossaryStemRatio).toBe(0.9)
  })

  it('replaces a proper-noun list it names and keeps the other', async () => {
    await writeRules('tr', 'properNouns:\n  always: [Acme]\n')
    const nouns = properNounsFor('tr')
    expect(nouns.always).toEqual(['Acme'])
    expect(nouns.dateOnly).toContain('Ocak')
  })

  // A name of several words is matched as a phrase, the way the names in
  // config.json were before they moved here: Türk Dil Kurumu is excused, and
  // Dil on its own still reads as a capital mid-sentence.
  it('matches a name of several words as a phrase', async () => {
    await writeRules('tr', 'properNouns:\n  always: ["Türk Dil Kurumu"]\n')
    const findings = (msgid: string, msgstr: string) => {
      const e = { key: msgid, msgid, msgstr: [msgstr], comments: [], references: [], fuzzy: false }
      const ctx = buildRuleContext({ locale: 'tr', glossary: [], nplurals: 2, entries: [e] })
      return runRules(e, ctx).map((f) => f.rule)
    }
    expect(findings('Approved by TDK', 'Türk Dil Kurumu tarafından onaylandı')).not.toContain('title-case')
    expect(findings('Language settings', 'Ayarlar ve Dil seçimi')).toContain('title-case')
  })

  it('runs the custom rule whenever the file has mistakes or patterns', async () => {
    expect(profileFor('tr').rules.has('custom')).toBe(false)
    await writeRules('tr', 'mistakes:\n  - wrong: önizleme\n')
    expect(profileFor('tr').rules.has('custom')).toBe(true)
  })

  // Any edit must invalidate cached verdicts, or a new rule would never be
  // applied to a file already reviewed.
  it.each([
    ['a switched rule', 'rules:\n  disable: [punctuation]\n'],
    ['the stem ratio', 'glossaryStemRatio: 0.5\n'],
    ['a proper noun', 'properNouns:\n  always: [Acme]\n'],
    ['a mistake', 'mistakes:\n  - wrong: önizleme\n'],
    ['only a note', 'mistakes:\n  - wrong: önizleme\n    note: two words\n'],
    ['the guidance', 'guidance: Be brief.\n'],
  ])('changes configHash when the file changes %s', async (_, text) => {
    await writeRules('tr', text)
    expect(hashTr()).not.toBe(BEFORE.trEmpty)
  })

  it('changes configHash between two different files, not only from none to one', async () => {
    await writeRules('tr', 'mistakes:\n  - wrong: önizleme\n')
    const first = hashTr()
    await writeRules('tr', 'mistakes:\n  - wrong: önizlem\n')
    expect(hashTr()).not.toBe(first)
  })
})

describe('guidance', () => {
  it('reaches the review prompt and the translate review prompt', async () => {
    await writeRules('tr', 'guidance: |\n  Button labels are verbs in the imperative.\n')
    expect(buildAuditPrompt([], 'tr', 2)).toContain('Button labels are verbs in the imperative.')
    expect(buildReviewPrompt([], 'tr', 2)).toContain('Button labels are verbs in the imperative.')
  })

  // Translate caches its draft reviews under its own hash; guidance must move
  // that one too, or a draft reviewed before the guidance would be reused.
  it('changes the translate hash as well as the review hash', async () => {
    await writeRules('tr', 'guidance: Be brief.\n')
    expect(translateConfigHash('tr')).not.toBe(BEFORE.trTranslate)
  })

  it('stays out of both prompts when the file has none', async () => {
    const before = [buildAuditPrompt([], 'tr', 2), buildReviewPrompt([], 'tr', 2)]
    await writeRules('tr', 'mistakes:\n  - wrong: önizleme\n')
    expect([buildAuditPrompt([], 'tr', 2), buildReviewPrompt([], 'tr', 2)]).toEqual(before)
  })
})

// The loader validates names against this list; the engine runs RULES. The two
// must not drift, or a valid name in a file would switch nothing.
describe('BUILT_IN_RULES', () => {
  it('names every rule the engine knows, and only those', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(import.meta.dirname, '..', '..', 'src', 'audit', 'rules', 'index.ts'), 'utf8'),
    )
    const block = src.slice(src.indexOf('const RULES'), src.indexOf(']', src.indexOf('const RULES')))
    const engine = [...new Set([...block.matchAll(/name: '([^']+)'/g)].map((m) => m[1]))].filter((n) => n !== 'custom')
    expect([...engine].sort()).toEqual([...BUILT_IN_RULES].sort())
  })
})
