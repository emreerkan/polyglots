import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config.js'
import { glossaryCount, localeConfigured, setupStatus, type SetupFacts } from '../../src/tui/setup.js'
import { DEFAULT_TUI_STATE, loadTuiState, parseTuiState, saveTuiState, tuiStateFile } from '../../src/tui/state.js'
import { VERSION } from '../../src/version.js'
import { agentStatus, makeHome, unusableAgent, type Home } from './helpers.js'

let home: Home
beforeEach(async () => {
  home = await makeHome()
})
afterEach(async () => {
  await home.cleanup()
})

function facts(patch: Partial<SetupFacts> = {}): SetupFacts {
  return {
    config: DEFAULT_CONFIG,
    secrets: {},
    state: DEFAULT_TUI_STATE,
    agents: [agentStatus('claude'), agentStatus('antigravity')],
    localeConfigured: false,
    glossaryCount: 0,
    hasLocaleRules: false,
    ...patch,
  }
}

describe('setupStatus', () => {
  it('counts only the provider on a fresh install with a working agent', () => {
    const status = setupStatus(facts())
    expect(status.steps).toEqual({ locale: 'missing', provider: 'done', keys: 'missing', glossary: 'missing', rules: 'missing' })
    expect(status.done).toBe(1)
    expect(status.total).toBe(5)
  })

  // Read off config.json, not the loaded config: the defaults once named tr,
  // and marked the step done before anyone chose anything.
  it('does not count the default locale as chosen', () => {
    expect(setupStatus(facts({ config: { ...DEFAULT_CONFIG, defaultLocale: 'tr' } })).steps.locale).toBe('missing')
    expect(setupStatus(facts({ localeConfigured: true })).steps.locale).toBe('done')
    const confirmed = { ...DEFAULT_TUI_STATE, wizard: { ...DEFAULT_TUI_STATE.wizard, confirmed: ['locale' as const] } }
    expect(setupStatus(facts({ state: confirmed })).steps.locale).toBe('done')
  })

  it('reads the provider as unknown until discovery answers, and missing when it is unusable', () => {
    const { agents: _, ...rest } = facts()
    expect(setupStatus(rest).steps.provider).toBe('unknown')
    expect(setupStatus(facts({ agents: [unusableAgent('claude', 'not signed in'), agentStatus('antigravity')] })).steps.provider).toBe('missing')
    expect(setupStatus(facts({ config: { ...DEFAULT_CONFIG, reviewProvider: 'local' }, agents: [] })).steps.provider).toBe('done')
  })

  // No AI is a finished choice, not a missing agent: someone who works
  // without AI must be able to reach 5/5, or the wizard reopens every launch.
  it('counts the provider as done with none, before and after discovery answers', () => {
    const none = { ...DEFAULT_CONFIG, reviewProvider: 'none' as const }
    const { agents: _agents, ...rest } = facts({ config: none })
    expect(setupStatus(rest).steps.provider).toBe('done')
    expect(setupStatus(facts({ config: none, agents: [] })).steps.provider).toBe('done')
  })

  it('counts keys as done with the draft engine none, which needs no key', () => {
    expect(setupStatus(facts({ config: { ...DEFAULT_CONFIG, defaultDraftEngine: 'none' } })).steps.keys).toBe('done')
  })

  it('counts keys as done with a key, with the local engine, or when skipped', () => {
    expect(setupStatus(facts({ secrets: { DEEPL_API_KEY: 'k' } })).steps.keys).toBe('done')
    expect(setupStatus(facts({ secrets: { OPENAI_API_KEY: 'k' } })).steps.keys).toBe('done')
    expect(setupStatus(facts({ config: { ...DEFAULT_CONFIG, defaultDraftEngine: 'local' } })).steps.keys).toBe('done')
    const skipped = { ...DEFAULT_TUI_STATE, wizard: { ...DEFAULT_TUI_STATE.wizard, skipped: ['keys' as const] } }
    expect(setupStatus(facts({ state: skipped })).steps.keys).toBe('done')
  })

  // Skipping is a choice about optional keys only. A skipped glossary is
  // still a review with no glossary to check against.
  it('does not count a skipped glossary or rules step as done', () => {
    const skipped = { ...DEFAULT_TUI_STATE, wizard: { ...DEFAULT_TUI_STATE.wizard, skipped: ['glossary' as const, 'rules' as const] } }
    const status = setupStatus(facts({ state: skipped }))
    expect(status.steps.glossary).toBe('missing')
    expect(status.steps.rules).toBe('missing')
  })

  it('counts a synced glossary and a rules file', () => {
    const status = setupStatus(facts({ glossaryCount: 12, hasLocaleRules: true }))
    expect(status.steps.glossary).toBe('done')
    expect(status.steps.rules).toBe('done')
  })
})

