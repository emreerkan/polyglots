import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AUDIT_CATEGORIES } from '../../src/audit/schema.js'
import { BUILT_IN_RULES, CUSTOM_RULE, FINDING_KEYS, findingLabel } from '../../src/rules/names.js'

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

describe('finding labels', () => {
  it('name every built-in rule, the locale file rule and every AI category', () => {
    for (const key of [...BUILT_IN_RULES, CUSTOM_RULE, ...AUDIT_CATEGORIES.map((c) => `ai:${c}`)]) {
      expect(findingLabel(key), key).toBeDefined()
    }
  })

  // The keys a finding can carry are not all in a list. audit.ts writes a few
  // by hand (repaired, fix-rejected, unreviewed), and the next one will be
  // written the same way, so the source is the only complete record.
  it('name every rule key written as a literal anywhere in src', () => {
    const written = new Set<string>()
    for (const file of sources(join(import.meta.dirname, '../../src'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\brule: '([a-z][a-z:-]*)'/g)) written.add(m[1]!)
    }
    expect(written.size).toBeGreaterThan(10)
    const unlabelled = [...written].filter((key) => findingLabel(key) === undefined)
    expect(unlabelled).toEqual([])
  })

  // Written through a constant rather than a literal, so the scan above cannot
  // see it.
  it('name the finding an accepted model fix carries', async () => {
    const { FIX_SUSPECT_RULE } = await import('../../src/audit/repair.js')
    expect(findingLabel(FIX_SUSPECT_RULE)).toBeDefined()
  })

  it('say whether a key is a mechanical check or the model’s judgement', () => {
    expect(findingLabel('ampersand')?.source).toBe('rule')
    expect(findingLabel('ai:register')?.source).toBe('ai')
    expect(findingLabel('fix-rejected')?.source).toBe('ai')
    expect(findingLabel('fix-suspect')?.source).toBe('ai')
    expect(findingLabel('unreviewed')?.source).toBe('process')
  })

  it('give a human name and a one-line description, never the key itself', () => {
    for (const key of FINDING_KEYS) {
      const label = findingLabel(key)!
      expect(label.name).not.toBe(key)
      expect(label.name.length).toBeGreaterThan(3)
      expect(label.description).toMatch(/\.$/)
      expect(label.description).not.toContain('\n')
    }
  })

  it('know nothing of a key no code writes, so the caller can show it as other', () => {
    expect(findingLabel('retired-rule')).toBeUndefined()
  })
})
