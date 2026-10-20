import type { Severity } from '../../types.js'

// PHP date formats, as WordPress hands them to date_i18n and wp_date. A
// translator who copies "g:i a" gives the locale's sites English dates, and
// one who translates the letters breaks them: nl_NL had woocommerce's
// "M d, Y @ h:i A" approved as "M d, J @ u:m", which prints the day,
// microseconds and the month, and six themes with "J" (jaar) for "Y". Neither
// is caught elsewhere. tm-conflict keys by context, and core's own time
// formats use a no-break space, so a theme's "g:i a" never meets core's.
//
// No imports beyond types: the rules file schema checks a dateTime section's
// suggested formats with these functions, and the website's rules builder
// bundles that schema for the browser.

/** A locale's dates and times, from the dateTime section of its rules file. */
export interface DateTimeRules {
  clock?: '12h' | '24h'
  order?: 'dmy' | 'mdy' | 'ymd'
  // What a common English format becomes. Keys are stored with an ordinary
  // space where core writes a no-break one.
  formats?: Readonly<Record<string, string>>
}

export interface DateFormatProblem {
  severity: Severity
  message: string
}

// Every letter PHP's date() reads. Anything else must be escaped.
const FORMAT_LETTERS = new Set('dDjlNSwzWFmMntLoXxYyaABgGhHisuveIOPpTZcrU')
// The letters that make a string recognisably a date or a time.
const CORE_LETTERS = new Set('YFMjdgGhHi')
const MAX_LENGTH = 40
const CONTEXT = /(date|time)[ -]?format/i

const PARTS: { name: string; letters: string; severity: Severity }[] = [
  { name: 'year', letters: 'YyoXx', severity: 'error' },
  { name: 'month', letters: 'FMmn', severity: 'error' },
  { name: 'day', letters: 'dj', severity: 'error' },
  { name: 'hour', letters: 'gGhH', severity: 'error' },
  { name: 'minute', letters: 'i', severity: 'error' },
  // Sometimes left out on purpose: a short date without its weekday.
  { name: 'second', letters: 's', severity: 'suspect' },
  { name: 'weekday', letters: 'DlNw', severity: 'suspect' },
]

/** Core's time formats separate the minute from am and pm with U+00A0. */
export const normaliseFormat = (value: string): string => value.replaceAll(' ', ' ')

// The letters of a format in order, escaped ones skipped: "\a\t" is the word
// "at" in the output, not two format characters.
function letters(value: string): string[] {
  const out: string[] = []
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!
    if (c === '\\') {
      i++
      continue
    }
    if (/\p{L}/u.test(c)) out.push(c)
  }
  return out
}

const has = (found: readonly string[], set: string) => found.some((c) => set.includes(c))

/**
 * Whether a source string is a PHP date format.
 *
 * Measured over the 291 formats in the tr_TR and nl_NL memories, and the
 * strings around them that look like one. A placeholder, a digit or a quote
 * means prose ("Created %@", "e.g. '4M'"), and two letters side by side mean
 * a word ("Date Format" itself, with a "date format" context). A short string
 * of format letters is taken on the word of its context, which is how a
 * yearly archive's lone "Y" is found; without one it needs two distinct
 * date or time letters and something between them, so "N/A" and "A-Z" stay
 * labels.
 */
