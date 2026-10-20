import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dateFormatProblems, isDateFormat, type DateTimeRules } from '../../src/audit/rules/date-format.js'

// Every PHP date format polyglots-data's analyzer found in the tr_TR and
// nl_NL memories (core and the locale projects), with what it found wrong.
// Approved translations all of them, so the quiet rows are the ones a check
// must not report, and the rest are mistakes that reached sites.
interface Row {
  path: string
  source: string
  context: string
  translation: string
  problems: string[]
}
const table = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'date-formats', 'formats.json'), 'utf8')) as Record<
  'tr_TR' | 'nl_NL',
  Row[]
>

// The values polyglots-data ships for the two locales.
const LOCALES: Record<'tr_TR' | 'nl_NL', DateTimeRules> = {
  tr_TR: { clock: '24h', order: 'dmy', formats: { 'F j, Y': 'j F Y', 'M j, Y': 'j M Y', 'M j': 'j M', 'n/j/Y': 'd.m.Y', 'g:i a': 'H:i' } },
  nl_NL: { clock: '24h', order: 'dmy', formats: { 'F j, Y': 'j F Y', 'M j, Y': 'j M Y', 'M j': 'j M', 'n/j/Y': 'd-m-Y', 'g:i a': 'G:i' } },
}

// What the analyzer reports that needs no locale knowledge: a broken format
// is broken in every language.
const UNIVERSAL = /^(not a format letter|lost the |12-hour time without am\/pm|space after a time colon)/
const rows = (Object.keys(table) as ('tr_TR' | 'nl_NL')[]).flatMap((locale) => table[locale].map((row) => ({ locale, ...row })))
const name = (r: (typeof rows)[number]) => `${r.locale} ${r.path} ${JSON.stringify(r.source)} -> ${JSON.stringify(r.translation)}`

describe('isDateFormat over the approved formats', () => {
  it.each(rows.map((r) => [name(r), r] as const))('recognises %s', (_, r) => {
    expect(isDateFormat(r.source, r.context)).toBe(true)
  })
})

describe('dateFormatProblems over the approved formats', () => {
  it.each(rows.map((r) => [name(r), r] as const))('agrees with the analyzer on %s, with the locale’s dateTime', (_, r) => {
    expect(dateFormatProblems(r.source, r.translation, LOCALES[r.locale]).length > 0).toBe(r.problems.length > 0)
  })

  it.each(rows.map((r) => [name(r), r] as const))('reports only the broken formats on %s, without a dateTime', (_, r) => {
    expect(dateFormatProblems(r.source, r.translation).length > 0).toBe(r.problems.some((p) => UNIVERSAL.test(p)))
  })
})

describe('isDateFormat', () => {
  it.each([
    ['N/A', ''],
    ['A-Z', ''],
    ['Date Format', 'date format'],
    ['Created %@', ''],
    ["e.g. '4M'", ''],
    ['Y', ''],
    ['F j, Y g:i a — and then some words that run on', ''],
  ])('leaves %j (context %j) alone', (source, context) => {
    expect(isDateFormat(source, context)).toBe(false)
  })

  // Found in review, not in the memories: PHP's ordinal suffix and am/pm
  // written against the time.
  it.each(['jS F Y', 'F jS, Y', 'l, F jS, Y h:i:s A', 'g:ia', 'Y-m-d\\TH:i:sP', 'y/m/d'])('takes %j', (source) => {
    expect(isDateFormat(source)).toBe(true)
  })

  // Every letter of these is a PHP letter, which is why adjacency is allowed
  // only for the pairs a format writes.
  it.each(['Hide all', 'M-F', 'M - F', 'S M T W T F S', 'y/n', 'Y/N', 'm/s'])('leaves the label %j alone', (source) => {
    expect(isDateFormat(source)).toBe(false)
  })

  it('takes a single letter when the context names a date format', () => {
    expect(isDateFormat('Y', 'yearly archives date format')).toBe(true)
    expect(isDateFormat('g a', 'time-format')).toBe(true)
  })

  it('reads core’s no-break space as a space', () => {
    expect(isDateFormat('F j, Y g:i a')).toBe(true)
  })

  it('skips escaped letters', () => {
    expect(isDateFormat('j F Y \\a\\t G:i')).toBe(true)
  })
})

