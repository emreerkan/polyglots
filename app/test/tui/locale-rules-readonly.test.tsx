import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveConfig } from '../../src/config.js'
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { dbFile } from '../../src/paths.js'
import { openDb } from '../../src/storage/index.js'
import { glossaryRows } from '../../src/tui/setup.js'
import { CommandsProvider } from '../../src/tui/commands.js'
import { LocaleRules } from '../../src/tui/screens/LocaleRules.js'
import { cleanup, fakeCommands, keys, makeHome, render, tick, waitForText, type Home } from './helpers.js'

let home: Home

beforeEach(async () => {
  home = await makeHome()
  // Named rather than assumed: polyglots has no default locale (no-locale.test.tsx).
  saveConfig({ defaultLocale: 'tr' })
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

// A database in rollback-journal mode with one glossary row. openDb() would
// switch it to WAL, a change written into the file header, which is how a
// write on open shows from outside.
function seedRollbackDb(): void {
  const db = openDb()
  db.prepare(`INSERT INTO glossary (locale, source_term, translation, part_of_speech, notes, updated_at) VALUES ('tr', 'post', 'yazı', '', '', 0)`).run()
  db.pragma('journal_mode = DELETE')
  db.close()
}

const journalMode = (): string => {
  const db = new Database(dbFile(), { readonly: true })
  try {
    return String(db.pragma('journal_mode', { simple: true }))
  } finally {
    db.close()
  }
}

describe('glossaryRows', () => {
  it('reads a locale\'s glossary without writing to the database', () => {
    seedRollbackDb()
    expect(glossaryRows('tr').map((g) => g.translation)).toEqual(['yazı'])
    expect(journalMode()).toBe('delete')
  })

  it('creates no database where there is none', () => {
    expect(glossaryRows('tr')).toEqual([])
    expect(existsSync(dbFile())).toBe(false)
  })
})

// The trial stage reads the glossary so the glossary rule fires in a trial
// too. It used openDb(), which sets WAL and runs the migrations: a write to
// the one file polyglots cannot regenerate, from a screen that only reads.
describe('LocaleRules: trying the rules', () => {
  it('leaves polyglots.db untouched when it reads the glossary', async () => {
    seedRollbackDb()
    const view = render(
      <CommandsProvider value={fakeCommands()}>
        <LocaleRules onBack={() => undefined} />
      </CommandsProvider>,
    )
    await waitForText(view.lastFrame, /Locale/)
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Built-in rules/)
    for (let i = 0; i < 20 && !/❯ Try the rules/.test(view.lastFrame()); i++) {
      view.stdin.write(keys.down)
      await tick()
    }
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Source:/)
    expect(journalMode()).toBe('delete')
  })
})
