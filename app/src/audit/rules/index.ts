import type { AuditEntry, Finding, GlossaryEntry, Locale } from '../../types.js'
import { controlFindings, controlSpec } from '../control.js'
import { languageOf, localeDisplayName } from '../../wporg/locales.js'
import { customFindings } from '../../rules/custom.js'
import { loadLocaleRules } from '../../rules/load.js'
import { CUSTOM_RULE } from '../../rules/names.js'
import type { CustomPattern } from '../../rules/schema.js'
import { missingPlaceholders } from '../../draft/placeholders.js'
import {
  acronymStem,
  capitalizedWords,
  comparable,
  isAcronym,
  isTitleCase,
  isUpperFirst,
  lower,
  scan,
  words,
  type Word,
} from './text.js'
import { properNounsFor, type ProperNouns } from './proper-nouns.js'
import { profileFor, type RuleProfile } from './profiles.js'

function languageName(locale: Locale): string {
  return localeDisplayName(locale)
}

export interface RuleContext {
  locale: Locale
  nplurals: number
  glossary: GlossaryEntry[]
  brands: Set<string>
  // Brands safe to match a suffix against; see buildRuleContext.
  certainBrands: Set<string>
  properNouns: ProperNouns
  profile: RuleProfile
  namePhrases: string[][]
  translationsByMsgid: Map<string, Set<string>>
  // Every wording the translation memory holds for a source, keyed by tmKey.
  // Resolved by the caller because the rules read no database. Absent when
  // the caller did not look, which is not the same as the memory being empty.
  tm?: Map<string, readonly string[]>
  // Mistakes and patterns from the locale's rules file. Resolved once here
  // rather than read per entry; absent when the locale has no file.
  customPatterns?: readonly CustomPattern[]
}

export interface BuildRuleContextOptions {
  locale: Locale
  glossary: GlossaryEntry[]
  nplurals: number
  entries: AuditEntry[]
  // Names the locale keeps hitting that no built-in list can cover: places,
  // people, institutions, historical events. Entries may be multi-word.
  properNouns?: string[]
  tm?: Map<string, readonly string[]>
}

const DEFAULT_BRANDS = [
  'WordPress',
  'WooCommerce',
  'Jetpack',
  'Gutenberg',
  'Akismet',
  'Elementor',
  'Yoast',
  'Google',
  'Analytics',
  'Facebook',
  'Instagram',
  'YouTube',
  'Twitter',
  'LinkedIn',
  'PayPal',
  'Stripe',
  'Mailchimp',
  'GitHub',
  'reCAPTCHA',
]

