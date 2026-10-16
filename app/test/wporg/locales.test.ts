import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM script without types
import { parseStats } from '../../scripts/update-locales.mjs'
import {
  WPORG_LOCALES,
  intlTag,
  languageOf,
  localeFileTag,
  localeOfWpCode,
  resolveLocale,
  splitLocale,
  suggestLocales,
  wpCodeOf,
} from '../../src/wporg/locales.js'

const stats = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'wporg', 'stats-page.html'), 'utf8')

describe('parseStats', () => {
  it('reads each WordPress code with its slug and set, once each, sorted', () => {
    expect(parseStats(stats)).toEqual([
      { wp: 'az_TR', slug: 'az-tr', set: 'default' },
      { wp: 'ca_valencia', slug: 'ca-val', set: 'default' },
      { wp: 'nl_BE', slug: 'nl-be', set: 'default' },
      { wp: 'nl_NL', slug: 'nl', set: 'default' },
      { wp: 'nl_NL_formal', slug: 'nl', set: 'formal' },
      { wp: 'pt_PT_ao90', slug: 'pt', set: 'ao90' },
      { wp: 'tr_TR', slug: 'tr', set: 'default' },
    ])
  })

  // The slug and set are written between single quotes into a TypeScript
  // source file, so a quote in either would break it or add code to it.
  it('skips a row whose slug or set is not a plain slug', () => {
    const row = (slug: string, set: string, wp: string) => `<tr><td><a href="/locale/${slug}/${set}/">${wp}</a></td></tr>`
    const html = [row("tr'x", 'default', 'tr_TR'), row('nl', "formal'+x", 'nl_NL'), row('de', 'default', 'de_DE')].join('')
    expect(parseStats(html)).toEqual([{ wp: 'de_DE', slug: 'de', set: 'default' }])
  })
})

describe('the shipped table', () => {
  it('has the locales translate.wordpress.org lists, variants included', () => {
    expect(WPORG_LOCALES.length).toBeGreaterThan(150)
    expect(WPORG_LOCALES).toContainEqual({ wp: 'nl_NL_formal', slug: 'nl', set: 'formal' })
    expect(WPORG_LOCALES).toContainEqual({ wp: 'tr_TR', slug: 'tr', set: 'default' })
  })
})

describe('resolveLocale', () => {
  // What translators type, every spelling of it.
  it.each([
    ['nl_NL', 'nl'],
    ['nl', 'nl'],
    ['NL', 'nl'],
    ['nl_BE', 'nl-be'],
    ['nl-be', 'nl-be'],
    ['nl_NL_formal', 'nl/formal'],
    ['nl/formal', 'nl/formal'],
    ['nl-NL-formal', 'nl/formal'],
    ['pt_PT_ao90', 'pt/ao90'],
    ['ca_valencia', 'ca-val'],
    ['tr_TR', 'tr'],
    ['az_TR', 'az-tr'],
    ['de_CH_informal', 'de-ch/informal'],
  ])('reads %s as %s', (input, id) => {
    expect(resolveLocale(input)?.id).toBe(id)
  })

  it('knows nothing it was not told', () => {
    expect(resolveLocale('xx_YY')).toBeUndefined()
    expect(resolveLocale('nl/nonsense')).toBeUndefined()
    expect(resolveLocale('')).toBeUndefined()
  })
})

describe('locale parts', () => {
  it('splits an id into slug and set', () => {
    expect(splitLocale('nl/formal')).toEqual({ slug: 'nl', set: 'formal' })
    expect(splitLocale('tr')).toEqual({ slug: 'tr', set: 'default' })
  })

  it('finds the language a profile is chosen by', () => {
    expect(languageOf('nl/formal')).toBe('nl')
    expect(languageOf('pt-br')).toBe('pt')
    expect(languageOf('tr')).toBe('tr')
  })

  // nl/formal is not a language tag; toLocaleLowerCase and Intl throw on it.
  it('gives case conversion and Intl a tag they accept', () => {
    expect(intlTag('nl/formal')).toBe('nl')
    expect(intlTag('pt-br')).toBe('pt-br')
    expect(() => 'İ'.toLocaleLowerCase(intlTag('ca-val'))).not.toThrow()
    expect(() => 'I'.toLocaleLowerCase(intlTag('art-xemoji'))).not.toThrow()
    expect('I'.toLocaleLowerCase(intlTag('tr'))).toBe('ı')
  })

  it('names a file part without a slash', () => {
    expect(localeFileTag('nl/formal')).toBe('nl-formal')
    expect(localeFileTag('nl-be')).toBe('nl-be')
  })

  it('finds the WordPress code of an id', () => {
    expect(wpCodeOf('nl/formal')).toBe('nl_NL_formal')
    expect(wpCodeOf('tr')).toBe('tr_TR')
    expect(wpCodeOf('zz')).toBeUndefined()
  })

  // The reverse, for a WordPress code someone else wrote down: only a code,
  // never a slug, since a manifest that puts a slug where the code belongs
  // is wrong and must not be read as agreeing with itself.
  it('maps a WordPress code back to the locale id', () => {
    expect(localeOfWpCode('nl_NL_formal')).toBe('nl/formal')
    expect(localeOfWpCode('tr_TR')).toBe('tr')
    expect(localeOfWpCode('az')).toBe('az')
    expect(localeOfWpCode('tr')).toBeUndefined()
    expect(localeOfWpCode('xx_YY')).toBeUndefined()
  })
})

describe('suggestLocales', () => {
  it('offers the codes of the language that was typed', () => {
    expect(suggestLocales('de_XX')).toContain('de_DE')
  })

  // A typo in the language itself shares no prefix with anything, and a
  // refusal that suggests nothing leaves the person guessing.
  it('falls back to the nearest spelling when no language matches', () => {
    expect(suggestLocales('trr')[0]).toBe('tr_TR')
    expect(suggestLocales('tr_TRR')).toContain('tr_TR')
  })

  it('suggests nothing for input nowhere near a locale', () => {
    expect(suggestLocales('zzzzzzzz')).toEqual([])
  })
})
