import { describe, expect, it } from 'vitest'
import { RULES, RULE_IDS, printfPlaceholders, type RuleId } from '../../src/lint/rules.js'
import type { TranslationUnit } from '../../src/types.js'

const unit = (msgid: string, extra: Partial<TranslationUnit> = {}): TranslationUnit => ({
  key: msgid,
  msgid,
  comments: [],
  references: ['plugin.php:1'],
  ...extra,
})
const fires = (id: RuleId, u: TranslationUnit): boolean => RULES.find((r) => r.id === id)!.test(u)
const noted = ['translators: %s: a name']

describe('RULES', () => {
  it('lists the four certain rules as errors and the five heuristics as warnings, in RULE_IDS order', () => {
    expect(RULES.map((r) => r.id)).toEqual([...RULE_IDS])
    expect(RULES.map((r) => r.level)).toEqual(['error', 'error', 'error', 'error', 'warning', 'warning', 'warning', 'warning', 'warning'])
    for (const r of RULES) expect(r.fix.length).toBeGreaterThan(20)
  })
})

describe('printfPlaceholders', () => {
  it('keeps positions and skips the literal percent sign', () => {
    expect(printfPlaceholders('100%% of %1$s and %d')).toEqual(['%1$s', '%d'])
    expect(printfPlaceholders('%%s is literal')).toEqual([])
    expect(printfPlaceholders('100% done')).toEqual([])
  })
})

describe('translators-comment', () => {
  it('fires on a placeholder with no translators comment', () => {
    expect(fires('translators-comment', unit('Hello %s'))).toBe(true)
  })
  it('fires when only the plural form has the placeholder', () => {
    expect(fires('translators-comment', unit('One item', { msgidPlural: '%d items' }))).toBe(true)
  })
  it('is satisfied by a translators comment in any case', () => {
    expect(fires('translators-comment', unit('Hello %s', { comments: noted }))).toBe(false)
    expect(fires('translators-comment', unit('Hello %s', { comments: ['Translators: %s: a name'] }))).toBe(false)
  })
  it('ignores %% and strings with no placeholder', () => {
    expect(fires('translators-comment', unit('100%% done'))).toBe(false)
    expect(fires('translators-comment', unit('Save changes'))).toBe(false)
  })
})

describe('unordered-placeholders', () => {
  it('fires on two placeholders when one has no position', () => {
    expect(fires('unordered-placeholders', unit('%s of %s', { comments: noted }))).toBe(true)
    expect(fires('unordered-placeholders', unit('%1$s of %s', { comments: noted }))).toBe(true)
  })
  it('fires on the plural form too', () => {
    expect(fires('unordered-placeholders', unit('%1$s item', { msgidPlural: '%s of %d', comments: noted }))).toBe(true)
  })
  it('passes numbered placeholders and a single one', () => {
    expect(fires('unordered-placeholders', unit('%1$s of %2$s', { comments: noted }))).toBe(false)
    expect(fires('unordered-placeholders', unit('Hello %s', { comments: noted }))).toBe(false)
  })
})

describe('plural-placeholders', () => {
  it('fires when the singular lacks the plural form\'s placeholder', () => {
    expect(fires('plural-placeholders', unit('One item', { msgidPlural: '%d items' }))).toBe(true)
  })
  it('compares without positions, as multisets', () => {
    expect(fires('plural-placeholders', unit('%1$d item in %2$s', { msgidPlural: '%2$s has %1$d items' }))).toBe(false)
    expect(fires('plural-placeholders', unit('%d item', { msgidPlural: '%d items' }))).toBe(false)
    expect(fires('plural-placeholders', unit('%d item', { msgidPlural: '%d items in %d' }))).toBe(true)
  })
  it('leaves a plural form with no placeholder to plural-without-count', () => {
    expect(fires('plural-placeholders', unit('%d item', { msgidPlural: 'items' }))).toBe(false)
  })
  it('ignores entries with no plural', () => {
    expect(fires('plural-placeholders', unit('%d item'))).toBe(false)
  })
})

describe('plural-without-count', () => {
  it('fires on a plural form with no placeholder', () => {
    expect(fires('plural-without-count', unit('Item', { msgidPlural: 'Items' }))).toBe(true)
  })
  it('passes a counted plural and a plain string', () => {
    expect(fires('plural-without-count', unit('%d item', { msgidPlural: '%d items' }))).toBe(false)
    expect(fires('plural-without-count', unit('Item'))).toBe(false)
  })
})

