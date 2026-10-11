import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chooseTemplate,
  createTemplate,
  deleteTemplate,
  fillTemplate,
  listTemplateLocales,
  listTemplates,
  loadTemplates,
  normaliseRequester,
  saveTemplate,
  starterTemplate,
  templateFile,
  templatesDir,
  replyCaution,
} from '../../src/reply/templates.js'

let home: string
let saved: string | undefined
beforeEach(async () => {
  saved = process.env.POLYGLOTS_HOME
  home = await mkdtemp(join(tmpdir(), 'polyglots-reply-'))
  process.env.POLYGLOTS_HOME = home
})
afterEach(async () => {
  if (saved === undefined) delete process.env.POLYGLOTS_HOME
  else process.env.POLYGLOTS_HOME = saved
  await rm(home, { recursive: true, force: true })
})

async function writeTemplate(locale: string, name: string, text: string) {
  const file = templateFile(locale, name)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text, 'utf8')
  return file
}

describe('fillTemplate', () => {
  const results = 'I fixed 3 entries, which you can see <a href="">here</a>.'

  it('fills the username, the choice and the results copy', () => {
    const text = 'Hello @{username},\n\n{No problems.|A few problems, fixed.}\n\n{results_copy}\n\nCheers!'
    expect(fillTemplate(text, { username: 'ayse', repaired: 3, flagged: 0, results })).toBe(
      `Hello @ayse,\n\nA few problems, fixed.\n\n${results}\n\nCheers!`,
    )
  })

  // Repairing nothing is not the same as finding nothing: entries left for
  // the reviewer may still turn out to be problems, so "no problems" waits.
  it('takes the second branch when nothing was repaired but entries are flagged for the reviewer', () => {
    expect(fillTemplate('{none|some}', { repaired: 0, flagged: 2, results: '' })).toBe('some')
  })

  it('says how many entries are flagged for the reviewer, and nothing when none are', () => {
    expect(replyCaution({ needsReview: 0, unreviewed: 0 })).toBeUndefined()
    expect(replyCaution({ needsReview: 1, unreviewed: 0 })).toBe(
      '1 entry is flagged for you. Check the verdict sentence before you post.',
    )
    expect(replyCaution({ needsReview: 2, unreviewed: 1 })).toBe(
      '3 entries are flagged for you. Check the verdict sentence before you post.',
    )
  })

  it('takes the first branch of a choice when nothing was repaired', () => {
    expect(fillTemplate('{There were no problems.|There were a few problems.}', { repaired: 0, flagged: 0, results: '' })).toBe(
      'There were no problems.',
    )
    expect(fillTemplate('{none|some}', { repaired: 1, flagged: 0, results: '' })).toBe('some')
  })

  // The docs offer this form for a sentence that only makes sense when there
  // are results to read: an empty first branch says nothing on a clean run.
  it('reads a choice with an empty first branch', () => {
    const text = 'I have granted you PTE rights.{| Please see below:}'
    expect(fillTemplate(text, { repaired: 0, flagged: 0, results: '' })).toBe('I have granted you PTE rights.')
    expect(fillTemplate(text, { repaired: 2, flagged: 0, results: 'x' })).toBe('I have granted you PTE rights. Please see below:')
  })

  it('leaves {username} in place when no username was given', () => {
    expect(fillTemplate('Hello @{username},', { repaired: 0, flagged: 0, results: '' })).toBe('Hello @{username},')
    expect(fillTemplate('Hello @{username},', { username: '', repaired: 0, flagged: 0, results: '' })).toBe('Hello @{username},')
  })

  it('leaves any other brace group verbatim', () => {
    const text = 'Keep {this}, {a|b|c}, {} and {{nested|x}} and a lone { brace.'
    expect(fillTemplate(text, { repaired: 2, flagged: 0, results: '' })).toBe('Keep {this}, {a|b|c}, {} and {x} and a lone { brace.')
  })

  it('does not read placeholders inside what it substituted', () => {
    expect(fillTemplate('{username} {results_copy}', { username: '{results_copy}', repaired: 1, flagged: 0, results: '{a|b}' })).toBe(
      '{results_copy} {a|b}',
    )
  })

  // A clean run has no requester message. The paragraph it would have filled
  // goes, with one of the blank lines around it, so the reply does not carry
  // a visible hole where the findings were.
  it('drops a line holding only an empty results copy, and one blank line with it', () => {
    const text = 'Hello,\n\nI reviewed it.\n\n{results_copy}\n\nCheers!\n'
    expect(fillTemplate(text, { repaired: 0, flagged: 0, results: '' })).toBe('Hello,\n\nI reviewed it.\n\nCheers!')
  })

  it('keeps the HTML exactly as written, with no wrapping', () => {
    const long = `Please join our <a href="https://www.wp-tr.org/slack/">local slack</a> ${'and more words '.repeat(20)}`.trim()
    expect(fillTemplate(long, { repaired: 0, flagged: 0, results: '' })).toBe(long)
  })
})

