import { dateTimeInstruction } from '../audit/rules/date-format.js'
import type { Locale } from '../types.js'
import { loadLocaleRules } from './load.js'

/**
 * The locale file's guidance as a prompt section, or an empty string.
 *
 * Empty rather than an empty heading when there is none, so a locale without
 * a file gets a prompt identical to before, and so the same configHash and
 * every cached verdict. Placed in the fixed part of each prompt, after the
 * standards and before the entries, so a provider that caches a prompt's
 * opening still can.
 */
export function guidanceSection(locale: Locale): string {
  const guidance = loadLocaleRules(locale)?.guidance
  return guidance ? `\nThe locale team's own guidance:\n${guidance}\n` : ''
}

/** The locale file's dateTime as a prompt line; see dateTimeInstruction. */
export function dateTimeLine(locale: Locale, language: string): string {
  return dateTimeInstruction(loadLocaleRules(locale)?.dateTime, language)
}
