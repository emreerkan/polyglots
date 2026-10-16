import { describe, expect, it } from 'vitest'
import { builtInProfileFor } from '../../src/audit/rules/profiles.js'
import { builtInProperNounsFor } from '../../src/audit/rules/proper-nouns.js'
import { renderDefaultRules } from '../../src/rules/defaults.js'
import { parseLocaleRules, rulesFingerprint } from '../../src/rules/load.js'
import { UNIVERSAL_RULES } from '../../src/audit/rules/profiles.js'

const EXAMPLE_KEYS = ['guidance', 'capitalization', 'register', 'formality', 'sentenceEnd']

// What a person does to the template by hand: drop the empty mistakes and
// patterns lists in favour of the examples under them, and take the hash off
// each example block. A blank line ends a block, as it does in the template.
function uncommentExamples(text: string): string {
  let mode: 'list' | 'block' | undefined
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (line === '') mode = undefined
    if (line === 'mistakes: []' || line === 'patterns: []') {
      out.push(line.slice(0, -' []'.length))
      mode = 'list'
    } else if (mode === 'list' && line.startsWith('#  ')) out.push(line.slice(1))
    else if (EXAMPLE_KEYS.some((key) => line.startsWith(`# ${key}:`))) {
      out.push(line.slice(2))
      mode = 'block'
    } else if (mode === 'block' && line.startsWith('#   ')) out.push(line.slice(2))
    else out.push(line)
  }
  return out.join('\n')
}

describe('renderDefaultRules', () => {
  // The file written for editing must describe exactly what runs today, or the
  // first edit would silently change rules the person never touched.
  it('describes the built-in profile and names exactly, once uncommented', () => {
    const rules = parseLocaleRules(renderDefaultRules('tr', { commented: false }), 'tr.yaml')
    const active = new Set([...UNIVERSAL_RULES, ...rules.rules!.enable].filter((r) => !rules.rules!.disable.includes(r)))
    expect([...active].sort()).toEqual([...builtInProfileFor('tr').rules].sort())
    expect(rules.glossaryStemRatio).toBe(builtInProfileFor('tr').glossaryStemRatio)
    expect(rules.properNouns).toEqual(builtInProperNounsFor('tr'))
  })

  it('describes the universal profile for a locale without built-in extras', () => {
    const rules = parseLocaleRules(renderDefaultRules('de', { commented: false }), 'de.yaml')
    expect(rules.rules).toEqual({ enable: [], disable: [] })
  })

  // Written as comments, the file changes nothing until something is uncommented.
  it('is a valid file that sets nothing when commented', () => {
    const rules = parseLocaleRules(renderDefaultRules('tr'), 'tr.yaml')
    expect(rulesFingerprint(rules)).toBe('')
  })

  // Locale data lives in polyglots-data now, so the template names no pack and
  // shows every locale the same neutral examples. The schema line is live so a
  // file written from it can use the schema-2 keys the moment they are uncommented.
  it('names no pack and starts with schema 2', () => {
    const text = renderDefaultRules('tr')
    expect(text).not.toMatch(/\bpacks?\b/i)
    expect(text.split('\n')).toContain('schema: 2')
    expect(text).toContain('a wording your team rejects')
  })

  // The examples stay commented in both modes, so the commented:false test
  // above never parses them. Someone who uncomments one is told the template
  // was a working file, and a typo here would greet them with a refusal
  // instead. This takes every example live and expects each key to be set.
  it('parses with every example uncommented', () => {
    const rules = parseLocaleRules(uncommentExamples(renderDefaultRules('tr', { commented: false })), 'tr.yaml')
    // Mistakes and patterns are read into one list, one example from each.
    expect(rules.patterns).toHaveLength(2)
    expect(rules.guidance).toBeDefined()
    expect(rules.capitalization).toBeDefined()
    expect(rules.register).toBeDefined()
    expect(rules.formality).toBeDefined()
    expect(rules.sentenceEnd).toBeDefined()
  })

  it('shows an example of each section', () => {
    const text = renderDefaultRules('tr')
    for (const section of ['mistakes', 'patterns', 'guidance', 'level: fix']) expect(text).toContain(section)
  })
})
