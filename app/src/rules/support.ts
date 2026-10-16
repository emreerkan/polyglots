import { isUniversalOnly, profileFor } from '../audit/rules/profiles.js'
import type { Locale } from '../types.js'
import { loadLocaleRules } from './load.js'

export interface LocaleSupport {
  // Whether the locale has a rules file. Throws, through the loader, when it
  // has one that does not parse, exactly as a review would.
  file: boolean
  // The rules that will run are the universal ones and nothing else.
  universalOnly: boolean
}

/**
 * What polyglots knows about a locale, for the surfaces that say so. Only what
 * its rules file says: the code ships no locale's data, so there is nothing
 * built in to report beside it.
 */
export function localeSupport(locale: Locale): LocaleSupport {
  return {
    file: loadLocaleRules(locale) !== undefined,
    universalOnly: isUniversalOnly(profileFor(locale)),
  }
}

/**
 * Said before a review or translate whose rules know nothing about the
 * language, so the person reading the output can tell an absent finding from
 * a passed check. Undefined otherwise. Never a refusal: the universal checks
 * are worth running on their own.
 *
 * It points at rules fetch, as rules check does: most locales that have rules
 * have them from their team's published file, and writing one by hand is for
 * the locale whose team has published none.
 */
export function supportNotice(locale: Locale): string | undefined {
  if (!isUniversalOnly(profileFor(locale))) return undefined
  return `No locale rules for ${locale}; only the universal checks run. Fetch your locale team's file with: polyglots rules fetch ${locale}`
}
