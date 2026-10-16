import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openRulesDraft } from '../../src/rules/edit.js'
import { tryRules } from '../../src/rules/try.js'

let home: string
let saved: string | undefined
beforeEach(async () => {
  saved = process.env.POLYGLOTS_HOME
  home = await mkdtemp(join(tmpdir(), 'polyglots-try-'))
  process.env.POLYGLOTS_HOME = home
})
afterEach(async () => {
  if (saved === undefined) delete process.env.POLYGLOTS_HOME
  else process.env.POLYGLOTS_HOME = saved
  await rm(home, { recursive: true, force: true })
})

// What the editor shows before anything is saved, so the rules can be tried
// as they are being written.
describe('tryRules', () => {
  it('runs unsaved mistakes and patterns against a sample', () => {
    const draft = openRulesDraft('tr')
    const r = tryRules(draft, {
      ...draft.value,
      mistakes: [{ wrong: 'önizleme', right: 'ön izleme' }],
      patterns: [{ find: '\\.\\.\\.', replace: '…', level: 'fix' }],
    }, { source: 'Preview...', translation: 'Önizleme...' })
    expect(r.fixed).toBe('Önizleme…')
    expect(r.findings).toContainEqual(expect.objectContaining({ rule: 'custom', message: '"önizleme" -> "ön izleme"' }))
  })

  it('runs the built-in rules as switched in the editor', () => {
    const draft = openRulesDraft('tr')
    const on = tryRules(
      draft,
      { ...draft.value, rules: { enable: ['title-case'], disable: [] } },
      { source: 'Save Changes', translation: 'Değişiklikleri Kaydet' },
    )
    expect(on.findings.some((f) => f.rule === 'title-case')).toBe(true)
    const off = tryRules(
      draft,
      { ...draft.value, rules: { enable: ['apostrophe'], disable: [] } },
      { source: 'Save Changes', translation: 'Değişiklikleri Kaydet' },
    )
    expect(off.findings.some((f) => f.rule === 'title-case')).toBe(false)
  })

  it('reports nothing for a clean translation', () => {
    const draft = openRulesDraft('tr')
    expect(tryRules(draft, draft.value, { source: 'Settings', translation: 'Ayarlar' })).toEqual({ findings: [] })
  })

  it('says so when the unsaved rules are invalid rather than trying them', () => {
    const draft = openRulesDraft('tr')
    expect(() => tryRules(draft, { ...draft.value, patterns: [{ find: '(', level: 'hint' }] }, { source: 'a', translation: 'b' })).toThrow(
      /patterns\.0\.find/,
    )
  })
})
