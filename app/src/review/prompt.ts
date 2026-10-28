import { DEFAULT_REGISTER, pluralFormsLine, universalOnlyNote, type PromptOptions } from '../audit/prompt.js'
import { isUniversalOnly, profileFor } from '../audit/rules/profiles.js'
import { dateTimeLine, guidanceSection } from '../rules/guidance.js'
import { loadLocaleRules } from '../rules/load.js'
import { localeDisplayName, splitLocale } from '../wporg/locales.js'
import type { Locale, ReviewInput } from '../types.js'

// Worded as the audit prompt's tool rules are, and for the same reason: the
// glossary terms are on the entry now, so an agent that still looked each one
// up spent a round trip per term to learn what it had already been told. Run
// 313 made 50 to 86 tool calls a batch this way, against 3 to 8 for a review
// batch that carries the same terms inline. consistency_lookup is the one
// that reaches translate.wordpress.org, which answered that run with a 429,
// so it is kept for the case nothing on the entry settles. The last line is
// the review prompt's own: Gemini Flash, with antigravity's settings
// approving every tool, wrote and ran scripts in the folder it was started in.
const TOOL_RULES = (language: string) => `- The official WordPress ${language} glossary is binding. Every glossary term an entry's source contains is listed on that entry under "glossary", with its approved translation, so do not look those up. Call glossary_lookup only for a term you need that is not listed there.
- Call tm_lookup only when you are unsure of a wording and want to see how the locale worded similar strings; not for every entry.
- Call consistency_lookup only when neither the entry's glossary nor the translation memory settles the wording of a UI string WordPress core is likely to have. It reports how WordPress core already translates that exact string, which is authoritative; never call it to confirm a term the glossary already settled.
- This prompt and the three lookup tools are everything you have. There is no shell and no filesystem: never write a file or run a command.
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
  // See PromptOptions: false for a local model, which has no MCP tools. Both
  // are handed each entry's glossary terms, rendered the same way; only the
  // rules about the tools differ. The agents' rules text is hashed into the
  // configuration that keys every cached draft review (translateConfigHash),
  // so an edit to it re-asks those reviews rather than serving answers formed
  // under the old instructions.
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
        ...(input.glossary?.length
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
${tools ? TOOL_RULES(language) : NO_TOOL_RULES(language)}- Preserve the source's placeholders: %s, %d, %1$s, %2$d, {x}, {{x}}, and similar. Do not add, drop or reformat them. A numbered placeholder such as %1$s may move where the language needs it, since the code fills it by its number: a locale that puts the family name first writes "%2$s %1$s" for "%1$s %2$s". Unnumbered ones such as %s and %d are filled in turn: keep them in the source's order, or number them all (%1$s, %2$d) to move them.
- Preserve HTML tags and their attributes exactly.
- Preserve leading/trailing whitespace and newlines exactly as in the source.
- The "text" array must have exactly ${nplurals} strings for entries with msgidPlural (one per plural form, in the locale's plural order), and exactly 1 string otherwise. Never return an empty string.
${register}${dateTimeLine(locale, language)}${universalOnly}- Do not translate brand names, product names, code, shortcodes, URLs, CSS classes or option keys.
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
