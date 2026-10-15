import { describe, expect, it } from 'vitest'
import { cutWhatsNew } from '../../scripts/release-whats-new.mjs'

const file = (body: string) => `// comment\nexport const WHATS_NEW: Readonly<Record<string, readonly string[]>> = {\n${body}}\n`

describe('cutWhatsNew', () => {
  it('files the unreleased lines under the version being released', () => {
    const before = file(`  unreleased: ['New thing.'],\n  '0.32.0': ['Old thing.'],\n`)
    expect(cutWhatsNew(before, '0.33.0')).toEqual({
      text: file(`  '0.33.0': ['New thing.'],\n  '0.32.0': ['Old thing.'],\n`),
      cut: true,
    })
  })

  // Most patches have nothing to tell a TUI user, and that is fine.
  it('leaves the file alone when there are no unreleased lines', () => {
    const before = file(`  '0.32.0': ['Old thing.'],\n`)
    expect(cutWhatsNew(before, '0.32.1')).toEqual({ text: before, cut: false })
  })

  it('refuses when the version already has lines, rather than hide one set', () => {
    const before = file(`  unreleased: ['New thing.'],\n  '0.33.0': ['Already.'],\n`)
    expect(() => cutWhatsNew(before, '0.33.0')).toThrow(/0\.33\.0/)
  })
})