describe('dateFormatProblems', () => {
  const only = (source: string, translation: string, rules?: DateTimeRules) =>
    dateFormatProblems(source, translation, rules).map((p) => [p.severity, p.message])

  it('reports a letter PHP does not know as an error', () => {
    expect(only('Y', 'J')).toContainEqual(['error', expect.stringContaining('"J"')])
  })

  it('reports a lost year, month, day, hour or minute as an error', () => {
    expect(only('d.m.Y', 'd.m')).toEqual([['error', expect.stringContaining('year')]])
    expect(only('G:i', 'G')).toEqual([['error', expect.stringContaining('minute')]])
  })

  // The analyzer's minute archives: "i" for "l" prints the weekday.
  it('reports a minute turned into a weekday', () => {
    expect(only('i', 'l').map(([s]) => s)).toContain('error')
  })

  it('reports 12-hour time without am or pm as an error', () => {
    expect(only('g:i a', 'g:i')).toEqual([['error', expect.stringContaining('am')]])
  })

  it('reports a space added after a time colon as an error', () => {
    expect(only('Y-m-d G:i:s', 'Y-m-d G: i: s')).toEqual([['error', expect.stringContaining('colon')]])
  })

  // Sometimes deliberate: a short date drops the weekday on purpose.
  it('reports a lost second or weekday as a suspicion', () => {
    expect(only('G:i:s', 'G:i')).toEqual([['suspect', expect.stringContaining('second')]])
    expect(only('l, F j, Y', 'j F Y')).toEqual([['suspect', expect.stringContaining('weekday')]])
  })

  it('names a word left unescaped, not only its unknown letter', () => {
    expect(only('j F Y', 'j F Y yılı')).toContainEqual(['error', expect.stringContaining('"yılı"')])
  })

  it('takes escaped text as text', () => {
    expect(only('j F Y \\a\\t G:i', 'j F Y \\o\\m G:i')).toEqual([])
  })

  describe('with a dateTime section', () => {
    const tr: DateTimeRules = LOCALES.tr_TR

    it('suggests 24-hour time', () => {
      expect(only('Y/m/d g:i:s A', 'Y/m/d g:i:s A', tr)).toEqual([['suspect', expect.stringContaining('24-hour')]])
    })

    it('suggests the day before the month', () => {
      expect(only('M j, Y @ G:i', 'M j, Y @ G:i', tr)).toEqual([['suspect', expect.stringContaining('day before the month')]])
    })

    it('never reports a year-first date', () => {
      expect(only('Y-M-d', 'Y-m-d', tr)).toEqual([])
    })

    it('names the locale’s wording for a copied format it lists', () => {
      expect(only('F j, Y', 'F j, Y', tr)).toEqual([['suspect', expect.stringContaining('"j F Y"')]])
    })

    it('matches a listed format written with core’s no-break space', () => {
      expect(only('g:i a', 'g:i a', tr)).toEqual([['suspect', expect.stringContaining('"H:i"')]])
    })

    it('leaves a translation that is the locale’s own wording alone', () => {
      expect(only('F j, Y', 'j F Y', tr)).toEqual([])
      expect(only('F j, Y', 'd.m.Y', tr)).toEqual([])
    })

    it('reads the order for a month-first locale', () => {
      expect(only('F j, Y', 'j F Y', { order: 'mdy' })).toEqual([['suspect', expect.stringContaining('month before the day')]])
      expect(only('j F Y', 'F j, Y', { order: 'mdy' })).toEqual([])
    })

    it('reads the order for a year-first locale', () => {
      expect(only('F j, Y', 'j F Y', { order: 'ymd' })).toEqual([['suspect', expect.stringContaining('year first')]])
      expect(only('F j, Y', 'Y. F j.', { order: 'ymd' })).toEqual([])
    })

    // Core writes U+00A0 before am and pm, and a 12-hour locale may list
    // that format as its own.
    it('stays quiet on a listed format that is the source itself', () => {
      expect(only('g:i\u00a0a', 'g:i\u00a0a', { formats: { 'g:i a': 'g:i\u00a0a' } })).toEqual([])
    })

    it('says nothing about a 12-hour locale’s am and pm', () => {
      expect(only('g:i a', 'g:i a', { clock: '12h' })).toEqual([])
    })
  })
})
