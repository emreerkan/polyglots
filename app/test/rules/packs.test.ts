import { describe, expect, it } from 'vitest'
import { builtInProfileFor, UNIVERSAL_RULES } from '../../src/audit/rules/profiles.js'
import { builtInProperNounsFor } from '../../src/audit/rules/proper-nouns.js'
import { renderDefaultRules } from '../../src/rules/defaults.js'
import { parseLocaleRules, rulesFingerprint } from '../../src/rules/load.js'
import { BUILT_IN_RULES } from '../../src/rules/names.js'
import { packFor, PACKS } from '../../src/rules/packs/index.js'

// A pack is code, so a mistake in one is caught here rather than at runtime:
// the same limits a user's rules file is held to, applied to what ships.
describe.each(PACKS.map((p) => [p.language, p] as const))('the %s pack', (language, pack) => {
  it('names only built-in rules beyond the universal set', () => {
    for (const rule of pack.extraRules) {
      expect(BUILT_IN_RULES as readonly string[]).toContain(rule)
      expect(UNIVERSAL_RULES).not.toContain(rule)
    }
  })

  it('keeps the glossary stem ratio inside (0, 1]', () => {
    expect(pack.glossaryStemRatio).toBeGreaterThan(0)
    expect(pack.glossaryStemRatio).toBeLessThanOrEqual(1)
  })

  it('is what packFor answers for its language and a set of it', () => {
    expect(packFor(language)).toBe(pack)
    expect(packFor(`${language}/formal`)).toBe(pack)
  })

  // The file written for editing must describe exactly what runs today, or
  // the first edit would silently change rules the person never touched.
  it('is reproduced exactly by the live defaults file', () => {
    const rules = parseLocaleRules(renderDefaultRules(language, { commented: false }), `${language}.yaml`)
    const active = new Set([...UNIVERSAL_RULES, ...rules.rules!.enable].filter((r) => !rules.rules!.disable.includes(r)))
    expect([...active].sort()).toEqual([...builtInProfileFor(language).rules].sort())
    expect(rules.glossaryStemRatio).toBe(pack.glossaryStemRatio)
    expect(rules.properNouns).toEqual(builtInProperNounsFor(language))
  })

  it('sets nothing while the defaults file is still commented out', () => {
    expect(rulesFingerprint(parseLocaleRules(renderDefaultRules(language), `${language}.yaml`))).toBe('')
  })

  // The examples are there to be uncommented. One that does not parse once
  // the team does so would be the template teaching a broken file.
  it('has examples that make a valid file once uncommented', () => {
    const uncommented = renderDefaultRules(language)
      .replace('mistakes: []', 'mistakes:')
      .replace('patterns: []', 'patterns:')
      .split('\n')
      .map((line) => (/^# {2}(- | {2}\S)/.test(line) ? line.slice(1) : line))
      .join('\n')
    const rules = parseLocaleRules(uncommented, `${language}.yaml`)
    const examples = [...(pack.examples?.mistakes ?? []), ...(pack.examples?.patterns ?? [])].filter((l) => l.startsWith('  - '))
    expect(examples.length).toBeGreaterThan(0)
    expect(rules.patterns.length).toBe(examples.length)
  })
})

describe('packFor', () => {
  it('has no pack for a language nobody has supplied one for', () => {
    expect(packFor('de')).toBeUndefined()
    expect(packFor('nl/formal')).toBeUndefined()
  })

  it('marks Turkish maintained and Swedish as defaults to confirm', () => {
    expect(packFor('tr')?.status).toBe('maintained')
    expect(packFor('sv')?.status).toBe('defaults')
  })
})

describe('the Swedish pack', () => {
  // Asked of the pack rather than the built-in profile, which is the
  // universal set for every locale now that rules come from the rules file.
  it('adds title-case and nothing Turkish', () => {
    expect(packFor('sv')?.extraRules).toEqual(['title-case'])
    expect(packFor('sv')?.glossaryStemRatio).toBe(0.7)
    expect(builtInProfileFor('sv').rules).toEqual(new Set(UNIVERSAL_RULES))
  })

  // Swedish writes languages, days and months in lower case, so there is
  // nothing to exempt from title-case.
  it('carries no proper nouns', () => {
    expect(builtInProperNounsFor('sv')).toEqual({ always: [], dateOnly: [] })
  })

  it('labels every template example for the team to confirm', () => {
    const text = renderDefaultRules('sv')
    expect(text).toMatch(/Built-in pack: Swedish \(defaults for the locale team to confirm\)/)
    expect(text).toMatch(/särskrivning/)
    expect(text).toMatch(/WordPress's/)
    expect(text).toMatch(/25 %/)
    expect(text.match(/[Cc]onfirm with your team/g)?.length).toBe(3)
    expect(text).not.toMatch(/önizleme|TDK/)
  })
})

describe('the template for a locale without a pack', () => {
  it('says so, and uses examples that name no language', () => {
    const text = renderDefaultRules('de')
    expect(text).toMatch(/No built-in pack for de: only the universal rules run unless this file adds some\./)
    expect(text).not.toMatch(/önizleme|TDK|särskrivning/)
  })
})
