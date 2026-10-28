import type { Finding, Locale } from '../types.js'
import { localeDisplayName } from '../wporg/locales.js'
import type { GlossaryMatch } from './rules/index.js'
import { AUDIT_CATEGORIES } from './schema.js'
import { isUniversalOnly, profileFor } from './rules/profiles.js'
import { dateTimeLine, guidanceSection } from '../rules/guidance.js'
import { loadLocaleRules } from '../rules/load.js'
import { isSkipFinding } from '../rules/custom.js'

const GLOSSARY_LIMIT = 12

/**
 * The register line both review prompts carry for a locale whose rules file
 * says nothing about register. It used to ask for "the formal, neutral
 * register ... no over-familiar address", which asserted a convention that is
 * wrong for Swedish, Spanish and others: WordPress in those languages says
 * "du" or "tú", and a reviewer told to avoid over-familiar address proposes the
 * polite form as a fix, written into a contributor's work. This line names no
 * convention and leaves the choice to what the locale already does; a team
 * that wants one states it in its file. Exported for the draft review prompt,
 * which must say the same thing in the same words.
 */
export const DEFAULT_REGISTER =
  '- Use the register that is standard in WordPress {language}. Keep the tone neutral and concise, with no slang.'

export interface AuditCandidate {
  id: number
  key: string
  msgid: string
  msgctxt?: string
  msgidPlural?: string
  msgstr: string[]
  comments: string[]
  references: string[]
  hints: Finding[]
  // The binding glossary terms this source contains, with their approved
  // translations, resolved before the prompt is built. Carried inline because
  // the alternative is a tool call per term, and an agent that issues those one
  // at a time spends most of a batch on them.
  glossary?: GlossaryMatch[]
  // Every wording this exact source has been translated and approved as, from
  // the local memory. Carried inline for the same reason the glossary terms
  // are: asking costs a round trip, and tm_lookup was 44% of every tool call an
  // agent made. More than one means the locale has approved each of them, so
  // the model is choosing between settled options rather than judging one.
  memory?: readonly string[]
  // Carries a rules-side mechanical repair through the batch round trip, since
  // toVerdict and unreviewed build a fresh Verdict per candidate and would
  // otherwise lose it.
  repaired?: { text: string[]; repairedBy: 'rules' }
  // Set when the deterministic rules already proved this entry wrong. Its
  // verdict is settled; the model is being asked for a fix, not an opinion.
  condemned?: Finding[]
  // A setting WordPress code reads ("on" for a font switch), not text.
  control?: boolean
}

function languageName(locale: Locale): string {
  return localeDisplayName(locale)
}

// For a locale that turns title-case on with no capitalization paragraph in
// its rules file to say how its own orthography works: what sentence case
// means, and nothing about TDK or any other language's institutions and
// examples.
const GENERIC_CAPITALIZATION = `- {language} capitalizes only the first word of a sentence and proper nouns, not every word as English Title Case does. Brand names (WordPress, WooCommerce) and acronyms keep their own casing.
- A capital mid-string is legitimate when the word is a proper noun in {language}. An automated check cannot recognize most proper nouns, so when a title-case finding is really one of them, clear it.
- A title-case finding that says the translation "mirrors the English source" is close to proof of an English calque. One that only says a word is capitalized mid-string is weaker: check what the word refers to before confirming it.
`

/**
 * Said in both review prompts when the checks that ran know nothing about the
 * language, so the model does not read an entry with no automatedChecks as one
 * that passed a spelling or capitalization check. Exported for the draft
 * review prompt, which must say the same thing in the same words.
 */
export function universalOnlyNote(language: string): string {
  return `- The automated checks for ${language} are only the universal ones: placeholders, HTML, whitespace, plural count, glossary and the like. Nothing language-specific is checked, so the absence of a finding says nothing about spelling, capitalization or grammar.\n`
}

/**
 * The catalogue's Plural-Forms header, above two forms. With one or two the
 * count says everything, and leaving the line out keeps those prompts, and so
 * every cached verdict for them, exactly as they were. With three or more
 * only the expression says which index is "few" and which is "many".
 */
export function pluralFormsLine(nplurals: number, pluralForms: string | undefined): string {
  return nplurals > 2 && pluralForms ? `Plural-Forms: ${pluralForms}\n` : ''
}

