import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildRuleContext, runRules } from '../../src/audit/rules/index.js'
import { profileFor, UNIVERSAL_RULES } from '../../src/audit/rules/profiles.js'
import { properNounsFor } from '../../src/audit/rules/proper-nouns.js'
import { buildAuditPrompt } from '../../src/audit/prompt.js'
import { configHash, translateConfigHash } from '../../src/jobs/hash.js'
import { buildReviewPrompt } from '../../src/review/prompt.js'
import { localeRulesFile } from '../../src/rules/load.js'
import { BUILT_IN_RULES } from '../../src/rules/names.js'
import { draftSystemPrompt } from '../../src/draft/prompt.js'

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
//
// Every one of them moved once, on purpose, when the default register line
// stopped asking for a formal register and the fix instruction began naming
// "the register above" for every locale: each locale without a register in
// its file re-reviews once. Turkish and Swedish moved further in the same
// release, because polyglots stopped shipping their packs. Without a file
// they are now universal-only locales like German, and a team keeps its
// Turkish or Swedish rules by having the rules file, whose fingerprint is in
// the hash anyway.
//
// The three translate hashes moved once more, on purpose, when the draft
// review stopped sending agents to glossary_lookup for every term and handed
// them each entry's glossary terms instead: every agent draft review is asked
// again once.
//
// The four review hashes moved once more, on purpose, when date-format joined
// the universal rules: a verdict cached before it ran never saw a broken date
// format, so every locale re-reviews once. The translate hashes did not move.
const BEFORE = {
  trEmpty: '258589bbfbb38a37',
  trGloss: '39a20f1f70224c63',
  de: '9899ccd1d0cafbfb',
  deTranslate: 'd8f22a79e6376085',
  trTranslate: '0024447086e462a4',
  sv: '0388950fc4fa589a',
  svTranslate: '769201ccf76bc57b',
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

  // polyglots ships no locale data, so Turkish without its rules file is
  // every other language without one: the universal checks and nothing more.
  it('runs only the universal rules for Turkish', () => {
    expect([...profileFor('tr').rules]).toEqual([...UNIVERSAL_RULES])
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
    expect([...profileFor('tr').rules]).toEqual([...UNIVERSAL_RULES])
  })

  it('applies the glossary stem ratio', async () => {
    await writeRules('tr', 'glossaryStemRatio: 0.9\n')
    expect(profileFor('tr').glossaryStemRatio).toBe(0.9)
  })

  // There is no built-in list left for the other to keep, so a list the file
  // leaves out is empty rather than Turkish.
  it('uses a proper-noun list it names and leaves the other empty', async () => {
    await writeRules('tr', 'properNouns:\n  always: [Acme]\n')
    const nouns = properNounsFor('tr')
    expect(nouns.always).toEqual(['Acme'])
    expect(nouns.dateOnly).toEqual([])
  })

  // A name of several words is matched as a phrase, the way the names in
  // config.json were before they moved here: Türk Dil Kurumu is excused, and
  // Dil on its own still reads as a capital mid-sentence.
  it('matches a name of several words as a phrase', async () => {
    await writeRules('tr', 'rules:\n  enable: [title-case]\nproperNouns:\n  always: ["Türk Dil Kurumu"]\n')
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

// polyglots-data's tr_TR values, as the date-format rule and the prompts read them.
const DATE_TIME = "schema: 3\ndateTime:\n  clock: 24h\n  order: dmy\n  formats:\n    'F j, Y': 'j F Y'\n    'g:i a': 'H:i'\n"

describe('date-format', () => {
  const entry = (msgid: string, msgstr: string, msgctxt?: string) => ({
    key: msgid,
    msgid,
    msgstr: [msgstr],
    comments: [],
    references: [],
    fuzzy: false,
    ...(msgctxt === undefined ? {} : { msgctxt }),
  })
  const run = (e: ReturnType<typeof entry>) => runRules(e, buildRuleContext({ locale: 'tr', glossary: [], nplurals: 2, entries: [e] })).filter((f) => f.rule === 'date-format')

  it('runs without a rules file, on the universal checks', () => {
    expect(run(entry('Y', 'J', 'yearly archives date format'))).toEqual([
      { rule: 'date-format', severity: 'error', message: expect.stringContaining('"J" is not a PHP date letter') },
    ])
    expect(run(entry('F j, Y', 'F j, Y'))).toEqual([])
    expect(run(entry('N/A', 'Yok'))).toEqual([])
  })

  it('reads the locale’s dateTime from its rules file', async () => {
    await writeRules('tr', DATE_TIME)
    expect(run(entry('F j, Y', 'F j, Y'))).toEqual([
      { rule: 'date-format', severity: 'suspect', message: 'date format: "F j, Y" is the English format; Turkish writes it "j F Y"' },
    ])
  })

  it('is switched off by name', async () => {
    await writeRules('tr', 'schema: 3\nrules: { disable: [date-format] }\n')
    expect(run(entry('Y', 'J', 'yearly archives date format'))).toEqual([])
  })

  it('reaches all three prompts as one line when the file has a dateTime', async () => {
    await writeRules('tr', DATE_TIME)
    for (const prompt of [buildAuditPrompt([], 'tr', 2), buildReviewPrompt([], 'tr', 2), draftSystemPrompt('tr', 2)]) {
      expect(prompt).toContain('- Dates and times:')
      expect(prompt).toContain('24-hour time')
      expect(prompt).toContain('"F j, Y" → "j F Y"')
    }
    expect(translateConfigHash('tr')).not.toBe(BEFORE.trTranslate)
  })

  it('stays out of the prompts without one', async () => {
    await writeRules('tr', 'schema: 3\nguidance: Be brief.\n')
    for (const prompt of [buildAuditPrompt([], 'tr', 2), buildReviewPrompt([], 'tr', 2), draftSystemPrompt('tr', 2)]) {
      expect(prompt).not.toContain('Dates and times')
    }
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

  // Compared against a file that already enables a language check, so the
  // only thing a mistake could change is the guidance, not the universal-only
  // note a mistake also lifts.
  it('stays out of both prompts when the file has none', async () => {
    await writeRules('tr', 'rules:\n  enable: [title-case]\n')
    const before = [buildAuditPrompt([], 'tr', 2), buildReviewPrompt([], 'tr', 2)]
    await writeRules('tr', 'rules:\n  enable: [title-case]\nmistakes:\n  - wrong: önizleme\n')
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
