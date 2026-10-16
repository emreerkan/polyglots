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

export interface TuiState {
  wizard: {
    // Set when the wizard was finished or walked past to the end. It then
    // stops opening by itself; Configuration still reaches it.
    dismissed: boolean
    skipped: SetupStep[]
    confirmed: SetupStep[]
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
  wizard: { dismissed: false, skipped: [], confirmed: [] },
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
    },
    settings: {
      exitSummary: typeof settings.exitSummary === 'boolean' ? settings.exitSummary : DEFAULT_TUI_STATE.settings.exitSummary,
    },
    // Not the default's version: a file without one predates the feature.
    whatsNew: typeof whatsNew.seen === 'string' ? { seen: whatsNew.seen } : {},
  }
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