/**
 * The findings a model is asked to adjudicate, rendered as both review prompts
 * list them: the audit's for a contributor's text and the draft review's for
 * translate's own drafts. One function for the prompt and for the cache key,
 * because the key has to cover exactly what the prompt renders: keyed on the
 * findings before this filter, a skip that the prompt never showed would still
 * move the key, and a verdict would be paid for twice over a prompt that had
 * not changed.
 *
 * Two kinds are withheld. The mechanical repair is a decided fact, not an open
 * check: listing it would ask the model to adjudicate the one finding that
 * needs no adjudication, and invite a fix for an entry that already has one.
 * A locale pattern that ran past its budget on this text speaks of the rules
 * file, not of the text (maintainer ruling 2026-10-16): the model cannot
 * answer for a regex it never sees, and a check it cannot weigh invites a
 * guess either way on a contributor's work. The person reads it in the
 * problems file and in the run summary instead.
 */
export function automatedChecks(hints: readonly Finding[]): string[] {
  return hints.filter((h) => h.rule !== 'repaired' && !isSkipFinding(h)).map((h) => `${h.rule}: ${h.message}`)
}

/**
 * The prompt for one batch.
 *
 * The entry count is stated rather than left to be counted, which is a line of
 * text bought with a lost batch of a hundred: antigravity pasted all 32KB of
 * one into a python heredoc whose entire body was len(lines), asked for a
 * shell headless mode cannot grant, was soft-denied and produced nothing at
 * all. It happened at batch size 50 as well, where the same instinct reached
 * for a scratch file to validate its own output, so it is not a property of
 * large batches. An agent told the number has no reason to derive it.
 *
 * The count differs between batches while the per-entry cache key does not,
 * which is deliberate and matches batchSize being left out of the review
 * fingerprint: how many entries sit beside an entry cannot change whether that
 * entry's own translation is wrong. What this wording does change is the
 * configuration hash, through fingerprintReview, so editing it prunes the
 * cached verdicts for the locale. That is the intended cost of changing the
 * question.
 */
export interface PromptOptions {
  // False for a reviewer that has no MCP tools: a local chat model. The
  // glossary terms and the memory are already on each entry, so what changes
  // is only what the prompt promises. Absent or true gives the agents' prompt
  // byte for byte, which the configuration hash and every cached verdict
  // depend on.
  tools?: boolean
}