describe('template files', () => {
  it('lives under the config directory, by WordPress locale code', () => {
    expect(templatesDir('tr')).toBe(join(home, 'config', 'templates', 'tr_TR'))
    expect(templateFile('tr', 'approved')).toBe(join(home, 'config', 'templates', 'tr_TR', 'approved.txt'))
  })

  it('refuses a name that would leave the directory', () => {
    expect(() => templateFile('tr', '../x')).toThrow(/template name/i)
    expect(() => templateFile('tr', 'a/b')).toThrow(/template name/i)
    expect(() => templateFile('tr', '')).toThrow(/template name/i)
  })

  it('lists none for a locale with no directory', () => {
    expect(listTemplates('tr')).toEqual([])
    expect(loadTemplates('tr')).toEqual([])
  })

  it('lists and loads the .txt files, approved first, then by name', async () => {
    await writeTemplate('tr', 'declined', 'B')
    await writeTemplate('tr', 'approved', 'A')
    await writeTemplate('tr', 'another', 'C')
    await writeFile(join(templatesDir('tr'), 'notes.md'), 'ignored')
    expect(listTemplates('tr')).toEqual(['approved', 'another', 'declined'])
    expect(loadTemplates('tr')).toEqual([
      { name: 'approved', text: 'A' },
      { name: 'another', text: 'C' },
      { name: 'declined', text: 'B' },
    ])
  })

  it('lists the locales that hold at least one template', async () => {
    await writeTemplate('tr', 'approved', 'A')
    await mkdir(templatesDir('de'), { recursive: true })
    expect(listTemplateLocales()).toEqual([{ dir: 'tr_TR', names: ['approved'] }])
  })
})

// The app manages the files, so nobody has to find the folder: these are what
// the CLI's edit and delete and the TUI's screen both call.
describe('createTemplate and deleteTemplate', () => {
  it('writes the starter for the name and returns its path', () => {
    const file = createTemplate('tr', 'declined')
    expect(file).toBe(templateFile('tr', 'declined'))
    return expect(readFile(file, 'utf8')).resolves.toBe(starterTemplate('tr', 'declined'))
  })

  it('starts any other name from the approved text', async () => {
    expect(await readFile(createTemplate('tr', 'short'), 'utf8')).toBe(starterTemplate('tr', 'approved'))
  })

  it('never overwrites a template that exists', async () => {
    const file = templateFile('tr', 'approved')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'mine')
    expect(() => createTemplate('tr', 'approved')).toThrow(/already exists/)
    expect(await readFile(file, 'utf8')).toBe('mine')
  })

  it('refuses a name that is not a plain file name', () => {
    expect(() => createTemplate('tr', '../escape')).toThrow(/not a valid template name/)
    expect(() => deleteTemplate('tr', '../escape')).toThrow(/not a valid template name/)
  })

  it('deletes a template and says whether there was one', () => {
    const file = createTemplate('tr', 'approved')
    expect(deleteTemplate('tr', 'approved')).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(listTemplates('tr')).toEqual([])
    expect(deleteTemplate('tr', 'approved')).toBe(false)
  })
})

