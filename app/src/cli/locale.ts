import { basename } from 'node:path'
import { loadPo } from '../po/po-file.js'
import type { Locale, PolyglotsConfig } from '../types.js'
import { WPORG_LOCALES, resolveLocale } from '../wporg/locales.js'
import { UsageError, parseLocaleArg } from './args.js'

// polyglots once fell back to tr when no locale was set, because it was
// written by and for one Turkish reviewer. For anyone else that fallback was
// worse than an error: a German translator's first review ran Turkish rules
// against German text and reported the result with full confidence. So there
// is no default now, and a command that needs a locale and is given none
// stops and says how to give one.

/** How a command takes its locale, as the refusal should tell the person to pass it. */
export type LocaleWay = { flag: true } | { argument: string }

const SET_IT = 'or set one for every run: polyglots config set defaultLocale <code>'

/** The refusal for a command that needs a locale and was given none. */
export function noLocaleMessage(way: LocaleWay): string {
  const pass = 'flag' in way ? 'Pass --locale <code>' : `Name one, as in ${way.argument} <code>`
  return `No locale set. ${pass}, ${SET_IT}`
}

/**
 * The locale a command runs in: what was typed, else the configured one, else
 * a refusal. For the commands with no file to read a language from, and for
 * those whose file must not be trusted to choose: a TMX imported under the
 * wrong locale lands in the one database that cannot be regenerated.
 */
export function requireLocale(raw: string | undefined, config: PolyglotsConfig, way: LocaleWay = { flag: true }): Locale {
  if (raw !== undefined) return parseLocaleArg(raw)
  if (config.defaultLocale !== undefined) return parseLocaleArg(config.defaultLocale)
  throw new UsageError(noLocaleMessage(way))
}

/** Help text for a --locale flag, saying what applies when it is left off. */
export function localeDefaultHelp(config: PolyglotsConfig, header = false): string {
  if (config.defaultLocale !== undefined) return `default: ${config.defaultLocale}`
  return header ? "default: defaultLocale, else the file's Language header" : 'default: defaultLocale, none set yet'
}

export interface FileLocale {
  locale: Locale
  /** Set when the locale came from the files' Language header rather than from a flag or config. */
  fromHeader?: true
}

/**
 * The locale for a run over .po files: --locale, then config, then the files'
 * own Language header.
 *
 * Config before the header, not after, so nobody who set a locale sees a
 * change: their files are run exactly as before, whatever their headers say.
 * The header is only reached by someone who has set nothing, for whom the
 * alternative is a refusal.
 *
 * It is trusted only when it cannot be misread. Every file must declare the
 * same language, and translate.wordpress.org must have one translation set
 * for it: GlotPress writes de_DE for both de and de/formal, and guessing the
 * informal one would review a formal submission against the wrong register
 * without a word. Either failure refuses with the same message as having no
 * header at all, plus what the files did say.
 */
export async function resolveFileLocale(
  raw: string | undefined,
  config: PolyglotsConfig,
  files: string[],
  opts: { antigravity?: boolean } = {},
): Promise<FileLocale> {
  if (raw !== undefined || config.defaultLocale !== undefined) return { locale: requireLocale(raw, config) }
  // Antigravity's lookup server is registered once, outside any run, and
  // takes its locale from POLYGLOTS_LOCALE or config when it starts. A locale
  // read from a header never reaches it, so its glossary and memory lookups
  // would answer in whatever language it was started with. Passing the run's
  // locale through the prompt would fix that, at the cost of every cached
  // verdict; refusing the header costs one flag.
  if (opts.antigravity) {
    throw new UsageError(
      `With Antigravity reviewing, the locale has to come from --locale or defaultLocale: its lookup server never hears a locale read from the file. ${noLocaleMessage({ flag: true })}`,
    )
  }
  const declared: string[] = []
  for (const file of files) {
    const language = (await loadPo(file)).headers['Language']?.trim()
    if (!language) {
      // With several files, say which one stopped it.
      const which = files.length > 1 ? `${basename(file)} has no Language header. ` : ''
      throw new UsageError(`${which}${noLocaleMessage({ flag: true })}`)
    }
    declared.push(language)
  }
  const resolved = declared.map((language) => resolveLocale(language))
  const ids = [...new Set(resolved.map((r) => r?.id))]
  if (resolved.some((r) => r === undefined) || ids.length !== 1) {
    const said = [...new Set(declared)].join(', ')
    throw new UsageError(`The files declare ${said}, not one locale polyglots can use. ${noLocaleMessage({ flag: true })}`)
  }
  const read = readLanguage(declared[0]!)
  if (read !== undefined && 'choices' in read) {
    const choices = [...read.choices]
    const last = choices.pop()
    throw new UsageError(`The file says ${declared[0]}, and ${declared[0]} could be ${choices.join(', ')} or ${last}. ${noLocaleMessage({ flag: true })}`)
  }
  return { locale: ids[0]!, fromHeader: true }
}

/**
 * What a Language header names: one locale, the several it could be, or
 * nothing translate.wordpress.org lists. Several when the header resolves to
 * a default translation set whose language has others (de_DE: de, de/formal),
 * because GlotPress writes the same code for all of them.
 */
export function readLanguage(language: string): { locale: Locale } | { choices: Locale[] } | undefined {
  const row = resolveLocale(language)
  if (!row) return undefined
  const siblings = WPORG_LOCALES.filter((l) => l.slug === row.slug)
  if (row.set === 'default' && siblings.length > 1) {
    return { choices: siblings.map((l) => (l.set === 'default' ? l.slug : `${l.slug}/${l.set}`)) }
  }
  return { locale: row.id }
}

/**
 * The locale a .po's header names unambiguously, for the menu to offer in its
 * locale field. Undefined for anything less certain, or a file that cannot be
 * read: the field is shown and editable, so an empty one costs a few keys and
 * a wrong one could cost a review.
 */
export async function headerLocaleOf(file: string): Promise<Locale | undefined> {
  try {
    const language = (await loadPo(file)).headers['Language']?.trim()
    const read = language ? readLanguage(language) : undefined
    return read !== undefined && 'locale' in read ? read.locale : undefined
  } catch {
    return undefined
  }
}

/**
 * The Language header of a file written for another language than `locale`,
 * as the header writes it, for a run form to say so when the configured
 * locale is the one that will run. Compared by language rather than through
 * headerLocaleOf, which gives nothing for de_DE (de or de/formal) and so would
 * say nothing for most Dutch and German files. Undefined for the same
 * language, and for a header it cannot read: a warning that guesses is noise.
 */
export async function headerLanguageOtherThan(file: string, locale: Locale): Promise<string | undefined> {
  try {
    const language = (await loadPo(file)).headers['Language']?.trim()
    const header = language ? resolveLocale(language) : undefined
    const configured = resolveLocale(locale)
    if (!header || !configured) return undefined
    return header.slug === configured.slug ? undefined : language
  } catch {
    return undefined
  }
}

export const headerLocaleNotice = (locale: Locale): string =>
  `Locale ${locale}, from the file's Language header. Pass --locale to choose another.`
