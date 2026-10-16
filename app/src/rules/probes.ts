import type { LocaleRules } from './schema.js'

// The probe's half that needs no Node: the test strings, which regexes a file
// is probed for, and how a runaway is reported. rules check runs them in the
// app's sandbox (load.ts); the website's rules builder runs the same strings
// in a Web Worker before it calls a file valid, so the page and rules check
// cannot disagree about the file the page tells the person to check.

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
export const PROBE_LENGTH = 5_000
export const PROBES = ['a'.repeat(PROBE_LENGTH), 'a'.repeat(28) + '!', ' '.repeat(PROBE_LENGTH) + 'x', 'ab'.repeat(PROBE_LENGTH / 2) + '\n', 'İ'.repeat(1_000)]

export interface ProbedRegex {
  // The path in the file, for placing the error on its line.
  at: (string | number)[]
  source: string
  flags: string
}

/** Every regex the file carries, with the flags the rules themselves compile it with. */
export function probedRegexes(rules: LocaleRules): ProbedRegex[] {
  const regexes: ProbedRegex[] = []
  rules.patterns.forEach((p, i) => {
    if (p.find !== undefined) regexes.push({ at: ['patterns', i, 'find'], source: p.find, flags: `gu${p.ignoreCase ? 'i' : ''}` })
  })
  const end = rules.sentenceEnd
  end?.answers?.forEach((a, i) => {
    regexes.push({ at: ['sentenceEnd', 'answers', i, 'text'], source: a.text, flags: 'u' })
    if (a.source !== undefined) regexes.push({ at: ['sentenceEnd', 'answers', i, 'source'], source: a.source, flags: 'u' })
  })
  if (end?.notEnding !== undefined) regexes.push({ at: ['sentenceEnd', 'notEnding'], source: end.notEnding, flags: 'u' })
  return regexes
}

/** The refusal for a regex that ran past the budget, in the same words wherever it is said. */
export function runawayReason(at: (string | number)[], budgetMs: number): string {
  return `${at.join('.')} took longer than ${budgetMs} ms on a test string (a regex that can run away)`
}
