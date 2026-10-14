import type { Finding, LintReport } from '../lint/lint.js'
import { errorLine, hintLine, okLine, warnLine } from '../ui/messages.js'
import type { Painter } from '../ui/paint.js'

export type LintFormat = 'text' | 'json' | 'github'
export const LINT_FORMATS: readonly LintFormat[] = ['text', 'json', 'github']

const SHOWN_REFERENCES = 3
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

// A string used in thirty places would otherwise be a paragraph of
// references; the first few say where to look, json carries them all.
export function shownReferences(refs: readonly string[]): string {
  if (refs.length === 0) return '(no reference)'
  if (refs.length <= SHOWN_REFERENCES) return refs.join(', ')
  return `${refs.slice(0, SHOWN_REFERENCES).join(', ')} and ${refs.length - SHOWN_REFERENCES} more`
}

const label = (f: Finding): string =>
  f.msgctxt === undefined ? JSON.stringify(f.msgid) : `${JSON.stringify(f.msgid)} (context ${JSON.stringify(f.msgctxt)})`

// The glyph says what the exit code will: red when this run fails, yellow
// when there are warnings that do not fail it.
export function totalLine(p: Painter, r: LintReport, strict: boolean): string {
  if (r.findings.length === 0) return okLine(p, `No problems in ${plural(r.checked, 'string')}.`)
  const counts = `${plural(r.errors, 'error')}, ${plural(r.warnings, 'warning')} in ${plural(r.checked, 'string')}.`
  return r.errors > 0 || strict ? errorLine(p, counts) : warnLine(p, counts)
}

// Grouped by rule, because the fix is the same for every string a rule
// finds: it is said once, under the heading, instead of once per string.
export function textReport(p: Painter, r: LintReport, strict: boolean): string[] {
  const groups = new Map<string, Finding[]>()
  for (const f of r.findings) groups.set(f.rule, [...(groups.get(f.rule) ?? []), f])
  const lines: string[] = []
  for (const [rule, found] of groups) {
    const head = `${rule}  ${p.paint('muted', plural(found.length, 'string'))}`
    lines.push(found[0]!.level === 'error' ? errorLine(p, head) : warnLine(p, head))
    lines.push(hintLine(p, found[0]!.message))
    for (const f of found) lines.push(`  ${label(f)}  ${p.paint('path', shownReferences(f.references))}`)
    lines.push('')
  }
  lines.push(totalLine(p, r, strict))
  return lines
}

export function jsonReport(r: LintReport, pot: string): string {
  return JSON.stringify({ version: 1, pot, checked: r.checked, findings: r.findings, errors: r.errors, warnings: r.warnings }, null, 2)
}

// GitHub's workflow command escaping: data escapes %, CR and LF; property
// values also escape : and , since those separate the properties.
const escapeData = (s: string): string => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const escapeProperty = (s: string): string => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C')

// One annotation per finding, at its first reference: GitHub draws it on that
// line of the pull request's diff. locate turns a .pot reference into a path
// from the repository root, which is where a workflow runs.
export function githubReport(r: LintReport, locate: (ref: string) => { file: string; line?: number }): string[] {
  return r.findings.map((f) => {
    const where = f.references[0] === undefined ? undefined : locate(f.references[0])
    const props = [
      ...(where === undefined ? [] : [`file=${escapeProperty(where.file)}`]),
      ...(where?.line === undefined ? [] : [`line=${where.line}`]),
      `title=${escapeProperty(`polyglots ${f.rule}`)}`,
    ]
    return `::${f.level} ${props.join(',')}::${escapeData(`${label(f)}: ${f.message}`)}`
  })
}