export function isDateFormat(source: string, context?: string): boolean {
  const s = normaliseFormat(source)
  if (s.length > MAX_LENGTH || /[%0-9'"]/.test(s)) return false
  if (/\p{L}{2}/u.test(s.replace(/\\./g, ''))) return false
  const found = letters(s)
  if (found.length === 0 || found.some((c) => !FORMAT_LETTERS.has(c))) return false
  if (context !== undefined && CONTEXT.test(context)) return true
  return new Set(found.filter((c) => CORE_LETTERS.has(c))).size >= 2 && /[^\p{L}\\]/u.test(s)
}

const TIME_COLON_SPACE = /[gGhHi]: /

/**
 * What is wrong with a translation of a date format source. The caller has
 * already decided the source is one.
 *
 * The universal checks are errors because each prints a wrong date on a
 * site: a letter PHP does not know, a part of the date the source shows and
 * the translation lost, 12-hour time with no am or pm (15:00 as 3:00), and a
 * space after a time colon the source does not have. The locale's dateTime,
 * when it has one, adds suspicions only: a theme sentence can mention a
 * format on purpose, and a copied format is still a working one.
 */
export function dateFormatProblems(source: string, translation: string, rules?: DateTimeRules, language = 'this locale'): DateFormatProblem[] {
  const s = normaliseFormat(source)
  const t = normaliseFormat(translation)
  const from = letters(s)
  const to = letters(t)
  const problems: DateFormatProblem[] = []

  const unknown = [...new Set(to.filter((c) => !FORMAT_LETTERS.has(c)))]
  if (unknown.length > 0) {
    problems.push({
      severity: 'error',
      message: `${unknown.map((c) => `"${c}"`).join(', ')} ${unknown.length === 1 ? 'is not a PHP date letter' : 'are not PHP date letters'}, so the date shows something else; a letter meant as text is escaped, as \\${unknown[0]}`,
    })
  }
  if (TIME_COLON_SPACE.test(t) && !TIME_COLON_SPACE.test(s)) {
    problems.push({ severity: 'error', message: 'a space after the time colon splits the time; the source has none' })
  }
  for (const part of PARTS) {
    if (has(from, part.letters) && !has(to, part.letters)) {
      problems.push({ severity: part.severity, message: `the source shows the ${part.name} and the translation does not` })
    }
  }
  if (has(to, 'gh') && !has(to, 'aA')) {
    problems.push({ severity: 'error', message: '12-hour time (g or h) needs a or A for am and pm; without it 15:00 shows as 3:00' })
  }
  if (rules) problems.push(...localeProblems(s, t, to, rules, language))
  return problems
}

function localeProblems(s: string, t: string, to: string[], rules: DateTimeRules, language: string): DateFormatProblem[] {
  // A copy of a format the file lists gets the locale's wording and nothing
  // else: the clock and the order would only say the same thing less usefully.
  const suggested = rules.formats?.[s.trim()]
  if (suggested !== undefined && t.trim() === s.trim() && suggested !== s.trim()) {
    return [{ severity: 'suspect', message: `"${s.trim()}" is the English format; ${language} writes it "${suggested}"` }]
  }
  const out: DateFormatProblem[] = []
  if (rules.clock === '24h' && has(to, 'ghaA')) {
    out.push({ severity: 'suspect', message: `${language} uses 24-hour time: H or G, without a or A` })
  }
  const wrongOrder = rules.order === undefined ? undefined : orderProblem(to, rules.order)
  if (wrongOrder) out.push({ severity: 'suspect', message: `${language} writes ${wrongOrder}` })
  return out
}

// The order of the day, the month and the year, by where each first appears.
// A year-first date is ISO's Y-m-d, which every locale reads, so it is never
// reported, and parts the translation does not show are not compared.
function orderProblem(to: string[], order: 'dmy' | 'mdy' | 'ymd'): string | undefined {
  const at = (set: string) => to.findIndex((c) => set.includes(c))
  const day = at('dj')
  const month = at('FMmn')
  const year = at('YyoXx')
  if (year !== -1 && (month === -1 || year < month) && (day === -1 || year < day)) return undefined
  if (order === 'ymd' && year !== -1) return 'the year first'
  if (day === -1 || month === -1) return undefined
  if (order === 'dmy' && month < day) return 'the day before the month'
  if (order !== 'dmy' && day < month) return 'the month before the day'
  return undefined
}

/**
 * The locale's dateTime as one prompt line, ending in a newline, or an empty
 * string when it has none.
 *
 * In the prompt as well as in the rule because the rule only compares a
 * translation with a format it knows. The model is the one that can rewrite
 * a composite such as "M j, Y @ g:i a" into the locale's order, given the
 * clock, the order and a few examples. Empty without a dateTime, so every
 * locale that has none keeps its prompt, its hash and its cached verdicts.
 */
export function dateTimeInstruction(rules: DateTimeRules | undefined, language: string): string {
  if (!rules) return ''
  const clock =
    rules.clock === '24h' ? `${language} uses 24-hour time (H or G, never a or A)` : rules.clock === '12h' ? `${language} uses 12-hour time with a or A` : undefined
  const order =
    rules.order === 'dmy'
      ? 'writes the day before the month'
      : rules.order === 'mdy'
        ? 'writes the month before the day'
        : rules.order === 'ymd'
          ? 'writes the year first, then the month and the day'
          : undefined
  const style = clock && order ? `${clock} and ${order}.` : clock ? `${clock}.` : order ? `${language} ${order}.` : ''
  const formats = Object.entries(rules.formats ?? {})
  const examples = formats.length === 0 ? '' : ` Its usual formats: ${formats.map(([from, to]) => `"${from}" → "${to}"`).join(', ')}. Rearrange a longer format the same way.`
  return `- Dates and times: a source that is a PHP date format (such as "F j, Y" or "g:i a", where each letter prints a part of the date) must stay one, with only letters PHP knows and any letter meant as text escaped with a backslash.${style ? ` ${style}` : ''}${examples}\n`
}
