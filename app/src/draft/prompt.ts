import { dateTimeInstruction } from '../audit/rules/date-format.js'
import { nameOrderInstruction } from '../audit/rules/name-order.js'
import { loadLocaleRules } from '../rules/load.js'
import type { Locale } from '../types.js'
import { localeDisplayName, splitLocale } from '../wporg/locales.js'

// The draft engine's own prompt, kept apart from the client that sends it so
// that hashing it does not drag the OpenAI SDK into every command's module
// graph. `draftConfigHash` reads it: changing a word here invalidates every
// cached draft, which is the point of giving the draft table a config_hash.

export function describeLocale(locale: Locale): string {
  const name = localeDisplayName(locale.replaceAll('_', '-'))
  return name !== splitLocale(locale).slug ? `${name} (${locale})` : locale
}

/**
 * How a draft should address the reader: the rules file's formality, else the
 * one a set named formal or informal implies, else nothing.
 *
 * The file wins because a set is a guess from a name and the file is a team
 * saying so. tr has no formal set, yet its translations address the reader
 * formally; only a file can say that.
 */
export function formalityOf(locale: Locale): 'formal' | 'informal' | undefined {
  const file = loadLocaleRules(locale)?.formality
  if (file !== undefined) return file
  const { set } = splitLocale(locale)
  return set === 'formal' || set === 'informal' ? set : undefined
}

export function draftSystemPrompt(locale: Locale, nplurals: number): string {
  // The file's formality only, not formalityOf. A set already reaches the
  // model through the locale's name, and adding a line for it here would
  // change draftConfigHash for every nl/formal user and prune their drafts on
  // the first run after an update that changed nothing they wrote. A line
  // appears only when someone writes formality into a rules file, and that
  // prune is the one they asked for: drafts made under the other address are
  // what the cache must stop serving, for DeepL and the AI engines alike.
  const formality = loadLocaleRules(locale)?.formality
  const language = localeDisplayName(locale.replaceAll('_', '-'))
  const dateTime = dateTimeInstruction(loadLocaleRules(locale)?.dateTime, language)
  const names = nameOrderInstruction(loadLocaleRules(locale)?.names, language)
  return [
    `You are a professional WordPress UI translator. Translate each item from English (en) into ${describeLocale(locale)}.`,
    'These are gettext strings from WordPress core, plugins and themes: UI labels, messages, settings.',
    'Rules:',
    '- Keep every placeholder exactly as written (%s, %d, %1$s, %2$d, %.2f, {name}, ###TOKEN###) and in a natural position.',
    '- Keep HTML tags, attributes, entities, Markdown, whitespace, leading/trailing spaces and newlines intact.',
    '- Do not translate code, URLs, shortcodes, or option/CSS/PHP identifiers.',
    '- Use the msgctxt and comments as disambiguation hints; produce natural, concise UI wording.',
    ...(formality === undefined ? [] : [`- Address the reader ${formality === 'formal' ? 'formally' : 'informally'}.`]),
    // Only when the file has a dateTime, for the same reason as formality.
    ...(dateTime === '' ? [] : [dateTime.trimEnd()]),
    // And the names, only for a locale that writes the family name first.
    ...(names === '' ? [] : [names.trimEnd()]),
    `- The target locale has ${nplurals} plural form(s). For an item WITHOUT "msgidPlural", return exactly 1 draft. For an item WITH "msgidPlural", return exactly ${nplurals} drafts: index 0 translates "msgid" (singular), the remaining indexes translate "msgidPlural" for the locale's other plural forms, in order.`,
    // Items are identified by a number, never by the gettext key. A key can
    // begin with a newline and end in spaces, and a model asked to echo one
    // back will quietly normalise it; the reply then looks well-formed while
    // the entry it names matches nothing. The review path learned this first.
    '- Return every input item, echoing its numeric "id" unchanged.',
    'Return ONLY a JSON object of the shape {"items":[{"id":1,"drafts":["..."]}]} with no prose.',
  ].join('\n')
}

