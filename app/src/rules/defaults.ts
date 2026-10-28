import { builtInProfileFor, UNIVERSAL_RULES } from '../audit/rules/profiles.js'
import { wpCodeOf } from '../wporg/locales.js'
import { builtInProperNounsFor } from '../audit/rules/proper-nouns.js'
import type { Locale } from '../types.js'
import { CAPITALIZATION_LIMIT, GUIDANCE_LIMIT, REGISTER_LIMIT } from './schema.js'

/** The first line of a rules file, which rules copy rewrites for the target. */
export const rulesHeader = (locale: Locale) => `# polyglots rules for ${wpCodeOf(locale) ?? locale} (${locale})`

const list = (items: readonly string[]) => `[${items.map((i) => JSON.stringify(i)).join(', ')}]`

// Examples that name no language, for every locale. The Turkish and Swedish
// templates once showed their own pack's examples; with the packs gone, a
// locale's real mistakes and patterns come from its team's file in
// polyglots-data, and the template only has to show the shape. A German team
// is not shown a Turkish spelling rule as the model of what to write.
const NEUTRAL_EXAMPLES = {
  mistakes: ['  - wrong: a wording your team rejects', '    right: the wording it uses instead', '    note: Why, for the reviewer'],
  patterns: ["  - find: ' {2,}'", "    replace: ' '", '    level: fix', '    note: One space between words'],
}

/**
 * The file `rules edit` writes when a locale has none: today's built-in
 * behaviour, spelled out, and an example of every section.
 *
 * Written with the built-in values commented out by default. A file that sets
 * nothing fingerprints as empty, so opening the editor and closing it again
 * changes no cache key and re-reviews nothing. The schema line is live even
 * so, and is safe there: the fingerprint leaves the schema number out, and
 * declaring 2 up front means uncommenting a schema-2 example below works
 * instead of being refused for want of a line nobody remembered to add.
 * `commented: false` writes the same values live, which is how a test proves
 * they match the code.
 */
export function renderDefaultRules(locale: Locale, opts: { commented?: boolean } = {}): string {
  const live = opts.commented === false
  const c = (line: string) => (live ? line : `# ${line}`)
  const profile = builtInProfileFor(locale)
  const nouns = builtInProperNounsFor(locale)
  const extras = [...profile.rules].filter((r) => !UNIVERSAL_RULES.includes(r))
  const examples = NEUTRAL_EXAMPLES

  return [
    rulesHeader(locale),
    '#',
    '# Every section is optional. A section left out keeps the built-in behaviour.',
    '# The built-in values are shown commented out; uncomment a section to change it.',
    '# Any change re-reviews files of this locale from scratch on their next run.',
    '# Check the file with: polyglots rules check ' + locale,
    '',
    '# The rules format version. polyglots refuses a file newer than it reads.',
    'schema: 2',
    '',
    `# Rules that always run unless disabled: ${UNIVERSAL_RULES.join(', ')}`,
    c('rules:'),
    c(`  enable: ${list(extras)}`),
    c('  disable: []'),
    '',
    '# How much of a glossary term must match an inflected form, between 0 and 1.',
    c(`glossaryStemRatio: ${profile.glossaryStemRatio}`),
    '',
    '# Names capitalized everywhere (always), and only inside a specific date (dateOnly).',
    c('properNouns:'),
    c(`  always: ${list(nouns.always)}`),
    c(`  dateOnly: ${list(nouns.dateOnly)}`),
    '',
    '# Common mistakes: found anywhere in a translation, case-insensitive.',
    '# The AI review weighs each match with your note.',
    'mistakes: []',
    ...examples.mistakes.map((line) => `#${line}`),
    '',
    '# Patterns: "text" (a literal) or "find" (a regular expression).',
    '# level: hint (the AI judges), error (always wrong, the AI must fix) or fix (replaced automatically).',
    '# "when: { source: ... }" applies a pattern only when the English source contains that text,',
    '# and "when: { notSource: ... }" only when it does not.',
    'patterns: []',
    ...examples.patterns.map((line) => `#${line}`),
    '',
    `# Guidance added to the AI review prompts, at most ${GUIDANCE_LIMIT} characters.`,
    '# guidance: |',
    '#   Button labels are verbs in the imperative.',
    '',
    `# How the language capitalizes, told to the AI review when title-case runs, at most ${CAPITALIZATION_LIMIT} characters.`,
    '# {language} is replaced with the language name.',
    '# capitalization: |',
    '#   - {language} uses sentence case ...',
    '',
    `# The register the AI prompts ask for, at most ${REGISTER_LIMIT} characters.`,
    '# One line for both prompts, or { audit: ..., translate: ... } for each.',
    "# register: '- Address the reader as ...'",
    '',
    '# formal or informal: how a draft addresses the reader, in DeepL and the AI engines.',
    '# formality: informal',
    '',
    '# How a sentence ends in the language, for the punctuation check.',
    '# unmarked: the language writes no final mark. Also answers and notEnding.',
    '# sentenceEnd:',
    '#   unmarked: true',
    '',
    '# The two below need schema: 3 in the line at the top, which polyglots 1.2 and later read.',
    '',
    '# How the language writes dates and times, for the date-format check and the AI prompts.',
    '# clock: 24h or 12h. order: dmy, mdy or ymd. formats: what common English PHP formats become.',
    '# dateTime:',
    '#   clock: 24h',
    '#   order: dmy',
    '#   formats:',
    "#     'F j, Y': 'j F Y'",
    '',
    '# Which name the language writes first: given-first, as English does, or family-first.',
    '# family-first checks full names such as "%1$s %2$s" and adds a line to the AI prompts.',
    '# names:',
    '#   order: family-first',
    '',
  ].join('\n')
}