export function buildRuleContext(opts: BuildRuleContextOptions): RuleContext {
  const customPatterns = loadLocaleRules(opts.locale)?.patterns
  const brands = new Set(DEFAULT_BRANDS.map((b) => lower(b, opts.locale)))
  const namePhrases = (opts.properNouns ?? [])
    .map((name) => words(name).map((w) => lower(w, opts.locale)))
    .filter((phrase) => phrase.length > 0)
  const localeNouns = properNounsFor(opts.locale)
  const properNouns: ProperNouns = {
    always: localeNouns.always.map((n) => lower(n, opts.locale)),
    dateOnly: localeNouns.dateOnly.map((n) => lower(n, opts.locale)),
  }
  const translationsByMsgid = new Map<string, Set<string>>()

  // Learned separately from the curated list, and kept only where the corpus
  // never contradicts it. A single mid-sentence capital is weak evidence on its
  // own: UI copy capitalises ordinary nouns freely, and on a real submission
  // this taught `footer`, `header`, `block`, `create`, `new` and `to` as proper
  // nouns. The same word written in lower case anywhere in the file settles it.
  const learned = new Set<string>()
  const lowercased = new Set<string>()

  for (const entry of opts.entries) {
    // A capital in the middle of a sentence-case source is a proper noun, so it is
    // legitimate in the translation too. Title Case sources carry no such signal,
    // which is exactly where DEFAULT_BRANDS has to do the work.
    if (!isTitleCase(entry.msgid, opts.locale, () => false)) {
      for (const word of words(entry.msgid).slice(1)) {
        if (isUpperFirst(word, opts.locale) && !isAcronym(word, opts.locale)) {
          learned.add(lower(word, opts.locale))
        }
      }
    }
    // Counter-evidence. A word already in lower case was written that way by
    // the author, wherever it sits; a capital at position 0 is the sentence's
    // doing and says nothing either way, so it is neither learned nor counted.
    for (const word of words(entry.msgid)) {
      if (lower(word, opts.locale) === word) lowercased.add(word)
    }
    // Normalised, or two encodings of one translation count as two wordings.
    const text = entry.msgstr.filter(Boolean).join('\0').normalize('NFC')
    if (!text) continue
    const seen = translationsByMsgid.get(entry.msgid) ?? new Set<string>()
    seen.add(text)
    translationsByMsgid.set(entry.msgid, seen)
  }

  /**
   * Two sets, because the two rules that read them want opposite things.
   *
   * `brands` is permissive and excuses a capital in a translation, so it wants
   * every word that might be a proper noun: losing `Philadelphia` or `Lorem`
   * from it makes title-case flag an address and a placeholder.
   *
   * `certainBrands` drives a prefix match against whole translated words, so a
   * wrong member invents offenders: `list` made `Liste` one. It keeps only what
   * the corpus never contradicts. The curated list is authoritative in both and
   * is never overruled, so a source that writes `wordpress` in lower case
   * somewhere cannot disarm the check for entries that spell it properly.
   */
  const certainBrands = new Set(brands)
  for (const word of learned) {
    brands.add(word)
    if (!lowercased.has(word)) certainBrands.add(word)
  }

  return {
    locale: opts.locale,
    nplurals: opts.nplurals,
    glossary: opts.glossary,
    brands,
    certainBrands,
    properNouns,
    profile: profileFor(opts.locale),
    namePhrases,
    ...(opts.tm ? { tm: opts.tm } : {}),
    translationsByMsgid,
    ...(customPatterns && customPatterns.length > 0 ? { customPatterns } : {}),
  }
}

type Rule = (entry: AuditEntry, ctx: RuleContext) => Finding[]

const HTML_TAG = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g

function tagCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const [, name] of value.matchAll(HTML_TAG)) {
    const tag = name.toLowerCase()
    counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return counts
}

const placeholder: Rule = (entry) => {
  const translation = entry.msgstr.filter(Boolean)
  if (translation.length === 0) return []
  const sources = entry.msgidPlural ? [entry.msgid, entry.msgidPlural] : [entry.msgid]
  const findings: Finding[] = []

  for (const [i, text] of translation.entries()) {
    const source = sources[Math.min(i, sources.length - 1)]!
    const missing = missingPlaceholders(source, text)
    const added = missingPlaceholders(text, source)
    if (missing.length > 0) {
      findings.push({
        rule: 'placeholder',
        severity: 'error',
        message: `translation is missing placeholder(s) ${missing.join(', ')}`,
      })
    }
    if (added.length > 0) {
      findings.push({
        rule: 'placeholder',
        severity: 'error',
        message: `translation adds placeholder(s) ${added.join(', ')} the source does not have`,
      })
    }
  }
  return findings.slice(0, 1)
}

const html: Rule = (entry) => {
  const text = entry.msgstr.find(Boolean)
  if (!text) return []
  const source = tagCounts(entry.msgid)
  const target = tagCounts(text)
  if (source.size === 0 && target.size === 0) return []

  const differing: string[] = []
  for (const tag of new Set([...source.keys(), ...target.keys()])) {
    if ((source.get(tag) ?? 0) !== (target.get(tag) ?? 0)) differing.push(`<${tag}>`)
  }
  if (differing.length === 0) return []
  return [{ rule: 'html', severity: 'error', message: `HTML tags differ from the source: ${differing.join(', ')}` }]
}

const pluralCount: Rule = (entry, ctx) => {
  if (entry.msgidPlural === undefined) return []
  if (entry.msgstr.every((s) => s === '')) return []
  const filled = entry.msgstr.filter((s) => s !== '').length
  if (filled === ctx.nplurals) return []
  return [
    {
      rule: 'plural-count',
      severity: 'error',
      message: `expected ${ctx.nplurals} plural form(s), found ${filled}`,
    },
  ]
}

