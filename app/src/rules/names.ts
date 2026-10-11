import type { AuditCategory } from '../audit/schema.js'

// The built-in rules a locale file may switch on or off, by name. Kept here
// rather than read from RULES in audit/rules/index.ts because that module
// imports the profile, which imports the rules file loader, which needs these
// names: reading them from RULES would be a circular import. A test holds this
// list and RULES together.
export const BUILT_IN_RULES = [
  'placeholder',
  'html',
  'plural-count',
  'whitespace',
  'untranslated',
  'escaping',
  'punctuation',
  'line-breaks',
  'ampersand',
  'number-format',
  'title-case',
  'glossary',
  'apostrophe',
  'inconsistent',
  'tm-conflict',
  'control',
] as const

// Mistakes and patterns from a locale file. Never switched on by name: it runs
// whenever the file has any.
export const CUSTOM_RULE = 'custom'

export type BuiltInRule = (typeof BUILT_IN_RULES)[number]

/**
 * What a reader is told a finding key means: on the stats page, and on the
 * TUI's locale rules screen.
 *
 * `source` separates the mechanical from the judged. A rule hit is a fact a
 * deterministic check established; an AI finding is a model's opinion about
 * wording; a process key says the pipeline itself could not do its job. The
 * stats page draws the first two apart because they deserve different trust,
 * which the page's caveat already says in words.
 */
export interface FindingLabel {
  name: string
  description: string
  source: 'rule' | 'ai' | 'process'
}

type Label = Omit<FindingLabel, 'source'>

// A Record over BuiltInRule, so a rule added to the list above fails the
// typecheck until it has a name here. That is the point: a rule that ships
// unlabelled reaches contributors as a bare key like "tm-conflict".
const RULE_LABELS: Record<BuiltInRule | typeof CUSTOM_RULE | 'repaired', Label> = {
  placeholder: {
    name: 'Placeholder missing or added',
    description: 'A placeholder such as %s or {name} in the source is missing from the translation, or one was added.',
  },
  html: { name: 'HTML tags differ', description: 'The translation has different HTML tags from the source.' },
  'plural-count': {
    name: 'Wrong number of plural forms',
    description: 'The translation fills a different number of plural forms than the language has.',
  },
  whitespace: {
    name: 'Leading or trailing space',
    description: 'Spaces or line breaks at the start or end differ from the source.',
  },
  untranslated: { name: 'Left in English', description: 'The translation is identical to the English source.' },
  escaping: {
    name: 'Escaped quotes differ',
    description: 'The source and translation escape quotes differently, so a backslash may show on screen.',
  },
  punctuation: {
    name: 'Ending punctuation differs',
    description: 'A colon, ellipsis or full stop that ends the source is missing from the translation, or was added.',
  },
  'line-breaks': { name: 'Line breaks differ', description: 'The translation has a different number of line breaks.' },
  ampersand: {
    name: 'Ampersand written as a word',
    description: 'The translation keeps “&” where the language writes the conjunction as a word.',
  },
  'number-format': {
    name: 'Number or percent format',
    description: 'A number or percent sign is written the English way rather than the language’s.',
  },
  'title-case': {
    name: 'Title case',
    description: 'Words are capitalised mid-sentence, usually copied from English headline style.',
  },
  glossary: { name: 'Glossary term not used', description: 'A term from the locale glossary is translated differently.' },
  apostrophe: {
    name: 'Missing apostrophe before a suffix',
    description: 'A proper noun takes a suffix without the apostrophe the language requires.',
  },
  inconsistent: {
    name: 'Inconsistent within the file',
    description: 'The same English string is translated in different ways in one file.',
  },
  'tm-conflict': {
    name: 'Differs from approved translations',
    description: 'The translation memory holds a different approved translation of the same string.',
  },
  control: {
    name: 'Setting translated as text',
    description: 'A value WordPress reads as a setting, such as “on” or “ltr”, was translated as if it were text.',
  },
  custom: {
    name: 'Locale rule',
    description: 'A mistake or pattern from the locale’s own rules file.',
  },
  // Written by the audit itself, not by a rule in the list above, when it puts
  // back whitespace or applies a locale fix pattern before the rules judge.
  repaired: {
    name: 'Repaired automatically',
    description: 'Whitespace or a locale fix pattern was corrected mechanically before review.',
  },
}

// The model's categories, which reach the run tally as `ai:<category>`. A
// Record over the schema's own list for the same reason as the rules.
const AI_LABELS: Record<AuditCategory, Label> = {
  meaning: {
    name: 'Meaning (AI)',
    description: 'The model judged that the translation says something different from the source.',
  },
  glossary: { name: 'Glossary (AI)', description: 'The model judged that a glossary term was not followed.' },
  'title-case': {
    name: 'Capitalisation (AI)',
    description: 'The model judged that words are capitalised where the language would not.',
  },
  register: {
    name: 'Tone and formality (AI)',
    description: 'The model judged the tone too casual, too stiff, or inconsistent in how it addresses the reader.',
  },
  fluency: {
    name: 'Fluency (AI)',
    description: 'The model judged the wording correct but unnatural, often a word-for-word calque.',
  },
  placeholder: { name: 'Placeholder (AI)', description: 'The model judged that a placeholder is misused or misplaced.' },
  other: { name: 'Other (AI)', description: 'The model flagged a problem that fits none of the other categories.' },
}

// Keys the audit writes by hand. fix-rejected counts with the AI findings
// because it is the model's proposal that failed, and fix-suspect for the same
// reason: the rules found it, but in the model's text, not the contributor's.
// unreviewed is neither rule nor model but the pipeline saying it could not look.
//
// Being in this list is also what lets a key into the usage payload
// (usage/payload.ts sends only FINDING_KEYS). That is meant for both fix keys:
// they fire for every locale, wherever the model's fix lands, so their counts
// name no locale, and they say how often the model's own repairs go wrong,
// which is the number worth having from installs.
const OTHER_LABELS: Record<'fix-rejected' | 'fix-suspect' | 'unreviewed', FindingLabel> = {
  'fix-rejected': {
    name: 'AI fix rejected',
    description: 'The model proposed a fix that failed the mechanical checks, so it was not applied.',
    source: 'ai',
  },
  'fix-suspect': {
    name: 'AI fix needs a look',
    description: 'The model’s fix was applied, but the checks found something in it the submitted text did not have.',
    source: 'ai',
  },
  unreviewed: {
    name: 'Could not be reviewed',
    description: 'The automated review failed for this entry, so it was set aside for a human.',
    source: 'process',
  },
}

const LABELS = new Map<string, FindingLabel>([
  ...Object.entries(RULE_LABELS).map(([key, l]): [string, FindingLabel] => [key, { ...l, source: 'rule' }]),
  ...Object.entries(AI_LABELS).map(([key, l]): [string, FindingLabel] => [`ai:${key}`, { ...l, source: 'ai' }]),
  ...Object.entries(OTHER_LABELS),
])

/** Every finding key that has a label, in a stable order for the translation template. */
export const FINDING_KEYS: readonly string[] = [...LABELS.keys()]

/** The label for a finding key, or undefined for a key no current code writes. */
export function findingLabel(key: string): FindingLabel | undefined {
  return LABELS.get(key)
}
