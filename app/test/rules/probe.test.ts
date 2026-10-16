import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseLocaleRules, RulesFileError } from '../../src/rules/load.js'
import { resetSandbox } from '../../src/rules/sandbox.js'

// rules check (and so rules fetch) runs every regex once over a fixed set of
// strings that make a runaway pattern run away, so a team learns of one
// before it is published rather than from a contributor's review.
afterEach(() => resetSandbox())

const thrown = (fn: () => unknown): RulesFileError => {
  try {
    fn()
  } catch (err) {
    if (err instanceof RulesFileError) return err
    throw err
  }
  throw new Error('did not throw')
}

describe('parseLocaleRules with probe', () => {
  it('refuses a find pattern that runs away on a test string, on its line', () => {
    const text = "schema: 1\npatterns:\n  - find: 'x'\n    level: hint\n  - find: '^(a+)+$'\n    level: hint\n"
    const err = thrown(() => parseLocaleRules(text, 'r.yaml', { probe: true }))
    expect(err.reason).toBe('patterns.1.find took longer than 100 ms on a test string (a regex that can run away)')
    expect(err.line).toBe(5)
  })

  it('refuses a runaway sentenceEnd regex', () => {
    const text = "schema: 2\nsentenceEnd:\n  answers:\n    - text: '(a|a)+!$'\n"
    const err = thrown(() => parseLocaleRules(text, 'r.yaml', { probe: true }))
    expect(err.reason).toBe('sentenceEnd.answers.0.text took longer than 100 ms on a test string (a regex that can run away)')
    expect(err.line).toBe(4)
  })

  it('does not probe unless asked: loading a file for a review never pays for it', () => {
    const text = "schema: 1\npatterns:\n  - find: '^(a+)+$'\n    level: hint\n"
    expect(parseLocaleRules(text, 'r.yaml').patterns).toHaveLength(1)
  })

  it('passes the shipped fixtures', () => {
    for (const name of ['tr_TR.yaml', 'sv_SE.yaml', 'el.yaml', 'bo.yaml', 'dzo.yaml', 'th.yaml', 'tr-grammar-patterns.yaml']) {
      const path = fileURLToPath(new URL(`../fixtures/locale/${name}`, import.meta.url))
      expect(() => parseLocaleRules(readFileSync(path, 'utf8'), path, { probe: true })).not.toThrow()
    }
  })
})
