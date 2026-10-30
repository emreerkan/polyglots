import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/storage/db.js'
import { replaceGlossary } from '../../src/storage/glossary.js'
import {
  discardGlossaryEdits,
  effectiveEntries,
  effectiveGlossary,
  glossaryStamp,
  importGlossaryRows,
  lookupEffectiveGlossary,
  saveGlossaryEdits,
  StaleGlossaryError,
} from '../../src/storage/glossary-edits.js'
import { importDiff } from '../../src/glossary/import.js'
import type { EffectiveRow, GlossaryDiff, GlossaryRow } from '../../src/glossary/types.js'

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

const row = (term: string, pos: string, translation: string, notes = ''): GlossaryRow => ({ term, pos, translation, notes })
const diff = (d: Partial<GlossaryDiff>): GlossaryDiff => ({ added: [], changed: [], deleted: [], ...d })

interface StoredEdit {
  kind: string
  base_term: string | null
  base_translation: string | null
  term: string | null
  translation: string | null
  base_snapshot: string | null
}

describe('saving glossary edits', () => {
  let db: Database.Database
  const at = new Date('2026-02-01T00:00:00.000Z')
  const now = (): Date => at

  beforeEach(() => {
    db = openDb(':memory:')
    replaceGlossary(db, 'tr', [
      { locale: 'tr', sourceTerm: 'post', translation: 'yazı', partOfSpeech: 'noun' },
      { locale: 'tr', sourceTerm: 'Post', translation: 'gönderi', partOfSpeech: 'noun' },
      { locale: 'tr', sourceTerm: 'post', translation: 'yayınla', partOfSpeech: 'verb' },
      { locale: 'tr', sourceTerm: 'page', translation: 'sayfa' },
    ])
  })

  afterEach(() => db.close())

  const edits = (): StoredEdit[] =>
    db
      .prepare<[], StoredEdit>(
        'SELECT kind, base_term, base_translation, term, translation, base_snapshot FROM glossary_edits ORDER BY id',
      )
      .all()
  const current = (): EffectiveRow[] => effectiveGlossary(db, 'tr')
  const find = (translation: string): EffectiveRow => {
    const r = current().find((x) => x.translation === translation)
    if (!r) throw new Error(`no row ${translation}`)
    return r
  }
  const save = (d: Partial<GlossaryDiff>): string => saveGlossaryEdits(db, 'tr', diff(d), glossaryStamp(db, 'tr'), now)

  it('turns a changed wp.org row into a change edit with that base', () => {
    save({ changed: [{ from: find('sayfa'), to: row('page', '', 'sayfa', 'n') }] })
    expect(edits()).toMatchObject([{ kind: 'change', base_term: 'page', base_translation: 'sayfa', translation: 'sayfa' }])
    expect(find('sayfa')).toMatchObject({ origin: 'changed', notes: 'n', base: row('page', '', 'sayfa') })
  })

  it('turns a deleted wp.org row into a delete edit with that base', () => {
    save({ deleted: [find('sayfa')] })
    expect(edits()).toMatchObject([{ kind: 'delete', base_term: 'page', base_translation: 'sayfa', term: null }])
    expect(current().map((r) => r.term)).not.toContain('page')
  })

  it('updates a changed row in place, keeping its base', () => {
    save({ changed: [{ from: find('yazı'), to: row('post', 'noun', 'ileti') }] })
    save({ changed: [{ from: find('ileti'), to: row('post', 'noun', 'makale') }] })
    expect(edits()).toMatchObject([{ kind: 'change', base_translation: 'yazı', translation: 'makale' }])
  })

  it('turns a deleted changed row into a delete keeping its base', () => {
    save({ changed: [{ from: find('yazı'), to: row('post', 'noun', 'ileti') }] })
    save({ deleted: [find('ileti')] })
    expect(edits()).toMatchObject([{ kind: 'delete', base_translation: 'yazı', term: null, translation: null }])
    expect(current().map((r) => r.translation)).not.toContain('yazı')
  })

  it('keeps at most one edit per base', () => {
    save({ deleted: [find('sayfa')] })
    // A page whose diff names the same base again must not add a second edit beside the first.
    const base = { ...row('page', '', 'sayfa'), origin: 'wporg' as const }
    saveGlossaryEdits(db, 'tr', diff({ changed: [{ from: base, to: row('page', '', 'sayfalar') }] }), glossaryStamp(db, 'tr'), now)
    expect(edits()).toMatchObject([{ kind: 'change', base_translation: 'sayfa', translation: 'sayfalar' }])
  })

  it('updates a changed added row', () => {
    save({ added: [row('archive', 'noun', 'arşiv')] })
    save({ changed: [{ from: find('arşiv'), to: row('archive', 'noun', 'arşivle') }] })
    expect(edits()).toMatchObject([{ kind: 'add', base_term: null, term: 'archive', translation: 'arşivle' }])
  })

  it('removes the edit of a deleted added row', () => {
    save({ added: [row('archive', 'noun', 'arşiv')] })
    save({ deleted: [find('arşiv')] })
    expect(edits()).toEqual([])
  })

  it('removes a change that makes the row equal to its base again', () => {
    save({ changed: [{ from: find('yazı'), to: row('post', 'noun', 'ileti') }] })
    save({ changed: [{ from: find('ileti'), to: row('post', 'noun', 'yazı') }] })
    expect(edits()).toEqual([])
    expect(find('yazı').origin).toBe('wporg')
  })

  it('writes an add with a sorted snapshot of the wp.org translations of its term and part of speech', () => {
    save({ added: [row('POST', 'noun', 'ileti'), row('archive', 'noun', 'arşiv')] })
    expect(edits().map((e) => [e.kind, e.term, e.base_snapshot])).toEqual([
      ['add', 'POST', JSON.stringify(['gönderi', 'yazı'])],
      ['add', 'archive', '[]'],
    ])
  })

  it('returns the new stamp', () => {
    const before = glossaryStamp(db, 'tr')
    const after = save({ added: [row('archive', 'noun', 'arşiv')] })
    expect(after).toBe(glossaryStamp(db, 'tr'))
    expect(after).not.toBe(before)
  })

  it('refuses a stale stamp and writes nothing', () => {
    const stamp = glossaryStamp(db, 'tr')
    save({ added: [row('archive', 'noun', 'arşiv')] })
    const snapshot = edits()
    expect(() =>
      saveGlossaryEdits(db, 'tr', diff({ added: [row('x', '', 'y')], deleted: [find('sayfa')] }), stamp, now),
    ).toThrow(StaleGlossaryError)
    expect(edits()).toEqual(snapshot)
  })

  it('discards every edit of the locale and returns the count', () => {
    save({ added: [row('archive', 'noun', 'arşiv')], deleted: [find('sayfa')] })
    expect(discardGlossaryEdits(db, 'tr')).toBe(2)
    expect(current().every((r) => r.origin === 'wporg')).toBe(true)
    expect(current()).toHaveLength(4)
  })
})

