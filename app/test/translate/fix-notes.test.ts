import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { localeRulesFile } from '../../src/rules/load.js'
import { createDraftChecker } from '../../src/translate/checks.js'
import type { TranslationUnit } from '../../src/types.js'

let home: string
let saved: string | undefined

beforeEach(async () => {
  saved = process.env.POLYGLOTS_HOME
  home = await mkdtemp(join(tmpdir(), 'polyglots-fix-notes-'))
  process.env.POLYGLOTS_HOME = home
  const file = localeRulesFile('tr')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(
    file,
    [
      'patterns:',
      "  - find: '(?<![\\p{L}])([Yy])ada(?![\\p{L}])'",
      "    replace: '$1a da'",
      '    level: fix',
      '    note: two words',
      '  - text: önizleme',
      '    replace: ön izleme',
      '    level: fix',
      '',
    ].join('\n'),
    'utf8',
  )
})

afterEach(async () => {
  if (saved === undefined) delete process.env.POLYGLOTS_HOME
  else process.env.POLYGLOTS_HOME = saved
  await rm(home, { recursive: true, force: true })
})

const unit = (msgid: string): TranslationUnit => ({ key: msgid, msgid, comments: [], references: [] })
const checkerFor = (...units: TranslationUnit[]) =>
  createDraftChecker({ locale: 'tr', nplurals: 2, glossary: [], properNouns: [], units })

describe('the notes of the fixes a draft checker made', () => {
  it('writes the note of a fix pattern on the entry it changed', () => {
    const u = unit('this or that')
    const out = checkerFor(u).finalize(u, { key: u.key, text: ['bu yada şu'], fuzzy: false, reason: '' })
    expect(out.text).toEqual(['bu ya da şu'])
    expect(out.notes).toEqual(['polyglots: locale rule: two words'])
  })

  it('says nothing about an entry no fix changed', () => {
    const u = unit('this or that')
    const out = checkerFor(u).finalize(u, { key: u.key, text: ['bu ya da şu'], fuzzy: false, reason: '' })
    expect(out.notes).toBeUndefined()
  })

  it('gives each pattern its own note, and names one without a note by what it replaced', () => {
    const u = unit('Preview this or that')
    const out = checkerFor(u).finalize(u, { key: u.key, text: ['Önizleme yada şu'], fuzzy: false, reason: '' })
    expect(out.text).toEqual(['Ön izleme ya da şu'])
    expect(out.notes).toEqual(['polyglots: locale rule: two words', 'polyglots: locale rule: replaced önizleme with "ön izleme"'])
  })

  // The usual path: prepare fixes the draft before the AI pass, the AI keeps
  // the fixed text, and finalize finds nothing left to change. The entry was
  // still changed by a rule, and the note must not be lost on the way.
  it('keeps the note of a fix made before the AI pass, once', () => {
    const u = unit('this or that')
    const checker = checkerFor(u)
    const prepared = checker.prepare(u, ['bu yada şu'])
    expect(prepared.drafts).toEqual(['bu ya da şu'])
    const out = checker.finalize(u, { key: u.key, text: prepared.drafts, fuzzy: false, reason: '' })
    expect(out.notes).toEqual(['polyglots: locale rule: two words'])
  })

  it('does not carry a note from one finalize to the next', () => {
    const u = unit('this or that')
    const checker = checkerFor(u)
    checker.finalize(u, { key: u.key, text: checker.prepare(u, ['bu yada şu']).drafts, fuzzy: false, reason: '' })
    const again = checker.finalize(u, { key: u.key, text: ['bu ya da şu'], fuzzy: false, reason: '' })
    expect(again.notes).toBeUndefined()
  })
})
