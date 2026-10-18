import { describe, expect, it } from 'vitest'
import { DEFAULT_TUI_STATE, localeWizard, markAsked, migrateTuiState, parseTuiState, recordStep, type TuiState } from '../../src/tui/state.js'

const withWizard = (wizard: Partial<TuiState['wizard']>): TuiState => ({ ...DEFAULT_TUI_STATE, wizard: { ...DEFAULT_TUI_STATE.wizard, ...wizard } })

describe('parseTuiState locales', () => {
  it('parses locales field by field and drops a damaged entry', () => {
    const s = parseTuiState(JSON.stringify({ wizard: { locales: { tr: { skipped: ['memory', 'bogus'], asked: true }, nl: 'x' } } }))
    expect(s.wizard.locales).toEqual({ tr: { skipped: ['memory'], confirmed: [], asked: true } })
  })

  it('reads a file without locales as none', () => {
    expect(parseTuiState(JSON.stringify({ wizard: { skipped: ['keys'] } })).wizard.locales).toEqual({})
  })
})

describe('migrateTuiState', () => {
  it('migrates a global memory skip into the configured locale and marks it asked', () => {
    const s = migrateTuiState(withWizard({ dismissed: true, skipped: ['memory', 'keys'], confirmed: ['locale'], locales: {} }), 'tr')
    expect(s.wizard.skipped).toEqual(['keys'])
    expect(s.wizard.confirmed).toEqual(['locale'])
    expect(s.wizard.locales.tr).toEqual({ skipped: ['memory'], confirmed: [], asked: true })
  })

  it('drops per-locale steps when no locale is configured', () => {
    const s = migrateTuiState(withWizard({ skipped: ['memory'], confirmed: ['rules'] }), undefined)
    expect(s.wizard.skipped).toEqual([])
    expect(s.wizard.confirmed).toEqual([])
    expect(s.wizard.locales).toEqual({})
  })

  it('is a no-op when already migrated', () => {
    const s = withWizard({ locales: { tr: { skipped: [], confirmed: [], asked: true } } })
    expect(migrateTuiState(s, 'tr')).toBe(s)
  })

  it('is a no-op without a locale and nothing to move', () => {
    expect(migrateTuiState(DEFAULT_TUI_STATE, undefined)).toBe(DEFAULT_TUI_STATE)
  })
})

describe('recordStep', () => {
  it('keeps per-locale and global steps apart', () => {
    let s = recordStep(DEFAULT_TUI_STATE, 'nl', 'skipped', 'memory')
    s = recordStep(s, 'nl', 'skipped', 'keys')
    expect(s.wizard.locales.nl?.skipped).toEqual(['memory'])
    expect(s.wizard.skipped).toEqual(['keys'])
  })

  it('lets the latest answer win', () => {
    let s = recordStep(DEFAULT_TUI_STATE, 'nl', 'skipped', 'memory')
    s = recordStep(s, 'nl', 'confirmed', 'memory')
    expect(localeWizard(s, 'nl')).toEqual({ skipped: [], confirmed: ['memory'] })
    s = recordStep(s, undefined, 'confirmed', 'keys')
    s = recordStep(s, undefined, 'skipped', 'keys')
    expect(s.wizard.confirmed).toEqual([])
    expect(s.wizard.skipped).toEqual(['keys'])
  })

  it('changes nothing for a per-locale step without a locale', () => {
    expect(recordStep(DEFAULT_TUI_STATE, undefined, 'skipped', 'memory')).toBe(DEFAULT_TUI_STATE)
  })
})

describe('localeWizard and markAsked', () => {
  it('answers an empty entry for an unknown locale', () => {
    expect(localeWizard(DEFAULT_TUI_STATE, 'nl')).toEqual({ skipped: [], confirmed: [] })
    expect(localeWizard(DEFAULT_TUI_STATE, undefined)).toEqual({ skipped: [], confirmed: [] })
  })

  it('marks a locale asked and keeps its steps', () => {
    const s = markAsked(recordStep(DEFAULT_TUI_STATE, 'nl', 'skipped', 'memory'), 'nl')
    expect(localeWizard(s, 'nl')).toEqual({ skipped: ['memory'], confirmed: [], asked: true })
  })
})