const whitespace: Rule = (entry) => {
  const text = entry.msgstr.find(Boolean)
  if (!text) return []
  const lead = (v: string) => /^\s*/.exec(v)![0]
  const trail = (v: string) => /\s*$/.exec(v)![0]
  if (lead(entry.msgid) === lead(text) && trail(entry.msgid) === trail(text)) return []
  return [
    {
      rule: 'whitespace',
      severity: 'error',
      message: 'leading or trailing whitespace differs from the source',
    },
  ]
}

const untranslated: Rule = (entry) => {
  const text = entry.msgstr.find(Boolean)
  if (!text || text !== entry.msgid) return []
  return [{ rule: 'untranslated', severity: 'suspect', message: 'translation is identical to the source' }]
}

/**
 * A `.po` line quotes its string, so a quote inside it is written `\"` in the
 * file and is a plain quote in the string. A translation that carries the
 * file's spelling instead renders the backslash, and one that drops an escape
 * the source genuinely has loses the character the string is about.
 *
 * Counted rather than matched position by position: a translation reorders
 * words, so where the quotes sit says nothing, but how many of them are escaped
 * has to agree with the source.
 */
const escaped = (value: string): number => (value.match(/\\"/g) ?? []).length

const escaping: Rule = (entry) => {
  const text = entry.msgstr.find(Boolean)
  if (!text) return []
  const source = escaped(entry.msgid)
  const target = escaped(text)
  if (source === target) return []
  return [
    {
      rule: 'escaping',
      severity: 'error',
      message:
        source === 0
          ? 'escapes a quote the source spells plainly, so the backslash would be shown'
          : `the source escapes ${source} quote${source === 1 ? '' : 's'} and the translation ${target}`,
    },
  ]
}

const TRAILING = /([:…]|\.\.\.)\s*$/

/**
 * Whether a string ends a sentence, rather than which mark it ends with.
 *
 * Measured over 69,229 approved strings: 326 lose or invent a final stop,
 * which is worth reporting, while 27 more trade an exclamation mark for a full
 * stop. That trade is the locale's own convention ("deleted successfully!" is
 * approved as "başarıyla silindi."), so comparing the marks themselves would
 * report a house style as an error.
 *
 * Any mark Unicode calls a sentence terminator counts, not only ".!?": the
 * danda (।) ends a Hindi or Bengali sentence, 。 a Japanese or Chinese one, ؟ an
 * Arabic question. A Latin-only class reported every correct translation in
 * those scripts as a dropped stop. The property leaves out the ellipsis and the
 * colon, which TRAILING handles, and the semicolon.
 */
const ENDS_SENTENCE = /\p{Sentence_Terminal}\s*$/u
const endsSentence = (value: string): boolean => !TRAILING.test(value) && ENDS_SENTENCE.test(value)

const punctuation: Rule = (entry) => {
  const text = entry.msgstr.find(Boolean)
  if (!text) return []
  const source = TRAILING.exec(entry.msgid)?.[1]
  const target = TRAILING.exec(text)?.[1]
  const norm = (v?: string) => (v === '...' ? '…' : v)
  if (norm(source) === norm(target)) return []
  return [
    {
      rule: 'punctuation',
      severity: 'suspect',
      message: source
        ? `source ends with "${source}" but the translation does not`
        : `translation ends with "${target}" but the source does not`,
    },
  ]
}

/**
 * How a language ends a sentence where the Unicode property above cannot say,
 * keyed by language so a regional locale or a formal set inherits its
 * language's entry.
 *
 * Each case is narrower than an extra mark, because a mark added to the class
 * would count in both directions and in every context. Measured over approved
 * wp/dev and wp/dev/admin before this table existed: 246 Greek, 2,331 Tibetan,
 * 350 Dzongkha and 2,975 Thai translations were reported as dropped stops,
 * and nearly all of them were correct.
 *
 * - `answers` ends a sentence only as the reply to a source that ends one.
 *   Counted the other way it would be read as a sentence the translation
 *   invented, on strings that are no such thing.
 * - `unmarked` says the language writes no final mark, so a translation
 *   without one has dropped nothing.
 * - `notEnding` is a final mark that looks like a stop and is not one.
 */
interface SentenceStyle {
  answers?: (source: string, text: string) => boolean
  unmarked?: true
  notEnding?: RegExp
}

// The shad, the double shad that closes a section, or a bare ཀ or ག, after
// which the shad is implied and not written (Unicode's notes on Tibetan line
// breaking). All of them only as an answer: Tibetan closes a phrase with the
// shad too, and counting it the other way reported 2,357 Tibetan and 863
// Dzongkha labels, weekday names among them, as invented sentences.
const TIBETAN: SentenceStyle = {
  answers: (_source, text) => /[\u0F0D\u0F0E\u0F40\u0F42]\s*$/u.test(text),
}

const SENTENCE_STYLES: Record<string, SentenceStyle> = {
  // Greek asks with a semicolon, U+037E by name and U+003B in practice, since
  // NFC folds one to the other. Paired with the source's question rather than
  // counted on its own: a final semicolon is also an HTML entity or a line of
  // untranslated code, and neither ends a sentence.
  el: { answers: (source, text) => /\?\s*$/.test(source) && /[;\u037E]\s*$/u.test(text) },
  bo: TIBETAN,
  dzo: TIBETAN,
  // Thai ends a sentence with a space. It uses the full stop only to
  // abbreviate: every approved translation the check reported as inventing a
  // stop was a month, a weekday, or น. after a time. A stop after a Latin word
  // is still a sentence end.
  th: { unmarked: true, notEnding: /\p{Script=Thai}\p{M}*\.\s*$/u },
}

// The same concern as the rule above, at the end of a sentence rather than a
// label: a full stop the source has and the translation drops, or the reverse.
const sentenceEnd: Rule = (entry, ctx) => {
  const text = entry.msgstr.find(Boolean)
  if (!text) return []
  const style = SENTENCE_STYLES[languageOf(ctx.locale)]
  // The source is English, so only the translation is read in its own style.
  const source = endsSentence(entry.msgid)
  const target =
    style?.notEnding?.test(text) === true
      ? false
      : endsSentence(text) || (source && style?.answers?.(entry.msgid, text) === true)
  if (source === target) return []
  if (source && style?.unmarked) return []
  return [
    {
      rule: 'punctuation',
      severity: 'suspect',
      message: source
        ? 'the source ends a sentence and the translation does not'
        : 'the translation ends a sentence and the source does not',
    },
  ]
}

/**
 * Line breaks are structure, not whitespace: an email body, a changelog, a
 * multi-line notice. 15 of 69,229 approved strings lose one, usually a whole
 * line with it.
 *
 * An error, and deliberately not repairable: the count is provable, but nothing
 * here knows which line the missing break belonged after.
 */
const lineBreaks: Rule = (entry) => {
  const text = entry.msgstr.find(Boolean)
  if (!text) return []
  const count = (value: string) => (value.match(/\n/g) ?? []).length
  const source = count(entry.msgid)
  const target = count(text)
  if (source === target) return []
  return [
    {
      rule: 'line-breaks',
      severity: 'error',
      message: `the source has ${source} line break${source === 1 ? '' : 's'} and the translation ${target}`,
    },
  ]
}

/**
 * An ampersand the translation kept. Turkish writes the conjunction as a word,
 * so "Date & Time" is "Tarih ve Saat".
 *
 * Entities and query strings are not the conjunction: `&hellip;`, `&#8220;` and
 * `?a=1&b=2` are left alone. 89 of 69,229 approved strings keep one, nearly all
 * of them labels, and the few that are right are product names like
 * "WooCommerce Shipping & Tax", which is why this asks rather than proves.
 */
const CONJUNCTION_AMP = /&(?!\w{1,8};|#\d)(?![^\s=]*=)/
const ampersand: Rule = (entry, ctx) => {
  const text = entry.msgstr.find(Boolean)
  if (!text) return []
  const stripUrls = (value: string) => value.replace(/\S+=\S*&\S*/g, ' ')
  if (!CONJUNCTION_AMP.test(stripUrls(entry.msgid)) && !/&amp;/.test(entry.msgid)) return []
  const target = stripUrls(text)
  if (!CONJUNCTION_AMP.test(target) && !/&amp;/.test(target)) return []
  return [
    {
      rule: 'ampersand',
      severity: 'suspect',
      // Named by the locale rather than as Turkish: a rules file can enable
      // this for any language, and a finding that names the wrong one is
      // read by the contributor as a mistake in the tool.
      message: `the translation keeps "&" where ${languageName(ctx.locale)} writes the conjunction as a word`,
    },
  ]
}

/**
 * How Turkish writes a number beside a symbol. Today that is the percent sign,
 * which goes before the number and closed up: %25, never % 25. Named for the
 * family rather than the check, since the rest of TDK's rules on numerals are
 * described in notes/ideas.md and would join this one rather than crowd the rule
 * list. 3 of 69,229 approved strings put a space there.
 */
const numberFormat: Rule = (entry, ctx) => {
  const text = entry.msgstr.find(Boolean)
  if (!text) return []
  if (!/%\s+\d/.test(text)) return []
  return [
    {
      rule: 'number-format',
      severity: 'suspect',
      // The check itself stays Turkish-shaped, percent before the number;
      // only the language it names follows the locale. Generalising the
      // placement per language is deferred (#2).
      message: `${languageName(ctx.locale)} writes the percent sign closed up to its number, as %25`,
    },
  ]
}

// A user-supplied name may be several words (Türk Dil Kurumu), and TDK capitalizes
// every one of them, so the whole phrase has to be recognized before any single
// word can be excused. The final word is matched by prefix because Turkish
// attaches suffixes to it (Kurumu'nun).
function phraseIndices(all: Word[], phrases: string[][], locale: Locale): Set<number> {
  const covered = new Set<number>()
  const stems = all.map((w) => lower(acronymStem(w.text), locale))

  for (const phrase of phrases) {
    for (let start = 0; start + phrase.length <= all.length; start++) {
      const matches = phrase.every((part, offset) => {
        const token = stems[start + offset]!
        return offset === phrase.length - 1 ? token.startsWith(part) : token === part
      })
      if (!matches) continue
      for (let offset = 0; offset < phrase.length; offset++) covered.add(start + offset)
    }
  }
  return covered
}

// TDK madde Ç capitalizes a day or month name only when it states a specific
// date, so a neighbouring number is what makes the capital legitimate. In a .po
// string that number is often a placeholder, which `scan` leaves standing as one.
function inDateContext(index: number, all: Word[]): boolean {
  const numeric = (w?: Word) => w !== undefined && /^\d/.test(w.text)
  return numeric(all[index - 1]) || numeric(all[index + 1])
}

// A capital is legitimate when it is a brand, or a proper noun the locale's
// orthography capitalizes; suffixes attach directly (Mayıs'ta), so match the stem.
function isExemptCapital(
  word: string,
  index: number,
  all: Word[],
  ctx: RuleContext,
  named: Set<number>,
): boolean {
  if (named.has(index)) return true
  const lowered = lower(acronymStem(word), ctx.locale)
  if (ctx.brands.has(lowered)) return true
  if (ctx.properNouns.always.some((noun) => lowered.startsWith(noun))) return true
  if (ctx.properNouns.dateOnly.some((noun) => lowered.startsWith(noun))) return inDateContext(index, all)
  return false
}

const titleCase: Rule = (entry, ctx) => {
  const text = entry.msgstr.find(Boolean)
  if (!text) return []
  const named = ctx.namePhrases.length > 0 ? phraseIndices(scan(text), ctx.namePhrases, ctx.locale) : new Set<number>()
  const exempt = (word: string, index: number, all: Word[]) => isExemptCapital(word, index, all, ctx, named)
  const extra = capitalizedWords(text, ctx.locale, exempt)
  if (extra.length === 0) return []

  const mirrored = isTitleCase(entry.msgid, ctx.locale, () => false) && isTitleCase(text, ctx.locale, exempt)
  return [
    {
      rule: 'title-case',
      severity: 'suspect',
      message: mirrored
        ? `title case mirrors the English source (${extra.join(', ')}); ${languageName(ctx.locale)} capitalizes only the first word and proper nouns`
        : `capitalizes ${extra.join(', ')} mid-string; ${languageName(ctx.locale)} capitalizes only the first word and proper nouns`,
    },
  ]
}

// A suffixing language keeps the stem intact, so a prefix match survives most
// inflection. Root mutation (kitap -> kitabı) still defeats it, which is why this
// rule only ever reports a suspicion for the AI to adjudicate. The tolerance is a
// profile setting because it is a property of the language, not of the rule.
function containsTerm(haystack: string, needle: string, stemRatio: number): boolean {
  if (haystack.includes(needle)) return true
  const stem = needle.slice(0, Math.ceil(needle.length * stemRatio))
  return stem.length >= 3 && haystack.includes(stem)
}

export interface GlossaryMatch {
  term: string
  translations: string[]
}

/**
 * The binding glossary terms a source string actually contains.
 *
 * Shared by the glossary rule and the prompt so the two can never disagree
 * about which terms apply. The prompt carries these inline: asking the model to
 * look each one up costs a round trip per term, which on an agent that issues
 * tool calls one at a time is most of the time a batch takes.
 *
 * Terms shorter than three characters are skipped, and matching is on a whole
 * word, so `list` is not found inside `listen`.
 */
export function glossaryMatches(msgid: string, ctx: RuleContext): GlossaryMatch[] {
  const source = lower(msgid, ctx.locale)
  const byTerm = new Map<string, { term: string; translations: string[] }>()
  for (const item of ctx.glossary) {
    const term = lower(item.sourceTerm, ctx.locale)
    if (term.length < 3) continue
    if (!hasWord(source, term)) continue
    const found = byTerm.get(term) ?? { term: item.sourceTerm, translations: [] }
    if (!found.translations.includes(item.translation)) found.translations.push(item.translation)
    byTerm.set(term, found)
  }
  return [...byTerm.values()]
}

const glossary: Rule = (entry, ctx) => {
  const text = entry.msgstr.find(Boolean)
  if (!text) return []
  const target = comparable(text, ctx.locale)

  const missed: string[] = []
  for (const match of glossaryMatches(entry.msgid, ctx)) {
    const approved = match.translations.map((t) => comparable(t, ctx.locale))
    if (approved.some((t) => containsTerm(target, t, ctx.profile.glossaryStemRatio))) continue
    missed.push(`"${lower(match.term, ctx.locale)}" -> ${approved.map((t) => `"${t}"`).join(' / ')}`)
  }
  if (missed.length === 0) return []
  return [
    { rule: 'glossary', severity: 'suspect', message: `glossary term not used: ${missed.join('; ')}` },
  ]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Whole word only, or `and` would be found inside `sandwich` and the source
// check would wave through exactly what it exists to catch.
function hasWord(haystack: string, needle: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, 'u').test(haystack)
}

const apostrophe: Rule = (entry, ctx) => {
  const text = entry.msgstr.find(Boolean)
  if (!text) return []
  const offenders: string[] = []
  // Only the proper nouns this entry's own source names. The rule reads a
  // translation word as "brand plus suffix" on a prefix match, so every brand
  // the file ever mentioned used to be tried against every translation in it:
  // `list` made `Liste` an offender, `and` made `anda` one, `sun` made `sunt`
  // one. A suffixed proper noun in a translation answers to one in the source.
  const source = lower(entry.msgid, ctx.locale)
  const mentioned = [...ctx.certainBrands].filter((brand) => brand.length >= 3 && hasWord(source, brand))
  if (mentioned.length === 0) return []

  for (const word of words(text)) {
    if (word.includes("'") || word.includes('’')) continue
    const lowered = lower(word, ctx.locale)
    for (const brand of mentioned) {
      if (!lowered.startsWith(brand) || lowered === brand) continue
      const suffix = lowered.slice(brand.length)
      if (/^[a-zçğıöşü]{1,4}$/.test(suffix)) offenders.push(word)
    }
  }
  if (offenders.length === 0) return []
  return [
    {
      rule: 'apostrophe',
      severity: 'suspect',
      message: `proper noun takes a suffix without an apostrophe: ${offenders.join(', ')}`,
    },
  ]
}

/**
 * How a source and its context are looked up in the translation memory.
 *
 * Exported so the caller that resolves the memory and the rule that reads it
 * cannot disagree about the key. Context is part of it because gettext lets
 * the same English string mean two different things.
 */
export function tmKey(msgid: string, msgctxt?: string): string {
  return `${msgctxt ?? ''}\u0000${msgid}`
}

// Case, spacing and a trailing full stop or colon are not a disagreement worth
// a reviewer's time. On a real submission they were 138 of 474 differences, and
// reporting them would have buried the 336 that mattered.
function sameWording(a: string, b: string, locale: Locale): boolean {
  const norm = (v: string): string =>
    comparable(v, locale)
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[.:…]+$/, '')
  return norm(a) === norm(b)
}

/**
 * The memory already holds a different translation of this exact source.
 *
 * Strong evidence, not a verdict, so it is only ever a suspicion. Either side
 * can be the wrong one: on a real submission the memory offered "Yazı tipi"
 * for "post type", which in Turkish means a font. What the rule is good at is
 * putting the two in front of someone who knows which is which.
 *
 * `inconsistent` asks this question of one file; this one asks it of
 * everything that came before.
 */
// The memory can hold several approved wordings for one source, so a conflict
// is a submission that matches none of them. Matching any one means the
// contributor picked a wording the locale has already approved.
const tmConflict: Rule = (entry, ctx) => {
  if (!ctx.tm) return []
  const text = entry.msgstr.find(Boolean)
  if (!text) return []
  const approved = ctx.tm.get(tmKey(entry.msgid, entry.msgctxt))
  if (!approved || approved.length === 0) return []
  if (approved.some((a) => sameWording(text, a, ctx.locale))) return []
  const named = approved.length === 1 ? JSON.stringify(approved[0]) : approved.map((a) => JSON.stringify(a)).join(', ')
  return [
    {
      rule: 'tm-conflict',
      severity: 'suspect',
      message: `the translation memory has ${approved.length === 1 ? 'a different approved translation' : 'different approved translations'}: ${named}`,
    },
  ]
}

const inconsistent: Rule = (entry, ctx) => {
  const text = entry.msgstr.filter(Boolean).join('\0')
  if (!text) return []
  const variants = ctx.translationsByMsgid.get(entry.msgid)
  if (!variants || variants.size < 2) return []
  return [
    {
      rule: 'inconsistent',
      severity: 'suspect',
      message: `the same source is translated ${variants.size} different ways in this file`,
    },
  ]
}

const RULES: Array<{ name: string; run: Rule }> = [
  { name: 'placeholder', run: placeholder },
  { name: 'html', run: html },
  { name: 'plural-count', run: pluralCount },
  { name: 'whitespace', run: whitespace },
  { name: 'untranslated', run: untranslated },
  { name: 'escaping', run: escaping },
  { name: 'punctuation', run: punctuation },
  { name: 'punctuation', run: sentenceEnd },
  { name: 'line-breaks', run: lineBreaks },
  { name: 'ampersand', run: ampersand },
  { name: 'number-format', run: numberFormat },
  { name: 'title-case', run: titleCase },
  { name: 'glossary', run: glossary },
  { name: 'apostrophe', run: apostrophe },
  { name: 'inconsistent', run: inconsistent },
  { name: 'tm-conflict', run: tmConflict },
  { name: 'control', run: (entry) => {
    const spec = controlSpec(entry)
    return spec ? controlFindings(entry, spec) : []
  } },
  { name: CUSTOM_RULE, run: (entry, ctx) => customFindings(entry, ctx.customPatterns ?? [], ctx.locale) },
]

export function runRules(entry: AuditEntry, ctx: RuleContext): Finding[] {
  // A control string answers to its own rule alone. "on" kept as "on" is
  // right, and the untranslated or title-case rules firing on it would invite
  // the model to translate a switch into a word. Silenced even when a locale
  // turns the control rule off: that silences the check, not the protection.
  if (controlSpec(entry)) {
    return ctx.profile.rules.has('control') ? RULES.filter((r) => r.name === 'control').flatMap((r) => r.run(entry, ctx)) : []
  }
  return RULES.filter((rule) => ctx.profile.rules.has(rule.name)).flatMap((rule) => rule.run(entry, ctx))
}
