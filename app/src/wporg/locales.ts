import type { Locale } from '../types.js'
import { WPORG_LOCALES, type WporgLocaleRow } from './locales-data.js'

export { WPORG_LOCALES }

/**
 * A locale as polyglots identifies it: the GlotPress slug, followed by the
 * translation set when it is not the default one. `tr`, `nl-be`, `nl/formal`,
 * `pt/ao90`.
 *
 * The set is part of the identity because a variant is not a label: nl/formal
 * has its own glossary, its own approved translations and its own register, so
 * its memory, caches and rules must stay apart from nl's. The default set is
 * left implicit so every existing `tr` keeps meaning what it meant.
 */
export interface ResolvedLocale extends WporgLocaleRow {
  id: Locale
}

const DEFAULT_SET = 'default'

export const localeId = (slug: string, set: string): Locale => (set === DEFAULT_SET ? slug : `${slug}/${set}`)

const withId = (row: WporgLocaleRow): ResolvedLocale => ({ ...row, id: localeId(row.slug, row.set) })

/**
 * Reads whatever a translator types: the WordPress code (nl_NL_formal, any
 * case, `-` or `_`), the slug (nl-be), or slug/set (nl/formal). Undefined for
 * anything translate.wordpress.org does not list.
 */
export function resolveLocale(input: string): ResolvedLocale | undefined {
  const raw = input.trim()
  if (raw === '') return undefined
  if (raw.includes('/')) {
    const [slug, set] = raw.toLowerCase().split('/')
    const row = WPORG_LOCALES.find((l) => l.slug === slug && l.set === set)
    return row ? withId(row) : undefined
  }
  const asCode = raw.toLowerCase().replace(/-/g, '_')
  const byCode = WPORG_LOCALES.find((l) => l.wp.toLowerCase() === asCode)
  if (byCode) return withId(byCode)
  const asSlug = raw.toLowerCase().replace(/_/g, '-')
  const bySlug = WPORG_LOCALES.find((l) => l.slug === asSlug && l.set === DEFAULT_SET)
  return bySlug ? withId(bySlug) : undefined
}

export function splitLocale(id: Locale): { slug: string; set: string } {
  const [slug = id, set = DEFAULT_SET] = id.split('/')
  return { slug, set }
}

/** The language a rule profile is chosen by: nl for nl/formal, pt for pt-br. */
export function languageOf(id: Locale): string {
  return splitLocale(id).slug.toLowerCase().split(/[-_]/)[0] ?? id
}

/**
 * A tag toLocaleLowerCase and Intl accept. `nl/formal` is not one and makes
 * both throw, so the slug is tried, then its language, then nothing.
 */
// Memoised: lower() calls this for every word the rules compare.
const tags = new Map<Locale, string>()

export function intlTag(id: Locale): string {
  const known = tags.get(id)
  if (known !== undefined) return known
  const tag = findTag(id)
  tags.set(id, tag)
  return tag
}

function findTag(id: Locale): string {
  for (const candidate of [splitLocale(id).slug, languageOf(id)]) {
    try {
      Intl.getCanonicalLocales(candidate)
      'a'.toLocaleLowerCase(candidate)
      return candidate
    } catch {
      // try the next
    }
  }
  return 'und'
}

/**
 * The language name, with the set when it is not the default: "Turkish",
 * "Dutch (formal)". A formal set's register is the point of it, so the prompts
 * name it.
 */
export function localeDisplayName(id: Locale): string {
  const { set } = splitLocale(id)
  let name: string | undefined
  try {
    name = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(intlTag(id))
  } catch {
    name = undefined
  }
  const base = name && name !== intlTag(id) ? name : splitLocale(id).slug
  return set === DEFAULT_SET ? base : `${base} (${set})`
}

/** The locale as part of a file name, which cannot hold a slash: nl-formal. */
export const localeFileTag = (id: Locale): string => id.replace('/', '-')

export function wpCodeOf(id: Locale): string | undefined {
  const { slug, set } = splitLocale(id)
  return WPORG_LOCALES.find((l) => l.slug === slug && l.set === set)?.wp
}

/**
 * The locale id a WordPress code names, read as a code only. resolveLocale
 * would also accept a slug, which is right for what a person types and wrong
 * for a code another program wrote down: a polyglots-data entry whose
 * `locale` says `tr` instead of `tr_TR` is malformed, and reading it as
 * agreeing with the slug `tr` would hide that.
 */
export function localeOfWpCode(code: string): Locale | undefined {
  const wanted = code.trim().toLowerCase()
  const row = WPORG_LOCALES.find((l) => l.wp.toLowerCase() === wanted)
  return row ? localeId(row.slug, row.set) : undefined
}

/**
 * Close matches for an unknown locale, for the error that refuses it.
 *
 * The codes of the language that was typed come first: de_XX is a German
 * locale with a wrong region. When no language starts that way the language
 * itself was mistyped (trr), and a prefix finds nothing, so the nearest codes
 * and slugs by edit distance are offered instead. The distance is capped by
 * the length of what was typed, so a word that is no locale at all suggests
 * nothing rather than three unrelated two-letter codes. Among equally near
 * ones, the one sharing the longer start wins: trr is tr before it is tir.
 */
export function suggestLocales(input: string, limit = 5): string[] {
  const typed = input.trim().toLowerCase()
  const language = typed.split(/[-_/]/)[0] ?? ''
  const byLanguage = WPORG_LOCALES.filter((l) => l.wp.toLowerCase().startsWith(language))
  if (language !== '' && byLanguage.length > 0) return byLanguage.slice(0, limit).map((l) => l.wp)
  const asCode = typed.replace(/-/g, '_')
  const reach = Math.min(2, Math.floor(asCode.length / 2))
  const slugOf = (l: WporgLocaleRow) => l.slug.replace(/-/g, '_')
  return WPORG_LOCALES.map((l) => ({
    wp: l.wp,
    d: Math.min(editDistance(asCode, l.wp.toLowerCase()), editDistance(asCode, slugOf(l))),
    shared: Math.max(sharedStart(asCode, l.wp.toLowerCase()), sharedStart(asCode, slugOf(l))),
  }))
    .filter((c) => c.d <= reach)
    .sort((a, b) => a.d - b.d || b.shared - a.shared)
    .slice(0, limit)
    .map((c) => c.wp)
}

function sharedStart(a: string, b: string): number {
  let n = 0
  while (n < a.length && a[n] === b[n]) n++
  return n
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = row
  }
  return previous[b.length]!
}
