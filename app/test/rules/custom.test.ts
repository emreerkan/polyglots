import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildRuleContext, runRules } from '../../src/audit/rules/index.js'
import { applyFixPatterns, customFindings } from '../../src/rules/custom.js'
import { localeRulesFile } from '../../src/rules/load.js'
import type { CustomPattern } from '../../src/rules/schema.js'

const mistake = (wrong: string, right?: string, note?: string): CustomPattern => ({
  kind: 'mistake',
  text: wrong,
  ...(right ? { right } : {}),
  level: 'hint',
  ignoreCase: true,
  ...(note ? { note } : {}),
})

const entry = (msgid: string, ...msgstr: string[]) => ({ msgid, msgstr })

describe('customFindings', () => {
  it('reports a common mistake as a suspect, with the right form and the note', () => {
    const f = customFindings(entry('Preview', 'Önizlemeyi aç'), [mistake('önizleme', 'ön izleme', 'TDK writes it as two words')], 'tr')
    expect(f).toEqual([
      { rule: 'custom', severity: 'suspect', message: '"önizleme" -> "ön izleme" (TDK writes it as two words)' },
    ])
  })

  // JavaScript's i flag pairs i with I, not with İ; Turkish needs its own pairs.
  it('matches Turkish capitals the way Turkish spells them', () => {
    expect(customFindings(entry('Content', 'İçerik'), [mistake('içerik')], 'tr')).toHaveLength(1)
    expect(customFindings(entry('Content', 'ICERIK'), [mistake('içerik')], 'tr')).toHaveLength(0)
  })

  it('reports an error pattern as an error, so the entry is condemned', () => {
    const p: CustomPattern = { kind: 'pattern', text: 'sitenize', level: 'error', ignoreCase: true, note: 'Use "sitenizde" here' }
    expect(customFindings(entry('on your site', 'sitenize ekle'), [p], 'tr')).toEqual([
      { rule: 'custom', severity: 'error', message: 'Use "sitenizde" here' },
    ])
  })

  it('applies a pattern only when the English source contains its condition', () => {
    const p: CustomPattern = { kind: 'pattern', text: 'yazı', level: 'hint', ignoreCase: true, whenSource: 'page' }
    expect(customFindings(entry('Edit page', 'Yazıyı düzenle'), [p], 'tr')).toHaveLength(1)
    expect(customFindings(entry('Edit post', 'Yazıyı düzenle'), [p], 'tr')).toHaveLength(0)
  })

  it('runs a regular expression, case-sensitive unless asked', () => {
    const p: CustomPattern = { kind: 'pattern', find: '\\b(\\d+) %', level: 'hint', ignoreCase: false, note: 'no space before %' }
    expect(customFindings(entry('%d%%', '%d %'), [{ ...p, find: '%d %' }], 'tr')).toHaveLength(1)
    expect(customFindings(entry('Rate', '10 %'), [p], 'tr')).toHaveLength(1)
  })

  it('names what matched when a pattern has no note', () => {
    const p: CustomPattern = { kind: 'pattern', find: 'x+', level: 'hint', ignoreCase: false }
    expect(customFindings(entry('a', 'axxb'), [p], 'tr')[0]?.message).toBe('matches "xx"')
  })

  it('leaves fix patterns to the repair step', () => {
    const p: CustomPattern = { kind: 'pattern', text: '...', replace: '…', level: 'fix', ignoreCase: true }
    expect(customFindings(entry('Loading...', 'Yükleniyor...'), [p], 'tr')).toEqual([])
  })

  // A regex object with the g flag remembers where it stopped. Shared between
  // entries, it would skip the next entry's match.
  it('finds the same pattern in consecutive entries', () => {
    const p: CustomPattern = { kind: 'pattern', find: 'ab', level: 'hint', ignoreCase: false }
    expect(customFindings(entry('x', 'ab'), [p], 'tr')).toHaveLength(1)
    expect(customFindings(entry('x', 'ab'), [p], 'tr')).toHaveLength(1)
  })
})

/**
 * Two encodings of one letter (#25). Hindi ड़ is U+095C or ड plus a nukta,
 * Bengali য় is U+09DF or য plus a nukta, and approved core carries both, often
 * for the same word. A pack pattern written in one must find the other, as the
 * glossary, memory and consistency checks already do.
 */
