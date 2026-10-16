import { readFileSync, statSync } from 'node:fs'
import { localeFileTag, wpCodeOf } from '../wporg/locales.js'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { configDir } from '../paths.js'
import type { Locale } from '../types.js'
import { PATTERN_BUDGET_MS, runRegexOps, skippedFor, type RegexOp } from './sandbox.js'
import { parseRulesDocument, RulesFileError } from './parse.js'
import type { LocaleRules } from './schema.js'

// The parser itself lives in parse.ts, which the website's rules builder
// bundles for the browser. Re-exported so every reader of a rules file keeps
// importing from one place.
export { RulesFileError } from './parse.js'

// Named by the WordPress code (tr_TR.yaml, nl_NL_formal.yaml): the name
// translators recognise, and always a valid file name, which nl/formal is not.
// A locale missing from the wp.org table falls back to its id, slash replaced.
export function localeRulesFile(locale: Locale): string {
  return join(configDir(), 'locales', `${wpCodeOf(locale) ?? localeFileTag(locale)}.yaml`)
}

/**
 * Parses and validates a rules file's text: parse.ts's parser, which places a
 * syntax or schema error on its line.
 *
 * With `probe`, every regex the file carries is also run once over PROBES in
 * the sandbox, and one that runs past the budget is an error on its line.
 * Only rules check asks, and so rules fetch: a review already survives a
 * runaway pattern, and loading a file for one should not cost a second of
 * probing every time.
 */
export function parseLocaleRules(text: string, path: string, opts: { probe?: boolean } = {}): LocaleRules {
  const { rules, lineOf } = parseRulesDocument(text, path)
  if (opts.probe) {
    const runaway = probe(rules)
    if (runaway) {
      throw new RulesFileError(
        path,
        `${runaway.join('.')} took longer than ${PATTERN_BUDGET_MS} ms on a test string (a regex that can run away)`,
        lineOf(runaway),
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
