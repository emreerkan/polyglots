import { loadConfig, saveConfig, unsetConfig } from '../config.js'
import type { Locale } from '../types.js'
import { openRulesDraft, saveRulesDraft } from './edit.js'

export interface MovedNames {
  locale: string
  path: string
  count: number
}

export interface KeptNames {
  locale: string
  error: string
}

/**
 * Moves the proper nouns config.json held per locale into each locale's rules
 * file, the list Locale rules shows as Always capitalized.
 *
 * Two lists had grown for one purpose: names added with `config add-name`
 * in config.json, and the rules file's list, which the app edits. They are
 * one list now, in the rules file. The names are appended after what the
 * file already lists, or after the built-in names when the file has no list,
 * because a list in the file replaces the built-in one and writing only the
 * moved names would drop Türkiye and the rest.
 *
 * A locale whose rules file cannot be read or written keeps its names in
 * config.json, where review still finds them, and is reported, so a broken
 * file never costs a name. Run once per command; it does nothing when
 * config.json holds no names.
 */
export async function moveLegacyProperNouns(): Promise<{ moved: MovedNames[]; kept: KeptNames[] }> {
  const legacy = loadConfig().properNouns ?? {}
  const moved: MovedNames[] = []
  const kept: KeptNames[] = []
  const remaining: Record<string, string[]> = {}
  for (const [locale, names] of Object.entries(legacy)) {
    if (names.length === 0) continue
    try {
      const draft = openRulesDraft(locale as Locale)
      const current = draft.value.properNouns?.always ?? draft.builtIn.properNouns.always
      const added = names.filter((n) => !current.includes(n))
      if (added.length > 0) {
        await saveRulesDraft(draft, { ...draft.value, properNouns: { ...draft.value.properNouns, always: [...current, ...added] } })
      }
      moved.push({ locale, path: draft.path, count: names.length })
    } catch (err) {
      remaining[locale] = names
      kept.push({ locale, error: err instanceof Error ? err.message : String(err) })
    }
  }
  if (loadConfig().properNouns === undefined) return { moved, kept }
  if (Object.keys(remaining).length === 0) unsetConfig('properNouns')
  else saveConfig({ properNouns: remaining })
  return { moved, kept }
}
