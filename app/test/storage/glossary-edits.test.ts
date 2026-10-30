import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/storage/db.js'
import { replaceGlossary } from '../../src/storage/glossary.js'
import {
  effectiveEntries,
  effectiveGlossary,
  glossaryStamp,
  lookupEffectiveGlossary,
} from '../../src/storage/glossary-edits.js'

function edit(
  db: Database.Database,
  kind: 'add' | 'change' | 'delete',
  base: [string, string, string, string] | null,
  row: [string, string, string, string] | null,
  at = '2026-01-01T00:00:00.000Z',
): void {
  db.prepare(
    `INSERT INTO glossary_edits (locale, kind, base_term, base_pos, base_translation, base_notes,
       term, pos, translation, notes, created_at, updated_at)
     VALUES ('tr', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(kind, ...(base ?? [null, null, null, null]), ...(row ?? [null, null, null, null]), at, at)
}

describe('effective glossary', () => {
  let home: string
  let db: Database.Database

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'polyglots-glossary-edits-'))
    db = openDb(join(home, 'polyglots.db'))
    replaceGlossary(db, 'tr', [
      { locale: 'tr', sourceTerm: 'post', translation: 'yazı', partOfSpeech: 'noun' },
      { locale: 'tr', sourceTerm: 'post', translation: 'yayınla', partOfSpeech: 'verb' },
    ])
  })

  afterEach(async () => {
    db.close()
    await rm(home, { recursive: true, force: true })
  })

  it('applies a change in place', () => {
    edit(db, 'change', ['post', 'noun', 'yazı', ''], ['post', 'noun', 'gönderi', ''])
    const rows = effectiveGlossary(db, 'tr')
    expect(rows.map((r) => [r.pos, r.translation, r.origin])).toEqual([
      ['noun', 'gönderi', 'changed'],
      ['verb', 'yayınla', 'wporg'],
    ])
    expect(rows[0]?.base).toEqual({ term: 'post', pos: 'noun', translation: 'yazı', notes: '' })
  })

  it('removes only the deleted base', () => {
    edit(db, 'delete', ['post', 'verb', 'yayınla', ''], null)
    expect(effectiveGlossary(db, 'tr').map((r) => r.translation)).toEqual(['yazı'])
  })

  it('appends additions last', () => {
    edit(db, 'add', null, ['archive', 'noun', 'arşiv', 'n'])
    const rows = effectiveGlossary(db, 'tr')
    expect(rows.at(-1)).toMatchObject({ term: 'archive', origin: 'added', notes: 'n' })
    expect(rows).toHaveLength(3)
  })

  it('ignores an edit whose base is gone', () => {
    edit(db, 'change', ['post', 'noun', 'old', ''], ['post', 'noun', 'x', ''])
    edit(db, 'delete', ['gone', '', 'x', ''], null)
    expect(effectiveGlossary(db, 'tr').map((r) => r.translation)).toEqual(['yazı', 'yayınla'])
  })

  it('maps to entries and looks up exact before partial', () => {
    edit(db, 'add', null, ['post type', '', 'yazı tipi', ''])
    edit(db, 'change', ['post', 'noun', 'yazı', ''], ['post', 'noun', 'gönderi', ''])
    expect(effectiveEntries(db, 'tr')).toHaveLength(3)
    expect(lookupEffectiveGlossary(db, 'post', 'tr').map((e) => e.translation)).toEqual([
      'gönderi',
      'yayınla',
      'yazı tipi',
    ])
    expect(lookupEffectiveGlossary(db, '  ', 'tr')).toEqual([])
  })

  it('changes the stamp on insert and on delete', () => {
    const s0 = glossaryStamp(db, 'tr')
    edit(db, 'add', null, ['a', '', 'b', ''])
    const s1 = glossaryStamp(db, 'tr')
    expect(s1).not.toBe(s0)
    db.prepare('DELETE FROM glossary_edits').run()
    expect(glossaryStamp(db, 'tr')).not.toBe(s1)
    expect(glossaryStamp(openDb(':memory:'), 'tr')).toBe('0||')
  })

  it('adds the table to a database made before it, keeping rows', () => {
    const path = join(home, 'old.db')
    const old = new Database(path)
    old.exec(`CREATE TABLE glossary (id INTEGER PRIMARY KEY, locale TEXT NOT NULL, source_term TEXT NOT NULL,
      translation TEXT NOT NULL, part_of_speech TEXT, notes TEXT, updated_at TEXT NOT NULL);
      INSERT INTO glossary (locale, source_term, translation, updated_at) VALUES ('tr','a','b','x');`)
    old.close()
    const migrated = openDb(path)
    expect(migrated.prepare('SELECT count(*) AS n FROM glossary_edits').get()).toEqual({ n: 0 })
    expect(migrated.prepare('SELECT count(*) AS n FROM glossary').get()).toEqual({ n: 1 })
    migrated.close()
  })
})
