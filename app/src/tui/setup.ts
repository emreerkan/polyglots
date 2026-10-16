import { existsSync, readFileSync } from 'node:fs'
import { usableProviders, type AgentStatus } from '../agent/discover.js'
import { loadLocaleRules } from '../rules/load.js'
import { configFile, dbFile } from '../paths.js'
import { allGlossary } from '../storage/glossary.js'
import type { Manifest } from '../data/manifest.js'
import type { GlossaryEntry, Locale, PolyglotsConfig, Secrets } from '../types.js'
import { SETUP_STEPS, type SetupStep, type TuiState } from './state.js'
import { readOnly } from '../storage/read-only.js'

// The six setup steps and whether each is done, worked out in one place so
// the header's x/6 and the wizard can never disagree.

export type StepState = 'done' | 'missing' | 'unknown'

export interface SetupFacts {
  config: PolyglotsConfig
  secrets: Secrets
  state: TuiState
  // Undefined while discovery runs or after it failed.
  agents?: AgentStatus[]
  localeConfigured: boolean
  // Undefined when the memory could not be read.
  glossaryCount?: number
  hasLocaleRules: boolean
  // What polyglots-data offers the locale's memory, see memoryState.
  memory: MemoryFact
}

/**
 * The memory step's facts. `has-rows`: the memory holds strings for the
 * slug. `no-entry`: polyglots-data has no memory for the locale, so there is
 * nothing to fetch. `missing`: it has one and the memory is empty. `unknown`:
 * the manifest is still being read, or could not be.
 */
export type MemoryFact = 'has-rows' | 'no-entry' | 'unknown' | 'missing'

export interface SetupStatus {
  steps: Record<SetupStep, StepState>
  done: number
  total: number
}

export const STEP_LABELS: Record<SetupStep, string> = {
  locale: 'locale',
  provider: 'provider',
  keys: 'keys',
  glossary: 'glossary',
  memory: 'memory',
  rules: 'rules',
}

export function setupStatus(f: SetupFacts): SetupStatus {
  const confirmed = (s: SetupStep) => f.state.wizard.confirmed.includes(s)
  const skipped = (s: SetupStep) => f.state.wizard.skipped.includes(s)
  const steps: Record<SetupStep, StepState> = {
    // Whether the person chose a locale, read off config.json itself. The
    // defaults used to name tr, which made a fresh install read as done; they
    // name none now, but the file stays the authority, since the config here
    // falls back to the defaults when the file cannot be read.
    locale: f.localeConfigured || confirmed('locale') ? 'done' : 'missing',
    // The local reviewer is only ever chosen on purpose, by config set, so it
    // counts as configured, and so does none, which is the choice to work
    // without AI and has nothing for discovery to find. An agent counts once
    // discovery says it is usable; until discovery answers the step is unknown
    // rather than missing, so the count does not flicker down and back up at
    // every launch.
    provider:
      f.config.reviewProvider === 'local' || f.config.reviewProvider === 'none'
        ? 'done'
        : f.agents === undefined
          ? 'unknown'
          : usableProviders(f.agents).includes(f.config.reviewProvider)
            ? 'done'
            : 'missing',
    // Keys are optional: someone who drafts locally, or never drafts, has
    // nothing to set, and a step they can never finish would hold the count
    // at 4/5 and reopen the wizard at every launch.
    keys:
      Boolean(f.secrets.DEEPL_API_KEY) || Boolean(f.secrets.OPENAI_API_KEY) || f.config.defaultDraftEngine === 'local' ||
      f.config.defaultDraftEngine === 'none' ||
      skipped('keys')
        ? 'done'
        : 'missing',
    glossary: f.glossaryCount === undefined ? 'missing' : f.glossaryCount > 0 ? 'done' : 'missing',
    // Optional, unlike the glossary: a memory built from the person's own
    // imports is as good a start as the vault's, and most locales have no
    // vault memory at all. So a skip counts, and so does a locale the
    // manifest does not list. Unknown while the manifest is out of reach,
    // never missing: an offline launch must not reopen the wizard for a
    // step it cannot offer.
    memory:
      f.memory === 'has-rows' || f.memory === 'no-entry' || skipped('memory') ? 'done' : f.memory === 'unknown' ? 'unknown' : 'missing',
    rules: f.hasLocaleRules ? 'done' : 'missing',
  }
  const done = SETUP_STEPS.filter((s) => steps[s] === 'done').length
  return { steps, done, total: SETUP_STEPS.length }
}

/** Whether config.json names a locale itself, rather than leaving the default. */
export function localeConfigured(): boolean {
  try {
    const path = configFile()
    if (!existsSync(path)) return false
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && typeof (parsed as { defaultLocale?: unknown }).defaultLocale === 'string'
  } catch {
    return false
  }
}

/**
 * Glossary rows for a locale, counted without writing (see readOnly).
 * Undefined when there is no database or it cannot be read, which the status
 * shows as not synced.
 */
export function glossaryCount(locale: Locale, path: string = dbFile()): number | undefined {
  return readOnly(
    path,
    (db) => (db.prepare('SELECT COUNT(*) AS n FROM glossary WHERE locale = ?').get(locale) as { n: number }).n,
    undefined,
  )
}

/**
 * A locale's glossary rows, read the same way, for the Locale Rules trial so
 * the glossary rule fires in a trial too. Empty when there is no database or
 * it cannot be read, which leaves the trial without the glossary rule rather
 * than without a trial.
 */
export function glossaryRows(locale: Locale, path: string = dbFile()): GlossaryEntry[] {
  return readOnly(path, (db) => allGlossary(db, locale), [])
}

/**
 * Memory rows for a locale's slug, counted without writing, as glossaryCount
 * counts the glossary. Undefined when there is no database or it cannot be
 * read.
 */
export function memoryCount(locale: Locale, path: string = dbFile()): number | undefined {
  return readOnly(
    path,
    (db) => (db.prepare('SELECT COUNT(*) AS n FROM tm WHERE locale = ?').get(locale) as { n: number }).n,
    undefined,
  )
}

/**
 * The memory step's fact from what is known: rows first, since rows held
 * answer the question without the network; then whether the manifest lists
 * the locale (undefined while it is read, or when it could not be).
 */
export function memoryState(rows: number | undefined, listed: boolean | undefined): MemoryFact {
  if (rows !== undefined && rows > 0) return 'has-rows'
  return listed === undefined ? 'unknown' : listed ? 'missing' : 'no-entry'
}

/**
 * Whether the manifest has a memory for the slug. Only the slug is read, as
 * findTmEntry reads it, and the entry is not judged here: a listed entry that
 * turns out invalid is offered, and the fetch then says what is wrong with
 * it, which is more use than a step that silently never appears.
 */
export function tmListed(manifest: Manifest, locale: Locale): boolean {
  return manifest.tm.some((row) => typeof row === 'object' && row !== null && (row as { slug?: unknown }).slug === locale)
}

/** Whether the locale has a rules file. An invalid one still counts: it exists, and its screen says what is wrong. */
export function hasLocaleRules(locale: Locale): boolean {
  try {
    return loadLocaleRules(locale) !== undefined
  } catch {
    return true
  }
}