describe('saveTemplate', () => {
  it('replaces the text of a template and leaves nothing beside it', async () => {
    const file = createTemplate('tr', 'approved')
    saveTemplate('tr', 'approved', 'Edited.\n')
    expect(await readFile(file, 'utf8')).toBe('Edited.\n')
    expect(listTemplates('tr')).toEqual(['approved'])
  })

  it('refuses a name that is not a plain file name', () => {
    expect(() => saveTemplate('tr', '../escape', 'x')).toThrow(/not a valid template name/)
  })
})

describe('chooseTemplate', () => {
  it('defaults to approved, and to the first there is without one', () => {
    expect(chooseTemplate(['approved', 'declined'])).toBe('approved')
    expect(chooseTemplate(['declined'])).toBe('declined')
    expect(chooseTemplate([])).toBeUndefined()
  })

  it('takes the named one when it exists, and undefined when it does not', () => {
    expect(chooseTemplate(['approved', 'declined'], 'declined')).toBe('declined')
    expect(chooseTemplate(['approved'], 'declined')).toBeUndefined()
  })
})

describe('starterTemplate', () => {
  it('starts tr from the locale manager’s own reply', () => {
    const text = starterTemplate('tr', 'approved')
    expect(text).toContain('Hello @{username},')
    expect(text).toContain('{There were no problems.|There were a few problems, and I fixed them.}')
    expect(text).toContain('{results_copy}')
    expect(text).toContain('#tr_TR translation team')
    expect(text).toContain('<a href="https://www.wp-tr.org/slack/">local slack</a>')
  })

  it('starts any other locale from a neutral reply with the same placeholders', () => {
    for (const name of ['approved', 'declined', 'custom']) {
      const text = starterTemplate('de', name)
      expect(text).toContain('{username}')
      expect(text).toContain('{results_copy}')
      expect(text).toMatch(/\{[^{}|]+\|[^{}|]+\}/)
      expect(text).not.toContain('wp-tr.org')
    }
  })

  // A clean run drops the results line, so a sentence that points at it
  // would point at the team guidelines instead. Every starter written here
  // keeps that pointer inside a choice; tr approved is the one exception,
  // because it is the locale manager's own text, carried word for word.
  it('does not point below at results a clean run does not have', () => {
    const results = 'I fixed 3 entries, which you can see <a href="">here</a>.'
    const starters: Array<[string, string]> = [
      ['de', 'approved'],
      ['de', 'declined'],
      ['de', 'custom'],
      ['tr', 'declined'],
    ]
    for (const [locale, name] of starters) {
      const text = starterTemplate(locale, name)
      const clean = fillTemplate(text, { username: 'ayse', repaired: 0, flagged: 0, results: '' })
      for (const paragraph of clean.split(/\n\s*\n/)) {
        expect(paragraph.trimEnd(), `${locale} ${name}`).not.toMatch(/below:$/)
      }
      const repaired = fillTemplate(text, { username: 'ayse', repaired: 3, flagged: 0, results })
      expect(repaired, `${locale} ${name}`).toContain(`Please see below:\n\n${results}`)
    }
  })

  it('keeps the tr approved reply word for word, pointer and all', () => {
    expect(starterTemplate('tr', 'approved')).toContain(
      'I have reviewed your translations. {There were no problems.|There were a few problems, and I fixed them.} I have granted you PTE rights. Please see below:',
    )
  })

  it('says PTE was approved in one and not yet in the other', () => {
    expect(starterTemplate('de', 'approved')).toMatch(/granted you PTE/)
    expect(starterTemplate('de', 'declined')).toMatch(/not .*PTE.* yet/i)
    expect(starterTemplate('tr', 'declined')).toMatch(/not .*PTE.* yet/i)
  })
})

describe('normaliseRequester', () => {
  // Templates write @{username}, and a username copied from a profile or a
  // mention often arrives with its @ already on.
  it('trims and drops a leading @', () => {
    expect(normaliseRequester('  @ayse ')).toBe('ayse')
    expect(normaliseRequester('ayse')).toBe('ayse')
    expect(normaliseRequester('   ')).toBeUndefined()
    expect(normaliseRequester(undefined)).toBeUndefined()
  })
})
