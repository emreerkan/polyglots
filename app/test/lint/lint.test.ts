import { describe, expect, it } from 'vitest'
import { EMPTY_CONFIG, type LintConfig } from '../../src/lint/config.js'
import { lintPot, markerAt, parseReference, type ReadSource } from '../../src/lint/lint.js'
import type { TranslationUnit } from '../../src/types.js'

const unit = (msgid: string, extra: Partial<TranslationUnit> = {}): TranslationUnit => ({
  key: msgid,
  msgid,
  comments: [],
  references: ['plugin.php:3'],
  ...extra,
})
const config = (patch: Partial<LintConfig>): LintConfig => ({ ...EMPTY_CONFIG, ...patch })
const sources = (files: Record<string, string>): ReadSource => (file) => files[file]?.split('\n')
const rulesOf = (units: TranslationUnit[], c: LintConfig = EMPTY_CONFIG, read?: ReadSource) =>
  lintPot(units, c, read).findings.map((f) => f.rule)

describe('parseReference', () => {
  it('splits the line number off, and leaves a bare file alone', () => {
    expect(parseReference('inc/a.php:12')).toEqual({ file: 'inc/a.php', line: 12 })
    expect(parseReference('inc/a.php')).toEqual({ file: 'inc/a.php' })
  })
})

describe('lintPot', () => {
  it('counts strings, errors and warnings, errors first', () => {
    const report = lintPot([unit('Post'), unit('Hello %s')], EMPTY_CONFIG)
    expect(report.checked).toBe(2)
    expect(report.findings.map((f) => [f.rule, f.level])).toEqual([
      ['translators-comment', 'error'],
      ['ambiguous-word', 'warning'],
    ])
    expect(report.errors).toBe(1)
    expect(report.warnings).toBe(1)
  })
  it('carries the string, its context, every reference and the fix sentence', () => {
    const [f] = lintPot([unit('Hello %s', { msgctxt: 'greeting', references: ['a.php:1', 'b.php:2'] })], EMPTY_CONFIG).findings
    expect(f).toMatchObject({ msgid: 'Hello %s', msgctxt: 'greeting', references: ['a.php:1', 'b.php:2'] })
    expect(f!.message).toMatch(/translators:/)
  })
  it('drops a rule set off, and raises a warning set to error', () => {
    expect(rulesOf([unit('Post')], config({ rules: { 'ambiguous-word': 'off' } }))).toEqual([])
    const raised = lintPot([unit('Post')], config({ rules: { 'ambiguous-word': 'error' } }))
    expect(raised.errors).toBe(1)
    expect(raised.findings[0]!.level).toBe('error')
  })
})

describe('config ignore', () => {
  it('silences a warning on the named string, for every rule or the one named', () => {
    expect(rulesOf([unit('Post')], config({ ignore: [{ msgid: 'Post' }] }))).toEqual([])
    expect(rulesOf([unit('Post')], config({ ignore: [{ msgid: 'Post', rule: 'typography' }] }))).toEqual(['ambiguous-word'])
  })
  it('matches the context when the entry names one, and any context when it does not', () => {
    const wait = unit('Wait...', { msgctxt: 'button' })
    expect(rulesOf([wait], config({ ignore: [{ msgid: 'Wait...', msgctxt: 'status' }] }))).toEqual(['typography'])
    expect(rulesOf([wait], config({ ignore: [{ msgid: 'Wait...', msgctxt: 'button' }] }))).toEqual([])
    expect(rulesOf([wait, unit('Wait...')], config({ ignore: [{ msgid: 'Wait...' }] }))).toEqual([])
  })
  it('never silences an error', () => {
    expect(rulesOf([unit('Hello %s')], config({ ignore: [{ msgid: 'Hello %s' }] }))).toEqual(['translators-comment'])
  })
  it('never silences a warning a team raised to error', () => {
    expect(rulesOf([unit('Post')], config({ rules: { 'ambiguous-word': 'error' }, ignore: [{ msgid: 'Post' }] }))).toEqual(['ambiguous-word'])
  })
})

describe('markerAt', () => {
  it('finds a marker on the line itself', () => {
    expect(markerAt(['<?php', "echo __( 'Post' ); // polyglots-ignore"], 2)).toBe('all')
  })
  it('reads rule ids after the marker, up to the first word that is not one', () => {
    const marker = markerAt(["echo __( 'Post' ); /* polyglots-ignore ambiguous-word typography */"], 1)
    expect(marker).toEqual(new Set(['ambiguous-word', 'typography']))
    expect(markerAt(['// polyglots-ignore concatenation -- glued on purpose', 'x'], 2)).toEqual(new Set(['concatenation']))
  })
  it('means every warning when no rule id follows', () => {
    expect(markerAt(['// polyglots-ignore because it is fine', 'x'], 2)).toBe('all')
  })
  // make-pot drops a translators comment that is not directly above the
  // call, so the marker has to be allowed above it.
  it('finds a marker anywhere in the comment block directly above', () => {
    const lines = ['/* polyglots-ignore */', '/* translators: %s: name */', "printf( __( 'Hi %s' ), $n );"]
    expect(markerAt(lines, 3)).toBe('all')
    expect(markerAt(['/**', ' * polyglots-ignore', ' */', 'x'], 4)).toBe('all')
    expect(markerAt(['<?php /* polyglots-ignore */ ?>', 'x'], 2)).toBe('all')
  })
  it('stops at a blank line or a line of code', () => {
    expect(markerAt(['// polyglots-ignore', '', 'x'], 3)).toBeUndefined()
    expect(markerAt(['// polyglots-ignore', '$a = 1;', 'x'], 3)).toBeUndefined()
  })
  it('is undefined for a line past the end', () => {
    expect(markerAt(['x'], 5)).toBeUndefined()
  })
})

