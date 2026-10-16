import { afterEach, describe, expect, it } from 'vitest'
import { resetSandbox, runRegexOps, skippedFor, takeSkipped } from '../../src/rules/sandbox.js'

afterEach(() => resetSandbox())

const CATASTROPHIC = { kind: 'exec', id: 'bad', source: '^(a+)+$', flags: 'u', text: 'a'.repeat(30) + 'b' } as const

describe('sandbox', () => {
  it('matches like an in-thread regex', () => {
    const [r] = runRegexOps([{ kind: 'exec', id: 'p1', source: 'a(b)c', flags: 'gu', text: 'xabcx' }])
    expect(r).toEqual({ id: 'p1', match: 'abc' })
  })
  it('replaces with capture references', () => {
    const [r] = runRegexOps([{ kind: 'replace', id: 'p2', source: '([Yy])ada', flags: 'gu', text: 'Yada bu', replacement: '$1a da' }])
    expect(r?.text).toBe('Ya da bu')
  })
  it('skips a catastrophic pattern after the budget and keeps going', () => {
    const t0 = Date.now()
    const out = runRegexOps([
      CATASTROPHIC,
      { kind: 'exec', id: 'ok', source: 'b', flags: 'u', text: 'ab' },
    ])
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(out.find((r) => r.id === 'bad')).toBeUndefined()
    expect(out.find((r) => r.id === 'ok')?.match).toBe('b')
    expect(takeSkipped().map((s) => s.id)).toEqual(['bad'])
  })
  it('never runs a skipped pattern again in the process', () => {
    runRegexOps([CATASTROPHIC])
    const t0 = Date.now()
    runRegexOps([CATASTROPHIC])
    expect(Date.now() - t0).toBeLessThan(50)
  })

  // Beyond the brief's four cases.
  it('keeps the results of the ops before and after a hung one', () => {
    const out = runRegexOps([
      { kind: 'exec', id: 'before', source: 'x', flags: 'u', text: 'axb' },
      CATASTROPHIC,
      { kind: 'replace', id: 'after', source: 'b', flags: 'gu', text: 'abab', replacement: 'c' },
    ])
    expect(out).toEqual([
      { id: 'before', match: 'x' },
      { id: 'after', text: 'acac' },
    ])
  })
  it('reports a null match rather than no result', () => {
    expect(runRegexOps([{ kind: 'exec', id: 'none', source: 'z', flags: 'u', text: 'abc' }])).toEqual([{ id: 'none', match: null }])
  })
  it('matches a normalised op on NFC text and source', () => {
    // é typed decomposed in the text, precomposed in the pattern.
    const [r] = runRegexOps([{ kind: 'exec', id: 'n', source: 'é', flags: 'u', text: 'café', normalise: true }])
    expect(r?.match).toBe('é')
  })
  it('keeps the capital of what a literal replaced, in the locale casing', () => {
    const [r] = runRegexOps([
      { kind: 'replace', id: 'cap', source: '(?:i|İ)ptal', flags: 'gu', text: 'İptal et', replacement: 'iptal', capitaliseTag: 'tr' },
    ])
    expect(r?.text).toBe('İptal et')
  })
  it('names each skipped pattern by its label, once per take', () => {
    runRegexOps([CATASTROPHIC], () => 'the bad one')
    expect(skippedFor('bad')).toBe(true)
    expect(takeSkipped()).toEqual([{ id: 'bad', label: 'the bad one' }])
    expect(takeSkipped()).toEqual([])
  })
  it('names a pattern skipped earlier in the process again for the next run that asks for it', () => {
    runRegexOps([CATASTROPHIC], () => 'the bad one')
    takeSkipped()
    runRegexOps([CATASTROPHIC, CATASTROPHIC], () => 'the bad one')
    expect(takeSkipped()).toEqual([{ id: 'bad', label: 'the bad one' }])
  })
  it('does not blame the first op on a worker still starting', () => {
    // A fresh worker takes tens of milliseconds to load, longer on a loaded
    // machine; that wait must not count against the pattern it starts with.
    for (let i = 0; i < 3; i++) {
      resetSandbox()
      expect(runRegexOps([{ kind: 'exec', id: 'first', source: 'a', flags: 'u', text: 'a' }])).toEqual([{ id: 'first', match: 'a' }])
      expect(takeSkipped()).toEqual([])
    }
  })
})