describe('importing glossary rows', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDb(':memory:')
    replaceGlossary(db, 'tr', [
      { locale: 'tr', sourceTerm: 'Quiz', translation: 'test', partOfSpeech: 'noun' },
      { locale: 'tr', sourceTerm: 'page', translation: 'sayfa', partOfSpeech: 'noun' },
    ])
  })

  afterEach(() => db.close())

  it('replaces every row of a term the CSV names, case-insensitively', () => {
    const result = importGlossaryRows(db, 'tr', [row('quiz', 'noun', 'sınav')], glossaryStamp(db, 'tr'))
    expect(result).toEqual({ replaced: 1, added: 1 })
    const quiz = effectiveGlossary(db, 'tr').filter((r) => r.term.toLowerCase() === 'quiz')
    expect(quiz.map((r) => [r.term, r.pos, r.translation])).toEqual([['quiz', 'noun', 'sınav']])
  })

  it('leaves terms the CSV does not name untouched', () => {
    importGlossaryRows(db, 'tr', [row('quiz', 'noun', 'sınav')], glossaryStamp(db, 'tr'))
    expect(effectiveGlossary(db, 'tr').find((r) => r.term === 'page')).toMatchObject({ translation: 'sayfa', origin: 'wporg' })
  })

  it('builds the diff without touching storage', () => {
    const current: EffectiveRow[] = [
      { ...row('Quiz', 'noun', 'test'), origin: 'wporg' },
      { ...row('page', 'noun', 'sayfa'), origin: 'wporg' },
    ]
    expect(importDiff(current, [row('quiz', 'noun', 'sınav')])).toEqual({
      added: [row('quiz', 'noun', 'sınav')],
      changed: [],
      deleted: [current[0]],
    })
  })
})
