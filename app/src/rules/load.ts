import { readFileSync, statSync } from 'node:fs'
import { localeFileTag, wpCodeOf } from '../wporg/locales.js'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { LineCounter, parseDocument } from 'yaml'
import { configDir } from '../paths.js'
import type { Locale } from '../types.js'
import { PATTERN_BUDGET_MS, runRegexOps, skippedFor, type RegexOp } from './sandbox.js'
import { localeRulesSchema, MAX_SCHEMA, normalise, type LocaleRules } from './schema.js'

export class RulesFileError extends Error {
  readonly path: string
  readonly line: number | undefined
  readonly col: number | undefined
  // The message without the path and position in front of it, for a caller
  // that reports those in fields of their own (rules check --json).
  readonly reason: string

  constructor(path: string, message: string, line?: number, col?: number) {
    super(`${path}${line === undefined ? '' : `:${line}${col === undefined ? '' : `:${col}`}`} ${message}`)
    this.name = 'RulesFileError'
    this.path = path
    this.line = line
    this.col = col
    this.reason = message
  }
}

// Named by the WordPress code (tr_TR.yaml, nl_NL_formal.yaml): the name
// translators recognise, and always a valid file name, which nl/formal is not.
// A locale missing from the wp.org table falls back to its id, slash replaced.
export function localeRulesFile(locale: Locale): string {
  return join(configDir(), 'locales', `${wpCodeOf(locale) ?? localeFileTag(locale)}.yaml`)
}

/**
 * Parses and validates a rules file's text.
 *
 * A syntax error carries the line and column yaml reports. A schema error is
 * placed on the line of the value it is about, when the document can resolve
 * that path, so "patterns.2.find is not a valid regular expression" points at
 * the line to fix rather than leaving the person to count list items.
 *
 * With `probe`, every regex the file carries is also run once over PROBES in
 * the sandbox, and one that runs past the budget is an error on its line.
 * Only rules check asks, and so rules fetch: a review already survives a
 * runaway pattern, and loading a file for one should not cost a second of
 * probing every time.
 */
export function parseLocaleRules(text: string, path: string, opts: { probe?: boolean } = {}): LocaleRules {
  const lines = new LineCounter()
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false })
  const syntax = doc.errors[0]
  if (syntax) {
    const at = lines.linePos(syntax.pos[0])
    throw new RulesFileError(path, syntax.message.split('\n')[0] ?? 'invalid YAML', at.line, at.col)
  }
  const js: unknown = doc.toJS() ?? {}
  const declared = typeof js === 'object' && js !== null && 'schema' in js ? (js as { schema: unknown }).schema : undefined
  if (declared !== undefined) {
    const node = doc.get('schema', true) as { range?: [number, number, number] } | undefined
    const line = node?.range ? lines.linePos(node.range[0]).line : undefined
    const whole = typeof declared === 'number' && Number.isInteger(declared)
    // Checked before the shape: a newer file may use keys this polyglots has
    // never heard of, and "update polyglots" is the useful answer, not the
    // first unknown key it happens to reach.
    if (whole && declared > MAX_SCHEMA) {
      throw new RulesFileError(path, `needs rules schema ${declared}; this polyglots reads up to ${MAX_SCHEMA}. Update polyglots.`, line)
    }
    if (!whole || declared < 1) {
      throw new RulesFileError(path, `schema must be a whole number from 1 to ${MAX_SCHEMA}`, line)
    }
  }
  const parsed = localeRulesSchema.safeParse(js)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    const dotted = issue.path.join('.')
    const node = issue.path.length > 0 ? doc.getIn(issue.path, true) : undefined
    const range = (node as { range?: [number, number, number] } | undefined)?.range
    const line = range ? lines.linePos(range[0]).line : undefined
    throw new RulesFileError(path, `${dotted ? `${dotted} ` : ''}${issue.message}`, line)
  }
  const rules = normalise(parsed.data)
  if (opts.probe) {
    const runaway = probe(rules)
    if (runaway) {
      const range = (doc.getIn(runaway, true) as { range?: [number, number, number] } | undefined)?.range
      throw new RulesFileError(
        path,
        `${runaway.join('.')} took longer than ${PATTERN_BUDGET_MS} ms on a test string (a regex that can run away)`,
        range ? lines.linePos(range[0]).line : undefined,
      )
    }
  }
  return rules
}

