import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { emitRulesYaml, emptyBuilderState, stateFromRules, type BuilderState } from '../../src/rules/emit.js'
import { parseRulesText } from '../../src/rules/parse.js'
import { parseLocaleRules } from '../../src/rules/load.js'

// The published tr_TR file, copied from polyglots-data (locales/tr_TR/rules.yaml
// at 2fc967a). Unlike tr_TR.yaml, which is the old pack and nothing else, this
// is what "Start from the published rules" loads, comments, formality and all.
const published = readFileSync(new URL('../fixtures/locale/tr_TR.published.yaml', import.meta.url), 'utf8')

const parse = (text: string) => parseRulesText(text, 'tr_TR.rules.yaml')

function full(): BuilderState {
  return {
    ...emptyBuilderState('es_ES'),
    enable: ['title-case'],
    disable: ['untranslated'],
    glossaryStemRatio: 0.6,
    formality: 'informal',
    register: { audit: '- Address the reader as tú.', translate: '- Use tú.' },
    capitalization: '- {language} uses sentence case.\n- Brand names keep their casing.\n',
    guidance: 'Buttons are verbs.\nKeep it short.',
    properNouns: { always: ['España', 'Unión Europea'], dateOnly: ['Lunes'] },
    mistakes: [
      { wrong: 'loguear', right: 'iniciar sesión', note: 'RAE' },
      { wrong: 'cliquear', right: '', note: '' },
    ],
    patterns: [
      { mode: 'text', value: 'blog', level: 'hint', replace: '', ignoreCase: false, whenSource: '', whenNotSource: 'blog', note: 'Use "sitio"' },
      { mode: 'find', value: "\\s+'", level: 'fix', replace: "'", ignoreCase: true, whenSource: "'", whenNotSource: '', note: '' },
      { mode: 'find', value: '[Ee]-?mail', level: 'error', replace: '', ignoreCase: false, whenSource: '', whenNotSource: '', note: 'correo' },
    ],
    sentenceEnd: { answers: [{ text: '。', source: '\\.' }, { text: '!', source: '' }], unmarked: true, notEnding: '\\.\\.$' },
  }
}

describe('emitRulesYaml', () => {
  it('writes a file the app reads back with every value the builder held', () => {
    const yaml = emitRulesYaml(full())
    expect(yaml).toMatch(/^schema: 2$/m)
    expect(parse(yaml)).toEqual({
      schema: 2,
      rules: { enable: ['title-case'], disable: ['untranslated'] },
      glossaryStemRatio: 0.6,
      properNouns: { always: ['España', 'Unión Europea'], dateOnly: ['Lunes'] },
      patterns: [
        { kind: 'mistake', text: 'loguear', right: 'iniciar sesión', level: 'hint', ignoreCase: true, note: 'RAE' },
        { kind: 'mistake', text: 'cliquear', level: 'hint', ignoreCase: true },
        { kind: 'pattern', text: 'blog', level: 'hint', ignoreCase: true, whenNotSource: 'blog', note: 'Use "sitio"' },
        { kind: 'pattern', find: "\\s+'", replace: "'", level: 'fix', ignoreCase: true, whenSource: "'" },
        { kind: 'pattern', find: '[Ee]-?mail', level: 'error', ignoreCase: false, note: 'correo' },
      ],
      guidance: 'Buttons are verbs.\nKeep it short.',
      capitalization: '- {language} uses sentence case.\n- Brand names keep their casing.\n',
      register: { audit: '- Address the reader as tú.', translate: '- Use tú.' },
      formality: 'informal',
      sentenceEnd: { answers: [{ text: '。', source: '\\.' }, { text: '!' }], unmarked: true, notEnding: '\\.\\.$' },
    })
  })

  it('passes the probe rules check runs', () => {
    expect(() => parseLocaleRules(emitRulesYaml(full()), 'es_ES.rules.yaml', { probe: true })).not.toThrow()
  })

  it('writes the published tr_TR rules back to the same value', () => {
    const before = parse(published)
    const again = parse(emitRulesYaml(stateFromRules(before, 'tr_TR')))
    expect(again).toEqual(before)
  })

  it('writes an empty builder as a valid file that sets nothing', () => {
    const yaml = emitRulesYaml(emptyBuilderState('tr_TR'))
    expect(parse(yaml)).toEqual({ schema: 2, patterns: [] })
    expect(yaml).toContain('tr_TR')
  })

  it('writes one register line when both prompts share it', () => {
    const yaml = emitRulesYaml({ ...emptyBuilderState(''), register: { audit: '- Use du.', translate: '- Use du.' } })
    expect(yaml).toMatch(/^register: .*Use du/m)
    expect(parse(yaml).register).toEqual({ audit: '- Use du.', translate: '- Use du.' })
  })

  it('leaves out blank fields and blank list rows', () => {
    const yaml = emitRulesYaml({
      ...emptyBuilderState(''),
      guidance: '   ',
      capitalization: '\n',
      properNouns: { always: ['', ' '], dateOnly: [] },
      mistakes: [{ wrong: ' ', right: 'x', note: '' }],
      patterns: [{ mode: 'find', value: '', level: 'hint', replace: '', ignoreCase: false, whenSource: '', whenNotSource: '', note: 'n' }],
      sentenceEnd: { answers: [{ text: '', source: '' }], unmarked: false, notEnding: '' },
    })
    expect(parse(yaml)).toEqual({ schema: 2, patterns: [] })
  })

  it('writes guidance and capitalization as block text', () => {
    const yaml = emitRulesYaml(full())
    expect(yaml).toMatch(/^capitalization: \|\n {2}- \{language\} uses sentence case\.$/m)
    expect(yaml).toMatch(/^guidance: \|-?\n {2}Buttons are verbs\.$/m)
  })

  it('keeps a line too long to fold on one line', () => {
    const note = 'x '.repeat(80).trim()
    const yaml = emitRulesYaml({ ...emptyBuilderState(''), mistakes: [{ wrong: 'a', right: '', note }] })
    expect(yaml).toContain(`note: ${note}`)
  })
})

describe('stateFromRules', () => {
  it('splits mistakes from patterns and keeps the form fields', () => {
    const state = stateFromRules(parse(emitRulesYaml(full())), 'es_ES')
    expect(state).toEqual(full())
  })
})
