import { describe, expect, it } from 'vitest'
import { createModel, setCell, addRow, type EditorModel } from '../../../src/glossary/editor/model.js'
import {
  DEFAULT_SETTINGS, collatorFor, nextHeaderSort, readSettings, sortRows, textMatches,
} from '../../../src/glossary/editor/settings.js'
import type { EffectiveRow } from '../../../src/glossary/types.js'

const eff = (term: string, translation: string, pos = 'noun', origin: EffectiveRow['origin'] = 'wporg'): EffectiveRow => ({
  term, pos, translation, notes: '', origin,
})

const terms = (m: EditorModel, key: Parameters<typeof sortRows>[1], locale = 'tr') =>
  sortRows(m.rows, key, collatorFor(locale)).map((r) => r.term)

describe('readSettings', () => {
  it('fills every missing or unusable key from the defaults, keeping the usable ones', () => {
    expect(readSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(readSettings('nonsense')).toEqual(DEFAULT_SETTINGS)
    const read = readSettings({ sort: 'translation-desc', density: 'loud', wrap: false, columns: { notes: false, pos: 'no' }, extra: 1 })
    expect(read).toEqual({ ...DEFAULT_SETTINGS, sort: 'translation-desc', wrap: false, columns: { pos: true, notes: false } })
  })

  it('returns a value with no keys beyond its own, so storing it does not carry junk forward', () => {
    expect(Object.keys(readSettings({ junk: true })).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
  })
})

describe('sortRows', () => {
  const m = createModel([eff('şablon', 'kalıp'), eff('Course', 'kurs'), eff('çerez', ''), eff('ılık', 'ılık', 'adjective'), eff('item 10', 'öğe'), eff('item 9', 'Öğe')], 'csv')

  it('keeps the file order for file, and does not reorder the rows it was given', () => {
    expect(terms(m, 'file')).toEqual(['şablon', 'Course', 'çerez', 'ılık', 'item 10', 'item 9'])
    expect(m.rows.map((r) => r.term)[0]).toBe('şablon')
  })

  it('sorts the term with the locale\'s alphabet, ignoring case, numbers by value', () => {
    expect(terms(m, 'term-asc')).toEqual(['Course', 'çerez', 'ılık', 'item 9', 'item 10', 'şablon'])
    expect(terms(m, 'term-desc')).toEqual(['şablon', 'item 10', 'item 9', 'ılık', 'çerez', 'Course'])
  })

  it('puts an empty translation last in both directions', () => {
    expect(terms(m, 'translation-asc').at(-1)).toBe('çerez')
    expect(terms(m, 'translation-desc').at(-1)).toBe('çerez')
    expect(terms(m, 'translation-asc')[0]).toBe('ılık')
  })

  it('sorts by part of speech, then term', () => {
    expect(terms(m, 'pos')[0]).toBe('ılık')
  })

  it('puts the changed, added and locally edited rows first, in file order', () => {
    const c = createModel([eff('a', 'x'), eff('b', 'y', 'noun', 'changed'), eff('c', 'z')], 'db')
    setCell(c, 3, 'translation', 'w')
    addRow(c, 1)
    expect(sortRows(c.rows, 'changed', collatorFor('tr')).map((r) => r.term)).toEqual(['', 'b', 'c', 'a'])
  })

  it('falls back to a plain collator for a locale Intl does not know', () => {
    expect(() => collatorFor('not a locale!')).not.toThrow()
    expect(() => collatorFor('pt/ao90')).not.toThrow()
  })
})

describe('nextHeaderSort', () => {
  it('cycles a column ascending, descending, then back to the file order', () => {
    expect(nextHeaderSort('file', 'term')).toBe('term-asc')
    expect(nextHeaderSort('term-asc', 'term')).toBe('term-desc')
    expect(nextHeaderSort('term-desc', 'term')).toBe('file')
    expect(nextHeaderSort('term-desc', 'translation')).toBe('translation-asc')
    expect(nextHeaderSort('changed', 'translation')).toBe('translation-asc')
  })
})

describe('textMatches', () => {
  it('finds a substring, ignoring case', () => {
    expect(textMatches('Post type', 'post', false)).toBe(true)
    expect(textMatches('Repost', 'post', false)).toBe(true)
  })

  it('finds only whole words when asked, with letters outside ASCII counted as letters', () => {
    expect(textMatches('Repost', 'post', true)).toBe(false)
    expect(textMatches('a post, then', 'post', true)).toBe(true)
    expect(textMatches('yazıç', 'yazı', true)).toBe(false)
    expect(textMatches('yazı türü', 'yazı', true)).toBe(true)
    expect(textMatches('post post', 'post post', true)).toBe(true)
  })
})
