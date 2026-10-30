import type { AuditEntry, Finding, GlossaryEntry, GlossaryMatchRow, Locale } from '../../types.js'
import { controlFindings, controlSpec } from '../control.js'
import { localeDisplayName } from '../../wporg/locales.js'
import { customFindings, skipFinding } from '../../rules/custom.js'
import { loadLocaleRules } from '../../rules/load.js'
import { CUSTOM_RULE } from '../../rules/names.js'
import { runRegexOps, skippedFor, type RegexOp } from '../../rules/sandbox.js'
import type { CustomPattern, DateTimeRules, SentenceEndRules } from '../../rules/schema.js'
import { dateFormatProblems, isDateFormat } from './date-format.js'
import { nameOrderProblem, type NameRules } from './name-order.js'
import { missingPlaceholders, movedPlaceholders, placeholderKeys } from '../../draft/placeholders.js'
import type { PluralDistribution } from '../../po/plural-forms.js'
import {
  acronymStem,
  capitalizedWords,
  comparable,
  isAcronym,
  isTitleCase,
  isUpperFirst,
  lower,
  lowerSource,
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
  // The keys in tm whose every row is long text (readmes, release notes).
  // Their wordings were chosen for prose, so a submission that differs is no
  // conflict, though matching one still counts as agreement.
  tmWeak?: ReadonlySet<string>
  // Mistakes and patterns from the locale's rules file. Resolved once here
  // rather than read per entry; absent when the locale has no file.
  customPatterns?: readonly CustomPattern[]
  // How the locale ends a sentence, from the same file and compiled here for
  // the same reason. Absent when the file says nothing about it, which leaves
  // the generic Unicode check alone.
  sentenceEnd?: CompiledSentenceEnd
  // The locale's clock, date order and usual formats, from the same file.
  // Absent leaves the date-format rule to its universal checks.
  dateTime?: DateTimeRules
  // The order the locale writes names in, from the same file. Absent keeps the
  // name-order rule quiet.
  names?: NameRules
  // How the catalogue's plural formula spreads the numbers over the forms.
  // Absent when the caller had no formula to read.
  pluralDistribution?: PluralDistribution
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
  tmWeak?: ReadonlySet<string>
  pluralDistribution?: PluralDistribution
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
  const file = loadLocaleRules(opts.locale)
  const customPatterns = file?.patterns
  const sentenceEnd = compileSentenceEnd(file?.sentenceEnd)
  const brands = new Set(DEFAULT_BRANDS.map((b) => lower(b, opts.locale)))
  const localeNouns = properNounsFor(opts.locale)
  // The rules file's list holds single words and names of several words in
  // one list, because that is how a person thinks of them. A single word keeps
  // the stem match below, so Türkiye covers Türkiye'de; a longer name is matched
  // as a phrase, so Türk Dil Kurumu is excused without excusing Dil wherever it
  // stands. opts.properNouns is the same kind of list from callers that pass one.
  const isPhrase = (name: string) => words(name).length > 1
  const namePhrases = [...(opts.properNouns ?? []), ...localeNouns.always.filter(isPhrase)]
    .map((name) => words(name).map((w) => lower(w, opts.locale)))
    .filter((phrase) => phrase.length > 0)
  const properNouns: ProperNouns = {
    always: localeNouns.always.filter((n) => !isPhrase(n)).map((n) => lower(n, opts.locale)),
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
    ...(opts.tmWeak ? { tmWeak: opts.tmWeak } : {}),
    translationsByMsgid,
    ...(customPatterns && customPatterns.length > 0 ? { customPatterns } : {}),
    ...(sentenceEnd ? { sentenceEnd } : {}),
    ...(file?.dateTime ? { dateTime: file.dateTime } : {}),
    ...(file?.names ? { names: file.names } : {}),
    ...(opts.pluralDistribution ? { pluralDistribution: opts.pluralDistribution } : {}),
  }
}