export function buildAuditPrompt(
  candidates: AuditCandidate[],
  locale: Locale,
  nplurals: number,
  pluralForms?: string,
  options: PromptOptions = {},
): string {
  const tools = options.tools !== false
  const language = languageName(locale)
  const profile = profileFor(locale)
  const file = loadLocaleRules(locale)
  const fill = (text: string) => text.replaceAll('{language}', language)
  // Orthography guidance follows the locale's profile, not its name. Telling a
  // German reviewer that "German does not use English Title Case" would be false,
  // and would have it flag correct capitalization all day. The paragraph itself
  // comes from the rules file: the Turkish one is TDK text with Turkish
  // examples, and gating it on the rule name alone sent it to any team that
  // turned title-case on without writing its own.
  const capitalization = profile.rules.has('title-case')
    ? fill(file?.capitalization ?? GENERIC_CAPITALIZATION)
    : `- Follow ${language}'s own capitalization rules. Do not import English conventions, and do not treat a capital that ${language} requires as an error.
`
  const register = `${fill(file?.register?.audit ?? DEFAULT_REGISTER)}\n`
  const entries = candidates
    .map((c) => {
      const payload: Record<string, unknown> = { id: c.id, source: c.msgid, submitted: c.msgstr }
      if (c.msgctxt) payload.msgctxt = c.msgctxt
      if (c.msgidPlural) payload.sourcePlural = c.msgidPlural
      if (c.comments.length > 0) payload.comments = c.comments
      if (c.references.length > 0) payload.references = c.references
      const checks = automatedChecks(c.hints)
      if (checks.length > 0) payload.automatedChecks = checks
      // Capped, because a long source can touch a dozen terms and the list is
      // repeated for every entry in the batch. The cap is generous enough that
      // hitting it means the string is long enough for the model to ask.
      if (c.glossary && c.glossary.length > 0) {
        payload.glossary = Object.fromEntries(c.glossary.slice(0, GLOSSARY_LIMIT).map((g) => [g.term, g.translations]))
      }
      if (c.memory && c.memory.length > 0) payload.memory = c.memory
      if (c.repaired) payload.alreadyRepaired = true
      // Carried as a field rather than named as a list of rules in the guidance
      // below, so adding an error rule keeps the instruction true on its own.
      if (c.condemned) payload.condemned = true
      if (c.control) payload.control = true
      return JSON.stringify(payload)
    })
    .join('\n')

  return `You are the ${language} Locale Manager for WordPress, reviewing translations submitted by contributors to translate.wordpress.org. Many submissions are machine-translated or AI-generated. Your job is triage: decide which entries a human must fix before approval, and let the rest through.

Target locale: ${locale}
nplurals: ${nplurals}
${pluralFormsLine(nplurals, pluralForms)}
The locale team's standards:
- The official WordPress ${language} glossary is binding. Every glossary term an entry's source contains is listed on that entry under "glossary", with its approved translation, so you do not need to look those up. ${tools ? 'Call glossary_lookup only for a term you need that is not listed there.' : 'A term that is not listed there is not in the glossary.'}
${capitalization}${dateTimeLine(locale, language)}${isUniversalOnly(profile) ? universalOnlyNote(language) : ''}- Each entry's "references" are the source file and line the string comes from, and they are the best clue to its role: a path like admin-menu.php or help.php points at a label or a heading, while one like actions.php, or a translation in the imperative, points at a command.
- Placeholders (%s, %1$s, %d, {x}) must be the ones the source has, none added and none dropped. A numbered placeholder such as %1$s may move where the language needs it, since the code fills it by its number: a locale that puts the family name first writes "%2$s %1$s" for "%1$s %2$s". But keep unnumbered ones such as %s and %d in the source's order, since the code fills them in turn. HTML tags and leading/trailing whitespace must match the source exactly.
${register}- An entry's "memory" lists how this exact source has been translated and approved before, and every wording in it is already approved. Prefer one of them unless the source means something different here, or it breaks one of the standards above; where there are several, they are alternatives the locale accepts and any of them is a correct answer. ${tools ? 'You do not need tm_lookup for an entry that has one; call it only for near matches to an entry that has none. Call consistency_lookup to see how WordPress core already translates a string. ' : ''}Prefer established usage over a fresh invention.
${guidanceSection(locale)}
Some entries carry an "automatedChecks" list: findings from deterministic checks that could not be decided mechanically. ${language} may inflect a glossary term so it no longer matches the dictionary form exactly, and a check may be wrong on that basis. Adjudicate each one: confirm it only if it is a real problem, and clear it otherwise. Entries with no automatedChecks still need your own judgment on meaning, register and fluency.

An entry marked "alreadyRepaired" had its leading and trailing whitespace restored to match the source before it reached you. That part is settled and is not yours to weigh: judge the translation as it now stands.

Mark problem=true only when a human should change the translation before it is approved. Do not flag a translation that is merely different from how you would word it; the bar is "wrong or against the standards", not "not my preference". Every flagged entry costs the reviewer time, so be strict about accuracy but not about taste.

Categories: ${AUDIT_CATEGORIES.join(', ')}. Use an empty array when problem is false. Keep "reason" to one short sentence, written for the contributor, saying what is wrong (or why a flagged check was cleared).

- When an entry is a problem, also return "fix": the corrected translation, as an array with one string per plural form. It must obey every standard above: the glossary, this locale's capitalization rules, the source's placeholders and HTML exactly, and the register above.
- If you are not confident what the entry should say, leave "fix" out entirely. An honest "I do not know" is worth more than a confident wrong translation, which a human then has to catch.
- An entry marked "control" is a setting WordPress code reads, not text a person reads: "on" or "off" for a font, "ltr" for text direction, a language tag, a number separator. Its translator comment says which value to use. Never translate the English word; a fix is one of the values the comment names.
- An entry marked "condemned" has been proved wrong by a deterministic check, so it is already known to be broken whatever you think of it. Do not argue about whether it is wrong; return the fix.

There are ${candidates.length} entries below, with ids 1 to ${candidates.length}. Return exactly that many results, one per id. ${
    tools
      ? 'The count is stated so that nothing has to work it out: this prompt and the three lookup tools are everything you have. There is no shell and no filesystem, and reaching for one ends the batch with no output at all.'
      : 'This prompt is everything you have; there are no tools. Reply with only a JSON object of the shape {"results":[{"id":1,"problem":false,"categories":[],"reason":"..."}]}, adding "fix" to a result when you have one, and nothing before or after it.'
  }

${entries}`
}
