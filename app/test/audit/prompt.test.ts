import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildAuditPrompt, type AuditCandidate } from '../../src/audit/prompt.js'
import { buildRuleContext, runRules } from '../../src/audit/rules/index.js'
import { buildReviewPrompt } from '../../src/review/prompt.js'
import { skipFinding } from '../../src/rules/custom.js'
import { localeRulesFile } from '../../src/rules/load.js'
import type { Finding, ReviewInput } from '../../src/types.js'
import { useLocaleFixture } from '../locale-fixture.js'

// Turkish and Swedish read their paragraphs and register lines from their
// rules files, which these are, as a reviewer's would be.
useLocaleFixture('tr_TR.yaml', 'sv_SE.yaml')

// Each write moves the mtime forward, so the loader's cache always sees it.
let tick = 0
async function writeRules(locale: string, text: string) {
  const file = localeRulesFile(locale)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text, 'utf8')
  const t = new Date(Date.now() + ++tick * 1000)
  await utimes(file, t, t)
}

const audit = (locale: string, nplurals = 2, pluralForms?: string) => buildAuditPrompt([], locale, nplurals, pluralForms)
const review = (locale: string, nplurals = 2, pluralForms?: string) => buildReviewPrompt([], locale, nplurals, pluralForms)

const UNIVERSAL_NOTE = /only the universal ones/

describe('the capitalization paragraph', () => {
  // The Turkish paragraph is TDK text with Turkish examples. Gating it on the
  // rule name alone sent it to any team that turned title-case on.
  it('gives a locale that enables title-case by file the generic paragraph, with nothing Turkish in it', async () => {
    await writeRules('nl', 'rules:\n  enable: [title-case]\n')
    const prompt = audit('nl')
    expect(prompt).toMatch(/Dutch capitalizes only the first word of a sentence and proper nouns/)
    expect(prompt).not.toMatch(/TDK|Türk|Kaydet/)
  })

  it('gives Swedish its own paragraph', () => {
    const prompt = audit('sv')
    expect(prompt).toMatch(/Swedish writes the names of languages, nationalities, days of the week and months in lower case/)
    expect(prompt).not.toMatch(/TDK|Türk/)
  })

  it('keeps the plain line for a locale without title-case', () => {
    expect(audit('de')).toContain("- Follow German's own capitalization rules.")
  })
})

describe('the register line', () => {
  // WordPress in Swedish addresses the reader as "du". Asking for a formal
  // register with no over-familiar address invites the model to push "ni".
  it('tells both Swedish prompts to use "du" and not the formal register', () => {
    for (const prompt of [audit('sv'), review('sv')]) {
      expect(prompt).toMatch(/Address the reader as "du"/)
      expect(prompt).not.toMatch(/formal/)
    }
  })

  // The default no longer asserts a formal register, which is the Swedish
  // mistake made for every locale that has not written a register of its own.
  it('gives a locale without one the neutral line', () => {
    expect(audit('de')).toContain('- Use the register that is standard in WordPress German. Keep the tone neutral and concise, with no slang.')
    expect(review('de')).toContain('- Use the register that is standard in WordPress German (de). Keep the tone neutral and concise, with no slang.')
  })
})

describe('the universal-only note', () => {
  it('reaches both prompts for a locale whose rules are only the universal ones', () => {
    expect(audit('de')).toMatch(UNIVERSAL_NOTE)
    expect(review('de')).toMatch(UNIVERSAL_NOTE)
  })

  it('stays out of the Turkish and Swedish prompts', () => {
    for (const prompt of [audit('tr'), review('tr'), audit('sv'), review('sv')]) expect(prompt).not.toMatch(UNIVERSAL_NOTE)
  })

  // Decided by the rules that will run, not by whether a pack exists.
  it('reaches Turkish once its file turns every extra off', async () => {
    await writeRules('tr', 'rules:\n  enable: []\n')
    expect(audit('tr')).toMatch(UNIVERSAL_NOTE)
    expect(review('tr')).toMatch(UNIVERSAL_NOTE)
  })

  it('leaves German alone once its file writes one mistake', async () => {
    await writeRules('de', 'mistakes:\n  - wrong: Email\n')
    expect(audit('de')).not.toMatch(UNIVERSAL_NOTE)
    expect(review('de')).not.toMatch(UNIVERSAL_NOTE)
  })
})