describe('localeConfigured', () => {
  it('is true only when config.json names a locale itself', () => {
    expect(localeConfigured()).toBe(false)
    mkdirSync(join(home.path, 'config'), { recursive: true })
    writeFileSync(join(home.path, 'config', 'config.json'), JSON.stringify({ batchSize: 25 }))
    expect(localeConfigured()).toBe(false)
    writeFileSync(join(home.path, 'config', 'config.json'), JSON.stringify({ defaultLocale: 'de' }))
    expect(localeConfigured()).toBe(true)
  })
})

describe('glossaryCount', () => {
  it('is undefined when there is no database, and never creates one', () => {
    const path = join(home.path, 'data', 'polyglots.db')
    expect(glossaryCount('tr', path)).toBeUndefined()
    expect(() => new Database(path, { fileMustExist: true })).toThrow()
  })

  it('counts the rows for the locale only', () => {
    const path = join(home.path, 'g.db')
    const db = new Database(path)
    db.exec('CREATE TABLE glossary (locale TEXT, source_term TEXT)')
    db.prepare('INSERT INTO glossary VALUES (?, ?)').run('tr', 'post')
    db.prepare('INSERT INTO glossary VALUES (?, ?)').run('tr', 'page')
    db.prepare('INSERT INTO glossary VALUES (?, ?)').run('de', 'post')
    db.close()
    expect(glossaryCount('tr', path)).toBe(2)
    expect(glossaryCount('fr', path)).toBe(0)
  })
})

describe('tui.json', () => {
  it('reads the defaults when there is no file', () => {
    expect(loadTuiState()).toEqual(DEFAULT_TUI_STATE)
  })

  it('round-trips through the file beside config.json', () => {
    const state = {
      wizard: { dismissed: true, skipped: ['keys' as const], confirmed: ['locale' as const] },
      settings: { exitSummary: false },
      whatsNew: { seen: '0.31.0' },
    }
    saveTuiState(state)
    expect(tuiStateFile()).toBe(join(home.path, 'config', 'tui.json'))
    expect(loadTuiState()).toEqual(state)
  })

  it('falls back field by field on a damaged file instead of refusing to start', () => {
    expect(parseTuiState('{not json')).toEqual(DEFAULT_TUI_STATE)
    expect(parseTuiState(JSON.stringify({ wizard: { skipped: ['keys', 'nonsense'] }, settings: { exitSummary: 'yes' } }))).toEqual({
      wizard: { dismissed: false, skipped: ['keys'], confirmed: [] },
      settings: { exitSummary: true },
      whatsNew: {},
    })
  })

  // No file means nobody has opened the app here before, so there is nothing
  // new to them: the current version counts as seen. A file without the field
  // was written by a version before "What's new", so its owner is told.
  it('treats a missing file as having seen this version, and an older file as not', () => {
    expect(loadTuiState().whatsNew).toEqual({ seen: VERSION })
    expect(parseTuiState(JSON.stringify({ wizard: { dismissed: true } })).whatsNew).toEqual({})
    expect(parseTuiState(JSON.stringify({ whatsNew: { seen: 7 } })).whatsNew).toEqual({})
  })
})
