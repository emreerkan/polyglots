import { PRINTF_PLACEHOLDER } from '../draft/placeholders.js'
import type { TranslationUnit } from '../types.js'

// These judge English source strings, for the developer who wrote them. The
// rules in src/audit judge a translation against its source; the two sets
// share the placeholder pattern and nothing else.

export type Level = 'error' | 'warning'

export const RULE_IDS = [
  'translators-comment',
  'unordered-placeholders',
  'plural-placeholders',
  'plural-without-count',
  'concatenation',
  'ambiguous-word',
  'same-text-different-use',
  'markup-in-string',
  'typography',
] as const

export type RuleId = (typeof RULE_IDS)[number]

export interface Rule {
  id: RuleId
  level: Level
  // One sentence on the fix, shown once under each rule's findings.
  fix: string
  test(unit: TranslationUnit): boolean
}

// %% goes first, so "%%s" is the literal text "%s" and not a placeholder.
// URLs go too: a percent-encoded %20b or %2F reads as a placeholder to the
// shared pattern, and here it would raise an error no marker can silence. A
// URL in the string is markup-in-string's to report.
export function printfPlaceholders(text: string): string[] {
  return [...text.replace(/https?:\/\/[^\s"'<>]*/gi, '').replaceAll('%%', '').matchAll(new RegExp(PRINTF_PLACEHOLDER, 'g'))].map((m) => m[0])
}

const forms = (unit: TranslationUnit): string[] =>
  unit.msgidPlural === undefined ? [unit.msgid] : [unit.msgid, unit.msgidPlural]

const positioned = (placeholder: string): boolean => /^%\d+\$/.test(placeholder)

const unpositioned = (placeholders: string[]): string[] =>
  placeholders.map((p) => p.replace(/^%\d+\$/, '%')).sort()

// The words a sentence fragment ends on when the rest of the sentence is
// glued on in code: "Posted by" + name, "Read more of" + title.
const JOINING_WORDS = new Set(['of', 'and', 'or', 'the', 'a', 'an', 'to', 'for', 'by', 'with', 'from', 'in', 'on', 'at', 'than'])

// English UI words that are a noun and a verb at once. "Post" is a blog post
// or the act of posting, and most languages translate the two differently, so
// one string serving both is wrong in one of its places whatever the
// translator picks.
const AMBIGUOUS_WORDS = new Set(
  [
    'Post', 'Order', 'Archive', 'Free', 'Update', 'Draft', 'Comment', 'Filter', 'Export', 'Import',
    'Display', 'View', 'Set', 'Close', 'Open', 'Book', 'Charge', 'Return', 'Ship', 'Pin',
    'Tag', 'Feed', 'Like', 'Share', 'Schedule', 'Review', 'Report', 'Download', 'Upload', 'Save',
    'Publish',
  ].map((w) => w.toLowerCase()),
)

// Whole phrases that end on in or on: "Log in", "Turn on". The second word
// belongs to the verb, not to text glued on after it.
const PHRASAL_VERBS = new Set(['log', 'logged', 'sign', 'signed', 'opt', 'check', 'checked', 'zoom', 'turn', 'switch', 'plug', 'plugged', 'built', 'add', 'drop'])
// One-word toggle labels, beside "Off".
const TOGGLE_LABELS = new Set(['on', 'in'])

function endsOnJoiningWord(text: string): boolean {
  const m = /([\p{L}']+)$/u.exec(text)
  if (!m) return false
  const last = m[1]!.toLowerCase()
  if (!JOINING_WORDS.has(last)) return false
  // "Add-on", "Opt-in", "Built-in": one hyphenated word, not a fragment.
  if (text[m.index - 1] === '-') return false
  const previous = /([\p{L}']+)$/u.exec(text.slice(0, m.index).trimEnd())?.[1]?.toLowerCase()
  if (previous === undefined) return !TOGGLE_LABELS.has(last)
  return !((last === 'in' || last === 'on') && PHRASAL_VERBS.has(previous))
}

const isAmbiguousWord = (unit: TranslationUnit): boolean =>
  unit.msgctxt === undefined && AMBIGUOUS_WORDS.has(unit.msgid.trim().toLowerCase())

const referenceFile = (ref: string): string => ref.replace(/:\d+$/, '')

const HTML_TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/i
const URL = /https?:\/\//i

export const RULES: readonly Rule[] = [
  {
    id: 'translators-comment',
    level: 'error',
    fix: 'Add a /* translators: */ comment directly above the call, saying what each placeholder stands for.',
    test: (unit) =>
      forms(unit).some((t) => printfPlaceholders(t).length > 0) &&
      !unit.comments.some((c) => /^\s*translators:/i.test(c)),
  },
  {
    id: 'unordered-placeholders',
    level: 'error',
    fix: 'Number the placeholders (%1$s, %2$s), so a translation can put them in a different order.',
    test: (unit) =>
      forms(unit).some((t) => {
        const found = printfPlaceholders(t)
        return found.length >= 2 && found.some((p) => !positioned(p))
      }),
  },
  {
    id: 'plural-placeholders',
    level: 'error',
    fix: 'Use the same placeholders in the singular and the plural: "One item" beside "%d items" is wrong in languages that use the singular form for other numbers too.',
    test: (unit) => {
      if (unit.msgidPlural === undefined) return false
      const plural = printfPlaceholders(unit.msgidPlural)
      if (plural.length === 0) return false
      return unpositioned(printfPlaceholders(unit.msgid)).join(' ') !== unpositioned(plural).join(' ')
    },
  },
  {
    id: 'plural-without-count',
    level: 'error',
    fix: 'Put the number in the plural form (%d), or use __() if the text does not depend on a count.',
    test: (unit) => unit.msgidPlural !== undefined && printfPlaceholders(unit.msgidPlural).length === 0,
  },
  {
    id: 'concatenation',
    level: 'warning',
    fix: 'Make the whole sentence one string with placeholders instead of joining pieces in code; word order differs between languages.',
    test: (unit) => {
      const text = unit.msgid
      if (text.length === 0) return false
      if (text !== text.trim()) return true
      if (endsOnJoiningWord(text)) return true
      return /^[\p{P}\p{S}\s]+$/u.test(text)
    },
  },
  {
    id: 'ambiguous-word',
    level: 'warning',
    fix: 'Add a context with _x() saying whether this is a noun or a verb; many languages translate the two differently.',
    test: isAmbiguousWord,
  },
  {
    id: 'same-text-different-use',
    level: 'warning',
    fix: 'This short string is used in several files. If the uses differ, give each its own context with _x(), so each can be translated on its own.',
    test: (unit) => {
      if (unit.msgctxt !== undefined || isAmbiguousWord(unit)) return false
      const words = unit.msgid.trim().split(/\s+/).filter(Boolean)
      if (words.length < 1 || words.length > 3) return false
      // Block plugins commit build/ beside src/, and make-pot reads both, so a
      // built copy is not a second use. Counted only when a source file is
      // referenced too, so a plugin that ships only build/ is still checked.
      const files = [...new Set(unit.references.map(referenceFile))]
      const sources = files.filter((f) => !/(?:^|\/)build\//.test(f))
      return (sources.length > 0 ? sources.length : files.length) >= 2
    },
  },
  {
    id: 'markup-in-string',
    level: 'warning',
    fix: 'Keep HTML and URLs out of the string: use a placeholder and add the markup or URL in code, where a translation cannot break it.',
    test: (unit) => forms(unit).some((t) => HTML_TAG.test(t) || URL.test(t)),
  },
  {
    id: 'typography',
    level: 'warning',
    fix: 'Use the ellipsis character … instead of three full stops, and one space between words.',
    test: (unit) => forms(unit).some((t) => t.includes('...') || /\S {2,}\S/.test(t)),
  },
]