describe('marker suppression', () => {
  const read = sources({
    'plugin.php': "<?php\n\necho __( 'Post' ); // polyglots-ignore",
    'other.php': "<?php\n\necho __( 'Post' );",
    'ids.php': "<?php\n\necho __( 'Post' ); // polyglots-ignore typography",
  })
  it('silences every warning on a marked string', () => {
    expect(rulesOf([unit('Post')], EMPTY_CONFIG, read)).toEqual([])
  })
  it('silences only the rules it names', () => {
    expect(rulesOf([unit('Post', { references: ['ids.php:3'] })], EMPTY_CONFIG, read)).toEqual(['ambiguous-word'])
  })
  it('needs the marker at every reference', () => {
    expect(rulesOf([unit('Post', { references: ['plugin.php:3', 'other.php:3'] })], EMPTY_CONFIG, read)).toContain('ambiguous-word')
  })
  it('never silences an error', () => {
    const r = sources({ 'plugin.php': "<?php\n\nprintf( __( 'Hi %s' ), $n ); // polyglots-ignore" })
    expect(rulesOf([unit('Hi %s')], EMPTY_CONFIG, r)).toEqual(['translators-comment'])
  })
  it('keeps the finding when the source cannot be read, or the reference has no line', () => {
    expect(rulesOf([unit('Post', { references: ['missing.php:3'] })], EMPTY_CONFIG, read)).toEqual(['ambiguous-word'])
    expect(rulesOf([unit('Post', { references: ['plugin.php'] })], EMPTY_CONFIG, read)).toEqual(['ambiguous-word'])
    expect(rulesOf([unit('Post', { references: [] })], EMPTY_CONFIG, read)).toEqual(['ambiguous-word'])
  })
  it('reads no marker at all without a source reader', () => {
    expect(rulesOf([unit('Post')], EMPTY_CONFIG)).toEqual(['ambiguous-word'])
  })
})

// Review finding I4: make-pot extracts the plugin or theme header, which the
// developer cannot give a context, a placeholder or a marker.
describe('header entries', () => {
  it('are neither checked nor counted', () => {
    const header = [
      unit('https://example.com/acme', { comments: ['Plugin URI of the plugin'] }),
      unit('Acme Order Tools', { comments: ['Plugin Name of the plugin'] }),
      unit('https://example.com', { comments: ['Author URI of the theme'] }),
    ]
    const report = lintPot([...header, unit('Post')], EMPTY_CONFIG)
    expect(report.checked).toBe(1)
    expect(report.findings.map((f) => f.msgid)).toEqual(['Post'])
  })
})

// m9: the marker has to be in a comment, and a block comment's body lines
// need no leading star.
describe('markerAt, comments only', () => {
  it('ignores the word inside a string on the line', () => {
    expect(markerAt(["echo __( 'polyglots-ignore' );"], 1)).toBeUndefined()
  })
  it('walks a block comment whose lines have no leading star', () => {
    expect(markerAt(['/*', '  polyglots-ignore', '  because it is fine', '*/', 'x'], 5)).toBe('all')
  })
})

describe('markerAt, block comment edges', () => {
  // A regex literal at the end of a line is no comment closer.
  it('does not take a line of code ending in */ for the end of a comment', () => {
    expect(markerAt(["$s = '// polyglots-ignore';", 'const re = /\\s*/', 'x'], 3)).toBeUndefined()
  })
  it('does not end the block at a glob inside it', () => {
    expect(markerAt(['/*', ' polyglots-ignore', ' Reads src/**/*.js', '*/', 'x'], 5)).toBe('all')
  })
  it('reads the opener line from its /* only', () => {
    expect(markerAt(["foo( 'polyglots-ignore' ); /* x", ' y */', 'x'], 3)).toBeUndefined()
  })
})

describe('markerAt, closing lines with prose', () => {
  it('reads a block whose last line has parentheses or a semicolon', () => {
    expect(markerAt(['/* polyglots-ignore', '   shown elsewhere (in the title). */', "__('x')"], 3)).toBe('all')
    expect(markerAt(['/*', ' * polyglots-ignore', ' * Uses sprintf(); see #12. */', "__('x')"], 4)).toBe('all')
  })
})