describe('the plural expression', () => {
  const RU = 'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);'

  // Above two forms the count alone does not say which form is which.
  it('reaches both prompts above two forms', () => {
    expect(audit('ru', 3, RU)).toContain(`nplurals: 3\nPlural-Forms: ${RU}\n`)
    expect(review('ru', 3, RU)).toContain(`nplurals: 3\nPlural-Forms: ${RU}\n`)
  })

  it('stays out at two forms or fewer', () => {
    const two = 'nplurals=2; plural=(n > 1);'
    expect(audit('tr', 2, two)).toBe(audit('tr', 2))
    expect(review('tr', 2, two)).toBe(review('tr', 2))
  })
})

describe('rule messages', () => {
  const entry = (msgid: string, msgstr: string) => ({ key: msgid, msgid, msgstr: [msgstr], comments: [], references: [], fuzzy: false })

  it('name the locale\'s own language when a file enables ampersand or number-format', async () => {
    await writeRules('de', 'rules:\n  enable: [ampersand, number-format]\n')
    const entries = [entry('Date & Time', 'Datum & Zeit'), entry('Progress: 25%', 'Fortschritt: % 25')]
    const ctx = buildRuleContext({ locale: 'de', glossary: [], nplurals: 2, entries })
    const messages = entries.flatMap((e) => runRules(e, ctx)).map((f) => f.message)
    expect(messages).toEqual([
      'the translation keeps "&" where German writes the conjunction as a word',
      'German writes the percent sign closed up to its number, as %25',
    ])
  })
})

describe('the review prompt keeps its inputs', () => {
  it('still renders entries after the new lines', () => {
    const inputs: ReviewInput[] = [{ key: 'Save', msgid: 'Save', comments: [], drafts: ['Spara'] }]
    expect(buildReviewPrompt(inputs, 'sv', 2)).toContain('"msgid":"Save"')
  })
})

// Maintainer ruling 2026-10-16: a locale pattern that ran away on an entry is
// the rules file's fault, not the contributor's. The person reads it in the
// problems file; the model never weighs it, since it cannot answer for a regex
// it never sees and a check it cannot adjudicate invites a guess either way.
describe('a locale rule skipped as a runaway', () => {
  const candidate = (hints: Finding[]): AuditCandidate => ({
    id: 1,
    key: 'Save',
    msgid: 'Save',
    msgstr: ['Kaydet'],
    comments: [],
    references: [],
    hints,
  })
  const titleCase: Finding = { rule: 'title-case', severity: 'suspect', message: 'capital mid-string' }

  it('is not among the automated checks the review prompt sends', () => {
    const prompt = buildAuditPrompt([candidate([skipFinding('nested repetition'), titleCase])], 'tr', 2)
    expect(prompt).not.toContain('locale rule skipped')
    expect(prompt).toContain('"automatedChecks":["title-case: capital mid-string"]')
  })

  it('leaves an entry whose only finding it is with no automated checks at all', () => {
    // The entry is the last line; the guidance above it names the field too.
    const line = buildAuditPrompt([candidate([skipFinding('nested repetition')])], 'tr', 2).split('\n').at(-1)
    expect(line).toBe('{"id":1,"source":"Save","submitted":["Kaydet"]}')
  })
})

describe('placeholder order', () => {
  // A family-name-first locale writes "%2$s %1$s" for "%1$s %2$s", and sprintf
  // fills a numbered placeholder by its number. Both prompts used to ask for
  // the source's order, which sent a reviewer to put a correct swap back.
  it('lets both prompts move a numbered placeholder but keep unnumbered ones in order', () => {
    for (const prompt of [audit('de'), review('de')]) {
      expect(prompt).toContain('A numbered placeholder such as %1$s may move')
      expect(prompt).toContain('keep them in the source\'s order, or number them all (%1$s, %2$d) to move them')
      expect(prompt).not.toMatch(/\{x\}\), HTML tags, and leading\/trailing whitespace must match|add, drop, reorder/)
    }
  })
})