// The file's sources were already compiled with the same flag when it was
// loaded, so this cannot throw on a file that passed the schema.
function compileSentenceEnd(rules: SentenceEndRules | undefined): CompiledSentenceEnd | undefined {
  if (!rules) return undefined
  return {
    answers: (rules.answers ?? []).map((a) => ({
      text: new RegExp(a.text, 'u'),
      ...(a.source === undefined ? {} : { source: new RegExp(a.source, 'u') }),
    })),
    unmarked: rules.unmarked === true,
    ...(rules.notEnding === undefined ? {} : { notEnding: new RegExp(rules.notEnding, 'u') }),
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

interface PlaceholderCheck {
  text: string
  // The wording whose every placeholder the form must carry.
  source: string
  // A placeholder only this one has is no addition either: the singular,
  // formatted with the same arguments as the plural.
  alsoFrom?: string
  // The formula sends this form a single number, which it may say in words
  // in place of its placeholder.
  mayOmit: boolean
}

/**
 * Whether what a form for a single number left out is that number.
 *
 * gettext lets such a form drop any placeholder; this lets it drop one. Saying
 * the number in words loses one argument, the number, and a form that also
 * lost the name in "%s has %d items" has lost something no formula excuses.
 * Occurrences are counted, so a form that drops both %d of "%d items and %d
 * selected" has lost two.
 *
 * When the plural formats a number (%d, %u, %f and the other numeric
 * conversions), the number is one of those, so a form that keeps them and drops
 * a %s has dropped a name or a title instead. Core passes many counts through
 * number_format_i18n as %s, so with no numeric conversion in the plural any one
 * placeholder may go.
 *
 * A placeholder without a position takes the next argument in order, so only
 * the last of those can go: dropping the %d of "%d items in %s" leaves %s
 * printing the number. Positioned ones (%1$d) can go wherever they stand.
 *
 * What it cannot tell apart: two numbers of the same kind, as in "Sold %1$d
 * items in the last %2$d days", or a count and a title both written %s. Either
 * one may go there.
 */
function spellsOutTheNumber(source: string, text: string): boolean {
  // Read as missingPlaceholders reads them, so an all-unnumbered source's %s is
  // the %1$s a form numbers it as.
  const written = placeholderKeys(source).map(({ key }) => key)
  const kept = placeholderKeys(text).map(({ key }) => key)
  const lost = written.filter((placeholder) => {
    const at = kept.indexOf(placeholder)
    if (at === -1) return true
    kept.splice(at, 1)
    return false
  })
  if (lost.length !== 1) return false
  const gone = lost[0]!
  const isNumber = (placeholder: string) => placeholder.startsWith('%') && /[bdeEfFgGouxX]$/.test(placeholder)
  if (!isNumber(gone) && written.some(isNumber)) return false
  const inOrder = written.filter((placeholder) => placeholder.startsWith('%') && !/^%\d+\$/.test(placeholder))
  return !inOrder.includes(gone) || inOrder.at(-1) === gone
}

/**
 * Which source each filled form answers to.
 *
 * With the catalogue's formula, the way msgfmt reads it: every form against
 * msgid_plural, the wording that covers every number, and a form the formula
 * uses for one number alone free to say that number in words. The position of a
 * form says nothing about its numbers. Russian msgstr[0] serves 21 and 31 as
 * well as one, and Japanese has a single form for every number, so reading
 * msgstr[0] as the English singular passed a Russian form that would print
 * "one file" for 21 files, and reported the %d a Japanese form needs as an
 * addition. Arabic says zero, one and two in words, and each of those forms was
 * an error the model could not clear.
 *
 * Without a formula nothing says which numbers a form serves, and msgstr[0] is
 * read as the singular, as it always was.
 */
function placeholderChecks(entry: AuditEntry, ctx: RuleContext): PlaceholderCheck[] {
  const plural = entry.msgidPlural
  const distribution = ctx.pluralDistribution
  if (plural && distribution) {
    const { singleNumber, upToOne } = distribution
    return entry.msgstr.flatMap((text, form) =>
      text ? [{ text, source: plural, alsoFrom: entry.msgid, mayOmit: singleNumber.has(form) || upToOne.has(form) }] : [],
    )
  }
  const sources = plural ? [entry.msgid, plural] : [entry.msgid]
  return entry.msgstr
    .filter(Boolean)
    .map((text, i) => ({ text, source: sources[Math.min(i, sources.length - 1)]!, mayOmit: false }))
}

/**
 * What translate.wordpress.org will say about a plural entry this rule accepts.
 *
 * GlotPress compares the form that serves 1 with the singular and every other
 * form with the plural, or every form with the plural when the language has only
 * one (GP_Translation_Warnings::check), and lets no form drop a placeholder. So
 * it warns on forms gettext's reading accepts: the Arabic forms for zero, one
 * and two that say their number in words, or a Russian msgstr[0] that keeps the
 * %d it needs for 21. Calling those errors would reject correct translations
 * and have the model write the %d back; passing them without a word would have
 * the model judge them without knowing translate.wordpress.org disagrees. They
 * are a suspect: the model weighs the warning and may clear it like any other,
 * and under --no-ai the entry is listed for a person to look at.
 *
 * The placeholders are read with this tool's pattern, not GlotPress's, which
 * skips widths and flags such as %5d; on those rare shapes the warning named
 * here is this tool's reading of what GlotPress compares.
 */
function glotpressWarning(entry: AuditEntry, plural: string, ctx: RuleContext, formForOne: number): Finding | undefined {
  for (const [form, text] of entry.msgstr.entries()) {
    if (!text) continue
    const source = ctx.nplurals > 1 && form === formForOne ? entry.msgid : plural
    const differ = [...new Set([...missingPlaceholders(source, text), ...missingPlaceholders(text, source)])]
    if (differ.length === 0) continue
    return {
      rule: 'placeholder',
      severity: 'suspect',
      message: `translate.wordpress.org warns about placeholder(s) ${differ.join(', ')} in msgstr[${form}], though the form is right for the numbers its plural formula serves`,
    }
  }
  return undefined
}

const placeholder: Rule = (entry, ctx) => {
  const findings: Finding[] = []

  for (const { text, source, alsoFrom, mayOmit } of placeholderChecks(entry, ctx)) {
    const moved = movedPlaceholders(source, text)
    if (moved) {
      const numbered = moved.map((ph, k) => `%${k + 1}$${ph.slice(1)}`)
      findings.push({
        rule: 'placeholder',
        severity: 'error',
        message: `translation moves ${moved.join(', ')} out of the order the code fills them in; number them (${numbered.join(', ')}) to move them`,
      })
      continue
    }
    const lost = missingPlaceholders(source, text)
    const missing = mayOmit && spellsOutTheNumber(source, text) ? [] : lost
    const beyondSingular = alsoFrom === undefined ? undefined : missingPlaceholders(text, alsoFrom)
    const added = missingPlaceholders(text, source).filter((ph) => beyondSingular?.includes(ph) ?? true)
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
  const distribution = ctx.pluralDistribution
  if (findings.length === 0 && entry.msgidPlural && distribution) {
    const warning = glotpressWarning(entry, entry.msgidPlural, ctx, distribution.formForOne)
    if (warning) findings.push(warning)
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
 * How a language ends a sentence where the Unicode property above cannot say.
 * It used to be a table here, keyed by language; it now comes from the
 * locale's rules file (sentenceEnd), compiled once in buildRuleContext, so a
 * team can state its own convention without a polyglots release. The values
 * that were in the table live in the polyglots-data files for el, bo, dzo and
 * th. A rules file is per locale, so unlike the table a formal or regional set
 * does not inherit its language's convention; none of those four has one.
 *
 * Each case is narrower than an extra mark, because a mark added to the class
 * would count in both directions and in every context. Measured over approved
 * wp/dev and wp/dev/admin before the table existed: 246 Greek, 2,331 Tibetan,
 * 350 Dzongkha and 2,975 Thai translations were reported as dropped stops,
 * and nearly all of them were correct.
 *
 * - `answers` ends a sentence only as the reply to a source that ends one.
 *   Counted the other way it would be read as a sentence the translation
 *   invented, on strings that are no such thing: Tibetan closes a phrase with
 *   the shad too, and counting it both ways reported 2,357 Tibetan and 863
 *   Dzongkha labels, weekday names among them, as invented sentences. A bare
 *   ཀ or ག implies the shad (Unicode's notes on Tibetan line breaking) and may
 *   carry a tsheg, which many keyboards type for the space bar; four approved
 *   translations end that way. An
 *   answer's `source`, when given, must match the source as well, which is
 *   how Greek pairs its semicolon with the source's question rather than with
 *   an HTML entity or a line of untranslated code.
 * - `unmarked` says the language writes no final mark, so a translation
 *   without one has dropped nothing. Thai ends a sentence with a space.
 * - `notEnding` is a final mark that looks like a stop and is not one: Thai
 *   uses the full stop only to abbreviate a month, a weekday, or น. after a
 *   time.
 */
export interface CompiledSentenceEnd {
  answers: { text: RegExp; source?: RegExp }[]
  unmarked: boolean
  notEnding?: RegExp
}

// Single letters each closed by a dot, as in a.m., π.μ. or the Lao month ທ.ວ.,
// are an abbreviation in any script, so their last dot invents no sentence.
// Only the letter-dot pairs count: a whole word before the stop is a sentence,
// and Lao, unlike Thai, ends one that way. Measured over approved wp/dev and
// wp/dev/admin, this cleared 12 Lao, 4 German and 2 Greek translations and
// nothing the check should have reported.
const DOTTED_ABBREVIATION = /(?:^|[\s(])(?:\p{L}\p{M}*\.){2,}\s*$/u

/**
 * The file's sentenceEnd regexes over one entry, in the sandbox, in one call.
 *
 * They come from a rules file like any pattern, so they run where a runaway
 * one can be stopped. Each id carries the regex's source as well as its place,
 * because the sandbox remembers a skipped id for the whole process and a TUI
 * session can review a Greek file after a Thai one. All of them run, even an
 * answer the source does not ask for: one call costs less than the second
 * call laziness would need, and these are a handful of short patterns.
 */
function sentenceEndOf(style: CompiledSentenceEnd, msgid: string, text: string): { notEnding: boolean; answers: boolean; skipped: Finding[] } {
  const ops: RegexOp[] = []
  const labels = new Map<string, string>()
  const add = (path: string, re: RegExp, against: string) => {
    const id = `sentenceEnd:${path.replaceAll('.', ':')}\u0000${re.source}`
    labels.set(id, `sentenceEnd.${path}`)
    ops.push({ kind: 'exec', id, source: re.source, flags: re.flags, text: against })
    return id
  }
  const notEnding = style.notEnding ? add('notEnding', style.notEnding, text) : undefined
  const answers = style.answers.map((a, i) => ({
    text: add(`answers.${i}.text`, a.text, text),
    ...(a.source === undefined ? {} : { source: add(`answers.${i}.source`, a.source, msgid) }),
  }))
  if (ops.length === 0) return { notEnding: false, answers: false, skipped: [] }
  const before = new Set(ops.filter((op) => skippedFor(op.id)).map((op) => op.id))
  const results = new Map(runRegexOps(ops, (id) => labels.get(id) ?? id).map((r) => [r.id, r.match]))
  const matched = (id: string) => typeof results.get(id) === 'string'
  return {
    notEnding: notEnding !== undefined && matched(notEnding),
    answers: answers.some((a) => matched(a.text) && (a.source === undefined || matched(a.source))),
    skipped: [...labels]
      .filter(([id]) => !before.has(id) && skippedFor(id))
      .map(([, label]) => skipFinding(label)),
  }
}

// The same concern as the rule above, at the end of a sentence rather than a
// label: a full stop the source has and the translation drops, or the reverse.
const sentenceEnd: Rule = (entry, ctx) => {
  const text = entry.msgstr.find(Boolean)
  if (!text) return []
  const style = ctx.sentenceEnd ? sentenceEndOf(ctx.sentenceEnd, entry.msgid, text) : undefined
  // The source is English, so only the translation is read in its own style.
  const source = endsSentence(entry.msgid)
  // Where the source ends a sentence, the abbreviation's dot ends it too, as
  // English writes "at 9 a.m." without a second stop.
  const target =
    style?.notEnding === true || (!source && DOTTED_ABBREVIATION.test(text))
      ? false
      : endsSentence(text) || (source && style?.answers === true)
  const skipped = style?.skipped ?? []
  if (source === target) return skipped
  if (source && ctx.sentenceEnd?.unmarked) return skipped
  return [
    ...skipped,
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

// `translations` is the flat list the glossary rule checks a translation
// against, and does not care which part of speech a wording belongs to: any
// approved wording passes. `rows` is what the prompt shows, so the model can
// tell the noun from the verb. They are de-duplicated differently on purpose:
// a translation approved as both a noun and a verb is one wording to the rule
// and two rows to the model.
export interface GlossaryMatch {
  term: string
  translations: string[]
  rows: GlossaryMatchRow[]
}

// Each row's term lowered once per glossary rather than once per entry: the
// matcher runs for every row on every entry. Keyed on the array, which a
// context holds for its whole life. Not on the locale: a source term is
// English, and lowers by English rules in every locale.
const LOWERED = new WeakMap<readonly GlossaryEntry[], Array<{ item: GlossaryEntry; term: string; forms: string[] }>>()

function loweredTerms(ctx: RuleContext): Array<{ item: GlossaryEntry; term: string; forms: string[] }> {
  const cached = LOWERED.get(ctx.glossary)
  if (cached) return cached
  const terms = ctx.glossary.map((item) => {
    const term = lowerSource(item.sourceTerm)
    return { item, term, forms: termForms(term) }
  })
  LOWERED.set(ctx.glossary, terms)
  return terms
}

/**
 * The English spellings a glossary term is found under: the term, its last
 * word made plural or singular, and a hyphenated term written closed and open.
 *
 * A row names one form and sources use the others. On a Masteriyo run the tr
 * glossary held "course", "quiz", "attempt", "highlights" and "add-on", and
 * "All Courses", "Export quizzes", "Quiz Attempts", "Course Highlight" and
 * "addon" were all passed over, so dozens of strings kept the wording the
 * glossary had replaced. Only the last word is inflected, since that is the one
 * English marks: "payment methods", not "payments method".
 *
 * The rules are the regular ones and nothing cleverer. They over-generate, and
 * that is safe where it makes a word no source contains ("statu" from
 * "status"); the one kind that is not is a form that is another real word, so
 * "es" is stripped only after s, x, z, ch and sh, or "themes" would be found
 * in "them". What is left ("new" found in "news") is a suspicion the reviewer
 * or the model reads, which is what the rule only ever reports.
 */
export function termForms(term: string): string[] {
  const spellings = term.includes('-') ? [term, term.replaceAll('-', ''), term.replaceAll('-', ' ')] : [term]
  const forms = new Set<string>()
  for (const spelling of spellings) {
    const split = Math.max(spelling.lastIndexOf(' '), spelling.lastIndexOf('-')) + 1
    const head = spelling.slice(0, split)
    for (const word of wordForms(spelling.slice(split))) forms.add(head + word)
  }
  return [...forms].filter((f) => f.length >= 3)
}

function wordForms(word: string): string[] {
  const forms = [word]
  if (!/^\p{L}+$/u.test(word)) return forms
  // Plural.
  if (/(s|x|z|ch|sh)$/.test(word)) forms.push(`${word}es`)
  if (/[aeiou]z$/.test(word)) forms.push(`${word}zes`)
  if (/[^aeiou]y$/.test(word)) forms.push(`${word.slice(0, -1)}ies`)
  if (!word.endsWith('s')) forms.push(`${word}s`)
  // Singular.
  if (word.endsWith('ies')) forms.push(`${word.slice(0, -3)}y`)
  if (word.endsWith('zzes')) forms.push(word.slice(0, -3))
  if (/(s|x|z|ch|sh)es$/.test(word)) forms.push(word.slice(0, -2))
  if (word.endsWith('s') && !word.endsWith('ss')) forms.push(word.slice(0, -1))
  return forms
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
  // Tags out first, names and attributes with them: a translator keeps markup
  // as it is, so a term found there asks for a change nobody may make. On a
  // Masteriyo run "span" was flagged nineteen times from status counts and
  // "login" from a <login> tag. HTML_TAG wants a letter after the bracket, so
  // "items < 5" is left as text.
  const source = lowerSource(msgid.replace(HTML_TAG, ' '))
  const byTerm = new Map<string, GlossaryMatch>()
  for (const { item, term, forms } of loweredTerms(ctx)) {
    if (term.length < 3) continue
    // The substring test first: hasWord builds a regex, and this runs for
    // every glossary row on every entry, which on a real glossary and file
    // was seconds of a run spent compiling patterns for terms not present.
    if (!forms.some((form) => source.includes(form) && hasWord(source, form))) continue
    const found = byTerm.get(term) ?? { term: item.sourceTerm, translations: [], rows: [] }
    // Compared under NFC, so a translation stored in both encodings is listed
    // once; the first spelling stored is the one kept. Rows follow the same
    // rule, with the part of speech and note beside it: the same wording under
    // the same part of speech and note is one row however it was encoded.
    const nfc = item.translation.normalize('NFC')
    if (!found.translations.some((t) => t.normalize('NFC') === nfc)) found.translations.push(item.translation)
    const row: GlossaryMatchRow = {
      translation: item.translation,
      ...(item.partOfSpeech ? { pos: item.partOfSpeech } : {}),
      ...(item.notes ? { note: item.notes } : {}),
    }
    const same = (r: GlossaryMatchRow) =>
      r.translation.normalize('NFC') === nfc && (r.pos ?? '') === (row.pos ?? '') && (r.note ?? '') === (row.note ?? '')
    if (!found.rows.some(same)) found.rows.push(row)
    byTerm.set(term, found)
  }
  return [...byTerm.values()]
}

/**
 * The glossary terms as both prompts render them on an entry: each term's
 * rows, keyed "tr" for the translation whatever the locale, since the prompt
 * names the target language elsewhere and a key per locale would make the
 * payload shape depend on it. An empty part of speech or note is left out.
 */
export function glossaryPayload(matches: readonly GlossaryMatch[]): Record<string, Array<{ tr: string; pos?: string; note?: string }>> {
  return Object.fromEntries(
    matches.map((g) => [
      g.term,
      g.rows.map((r) => ({ tr: r.translation, ...(r.pos ? { pos: r.pos } : {}), ...(r.note ? { note: r.note } : {}) })),
    ]),
  )
}

/**
 * One term's part of a per-entry cache key: everything glossaryPayload
 * renders for it, so a part of speech or note edited on one row re-asks the
 * entries that carry that term and no others. Shared by the audit key and the
 * draft review key so the two cannot drift from the prompt, or from each other.
 *
 * The rows are written as JSON rather than joined with separators. A first
 * version joined fields with "/" and rows with "|", but translations carry "/"
 * (nl writes "waarschuwing/waarschuwingen") and notes are free text, so two
 * different glossaries could spell the same key. The audit key would still
 * part them through configHash's glossary hash; the draft review key has no
 * such second look, and would serve one glossary's verdicts for the other.
 */
export function glossaryKey(match: GlossaryMatch): string {
  return `${match.term}=${JSON.stringify(match.rows.map((r) => [r.translation, r.pos ?? '', r.note ?? '']))}`
}

/**
 * The wordings one glossary row approves, as separate strings.
 *
 * A row's translation is a single field, and translators fill it with more
 * than one wording because GlotPress does not search it strictly: nl stores
 * "waarschuwing/waarschuwingen", tr and es list synonyms with commas, es
 * abbreviates a plural as "dependiente/s". Matched whole, such a row is found
 * in no translation at all, so the rule flagged "Noodwaarschuwing" exactly as
 * it flagged "Noodmelding", and a check that fires on the right answer teaches
 * everyone to ignore it.
 *
 * Parts under three characters are dropped, the same floor glossaryMatches
 * puts on a source term: the "s" of a suffix row is not a word to look for, and
 * a two-letter fragment would be found inside almost anything. A row with
 * nothing left keeps its whole string, so it behaves as it did before. Prose
 * ("guardar o ahorrar, según contexto") splits into pieces no translation
 * contains, which leaves it flagged, as it was; a human reads the row there.
 *
 * Every comparison of a translation against a glossary row goes through this,
 * so the rule, and anything that asks it, cannot disagree about what a row
 * allows.
 */
export function glossaryAlternatives(translation: string): string[] {
  const parts: string[] = []
  for (const raw of translation.split(/[/,]/)) {
    const part = raw.trim().normalize('NFC')
    if ([...part].length < 3 || parts.includes(part)) continue
    parts.push(part)
  }
  return parts.length > 0 ? parts : [translation]
}

const glossary: Rule = (entry, ctx) => {
  const text = entry.msgstr.find(Boolean)
  if (!text) return []
  const target = comparable(text, ctx.locale)

  const missed: string[] = []
  for (const match of glossaryMatches(entry.msgid, ctx)) {
    // Shown as stored, matched by alternative: the message is what a reviewer
    // and the model read, and the GTE's own wording is the clearer of the two.
    const approved = match.translations.map((t) => comparable(t, ctx.locale))
    const accepted = match.translations.flatMap((t) => glossaryAlternatives(t).map((a) => comparable(a, ctx.locale)))
    if (accepted.some((t) => containsTerm(target, t, ctx.profile.glossaryStemRatio))) continue
    missed.push(`"${lowerSource(match.term)}" -> ${approved.map((t) => `"${t}"`).join(' / ')}`)
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

/**
 * The full stops among Unicode 17's sentence terminators: every
 * \p{Sentence_Terminal} except the question and exclamation marks, which change
 * what a sentence says, so a question against a statement is still a different
 * wording. Three of those are named as signs and only Unicode's notes say what
 * they are: Meetei Mayek's AHANG KHUDAM (U+AAF1, "= question mark") and Pahawh
 * Hmong's VOS THOM and VOS TSHAB CEEB (U+16B37, U+16B38), which "function as" a
 * question and an exclamation mark. Syriac's SUPRALINEAR FULL STOP (U+0701) also
 * marks questions in Biblical text, but it is named and mostly used as a stop,
 * so it stays.
 *
 * Written out rather than computed as the property minus those marks, because
 * V8 reads the property from the Unicode version Node ships. A question mark
 * added in a later version would then be stripped as a full stop without anyone
 * noticing. Listed, a newer Unicode changes nothing here: a full stop it adds
 * is reported as a difference until it is added, which is how every script's
 * stop was treated before this list existed, and visible, where the other way
 * round was silent.
 */
const FULL_STOPS =
  /[\u002E\u0589\u061D\u061E\u06D4\u0700-\u0702\u0837\u0839\u083D\u083E\u0964\u0965\u104A\u104B\u1362\u1368\u166E\u1735\u1736\u17D4\u17D5\u1803\u1809\u1AA8-\u1AAB\u1B4E\u1B4F\u1B5A\u1B5B\u1B5E\u1B5F\u1B7D-\u1B7F\u1C3B\u1C3C\u1C7E\u1C7F\u2024\u2CF9\u2E3C\u3002\uA4FF\uA60E\uA6F3\uA876\uA877\uA8CE\uA8CF\uA92F\uA9C8\uA9C9\uAA5D-\uAA5F\uAAF0\uABEB\uFE12\uFE52\uFF0E\uFF61\u{10A56}\u{10A57}\u{10F55}-\u{10F59}\u{10F86}-\u{10F89}\u{11047}\u{11048}\u{110BE}-\u{110C1}\u{11141}\u{11142}\u{111C5}\u{111C6}\u{111CD}\u{111DE}\u{111DF}\u{11238}\u{11239}\u{1123B}\u{1123C}\u{112A9}\u{113D4}\u{113D5}\u{1144B}\u{1144C}\u{115C2}\u{115C3}\u{115C9}-\u{115D7}\u{11641}\u{11642}\u{1173C}-\u{1173E}\u{11944}\u{11946}\u{11A42}\u{11A43}\u{11A9B}\u{11A9C}\u{11C41}\u{11C42}\u{11EF7}\u{11EF8}\u{11F43}\u{11F44}\u{16A6E}\u{16A6F}\u{16AF5}\u{16B44}\u{16D6E}\u{16D6F}\u{16E98}\u{1BC9F}\u{1DA88}]/u

/**
 * The full stop of any script, with the colon and the ellipsis, and any space
 * before them.
 *
 * A Latin-only class held every other script to a stricter standard: the danda
 * (।) ends 1,759 of 5,941 approved Hindi core translations, ۔ 1,295 of 4,061
 * Urdu ones and 。 3,241 of 8,142 Japanese ones, and a submission that dropped
 * one, or wrote "." for it, was reported as a different approved translation
 * where the same difference in German was not. The space is part of it because
 * some translators type one before the danda ("हो गया ।" in 28 approved Hindi
 * translations, 37 Nepali), and the fullwidth colon is the colon of Chinese,
 * where it ends 117 approved translations. The Tibetan shads are named because
 * Unicode does not count them as terminators, though the punctuation check
 * already reads them as the end of a bo or dz sentence.
 */
const TRAILING_STOP = new RegExp(`(?:[\\s:\\uFF1A\\u2026\\u0F0D\\u0F0E]|${FULL_STOPS.source})+$`, 'u')

// Case, spacing and a trailing full stop or colon are not a disagreement worth
// a reviewer's time. On a real submission they were 138 of 474 differences, and
// reporting them would have buried the 336 that mattered.
function sameWording(a: string, b: string, locale: Locale): boolean {
  const norm = (v: string): string =>
    comparable(v, locale)
      .trim()
      .replace(/\s+/g, ' ')
      .replace(TRAILING_STOP, '')
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
  const key = tmKey(entry.msgid, entry.msgctxt)
  const approved = ctx.tm.get(key)
  if (!approved || approved.length === 0) return []
  // Every row is from a readme or release notes: a wording chosen for prose
  // is no authority over an interface string, and on the vault's long-text
  // projects it differs often and for good reason. Matching such a row is
  // already silent below, so only the disagreement is dropped.
  if (ctx.tmWeak?.has(key)) return []
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

/**
 * A PHP date format whose translation prints a wrong date, or an English one
 * where the locale's rules file says how it writes dates. The detail is in
 * date-format.ts. Every problem goes into one finding, so a translation that
 * lost the year and gained a "J" counts once, as one entry with one rule.
 */
const dateFormat: Rule = (entry, ctx) => {
  if (!isDateFormat(entry.msgid, entry.msgctxt)) return []
  const text = entry.msgstr.find(Boolean)
  if (!text) return []
  const problems = dateFormatProblems(entry.msgid, text, ctx.dateTime, languageName(ctx.locale))
  if (problems.length === 0) return []
  return [
    {
      rule: 'date-format',
      severity: problems.some((p) => p.severity === 'error') ? 'error' : 'suspect',
      message: `date format: ${problems.map((p) => p.message).join('; ')}`,
    },
  ]
}

/**
 * A full name kept in English order where the locale's rules file says it
 * writes the family name first. The detail is in name-order.ts. A suspect,
 * not an error: the roles come from a comment or a context, and a string the
 * check misread should cost the contributor a look, not a rejection.
 */
const nameOrder: Rule = (entry, ctx) => {
  if (!ctx.names) return []
  const text = entry.msgstr.find(Boolean)
  if (!text) return []
  const message = nameOrderProblem(entry, text, ctx.names.order, languageName(ctx.locale))
  return message === undefined ? [] : [{ rule: 'name-order', severity: 'suspect', message }]
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
  { name: 'date-format', run: dateFormat },
  { name: 'name-order', run: nameOrder },
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