/**
 * Strings that make a runaway regex run away: long runs of one character,
 * the same run ending in a character that breaks the match (the bait for
 * nested repetition), long whitespace, a long alternation of two letters, and
 * a long run of a letter whose case mapping is not one to one. A second line
 * behind polyglots-data's own check, for the files people write themselves.
 *
 * The long runs are as long as the longest WordPress string, not longer. The
 * spec first asked for 30,000 characters, and at that length any quadratic
 * pattern looks like a runaway: a hint as ordinary as \w+: or (\p{L}+) \1
 * took over 200 ms there, while it takes well under a millisecond on any real
 * entry, and \s+$ passed at about 70 ms, so whether a file was valid depended
 * on how fast and how busy the machine was. rules fetch reuses this probe, so
 * one contributor's laptop could refuse a file another's accepted. The
 * question the probe answers is whether a pattern would hang on a real entry,
 * which is what the review's own budget would otherwise find out the hard
 * way. The longest msgid across 67 exported projects (wp/dev, meta, the top
 * plugins and themes, the apps) is 3,789 characters, in meta/plugins-v3;
 * 5,000 covers it with room. At that length a quadratic hint costs a few
 * milliseconds, a cubic one still runs for seconds, and nested repetition is
 * caught by the 28-character bait whatever the length.
 *
 * The dotted capital I is shorter again. It is there for its case mapping
 * under the i flag, not for its length, and V8 steps through a Unicode
 * property class like \p{L} about twenty times slower on a letter outside
 * ASCII: (\p{L}+) \1 took 370 ms over 5,000 of them and 60 ms over 2,000,
 * the same knife edge again. A thousand is already far longer than any word,
 * and a quadratic pattern costs about 15 ms there.
 *
 * Literal patterns are not probed: they compile to a sequence of fixed
 * alternatives, which cannot backtrack without bound, and expanding them
 * needs the locale, which a file read by path does not have.
 */
const PROBE_LENGTH = 5_000
export const PROBES = ['a'.repeat(PROBE_LENGTH), 'a'.repeat(28) + '!', ' '.repeat(PROBE_LENGTH) + 'x', 'ab'.repeat(PROBE_LENGTH / 2) + '\n', 'İ'.repeat(1_000)]

// The path in the file of the first regex that ran past the budget, or
// undefined when none did. Flags as the rules themselves compile them.
function probe(rules: LocaleRules): (string | number)[] | undefined {
  const regexes: { at: (string | number)[]; source: string; flags: string }[] = []
  rules.patterns.forEach((p, i) => {
    if (p.find !== undefined) regexes.push({ at: ['patterns', i, 'find'], source: p.find, flags: `gu${p.ignoreCase ? 'i' : ''}` })
  })
  const end = rules.sentenceEnd
  end?.answers?.forEach((a, i) => {
    regexes.push({ at: ['sentenceEnd', 'answers', i, 'text'], source: a.text, flags: 'u' })
    if (a.source !== undefined) regexes.push({ at: ['sentenceEnd', 'answers', i, 'source'], source: a.source, flags: 'u' })
  })
  if (end?.notEnding !== undefined) regexes.push({ at: ['sentenceEnd', 'notEnding'], source: end.notEnding, flags: 'u' })
  // Keyed by the regex itself, so probing the same file twice in a TUI
  // session finds the runaway it found the first time without running it.
  const idOf = (r: (typeof regexes)[number]) => `probe:${r.flags}\u0000${r.source}`
  const ops: RegexOp[] = regexes.flatMap((r) => PROBES.map((text) => ({ kind: 'exec' as const, id: idOf(r), source: r.source, flags: r.flags, text })))
  if (ops.length > 0) runRegexOps(ops)
  return regexes.find((r) => skippedFor(idOf(r)))?.at
}

// Keyed by path and modification time, so a file edited between two runs of
// one menu session applies to the second run without a restart, and an
// unchanged file is not re-read for every entry the rules look at.
const cache = new Map<string, { mtimeMs: number; rules: LocaleRules }>()

/** The locale's rules file, or undefined when there is none. Throws on an invalid file. */
export function loadLocaleRules(locale: Locale): LocaleRules | undefined {
  const path = localeRulesFile(locale)
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    cache.delete(path)
    return undefined
  }
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === mtimeMs) return hit.rules
  const rules = parseLocaleRules(readFileSync(path, 'utf8'), path)
  cache.set(path, { mtimeMs, rules })
  return rules
}

const isEmpty = (r: LocaleRules) =>
  r.rules === undefined &&
  r.glossaryStemRatio === undefined &&
  r.properNouns === undefined &&
  r.patterns.length === 0 &&
  r.guidance === undefined &&
  r.capitalization === undefined &&
  r.register === undefined &&
  r.formality === undefined &&
  r.sentenceEnd === undefined

/**
 * A stable fingerprint of a locale's rules, for the review fingerprint and so
 * for configHash. Empty when there is no file, which keeps every existing
 * cache key exactly as it was for anyone who never writes one.
 */
export function rulesFingerprint(rules: LocaleRules | undefined): string {
  // A file that sets nothing is no file. The defaults rules edit writes are
  // commented out, and opening the editor must not re-review anything.
  if (!rules || isEmpty(rules)) return ''
  // The schema number is left out: it says which keys the file may use, not
  // what the rules are, so adding schema: 2 to a file changes no cache key.
  // Stripping it also keeps the hash of every schema-1 file exactly what it
  // was before the field existed.
  const { schema: _schema, ...meaning } = rules
  return createHash('sha256').update(JSON.stringify(meaning)).digest('hex')
}
