import { BRACE_PLACEHOLDER, PRINTF_PLACEHOLDER } from '../../draft/placeholders.js'
import { intlTag } from '../../wporg/locales.js'
import type { Locale } from '../../types.js'

// Turkish casing is not the invariant mapping: I lowercases to ı, İ to i. Every
// case comparison in the rules goes through these so the dotted/dotless pairs
// behave, whatever locale is being reviewed.
export function lower(value: string, locale: Locale): string {
  return value.toLocaleLowerCase(intlTag(locale))
}

/**
 * Text as the rules compare it with other text: canonically equivalent
 * spellings made one, then folded by the locale's case.
 *
 * Many letters in Indian scripts have two encodings that render the same, a
 * Devanagari ड़ as one code point or as ड with a nukta, Bengali য়, Gurmukhi ਸ਼.
 * Approved translations carry both, often for the same word, so a comparison
 * of raw strings reported text a reviewer sees as identical. Kept out of lower()
 * itself, because isUpperFirst and isAcronym read a letter that changes under
 * lower() as a capital, and normalising turns a one-code-point letter into two.
 * Nor is the text normalised when the file is read: the translation is written
 * back as the contributor typed it.
 */
export function comparable(value: string, locale: Locale): string {
  return lower(value.normalize('NFC'), locale)
}

export function isUpperFirst(word: string, locale: Locale): boolean {
  const first = [...word][0]
  if (!first || !/\p{L}/u.test(first)) return false
  return first !== lower(first, locale)
}

// An acronym keeps its shape when Turkish attaches a suffix through an
// apostrophe (PDF'yi, URL'sini), so only the stem before the apostrophe counts.
export function acronymStem(word: string): string {
  const at = word.search(/['’]/)
  return at === -1 ? word : word.slice(0, at)
}

export function isAcronym(word: string, locale: Locale): boolean {
  const letters = [...acronymStem(word)].filter((c) => /\p{L}/u.test(c))
  if (letters.length < 2) return false
  return letters.every((c) => c !== lower(c, locale))
}

function strip(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    // A placeholder next to a month name is almost always the date number, so it
    // stands in as one rather than vanishing.
    .replace(new RegExp(PRINTF_PLACEHOLDER, 'g'), ' 0 ')
    .replace(new RegExp(BRACE_PLACEHOLDER, 'g'), ' 0 ')
}

function clean(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

// Splits on whitespace and strips surrounding punctuation, so "Changes," and
// "(Sidebar)" compare as words while placeholders and markup fall away.
export function words(value: string): string[] {
  return strip(value).split(/\s+/).map(clean).filter(Boolean)
}

// Turkish capitalizes the first word of every sentence, not just the first word
// of the string, so a run-on UI string legitimately has several capitals.
const SENTENCE_END = /[.!?:;…]$/

export interface Word {
  text: string
  initial: boolean
}

// Every word in order, each marked as sentence-initial or not, so a rule can look
// at a word's neighbours (a date number, say) and not just the word itself.
export function scan(value: string): Word[] {
  const out: Word[] = []
  let atSentenceStart = true

  for (const raw of strip(value).split(/\s+/)) {
    if (!raw) continue
    const text = clean(raw)
    if (text) {
      out.push({ text, initial: atSentenceStart })
      atSentenceStart = false
    }
    if (SENTENCE_END.test(raw)) atSentenceStart = true
  }
  return out
}

export function nonInitialWords(value: string): string[] {
  return scan(value)
    .filter((w) => !w.initial)
    .map((w) => w.text)
}

export type Exempt = (word: string, index: number, all: Word[]) => boolean

function countable(value: string, locale: Locale, exempt: Exempt): Word[] {
  const all = scan(value)
  return all.filter(
    (w, i) => !w.initial && /\p{L}/u.test(w.text) && !exempt(w.text, i, all) && !isAcronym(w.text, locale),
  )
}

export function isTitleCase(value: string, locale: Locale, exempt: Exempt): boolean {
  if (words(value).length < 2) return false
  const rest = countable(value, locale, exempt)
  if (rest.length === 0) return false
  return rest.every((w) => isUpperFirst(w.text, locale))
}

export function capitalizedWords(value: string, locale: Locale, exempt: Exempt): string[] {
  return countable(value, locale, exempt)
    .filter((w) => isUpperFirst(w.text, locale))
    .map((w) => w.text)
}
