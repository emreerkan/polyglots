import { describe, expect, it } from 'vitest'
import { parseLocaleRules, RulesFileError, rulesFingerprint } from '../../src/rules/load.js'

const parse = (text: string) => parseLocaleRules(text, '/x/tr_TR.yaml')
const error = (text: string) => {
  try { parse(text) } catch (e) { return e as RulesFileError }
  throw new Error('expected a RulesFileError')
}

describe('schema', () => {
  it('reads an absent schema as 1', () => expect(parse('guidance: x').schema).toBe(1))
  it('accepts schema 2', () => expect(parse('schema: 2\nguidance: x').schema).toBe(2))
  it('refuses a higher schema before anything else, on its line', () => {
    const e = error('guidance: 5\nschema: 3\nbogus: true')
    expect(e.message).toContain('needs rules schema 3; this polyglots reads up to 2. Update polyglots.')
    expect(e.line).toBe(2)
  })
  it.each(['0', '1.5', '"2"', '-1'])('refuses schema %s', (v) => {
    expect(error(`schema: ${v}`).message).toContain('schema must be a whole number from 1 to 2')
  })
  it.each(['capitalization: x', "register: x", 'formality: formal', 'sentenceEnd: { unmarked: true }'])(
    'refuses %s without schema: 2',
    (line) => {
      expect(error(line).message).toContain('needs schema: 2 at the top of the file')
      expect(error(`schema: 1\n${line}`).line).toBe(2)
    },
  )
})

describe('schema 2 keys', () => {
  it('renders | and |- capitalization the same', () => {
    const a = parse('schema: 2\ncapitalization: |\n  - line one\n')
    const b = parse('schema: 2\ncapitalization: |-\n  - line one\n')
    expect(a.capitalization).toBe('- line one\n')
    expect(b.capitalization).toBe('- line one\n')
  })
  it('limits capitalization to 2500 characters', () => {
    expect(error(`schema: 2\ncapitalization: '${'x'.repeat(2501)}'`).message).toContain('longer than 2500')
  })
  // A blank line is not an absent one: it would replace the default register
  // line with nothing and move the fingerprint, with nothing said.
  it.each([
    ["register: '   '", 'register is empty'],
    ["register: { audit: '  ' }", 'register.audit is empty'],
    ["capitalization: \"  \\n\"", 'capitalization is empty'],
  ])('refuses a blank %s', (line, message) => {
    expect(error(`schema: 2\n${line}`).message).toContain(message)
  })
  it('takes register as one string for both prompts', () => {
    expect(parse('schema: 2\nregister: "- du"').register).toEqual({ audit: '- du', translate: '- du' })
  })
  it('takes register as an object, one side allowed', () => {
    expect(parse('schema: 2\nregister: { audit: "- a" }').register).toEqual({ audit: '- a' })
  })
  it('limits each register side to 500 characters', () => {
    expect(error(`schema: 2\nregister: { translate: '${'x'.repeat(501)}' }`).message).toContain('longer than 500')
  })
  it('accepts formal and informal only', () => {
    expect(parse('schema: 2\nformality: informal').formality).toBe('informal')
    expect(error('schema: 2\nformality: casual').message).toContain('formality')
  })
  it('validates sentenceEnd regexes', () => {
    const ok = parse("schema: 2\nsentenceEnd:\n  answers:\n    - { text: '[;\\u037E]\\s*$', source: '\\?\\s*$' }\n  notEnding: '\\p{Script=Thai}\\.$'\n  unmarked: true")
    expect(ok.sentenceEnd?.answers?.[0]?.source).toBe('\\?\\s*$')
    expect(error("schema: 2\nsentenceEnd: { notEnding: '(' }").message).toContain('is not a valid regular expression')
  })
  it('does not fingerprint the schema number', () => {
    expect(rulesFingerprint(parse('guidance: x'))).toBe(rulesFingerprint(parse('schema: 2\nguidance: x')))
  })
  // An empty object sets nothing, so it must not count as set: a file that
  // changes nothing would otherwise move configHash and re-review a locale.
  it.each(['register: {}', 'sentenceEnd: {}', 'sentenceEnd: { answers: [] }'])('reads %s as absent', (line) => {
    const rules = parse(`schema: 2\n${line}`)
    expect(rules).not.toHaveProperty('register')
    expect(rules).not.toHaveProperty('sentenceEnd')
    expect(rulesFingerprint(rules)).toBe('')
  })
  it('treats a file with only a schema-2 key as not empty', () => {
    expect(rulesFingerprint(parse('schema: 2\nformality: formal'))).not.toBe('')
  })
})

describe('when', () => {
  it('reads notSource into whenNotSource', () => {
    const r = parse('schema: 2\npatterns:\n  - text: blog\n    when: { notSource: blog }\n')
    expect(r.patterns[0]).toMatchObject({ text: 'blog', whenNotSource: 'blog' })
    expect(r.patterns[0]).not.toHaveProperty('whenSource')
  })
  it('reads source and notSource together', () => {
    const r = parse('schema: 2\npatterns:\n  - text: x\n    when: { source: a, notSource: b }\n')
    expect(r.patterns[0]).toMatchObject({ whenSource: 'a', whenNotSource: 'b' })
  })
  it('rejects an empty when', () => {
    expect(error('schema: 2\npatterns:\n  - text: x\n    when: {}\n').message).toContain('needs source or notSource')
  })
  it('rejects an empty notSource and an unknown key', () => {
    expect(() => parse("schema: 2\npatterns:\n  - text: x\n    when: { notSource: '' }\n")).toThrow(RulesFileError)
    expect(() => parse('schema: 2\npatterns:\n  - text: x\n    when: { lacks: y }\n')).toThrow(RulesFileError)
  })
  // An older polyglots refuses notSource as an unknown key, so a file that
  // uses it must say so, as with the other schema 2 keys.
  it('needs schema: 2 for notSource, not for source', () => {
    expect(error('patterns:\n  - text: x\n    when: { notSource: y }\n').message).toContain('needs schema: 2 at the top of the file')
    expect(parse('patterns:\n  - text: x\n    when: { source: y }\n').patterns[0]?.whenSource).toBe('y')
  })
  it('fingerprints notSource', () => {
    const a = parse('schema: 2\npatterns:\n  - text: x\n    when: { notSource: y }\n')
    const b = parse('schema: 2\npatterns:\n  - text: x\n    when: { notSource: z }\n')
    expect(rulesFingerprint(a)).not.toBe(rulesFingerprint(b))
  })
})
