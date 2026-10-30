import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  GLOSSARY_POS,
  GlossaryCsvError,
  csvRecords,
  entryToRow,
  formatGlossaryCsv,
  normaliseGlossaryValue,
  readGlossaryCsv,
  rowToEntry,
  type GlossaryRow,
} from '../../src/glossary/csv.js'
import { parseGlossaryCsv } from '../../src/wporg/glossary.js'

const fixture = readFileSync(
  fileURLToPath(new URL('../fixtures/wporg/glossary-export.csv', import.meta.url)),
  'utf8',
)

describe('readGlossaryCsv', () => {
  const { headerLocale, rows } = readGlossaryCsv(fixture)

  it('accepts a BOM and reports the locale column name', () => {
    expect(fixture.charCodeAt(0)).toBe(0xfeff)
    expect(headerLocale).toBe('tr')
  })

  it('keeps every row, including one with an empty translation', () => {
    expect(rows).toHaveLength(8)
    expect(rows[3]).toEqual({ term: 'draft', pos: 'noun', translation: '', notes: 'Not translated yet' })
  })

  it('keeps quoted commas, doubled quotes, line breaks and dotless i as written', () => {
    expect(rows[1]?.notes).toBe('Visual look, set by a theme')
    expect(rows[2]?.notes).toBe('Use "Save" for buttons')
    expect(rows[4]?.notes).toBe('Dotless ı and İstanbul')
    expect(rows[6]?.notes).toBe('Line one\nline two')
  })

  it('does not normalise values', () => {
    const r = readGlossaryCsv('en,tr,pos,description\n"  a   b ",x,,\n').rows
    expect(r[0]?.term).toBe('  a   b ')
  })

  it('throws when the first header cell is not en', () => {
    expect(() => readGlossaryCsv('term,translation\na,b\n')).toThrow(GlossaryCsvError)
    expect(() => readGlossaryCsv('')).toThrow(GlossaryCsvError)
  })
})

describe('formatGlossaryCsv', () => {
  const rows: GlossaryRow[] = [
    { term: 'a, b', pos: 'noun', translation: 'say "x"', notes: 'one\ntwo' },
    { term: 'ı İ', pos: '', translation: '', notes: '' },
  ]

  it('starts with the header and ends lines with LF, no BOM', () => {
    const out = formatGlossaryCsv(rows, 'tr')
    expect(out.startsWith('en,tr,pos,description\n')).toBe(true)
    expect(out.charCodeAt(0)).not.toBe(0xfeff)
    expect(out.endsWith('\n')).toBe(true)
  })

  it('quotes a field only when it needs it', () => {
    const out = formatGlossaryCsv(rows, 'tr')
    expect(out).toContain('"a, b","say ""x""",noun,"one\ntwo"')
    expect(out).toContain('ı İ,,,\n')
  })

  it('round trips', () => {
    expect(readGlossaryCsv(formatGlossaryCsv(rows, 'tr')).rows).toEqual(rows)
  })

  it('feeds parseGlossaryCsv the same entries as the original export', () => {
    const { headerLocale, rows: all } = readGlossaryCsv(fixture)
    expect(parseGlossaryCsv(formatGlossaryCsv(all, headerLocale), 'tr')).toEqual(parseGlossaryCsv(fixture, 'tr'))
  })
})

describe('row and entry conversion', () => {
  it('maps a row to an entry, omitting empty optional fields', () => {
    expect(rowToEntry({ term: 'a', pos: '', translation: 'b', notes: '' }, 'tr')).toEqual({
      locale: 'tr',
      sourceTerm: 'a',
      translation: 'b',
    })
    expect(rowToEntry({ term: 'a', pos: 'noun', translation: 'b', notes: 'n' }, 'tr')).toEqual({
      locale: 'tr',
      sourceTerm: 'a',
      translation: 'b',
      partOfSpeech: 'noun',
      notes: 'n',
    })
  })

  it('maps an entry back to a row', () => {
    expect(entryToRow({ locale: 'tr', sourceTerm: 'a', translation: 'b' })).toEqual({
      term: 'a',
      pos: '',
      translation: 'b',
      notes: '',
    })
  })
})

describe('helpers', () => {
  it('lists parts of speech in order', () => {
    expect(GLOSSARY_POS[0]).toBe('noun')
    expect(GLOSSARY_POS[9]).toBe('abbreviation')
    expect(GLOSSARY_POS).toHaveLength(10)
  })
  it('collapses whitespace', () => {
    expect(normaliseGlossaryValue('  a \n b ')).toBe('a b')
  })
  it('splits records', () => {
    expect(csvRecords('a,b\r\nc,"d\ne"')).toEqual([['a', 'b'], ['c', 'd\ne']])
  })
})
