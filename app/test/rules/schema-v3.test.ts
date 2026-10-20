import { describe, expect, it } from 'vitest'
import { parseLocaleRules, RulesFileError, rulesFingerprint } from '../../src/rules/load.js'

const parse = (text: string) => parseLocaleRules(text, '/x/tr_TR.yaml')
const error = (text: string) => {
  try { parse(text) } catch (e) { return e as RulesFileError }
  throw new Error('expected a RulesFileError')
}

const TR = `schema: 3
dateTime:
  clock: 24h
  order: dmy
  formats:
    'F j, Y': 'j F Y'
    'M j, Y': 'j M Y'
    'M j': 'j M'
    'n/j/Y': 'd.m.Y'
    'g:i a': 'H:i'
`

describe('schema 3', () => {
  it('accepts schema 3', () => expect(parse('schema: 3\nguidance: x').schema).toBe(3))

  it('reads the dateTime polyglots-data ships for tr_TR', () => {
    expect(parse(TR).dateTime).toEqual({
      clock: '24h',
      order: 'dmy',
      formats: { 'F j, Y': 'j F Y', 'M j, Y': 'j M Y', 'M j': 'j M', 'n/j/Y': 'd.m.Y', 'g:i a': 'H:i' },
    })
  })

  it.each(['schema: 2\n', ''])('refuses dateTime under %j', (head) => {
    expect(error(`${head}dateTime: { clock: 24h }`).message).toContain('needs schema: 3 at the top of the file')
  })

  // A new rule name is a schema change too: an older polyglots rejects it
  // as an unknown rule rather than saying the file is too new.
  it.each(['enable', 'disable'])('needs schema 3 to name date-format in rules.%s', (list) => {
    expect(error(`schema: 2\nrules: { ${list}: [date-format] }`).message).toContain('needs schema: 3 at the top of the file')
    expect(parse(`schema: 3\nrules: { ${list}: [date-format] }`).rules?.[list as 'enable']).toEqual(['date-format'])
  })

  it('still reads a schema 2 file', () => expect(parse('schema: 2\nformality: formal').formality).toBe('formal'))

  it.each(['clock: 12', 'order: dym', 'bogus: 1'])('refuses dateTime with %s', (line) => {
    expect(() => parse(`schema: 3\ndateTime: { ${line} }`)).toThrow(RulesFileError)
  })

  // Core writes U+00A0 before am and pm; a key is matched as an ordinary space.
  it('stores a no-break space in a formats key as a space', () => {
    expect(parse("schema: 3\ndateTime:\n  formats:\n    \"g:i\\u00a0a\": 'H:i'\n").dateTime?.formats).toEqual({ 'g:i a': 'H:i' })
  })

  it('refuses two formats keys that are one key once normalised', () => {
    expect(error("schema: 3\ndateTime:\n  formats:\n    'g:i a': 'H:i'\n    \"g:i\\u00a0a\": 'G:i'\n").message).toContain('twice')
  })

  it('refuses a formats key that is not a date format', () => {
    expect(error("schema: 3\ndateTime:\n  formats:\n    'Date': 'Tarih'\n").message).toMatch(/formats.*not a PHP date format/)
  })

  it('refuses a suggested format the date-format rule would report', () => {
    expect(error("schema: 3\ndateTime:\n  formats:\n    'F j, Y': 'j F J'\n").message).toContain('"J"')
    expect(error("schema: 3\ndateTime:\n  formats:\n    'F j, Y': 'F Y'\n").message).toContain('day')
  })

  it('refuses a suggested format that contradicts the file’s clock or order', () => {
    expect(error("schema: 3\ndateTime:\n  clock: 24h\n  formats:\n    'g:i a': 'g:i a'\n").message).toContain('24-hour')
    expect(error("schema: 3\ndateTime:\n  order: dmy\n  formats:\n    'F j, Y': 'F j, Y'\n").message).toContain('day before the month')
  })

  // As sentenceEnd and register: a section that says nothing is no section.
  it('reads a dateTime that sets nothing as left out', () => {
    expect(parse('schema: 3\ndateTime: {}').dateTime).toBeUndefined()
    expect(parse('schema: 3\ndateTime: { formats: {} }').dateTime).toBeUndefined()
    expect(rulesFingerprint(parse('schema: 3\ndateTime: {}'))).toBe('')
  })

  it('moves the fingerprint with the dateTime', () => {
    expect(rulesFingerprint(parse(TR))).not.toBe('')
    expect(rulesFingerprint(parse(TR))).not.toBe(rulesFingerprint(parse(TR.replace("'H:i'", "'G:i'"))))
  })
})
