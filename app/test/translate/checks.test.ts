import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { localeRulesFile } from '../../src/rules/load.js'
import { resetSandbox } from '../../src/rules/sandbox.js'
import { createDraftChecker } from '../../src/translate/checks.js'
import type { TranslationUnit } from '../../src/types.js'

let home: string
let saved: string | undefined

beforeEach(async () => {
  resetSandbox()
  saved = process.env.POLYGLOTS_HOME
  home = await mkdtemp(join(tmpdir(), 'polyglots-draft-checks-'))
  process.env.POLYGLOTS_HOME = home
  const file = localeRulesFile('tr')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(
    file,
    ['patterns:', "  - find: '^(a+)+$'", '    level: hint', '    note: nested repetition', ''].join('\n'),
    'utf8',
  )
})

afterEach(async () => {
  resetSandbox()
  if (saved === undefined) delete process.env.POLYGLOTS_HOME
  else process.env.POLYGLOTS_HOME = saved
  await rm(home, { recursive: true, force: true })
})

const unit = (msgid: string): TranslationUnit => ({ key: msgid, msgid, comments: [], references: [] })

// A pattern that runs away on a draft says nothing about the draft: the rules
// file is at fault. Sent as an automated check, it would ask the AI to answer
// for a regex it never saw, and the run summary already names the pattern.
describe('the checks a draft checker sends with a draft', () => {
  it('leaves out a locale rule skipped as a runaway', () => {
    const u = unit('Save')
    const checker = createDraftChecker({ locale: 'tr', nplurals: 2, glossary: [], properNouns: [], units: [u] })
    const prepared = checker.prepare(u, ['a'.repeat(30) + 'b'])
    expect(prepared.checks.filter((c) => c.includes('locale rule skipped'))).toEqual([])
  })

  // A draft whose only finding is the skip goes to the reviewer as a clean
  // draft would: no automatedChecks, and so the same cache key as one.
  it('sends no checks at all with a draft whose only finding is the skip', () => {
    const u = unit('Save')
    const checker = createDraftChecker({ locale: 'tr', nplurals: 2, glossary: [], properNouns: [], units: [u] })
    expect(checker.prepare(u, ['a'.repeat(30) + 'b']).checks).toEqual([])
  })
})

// A draft engine keeps "F j, Y" as it is, and DeepL does so reliably, so a
// draft is where an English date format is most often born.
describe('date formats in a draft', () => {
  it('checks a draft’s date format against the locale’s dateTime', async () => {
    await writeFile(localeRulesFile('tr'), "schema: 3\ndateTime:\n  formats:\n    'F j, Y': 'j F Y'\n", 'utf8')
    const u = unit('F j, Y')
    const checker = createDraftChecker({ locale: 'tr', nplurals: 2, glossary: [], properNouns: [], units: [u] })
    expect(checker.prepare(u, ['F j, Y']).checks.join('\n')).toContain('Turkish writes it "j F Y"')
  })
})
