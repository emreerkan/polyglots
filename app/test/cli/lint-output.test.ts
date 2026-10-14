import { describe, expect, it } from 'vitest'
import { githubReport, jsonReport, shownReferences, textReport, totalLine } from '../../src/cli/lint-output.js'
import type { Finding, LintReport } from '../../src/lint/lint.js'
import { createPainter } from '../../src/ui/paint.js'

const p = createPainter({ isTTY: false }, {}, { isTTY: false })
const finding = (patch: Partial<Finding>): Finding => ({
  rule: 'translators-comment',
  level: 'error',
  msgid: 'Hello %s',
  references: ['plugin.php:3'],
  message: 'Add a translators comment.',
  ...patch,
})
const report = (findings: Finding[], checked = 10): LintReport => {
  const errors = findings.filter((f) => f.level === 'error').length
  return { checked, findings, errors, warnings: findings.length - errors }
}

describe('shownReferences', () => {
  it('lists up to three, then counts the rest', () => {
    expect(shownReferences(['a:1', 'b:2', 'c:3'])).toBe('a:1, b:2, c:3')
    expect(shownReferences(['a:1', 'b:2', 'c:3', 'd:4', 'e:5'])).toBe('a:1, b:2, c:3 and 2 more')
    expect(shownReferences([])).toBe('(no reference)')
  })
})

describe('totalLine', () => {
  it('says no problems when there are none', () => {
    expect(totalLine(p, report([], 1), false)).toMatch(/No problems in 1 string\.$/)
  })
  it('counts errors, warnings and strings', () => {
    expect(totalLine(p, report([finding({}), finding({ level: 'warning', rule: 'typography' })]), false)).toMatch(/1 error, 1 warning in 10 strings\.$/)
  })
})

describe('textReport', () => {
  it('groups by rule with the fix sentence once, each string with its references, and ends with the total', () => {
    const lines = textReport(
      p,
      report([
        finding({}),
        finding({ msgid: 'Bye %s', references: ['a.php:1'] }),
        finding({ rule: 'ambiguous-word', level: 'warning', msgid: 'Post', message: 'Add a context.' }),
      ]),
      false,
    )
    const text = lines.join('\n')
    expect(text).toMatch(/translators-comment\s+2 strings/)
    expect(text.match(/Add a translators comment\./g)).toHaveLength(1)
    expect(text).toMatch(/"Hello %s"\s+plugin\.php:3/)
    expect(text).toMatch(/"Bye %s"\s+a\.php:1/)
    expect(text.indexOf('translators-comment')).toBeLessThan(text.indexOf('ambiguous-word'))
    expect(lines.at(-1)).toMatch(/2 errors, 1 warning in 10 strings\./)
  })
  it('names the context beside the string', () => {
    expect(textReport(p, report([finding({ msgctxt: 'greeting' })]), false).join('\n')).toMatch(/"Hello %s" \(context "greeting"\)/)
  })
})

describe('jsonReport', () => {
  it('writes version, pot, counts and the findings', () => {
    const data = JSON.parse(jsonReport(report([finding({})]), 'my-plugin'))
    expect(data).toEqual({
      version: 1,
      pot: 'my-plugin',
      checked: 10,
      findings: [{ rule: 'translators-comment', level: 'error', msgid: 'Hello %s', references: ['plugin.php:3'], message: 'Add a translators comment.' }],
      errors: 1,
      warnings: 0,
    })
  })
})

describe('githubReport', () => {
  const locate = (ref: string) => {
    const [file, line] = ref.split(':')
    return { file: `src/${file}`, line: Number(line) }
  }
  it('writes one annotation per finding at its first reference, escaping the data', () => {
    const lines = githubReport(report([finding({ references: ['plugin.php:3', 'b.php:4'] }), finding({ rule: 'typography', level: 'warning', msgid: 'Wait...' })]), locate)
    expect(lines).toEqual([
      '::error file=src/plugin.php,line=3,title=polyglots translators-comment::"Hello %25s": Add a translators comment.',
      '::warning file=src/plugin.php,line=3,title=polyglots typography::"Wait...": Add a translators comment.',
    ])
  })
  it('leaves out file and line for a finding with no reference', () => {
    expect(githubReport(report([finding({ references: [] })]), locate)[0]).toMatch(/^::error title=polyglots translators-comment::/)
  })
})
