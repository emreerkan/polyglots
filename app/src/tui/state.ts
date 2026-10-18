import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configDir } from '../paths.js'
import { VERSION } from '../version.js'

// What only the interactive app cares about: where the setup wizard was left,
// and settings for the app itself. Kept in its own file beside config.json
// rather than as a key inside it, so config.ts and its schema stay the CLI's,
// and someone who never opens the TUI never sees fields that mean nothing to
// them.

export const SETUP_STEPS = ['locale', 'provider', 'keys', 'glossary', 'memory', 'rules'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

// The steps whose answer belongs to one locale: its glossary, its memory and
// its rules. The others (locale, provider, keys) are about the install. A skip
// of the memory step kept in the global list used to outlive a change of
// locale, so a person who skipped tr's memory was never offered nl's.
export const LOCALE_STEPS = ['glossary', 'memory', 'rules'] as const satisfies readonly SetupStep[]
const isLocaleStep = (step: SetupStep): boolean => (LOCALE_STEPS as readonly SetupStep[]).includes(step)

export interface LocaleWizard {
  skipped: SetupStep[]
  confirmed: SetupStep[]
  // Set once the person has been offered this locale's steps, so switching to
  // a locale that was never set up can tell it apart from one that was.
  asked?: true
}

export interface TuiState {
  wizard: {
    // Set when the wizard was finished or walked past to the end. It then
    // stops opening by itself; Configuration still reaches it.
    dismissed: boolean
    // The install-wide steps only; the per-locale ones live in locales.
    skipped: SetupStep[]
    confirmed: SetupStep[]
    locales: Record<string, LocaleWizard>
  }
  settings: {
    // Print the last run's output path on the normal screen after quitting.
    // The alternate screen is discarded on exit, so without this a finished
    // review's "Wrote x-problems.po" is gone the moment the app closes.
    exitSummary: boolean
  }
  whatsNew: {
    // The newest version whose "What's new" the home screen has shown. Absent
    // in a file written before the feature, which tells an existing user apart
    // from a new one (src/tui/whats-new.ts).
    seen?: string
  }
}

export const DEFAULT_TUI_STATE: TuiState = {
  wizard: { dismissed: false, skipped: [], confirmed: [], locales: {} },
  settings: { exitSummary: true },
  // No file at all is someone opening the app here for the first time, to
  // whom nothing is new. A damaged file lands here too, which costs at most
  // one release's lines.
  whatsNew: { seen: VERSION },
}

export function tuiStateFile(): string {
  return join(configDir(), 'tui.json')
}

const steps = (value: unknown): SetupStep[] =>
  Array.isArray(value) ? value.filter((v): v is SetupStep => (SETUP_STEPS as readonly unknown[]).includes(v)) : []

// Fails open to the defaults, field by field. This file only decides whether
// the wizard shows and whether a line is printed on exit; refusing to start
// the app over it would be out of all proportion, and the next save rewrites
// it whole.
export function parseTuiState(raw: string): TuiState {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_TUI_STATE
  }
  const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
  const root = obj(parsed)
  const wizard = obj(root.wizard)
  const settings = obj(root.settings)
  const whatsNew = obj(root.whatsNew)
  return {
    wizard: {
      dismissed: wizard.dismissed === true,
      skipped: steps(wizard.skipped),
      confirmed: steps(wizard.confirmed),
      locales: Object.fromEntries(
        Object.entries(obj(wizard.locales))
          // An entry that is not an object is damage, and is dropped rather
          // than read as an empty one, which would claim the locale was asked.
          .filter(([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v))
          .map(([locale, v]): [string, LocaleWizard] => {
            const entry = obj(v)
            return [locale, { skipped: steps(entry.skipped), confirmed: steps(entry.confirmed), ...(entry.asked === true ? { asked: true as const } : {}) }]
          }),
      ),
    },
    settings: {
      exitSummary: typeof settings.exitSummary === 'boolean' ? settings.exitSummary : DEFAULT_TUI_STATE.settings.exitSummary,
    },
    // Not the default's version: a file without one predates the feature.
    whatsNew: typeof whatsNew.seen === 'string' ? { seen: whatsNew.seen } : {},
  }
}

export function localeWizard(state: TuiState, locale: string | undefined): LocaleWizard {
  return (locale === undefined ? undefined : state.wizard.locales[locale]) ?? { skipped: [], confirmed: [] }
}

// The latest answer counts: a step chosen after being skipped is no longer
// skipped, and the other way round. A per-locale step with no locale has
// nowhere to go, and changes nothing.
export function recordStep(state: TuiState, locale: string | undefined, kind: 'confirmed' | 'skipped', step: SetupStep): TuiState {
  const other = kind === 'confirmed' ? 'skipped' : 'confirmed'
  const place = <T extends { skipped: SetupStep[]; confirmed: SetupStep[] }>(lists: T): T => ({
    ...lists,
    [kind]: [...lists[kind].filter((x) => x !== step), step],
    [other]: lists[other].filter((x) => x !== step),
  })
  if (!isLocaleStep(step)) return { ...state, wizard: { ...state.wizard, ...place({ skipped: state.wizard.skipped, confirmed: state.wizard.confirmed }) } }
  if (locale === undefined) return state
  return { ...state, wizard: { ...state.wizard, locales: { ...state.wizard.locales, [locale]: place(localeWizard(state, locale)) } } }
}

export function markAsked(state: TuiState, locale: string): TuiState {
  return { ...state, wizard: { ...state.wizard, locales: { ...state.wizard.locales, [locale]: { ...localeWizard(state, locale), asked: true } } } }
}

// Moves the per-locale answers an older file kept in the global lists into the
// locale configured now, which is the only one they can have been given for,
// and marks it asked. With no locale there is nothing to attach them to, and
// they are dropped: the steps read as unanswered, which is what they are.
// Returns the same object when nothing changes, so the caller can skip a save.
export function migrateTuiState(state: TuiState, locale: string | undefined): TuiState {
  const { skipped, confirmed } = state.wizard
  const movable = (list: SetupStep[]) => list.filter(isLocaleStep)
  const nothingToMove = movable(skipped).length === 0 && movable(confirmed).length === 0
  if (nothingToMove && (locale === undefined || state.wizard.locales[locale]?.asked === true)) return state
  const stripped: TuiState = {
    ...state,
    wizard: { ...state.wizard, skipped: skipped.filter((s) => !isLocaleStep(s)), confirmed: confirmed.filter((s) => !isLocaleStep(s)) },
  }
  if (locale === undefined) return stripped
  const entry = localeWizard(state, locale)
  const merge = (a: SetupStep[], b: SetupStep[]) => [...a, ...b.filter((x) => !a.includes(x))]
  return markAsked(
    {
      ...stripped,
      wizard: {
        ...stripped.wizard,
        locales: { ...state.wizard.locales, [locale]: { ...entry, skipped: merge(entry.skipped, movable(skipped)), confirmed: merge(entry.confirmed, movable(confirmed)) } },
      },
    },
    locale,
  )
}

export function loadTuiState(): TuiState {
  try {
    return parseTuiState(readFileSync(tuiStateFile(), 'utf8'))
  } catch {
    return DEFAULT_TUI_STATE
  }
}

export function saveTuiState(state: TuiState): void {
  const path = tuiStateFile()
  mkdirSync(dirname(path), { recursive: true })
  // Written aside and renamed, as config.json is, so a crash mid-write leaves
  // the old file rather than half of a new one.
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}