describe('concatenation', () => {
  it('fires on whitespace at either edge', () => {
    expect(fires('concatenation', unit(' items'))).toBe(true)
    expect(fires('concatenation', unit('Items '))).toBe(true)
  })
  it('fires when the last word is a joining word, in any case', () => {
    expect(fires('concatenation', unit('Posted by'))).toBe(true)
    expect(fires('concatenation', unit('Read more of'))).toBe(true)
    expect(fires('concatenation', unit('Or'))).toBe(true)
  })
  it('fires on punctuation or symbols only', () => {
    expect(fires('concatenation', unit(':'))).toBe(true)
    expect(fires('concatenation', unit('—'))).toBe(true)
  })
  it('passes whole phrases and the empty string', () => {
    expect(fires('concatenation', unit('Select all'))).toBe(false)
    expect(fires('concatenation', unit('Hello world'))).toBe(false)
    expect(fires('concatenation', unit(''))).toBe(false)
  })
})

describe('ambiguous-word', () => {
  it('fires on a listed word with no context, in any case', () => {
    expect(fires('ambiguous-word', unit('Post'))).toBe(true)
    expect(fires('ambiguous-word', unit('schedule'))).toBe(true)
  })
  it('passes a listed word with a context, and other words', () => {
    expect(fires('ambiguous-word', unit('Post', { msgctxt: 'verb' }))).toBe(false)
    expect(fires('ambiguous-word', unit('Posts'))).toBe(false)
    expect(fires('ambiguous-word', unit('Save changes'))).toBe(false)
  })
})

describe('same-text-different-use', () => {
  it('fires on a short string used in two files with no context', () => {
    expect(fires('same-text-different-use', unit('Read more', { references: ['a.php:1', 'b.php:9'] }))).toBe(true)
  })
  it('passes one file, a context, four words, and an ambiguous-word string', () => {
    expect(fires('same-text-different-use', unit('Read more', { references: ['a.php:1', 'a.php:9'] }))).toBe(false)
    expect(fires('same-text-different-use', unit('Read more', { msgctxt: 'link', references: ['a.php:1', 'b.php:9'] }))).toBe(false)
    expect(fires('same-text-different-use', unit('Read more about this', { references: ['a.php:1', 'b.php:9'] }))).toBe(false)
    expect(fires('same-text-different-use', unit('Post', { references: ['a.php:1', 'b.php:9'] }))).toBe(false)
  })
})

describe('markup-in-string', () => {
  it('fires on HTML tags and URLs, in either form', () => {
    expect(fires('markup-in-string', unit('Click <a href="%s">here</a>'))).toBe(true)
    expect(fires('markup-in-string', unit('Line<br>break'))).toBe(true)
    expect(fires('markup-in-string', unit('See https://example.com'))).toBe(true)
    expect(fires('markup-in-string', unit('%d item', { msgidPlural: '<strong>%d</strong> items' }))).toBe(true)
  })
  it('passes comparison signs', () => {
    expect(fires('markup-in-string', unit('Use a < b'))).toBe(false)
    expect(fires('markup-in-string', unit('Value <= 5'))).toBe(false)
  })
})

describe('typography', () => {
  it('fires on three full stops and on a double space inside', () => {
    expect(fires('typography', unit('Loading...'))).toBe(true)
    expect(fires('typography', unit('Two  spaces'))).toBe(true)
  })
  it('passes the ellipsis character and leaves edge whitespace to concatenation', () => {
    expect(fires('typography', unit('Loading…'))).toBe(false)
    expect(fires('typography', unit('  leading'))).toBe(false)
  })
})

// Review finding I5: phrasal verbs, hyphenated words and toggle labels end on
// a joining word without being fragments.
describe('concatenation, ordinary UI phrases', () => {
  it('passes phrasal verbs, hyphenated words and one-word toggle labels', () => {
    for (const text of ['Log in', 'Sign in', 'Turn on', 'Logged in', 'Add-on', 'Opt-in', 'Built-in', 'On', 'In']) {
      expect(fires('concatenation', unit(text)), text).toBe(false)
    }
  })
  it('still fires on fragments', () => {
    for (const text of ['Posted by', 'Or', 'Read more of', 'Comments on']) {
      expect(fires('concatenation', unit(text)), text).toBe(true)
    }
  })
})

// m7: block plugins commit build/ beside src/, so one string has a reference
// in each without being used in two places.
describe('same-text-different-use and build output', () => {
  it('does not count a built copy as a second file', () => {
    expect(fires('same-text-different-use', unit('Read more', { references: ['src/edit.js:4', 'build/index.js:1'] }))).toBe(false)
  })
  it('still fires on two source files', () => {
    expect(fires('same-text-different-use', unit('Read more', { references: ['src/edit.js:4', 'src/save.js:2', 'build/index.js:1'] }))).toBe(true)
  })
})

// m8: a percent-encoded URL is not a placeholder, and the error it raised
// could not be silenced.
describe('placeholders inside URLs', () => {
  it('are not placeholders', () => {
    expect(printfPlaceholders('See https://example.com/a%20b%2Fc for more')).toEqual([])
    expect(fires('translators-comment', unit('See https://example.com/a%20b'))).toBe(false)
  })
  it('do not hide a real placeholder beside the URL', () => {
    expect(printfPlaceholders('%s, see https://example.com/a%20b')).toEqual(['%s'])
  })
})
