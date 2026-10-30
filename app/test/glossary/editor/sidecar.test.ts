import { describe, expect, it } from 'vitest'
import { readSidecar, sidecarKey } from '../../../src/glossary/editor/sidecar.js'

const rec = (en: string, pos: string, extra: object = {}) => ({
  en, pos, proposed: 'x', confidence: 'settled', occurrences: { 'a.po': 2 },
  currentRenderings: [{ text: 'y', count: 1 }], glossary: [{ tr: 'z', pos: 'noun', description: '' }],
  otherPlugins: [{ project: 'p', tr: 'q' }], tm: [{ en: 'e', tr: 't' }], examples: ['ex'], reason: 'r', ...extra,
})

describe('sidecarKey', () => {
  it('lowercases en and joins with NUL', () => {
    expect(sidecarKey('Quiz', 'noun')).toBe('quiz\u0000noun')
  })
})

describe('readSidecar', () => {
  it('reads version 1 records by key, whatever the row order', () => {
    const r = readSidecar({ version: 1, rows: [rec('Post', 'verb'), rec('post', 'noun', { proposed: 'yazı' })] })
    if ('error' in r) throw new Error(r.error)
    expect(r.records.size).toBe(2)
    expect(r.records.get(sidecarKey('POST', 'noun'))!.proposed).toBe('yazı')
    expect(r.records.get(sidecarKey('post', 'verb'))!.en).toBe('Post')
    expect(r.records.get(sidecarKey('post', 'verb'))!.tm).toEqual([{ en: 'e', tr: 't' }])
  })

  it('fills missing optional fields with empty values', () => {
    const r = readSidecar({ version: 1, rows: [{ en: 'a', pos: 'noun' }] })
    if ('error' in r) throw new Error(r.error)
    const x = r.records.get(sidecarKey('a', 'noun'))!
    expect(x).toMatchObject({ proposed: '', confidence: 'settled', examples: [], tm: [], reason: '' })
  })

  it('returns an error for an unknown version', () => {
    expect(readSidecar({ version: 2, rows: [] })).toEqual({ error: expect.stringContaining('version') })
  })

  it('returns an error for something that is not a sidecar', () => {
    expect('error' in readSidecar(null)).toBe(true)
    expect('error' in readSidecar({ version: 1 })).toBe(true)
    expect('error' in readSidecar('x')).toBe(true)
  })
})
