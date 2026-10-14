import type { TranslationUnit } from '../types.js'
import type { LintConfig } from './config.js'
import { RULES, RULE_IDS, type Level, type RuleId } from './rules.js'

export interface Finding {
  rule: RuleId
  level: Level
  msgid: string
  msgctxt?: string
  references: string[]
  message: string
}

export interface LintReport {
  checked: number
  findings: Finding[]
  errors: number
  warnings: number
}

// The lines of a source file, named as the .pot's references name it,
// relative to the plugin or theme folder. Undefined when it cannot be read.
export type ReadSource = (file: string) => readonly string[] | undefined

export type Marker = ReadonlySet<RuleId> | 'all'

// make-pot's own comments on the header strings it extracts: "Plugin URI of
// the plugin", "Author of the theme". The developer cannot give a header a
// context, a placeholder or a marker, so these are neither checked nor
// counted. Matched whole, so a translators comment that happens to end in
// "of the plugin" is not mistaken for one.
const HEADER_COMMENT = /^(?:Plugin Name|Plugin URI|Theme Name|Theme URI|Description|Author|Author URI|Template Name) of the (?:plugin|theme)$/

export const isHeaderEntry = (unit: TranslationUnit): boolean => unit.comments.some((c) => HEADER_COMMENT.test(c.trim()))

export function parseReference(ref: string): { file: string; line?: number } {
  const m = /^(.*):(\d+)$/.exec(ref)
  return m ? { file: m[1]!, line: Number(m[2]) } : { file: ref }
}

const MARKER = /polyglots-ignore\b(.*)$/
// A line that is only a comment: PHP, JS and block comment lines, a PHP
// template's one-line <?php /* ... */ ?>, and JSX's {/* ... */}.
const COMMENT_LINE = /^(?:<\?php\s+|\{\s*)?(?:\/\/|#|\/\*|\*)/

function markerIn(text: string): Marker | undefined {
  const m = MARKER.exec(text)
  if (!m) return undefined
  const ids = new Set<RuleId>()
  for (const word of m[1]!.trim().split(/[\s,]+/)) {
    if (!(RULE_IDS as readonly string[]).includes(word)) break
    ids.add(word as RuleId)
  }
  return ids.size === 0 ? 'all' : ids
}

// make-pot carries only translators comments into the .pot, so the marker is
// read from the source at each reference: the reference's own line, or the
// comment block directly above it. The whole block counts, not only its last
// line, because make-pot drops a translators comment that is not the last
// comment before the call; the marker has to be able to sit above it.
export function markerAt(lines: readonly string[], line: number): Marker | undefined {
  const own = lines[line - 1]
  if (own === undefined) return undefined
  const same = markerIn(own)
  if (same) return same
  for (let i = line - 2; i >= 0; i--) {
    const text = lines[i]!.trim()
    if (!COMMENT_LINE.test(text)) return undefined
    const found = markerIn(text)
    if (found) return found
  }
  return undefined
}

function ignoredByConfig(config: LintConfig, id: RuleId, unit: TranslationUnit): boolean {
  return config.ignore.some(
    (e) =>
      e.msgid === unit.msgid &&
      (e.msgctxt === undefined || e.msgctxt === unit.msgctxt) &&
      (e.rule === undefined || e.rule === id),
  )
}

// Every reference has to carry the marker. make-pot merges identical strings
// into one entry, and a marker at one call site must not hide the same string
// used carelessly at another.
function ignoredByMarkers(readSource: ReadSource | undefined, id: RuleId, unit: TranslationUnit): boolean {
  if (!readSource || unit.references.length === 0) return false
  return unit.references.every((ref) => {
    const { file, line } = parseReference(ref)
    if (line === undefined) return false
    const lines = readSource(file)
    const marker = lines === undefined ? undefined : markerAt(lines, line)
    return marker === 'all' || (marker !== undefined && marker.has(id))
  })
}

export function lintPot(units: readonly TranslationUnit[], config: LintConfig, readSource?: ReadSource): LintReport {
  const findings: Finding[] = []
  const checked = units.filter((unit) => !isHeaderEntry(unit))
  for (const unit of checked) {
    for (const rule of RULES) {
      const level = config.rules[rule.id] ?? rule.level
      if (level === 'off' || !rule.test(unit)) continue
      // Neither kind of suppression reaches an error: an error is a string
      // translators cannot get right, and the way to drop one on purpose is
      // to turn its rule off where the whole team can see it.
      if (level === 'warning' && (ignoredByConfig(config, rule.id, unit) || ignoredByMarkers(readSource, rule.id, unit))) continue
      findings.push({
        rule: rule.id,
        level,
        msgid: unit.msgid,
        ...(unit.msgctxt === undefined ? {} : { msgctxt: unit.msgctxt }),
        references: [...unit.references],
        message: rule.fix,
      })
    }
  }
  const rank = (f: Finding): number => (f.level === 'error' ? 0 : RULE_IDS.length) + RULE_IDS.indexOf(f.rule)
  findings.sort((a, b) => rank(a) - rank(b))
  const errors = findings.filter((f) => f.level === 'error').length
  return { checked: checked.length, findings, errors, warnings: findings.length - errors }
}
