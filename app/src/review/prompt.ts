import { DEFAULT_REGISTER, pluralFormsLine, universalOnlyNote, type PromptOptions } from '../audit/prompt.js'
import { isUniversalOnly, profileFor } from '../audit/rules/profiles.js'
import { guidanceSection } from '../rules/guidance.js'
import { loadLocaleRules } from '../rules/load.js'
import { localeDisplayName, splitLocale } from '../wporg/locales.js'
import type { Locale, ReviewInput } from '../types.js'

const TOOL_RULES = (language: string) => `- Follow the official WordPress ${language} glossary. Call the glossary_lookup tool for any term that might be in it (WordPress UI vocabulary, post/page/plugin/theme/block/widget terminology, etc.) before deciding on wording.
- Call consistency_lookup only when the glossary has no answer for the wording in question. It reports how WordPress core already translates that exact string, which is authoritative; do not call it just to confirm a term the glossary already settled.
- Call tm_lookup to find near-matches in the translation memory and stay consistent with them.
`

const NO_TOOL_RULES = (language: string) => `- Follow the official WordPress ${language} glossary. An entry's "glossary" lists the approved translation of every glossary term its source contains; use it. A term that is not listed there is not in the glossary. There are no tools: this prompt is everything you have.
`

export function localeLabel(locale: Locale): string {
  const name = localeDisplayName(locale)
  return name !== splitLocale(locale).slug ? `${name} (${locale})` : `locale ${locale}`
}

export function buildReviewPrompt(
  inputs: ReviewInput[],
  locale: Locale,
  nplurals: number,
  pluralForms?: string,
  options: PromptOptions = {},
): string {
  // See PromptOptions: false for a local model, which has no MCP tools and so
  // is handed each entry's glossary terms instead. The agents' prompt is
  // unchanged byte for byte, glossary field included, because its
  // configuration hash keys every cached draft review.
  const tools = options.tools !== false
  const language = localeLabel(locale)
  // The file's line replaces the default rather than adding to it: WordPress
  // in Swedish says "du", and a neutral line left beside it would only blur
  // the instruction the team wrote.
  const register = `${(loadLocaleRules(locale)?.register?.translate ?? DEFAULT_REGISTER).replaceAll('{language}', language)}\n`
  // The same rules review runs are run on the drafts (translate/checks.ts),
  // so when those know nothing about the language this prompt says so too.
  const universalOnly = isUniversalOnly(profileFor(locale)) ? universalOnlyNote(language) : ''
  const entries = inputs
    .map((input, i) => {
      const entry = {
        id: i + 1,
        msgid: input.msgid,
        ...(input.msgctxt !== undefined ? { msgctxt: input.msgctxt } : {}),
        ...(input.msgidPlural !== undefined ? { msgidPlural: input.msgidPlural } : {}),
        comments: input.comments,
        drafts: input.drafts,
        ...(input.automatedChecks?.length ? { automatedChecks: input.automatedChecks } : {}),
        ...(input.control ? { control: true } : {}),
        ...(!tools && input.glossary?.length
          ? { glossary: Object.fromEntries(input.glossary.map((g) => [g.term, g.translations])) }
          : {}),
      }
      return `${i + 1}. ${JSON.stringify(entry)}`
    })
    .join('\n')

  return `You are a senior WordPress ${language} translator reviewing machine-translated drafts of WordPress .po entries.
Target locale: ${locale}
nplurals: ${nplurals}
${pluralFormsLine(nplurals, pluralForms)}
Rules:
${tools ? TOOL_RULES(language) : NO_TOOL_RULES(language)}- Preserve placeholders exactly as in the source: %s, %d, %1$s, %2$d, {x}, {{x}}, and similar. Do not add, drop, reorder or reformat them.
- Preserve HTML tags and their attributes exactly.
- Preserve leading/trailing whitespace and newlines exactly as in the source.
- The "text" array must have exactly ${nplurals} strings for entries with msgidPlural (one per plural form, in the locale's plural order), and exactly 1 string otherwise. Never return an empty string.
${register}${universalOnly}- Do not translate brand names, product names, code, shortcodes, URLs, CSS classes or option keys.
- Use the .po comments and msgctxt to disambiguate; they describe where and how the string is used.
- An entry marked "control" is a setting WordPress code reads, not text: "on" or "off" for a font, "ltr" for text direction, a language tag, a number separator. Its draft is the source value. Set it to the value its translator comment says fits this locale. Never translate the English word.
- Some entries carry "automatedChecks": findings from deterministic checks the draft failed. Fix the ones that are real problems in your text and ignore the ones that are not. A check about placeholders, HTML or the number of plural forms is always real.
${guidanceSection(locale)}
Fuzzy rule:
- Set fuzzy=true ONLY when a competent human should double-check the entry: ambiguous source text, a glossary conflict, uncertain context, or uncertainty about placeholders or HTML.
- Otherwise fuzzy=false. The goal is minimal human review, so do not over-flag. A confident, glossary-compliant translation is not fuzzy.
- Put a short justification in "reason" (why it is fuzzy, or what you checked).

Output:
- Return a JSON object matching the provided schema: { "results": [ { "id", "text", "fuzzy", "reason" } ] }.
- "id" is the integer id of the entry as given below. The output must contain exactly one result per input id, from 1 to ${inputs.length}. No extra ids, no missing ids, no duplicates.

Entries (${inputs.length}):
${entries}
`
}