describe('text in either encoding', () => {
  const COMPOSED = 'क\u095Cी'
  const DECOMPOSED = 'क\u0921\u093Cी'
  const hint = (text: string): CustomPattern => ({ kind: 'pattern', text, level: 'hint', ignoreCase: true })

  it('finds the decomposed spelling with a pattern written precomposed', () => {
    expect(customFindings(entry('Link', `${DECOMPOSED} जोड़ें`), [hint(COMPOSED)], 'hi')).toHaveLength(1)
  })

  it('finds the precomposed spelling with a pattern written decomposed', () => {
    expect(customFindings(entry('Link', `${COMPOSED} जोड़ें`), [hint(DECOMPOSED)], 'hi')).toHaveLength(1)
  })

  it('finds a Bengali letter in either encoding', () => {
    expect(customFindings(entry('Time', 'স\u09AF\u09BC'), [hint('স\u09DF')], 'bn')).toHaveLength(1)
  })

  // A word that mixes the two, and case on top: a capital O with a combining
  // diaeresis is the same Ö the pattern spells precomposed in lower case.
  it('still pairs Turkish capitals when the capital is decomposed', () => {
    expect(customFindings(entry('Preview', 'O\u0308nizleme yap'), [mistake('önizleme')], 'tr')).toHaveLength(1)
  })

  // The nukta is part of the letter: a pattern for ड़ is not one for ड.
  it('does not find a letter without the mark the pattern spells', () => {
    expect(customFindings(entry('Link', 'कडी'), [hint(COMPOSED)], 'hi')).toHaveLength(0)
  })

  // A regular expression is compared on normalised text for a finding, which
  // needs no position in the original.
  it('finds a regular expression in either encoding', () => {
    const p: CustomPattern = { kind: 'pattern', find: `^${COMPOSED}`, level: 'hint', ignoreCase: false }
    expect(customFindings(entry('Link', `${DECOMPOSED} जोड़ें`), [p], 'hi')).toHaveLength(1)
  })

  // A repair replaces what matched and leaves the rest as the contributor
  // typed it, encoding included: the precomposed ड़ after the match stays
  // U+095C.
  it('repairs a match in the other encoding and leaves the rest as typed', () => {
    const p: CustomPattern = { kind: 'pattern', text: COMPOSED, replace: 'लिंक', level: 'fix', ignoreCase: true }
    expect(applyFixPatterns(entry('Link', `${DECOMPOSED} और \u095C`), [p], 'hi')?.forms).toEqual(['लिंक और \u095C'])
  })

  it('keeps a leading capital that was typed decomposed', () => {
    const p: CustomPattern = { kind: 'pattern', text: 'önizleme', replace: 'ön izleme', level: 'fix', ignoreCase: true }
    expect(applyFixPatterns(entry('Preview', 'O\u0308nizleme yap'), [p], 'tr')?.forms).toEqual(['Ön izleme yap'])
  })
})

describe('applyFixPatterns', () => {
  const ellipsis: CustomPattern = { kind: 'pattern', find: '\\.\\.\\.', replace: '…', level: 'fix', ignoreCase: false, note: 'Use the ellipsis character' }

  it('rewrites every form and says why', () => {
    expect(applyFixPatterns(entry('Loading...', 'Yükleniyor...', 'Yükleniyorlar...'), [ellipsis], 'tr')).toEqual({
      forms: ['Yükleniyor…', 'Yükleniyorlar…'],
      notes: ['Use the ellipsis character'],
    })
  })

  it('keeps a leading capital when a literal replaces a capitalised word', () => {
    const p: CustomPattern = { kind: 'pattern', text: 'önizleme', replace: 'ön izleme', level: 'fix', ignoreCase: true }
    expect(applyFixPatterns(entry('Preview', 'Önizleme yap'), [p], 'tr')?.forms).toEqual(['Ön izleme yap'])
  })

  it('supports capture groups in a regex replacement', () => {
    const p: CustomPattern = { kind: 'pattern', find: '(\\d+) %', replace: '%$1', level: 'fix', ignoreCase: false }
    expect(applyFixPatterns(entry('Rate', 'Oran 10 %'), [p], 'tr')?.forms).toEqual(['Oran %10'])
  })

  it('returns nothing when no fix applies', () => {
    expect(applyFixPatterns(entry('Hello', 'Merhaba'), [ellipsis], 'tr')).toBeUndefined()
  })

  // A fix that empties a translation has destroyed it, not repaired it.
  it('never empties a form, and leaves an untranslated form alone', () => {
    const wipe: CustomPattern = { kind: 'pattern', find: '.+', replace: '', level: 'fix', ignoreCase: false }
    expect(applyFixPatterns(entry('Hi', 'Merhaba'), [wipe], 'tr')).toBeUndefined()
    expect(applyFixPatterns(entry('Hi', '  '), [ellipsis], 'tr')).toBeUndefined()
  })

  it('respects the source condition', () => {
    const p: CustomPattern = { kind: 'pattern', text: 'yazı', replace: 'sayfa', level: 'fix', ignoreCase: true, whenSource: 'page' }
    expect(applyFixPatterns(entry('Edit post', 'yazı'), [p], 'tr')).toBeUndefined()
  })
})

describe('through the rule engine', () => {
  let home: string
  let saved: string | undefined
  beforeEach(async () => {
    saved = process.env.POLYGLOTS_HOME
    home = await mkdtemp(join(tmpdir(), 'polyglots-custom-'))
    process.env.POLYGLOTS_HOME = home
  })
  afterEach(async () => {
    if (saved === undefined) delete process.env.POLYGLOTS_HOME
    else process.env.POLYGLOTS_HOME = saved
    await rm(home, { recursive: true, force: true })
  })

  it('runs the locale file mistakes as part of the ordinary rules', async () => {
    const file = localeRulesFile('tr')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'mistakes:\n  - wrong: önizleme\n    right: ön izleme\n', 'utf8')
    const e = { key: 'k', msgid: 'Preview', msgstr: ['Önizleme'], comments: [], references: [] }
    const ctx = buildRuleContext({ locale: 'tr', glossary: [], nplurals: 2, entries: [e as never] })
    expect(runRules(e as never, ctx).filter((f) => f.rule === 'custom')).toHaveLength(1)
  })
})
