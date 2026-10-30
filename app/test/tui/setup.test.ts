import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config.js'
import { glossaryCount, localeConfigured, memoryCount, memoryState, missingLocaleSteps, rulesMaintained, setupStatus, tmListed, type SetupFacts } from '../../src/tui/setup.js'
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
    memory: 'missing',
    ...patch,
  }
}

describe('setupStatus', () => {
  it('counts only the provider on a fresh install with a working agent', () => {
    const status = setupStatus(facts())
    expect(status.steps).toEqual({ locale: 'missing', provider: 'done', keys: 'missing', glossary: 'missing', memory: 'missing', rules: 'missing' })
    expect(status.done).toBe(1)
    expect(status.total).toBe(6)
  })

  // Read off config.json, not the loaded config: the defaults once named tr,
  // and marked the step done before anyone chose anything.
  it('does not count the default locale as chosen', () => {
    expect(setupStatus(facts({ config: { ...DEFAULT_CONFIG, defaultLocale: 'tr' } })).steps.locale).toBe('missing')
    expect(setupStatus(facts({ localeConfigured: true })).steps.locale).toBe('done')
    const confirmed = { ...DEFAULT_TUI_STATE, wizard: { ...DEFAULT_TUI_STATE.wizard, confirmed: ['locale' as const] } }
    expect(setupStatus(facts({ state: confirmed })).steps.locale).toBe('done')
  })

  // The skip belongs to the locale it was made for: a person who switches
  // from tr to nl has not declined nl's memory.
  it('a memory skip for one locale does not count for another', () => {
    const state = { ...DEFAULT_TUI_STATE, wizard: { ...DEFAULT_TUI_STATE.wizard, locales: { tr: { skipped: ['memory' as const], confirmed: [] } } } }
    expect(setupStatus(facts({ state, config: { ...DEFAULT_CONFIG, defaultLocale: 'tr' }, memory: 'missing' })).steps.memory).toBe('done')
    expect(setupStatus(facts({ state, config: { ...DEFAULT_CONFIG, defaultLocale: 'nl' }, memory: 'missing' })).steps.memory).toBe('missing')
  })

  it('a global memory skip no longer counts', () => {
    const state = { ...DEFAULT_TUI_STATE, wizard: { ...DEFAULT_TUI_STATE.wizard, skipped: ['memory' as const] } }
    expect(setupStatus(facts({ state, config: { ...DEFAULT_CONFIG, defaultLocale: 'nl' }, memory: 'missing' })).steps.memory).toBe('missing')
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

describe('the memory step', () => {
  it('header counts six steps', () => {
    expect(setupStatus(facts()).total).toBe(6)
  })

  // Done when there is nothing left to offer: rows already held, or a locale
  // the vault does not have. Unknown, not missing, while the manifest is
  // read or out of reach, so a launch offline does not reopen the wizard.
  it.each([
    ['has-rows', 'done'],
    ['no-entry', 'done'],
    ['unknown', 'unknown'],
    ['missing', 'missing'],
  ] as const)('reads %s as %s', (memory, step) => {
    expect(setupStatus(facts({ memory })).steps.memory).toBe(step)
  })

  it('counts a skipped memory step as done, since fetching is optional', () => {
    const skipped = { ...DEFAULT_TUI_STATE, wizard: { ...DEFAULT_TUI_STATE.wizard, locales: { tr: { skipped: ['memory' as const], confirmed: [] } } } }
    const config = { ...DEFAULT_CONFIG, defaultLocale: 'tr' }
    expect(setupStatus(facts({ state: skipped, config, memory: 'missing' })).steps.memory).toBe('done')
    expect(setupStatus(facts({ state: skipped, config, memory: 'unknown' })).steps.memory).toBe('done')
  })
})

describe('missingLocaleSteps', () => {
  it('missingLocaleSteps lists glossary and rules when absent', () => expect(missingLocaleSteps({ memorySkipped: false, hasRules: false })).toEqual(['glossary', 'rules']))

  // Unknown is not missing: offline, the vault cannot say whether it has a
  // memory for the locale, and an offer made on that alone would be noise.
  it('memory counts only when the vault is known to list it', () => {
    expect(missingLocaleSteps({ glossaryCount: 5, memorySkipped: false, hasRules: true })).toEqual([])
    expect(missingLocaleSteps({ glossaryCount: 5, memorySkipped: false, listed: true, hasRules: true })).toEqual(['memory'])
    expect(missingLocaleSteps({ glossaryCount: 5, memorySkipped: true, listed: true, hasRules: true })).toEqual([])
  })

  it('keeps the wizard order and counts held rows as done', () => {
    expect(missingLocaleSteps({ glossaryCount: 0, memoryRows: 0, memorySkipped: false, listed: true, hasRules: false })).toEqual(['glossary', 'memory', 'rules'])
    expect(missingLocaleSteps({ glossaryCount: 3, memoryRows: 10, memorySkipped: false, listed: true, hasRules: true })).toEqual([])
  })
})

describe('memoryState', () => {
  it('prefers rows, then the manifest, and is unknown without either', () => {
    expect(memoryState(3, undefined)).toBe('has-rows')
    expect(memoryState(3, true)).toBe('has-rows')
    expect(memoryState(0, false)).toBe('no-entry')
    expect(memoryState(0, true)).toBe('missing')
    expect(memoryState(undefined, true)).toBe('missing')
    expect(memoryState(0, undefined)).toBe('unknown')
    expect(memoryState(undefined, undefined)).toBe('unknown')
  })
})

describe('memoryCount', () => {
  it('is undefined when there is no database, and never creates one', () => {
    const path = join(home.path, 'data', 'polyglots.db')
    expect(memoryCount('tr', path)).toBeUndefined()
    expect(() => new Database(path, { fileMustExist: true })).toThrow()
  })

  it('counts the rows for the slug only', () => {
    const path = join(home.path, 'm.db')
    const db = new Database(path)
    db.exec('CREATE TABLE tm (locale TEXT, source TEXT)')
    db.prepare('INSERT INTO tm VALUES (?, ?)').run('tr', 'Post')
    db.prepare('INSERT INTO tm VALUES (?, ?)').run('tr', 'Page')
    db.prepare('INSERT INTO tm VALUES (?, ?)').run('tr_TR', 'Post')
    db.close()
    expect(memoryCount('tr', path)).toBe(2)
    expect(memoryCount('de', path)).toBe(0)
  })
})

describe('tmListed', () => {
  it('finds the locale by slug without judging the rest of the manifest', () => {
    const manifest = { schema: 1, generated: '', tm: [{ slug: 'tr', locale: 'tr_TR' }, 'garbage', null], rules: [] }
    expect(tmListed(manifest, 'tr')).toBe(true)
    expect(tmListed(manifest, 'de')).toBe(false)
  })
})

describe('rulesMaintained', () => {
  it('is true only for a maintained entry of the slug', () => {
    const row = (slug: string, status: string) => ({ slug, locale: slug, status })
    const manifest = { schema: 1, generated: '', tm: [], rules: [row('nl', 'maintained'), row('tr', 'maintained'), 'garbage', null] }
    expect(rulesMaintained(manifest, 'nl')).toBe(true)
    expect(rulesMaintained({ ...manifest, rules: [row('nl', 'draft')] }, 'nl')).toBe(false)
    expect(rulesMaintained({ ...manifest, rules: [row('tr', 'maintained')] }, 'nl')).toBe(false)
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

  // The step asks whether the locale has a glossary, and one built only in
  // the editor or by an import is one, before any sync has happened.
  it('counts local edits beside the synced rows', () => {
    const path = join(home.path, 'g.db')
    const db = new Database(path)
    db.exec('CREATE TABLE glossary (locale TEXT, source_term TEXT)')
    db.exec('CREATE TABLE glossary_edits (locale TEXT, kind TEXT)')
    db.prepare('INSERT INTO glossary_edits VALUES (?, ?)').run('tr', 'add')
    db.prepare('INSERT INTO glossary_edits VALUES (?, ?)').run('de', 'add')
    db.close()
    expect(glossaryCount('tr', path)).toBe(1)
    expect(glossaryCount('fr', path)).toBe(0)
  })
})

describe('tui.json', () => {
  it('reads the defaults when there is no file', () => {
    expect(loadTuiState()).toEqual(DEFAULT_TUI_STATE)
  })

  it('round-trips through the file beside config.json', () => {
    const state = {
      wizard: { dismissed: true, skipped: ['keys' as const], confirmed: ['locale' as const], locales: { tr: { skipped: ['memory' as const], confirmed: [], asked: true as const } } },
      settings: { exitSummary: false },
      whatsNew: { seen: '0.31.0' },
      recentLocales: ['tr', 'nl/formal'],
    }
    saveTuiState(state)
    expect(tuiStateFile()).toBe(join(home.path, 'config', 'tui.json'))
    expect(loadTuiState()).toEqual(state)
  })

  it('falls back field by field on a damaged file instead of refusing to start', () => {
    expect(parseTuiState('{not json')).toEqual(DEFAULT_TUI_STATE)
    expect(parseTuiState(JSON.stringify({ wizard: { skipped: ['keys', 'nonsense'] }, settings: { exitSummary: 'yes' } }))).toEqual({
      wizard: { dismissed: false, skipped: ['keys'], confirmed: [], locales: {} },
      settings: { exitSummary: true },
      whatsNew: {},
      recentLocales: [],
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
