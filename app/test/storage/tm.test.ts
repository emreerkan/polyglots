import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DatabaseCtor from 'better-sqlite3'
import type Database from 'better-sqlite3'
import { openDb } from '../../src/storage/db.js'
import { findExactTm, findMemory, findMemoryIgnoringCase, insertTmIfAbsent, searchTm, upsertTm } from '../../src/storage/tm.js'

describe('tm', () => {
  let home: string
  let db: Database.Database

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'polyglots-tm-'))
    db = openDb(join(home, 'polyglots.db'))
  })

  afterEach(async () => {
    db.close()
    await rm(home, { recursive: true, force: true })
  })

  /**
   * The memory holds every translation the locale approved for a source, not
   * the last one imported. Collapsing them made whichever alternative came last
   * in a TMX the one that answers for the source, which is arbitrary, and since
   * 0.14.0 that answer approves submissions without a model. A real export held
   * 6,480 sources with more than one approved wording.
   */
  it('keeps a second translation of the same source as an alternative', () => {
    upsertTm(db, [{ source: 'Scroll to Top', target: 'Tepeye kaydır', locale: 'tr' }])
    upsertTm(db, [{ source: 'Scroll to Top', target: 'Yukarı kaydır', locale: 'tr' }])

    expect(findMemory(db, 'Scroll to Top', 'tr').map((e) => e.target).sort()).toEqual(['Tepeye kaydır', 'Yukarı kaydır'])
  })

  it('still dedups a translation it already holds', () => {
    upsertTm(db, [
      { source: 'Settings', target: 'Ayarlar', locale: 'tr' },
      { source: 'Settings', target: 'Ayarlar', locale: 'tr' },
    ])
    expect(findMemory(db, 'Settings', 'tr')).toHaveLength(1)
  })

  // Alternatives belong to the context they were approved under. Mixing them
  // would hand a verb's translation to a noun.
  it('keeps each context own alternatives to itself', () => {
    upsertTm(db, [
      { source: 'Post', target: 'Yazı', locale: 'tr' },
      { source: 'Post', target: 'Gönderi', locale: 'tr' },
      { source: 'Post', target: 'Gönder', locale: 'tr', context: 'verb' },
    ])
    expect(findMemory(db, 'Post', 'tr', 'verb').map((e) => e.target)).toEqual(['Gönder'])
    expect(findMemory(db, 'Post', 'tr').map((e) => e.target).sort()).toEqual(['Gönderi', 'Yazı'])
    // The context-less fallback still applies when the scoped context has none.
    expect(findMemory(db, 'Post', 'tr', 'unknown').map((e) => e.target).sort()).toEqual(['Gönderi', 'Yazı'])
    expect(findMemory(db, 'Missing', 'tr')).toEqual([])
  })

  // For the callers that can only act on one, such as filling an untranslated
  // entry during a translate run.
  it('offers the most recently updated alternative first', () => {
    upsertTm(db, [{ source: 'Icon', target: 'İkon', locale: 'tr' }])
    upsertTm(db, [{ source: 'Icon', target: 'Simge', locale: 'tr' }])
    expect(findMemory(db, 'Icon', 'tr')[0]?.target).toBe('Simge')
    expect(findExactTm(db, 'Icon', 'tr')?.target).toBe('Simge')
  })

  it('upsert dedups on source+locale+context+target and refreshes what it holds', () => {
    const inserted = upsertTm(db, [
      { source: 'Settings', target: 'Ayarlar', locale: 'tr' },
      { source: 'Settings', target: 'Ayarlar', locale: 'tr' },
      { source: 'Settings', target: 'Einstellungen', locale: 'de' },
      { source: 'Settings', target: 'Ayarlar (menü)', locale: 'tr', context: 'menu' },
    ])
    expect(inserted).toBe(4)
    const rows = db.prepare('SELECT count(*) AS n FROM tm').get() as { n: number }
    expect(rows.n).toBe(3)

    // A wording the memory does not hold yet joins the source rather than
    // replacing what is there.
    upsertTm(db, [{ source: 'Settings', target: 'Seçenekler', locale: 'tr', project: 'woo' }])
    const after = db.prepare('SELECT count(*) AS n FROM tm').get() as { n: number }
    expect(after.n).toBe(4)
    const hit = findExactTm(db, 'Settings', 'tr')
    expect(hit?.target).toBe('Seçenekler')
    expect(hit?.project).toBe('woo')
    expect(hit?.context).toBeUndefined()
    expect(findMemory(db, 'Settings', 'tr').map((e) => e.target).sort()).toEqual(['Ayarlar', 'Seçenekler'])
  })

  it('returns 0 for an empty batch', () => {
    expect(upsertTm(db, [])).toBe(0)
  })

  /**
   * A database written before alternatives were kept carries a unique
   * constraint that allows only one translation per source. Opening it has to
   * rebuild the table, keep every row, and leave the full text index working.
   */
  it('migrates a database that could only hold one translation per source', async () => {
    const old = join(home, 'old.db')
    const raw = new DatabaseCtor(old)
    raw.exec(`
      CREATE TABLE tm (
        id INTEGER PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL, locale TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '', project TEXT, updated_at TEXT NOT NULL,
        UNIQUE (source, locale, context)
      );
      INSERT INTO tm (source, target, locale, context, project, updated_at)
      VALUES ('Scroll to Top', 'Tepeye kaydır', 'tr', '', 'core', '2020-01-01T00:00:00.000Z');
    `)
    raw.close()

    const migrated = openDb(old)
    try {
      expect(findMemory(migrated, 'Scroll to Top', 'tr').map((e) => e.target)).toEqual(['Tepeye kaydır'])
      upsertTm(migrated, [{ source: 'Scroll to Top', target: 'Yukarı kaydır', locale: 'tr' }])
      expect(findMemory(migrated, 'Scroll to Top', 'tr')).toHaveLength(2)
      // The index is content-backed by the table that was just replaced.
      expect(searchTm(migrated, 'Scroll to Top', 'tr').length).toBeGreaterThan(0)
    } finally {
      migrated.close()
    }
  })

  it('prefers a context-specific match and falls back to context-less', () => {
    upsertTm(db, [
      { source: 'Post', target: 'Yazı', locale: 'tr' },
      { source: 'Post', target: 'Gönder', locale: 'tr', context: 'verb' },
    ])
    expect(findExactTm(db, 'Post', 'tr', 'verb')?.target).toBe('Gönder')
    expect(findExactTm(db, 'Post', 'tr', 'verb')?.context).toBe('verb')
    expect(findExactTm(db, 'Post', 'tr', 'unknown-ctx')?.target).toBe('Yazı')
    expect(findExactTm(db, 'Post', 'tr')?.target).toBe('Yazı')
    expect(findExactTm(db, 'Post', 'de')).toBeUndefined()
    expect(findExactTm(db, 'Missing', 'tr')).toBeUndefined()
  })

  it('does not fall back to a contextual entry when no context-less one exists', () => {
    upsertTm(db, [{ source: 'Post', target: 'Gönder', locale: 'tr', context: 'verb' }])
    expect(findExactTm(db, 'Post', 'tr')).toBeUndefined()
    expect(findExactTm(db, 'Post', 'tr', 'noun')).toBeUndefined()
  })

  describe('searchTm', () => {
    beforeEach(() => {
      upsertTm(db, [
        { source: 'Save changes to your profile', target: 'Profilinizdeki değişiklikleri kaydedin', locale: 'tr' },
        { source: 'Discard changes', target: 'Değişiklikleri sil', locale: 'tr' },
        { source: 'Upload a new image', target: 'Yeni bir görsel yükle', locale: 'tr' },
        { source: 'Save changes', target: 'Änderungen speichern', locale: 'de' },
      ])
    })

    it('returns a near match for a partially matching phrase, scoped to locale', () => {
      const results = searchTm(db, 'Save your changes', 'tr')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]?.source).toBe('Save changes to your profile')
      expect(results.every((r) => r.locale === 'tr')).toBe(true)
      for (const r of results) {
        expect(r.score).toBeGreaterThan(0)
        expect(r.score).toBeLessThan(1)
      }
      expect(results.map((r) => r.source)).not.toContain('Upload a new image')
    })

    it('ranks better matches first', () => {
      const results = searchTm(db, 'save changes profile', 'tr')
      expect(results[0]?.source).toBe('Save changes to your profile')
      expect(results[1]?.source).toBe('Discard changes')
      expect(results[0]!.score).toBeGreaterThan(results[1]!.score)
    })

    it('gives an exact match a score of 1', () => {
      const results = searchTm(db, 'Discard changes', 'tr')
      expect(results[0]?.source).toBe('Discard changes')
      expect(results[0]?.score).toBe(1)
    })

    it('returns nothing for garbage', () => {
      expect(searchTm(db, 'xyzzy qwertyuiop', 'tr')).toEqual([])
      expect(searchTm(db, '', 'tr')).toEqual([])
    })

    it('does not throw on FTS special characters', () => {
      expect(() => searchTm(db, 'save "changes* OR (NOT) - ^ : {x}', 'tr')).not.toThrow()
      expect(searchTm(db, '"changes*', 'tr').length).toBeGreaterThan(0)
      expect(searchTm(db, '*** "" ()', 'tr')).toEqual([])
    })

    it('respects the limit', () => {
      expect(searchTm(db, 'changes', 'tr', 1)).toHaveLength(1)
    })
  })

  describe('insertTmIfAbsent', () => {
    const rows = () =>
      db.prepare('SELECT source, target, locale, context, project, updated_at FROM tm ORDER BY source, target').all()

    it('keeps a row the user has untouched, project and updated_at', () => {
      upsertTm(db, [{ source: 'Save', target: 'Kaydet', locale: 'tr', project: 'mine' }])
      const before = rows()
      const r = insertTmIfAbsent(
        db,
        [
          { source: 'Save', target: 'Kaydet', locale: 'tr', project: 'wp/dev' },
          { source: 'Edit', target: 'Düzenle', locale: 'tr', project: 'wp/dev' },
        ],
        '2026-10-16T03:00:00Z',
      )
      expect(r).toEqual({ added: 1, present: 1 })
      const after = rows() as { source: string; project: string; updated_at: string }[]
      expect(after.find((x) => x.source === 'Save')).toEqual(before[0])
      expect(after.find((x) => x.source === 'Edit')).toMatchObject({ project: 'wp/dev', updated_at: '2026-10-16T03:00:00Z' })
    })

    it('counts a duplicate inside the same list as present', () => {
      const e = { source: 'Save', target: 'Kaydet', locale: 'tr' }
      expect(insertTmIfAbsent(db, [e, e], 't')).toEqual({ added: 1, present: 1 })
    })

    it('gives the same rows in small chunks as in one', () => {
      const entries = Array.from({ length: 23 }, (_, i) => ({ source: `S${i % 17}`, target: `T${i}`, locale: 'tr', project: 'p' }))
      const r = insertTmIfAbsent(db, entries, 't', 4)
      const chunked = rows()
      const other = openDb(join(home, 'other.db'))
      try {
        expect(insertTmIfAbsent(other, entries, 't')).toEqual(r)
        expect(other.prepare('SELECT source, target, locale, context, project, updated_at FROM tm ORDER BY source, target').all()).toEqual(chunked)
      } finally {
        other.close()
      }
    })

    it('finds what it inserted through the full-text index', () => {
      insertTmIfAbsent(db, [{ source: 'Discard changes', target: 'Değişiklikleri at', locale: 'tr' }], 't')
      expect(searchTm(db, 'Discard changes', 'tr')[0]?.target).toBe('Değişiklikleri at')
    })

    it('adds nothing for an empty list', () => {
      expect(insertTmIfAbsent(db, [], 't')).toEqual({ added: 0, present: 0 })
    })
  })

  /**
   * A string taken only from readmes and release notes is a wording someone
   * chose for prose, and an interface label should not inherit it ahead of
   * one chosen for an interface. Low rows stay in every answer, after the rest.
   */
  describe('weight', () => {
    const weightOf = (target: string) =>
      (db.prepare('SELECT weight FROM tm WHERE target = ?').get(target) as { weight: number }).weight
    const age = (target: string, updatedAt: string) =>
      db.prepare('UPDATE tm SET updated_at = ? WHERE target = ?').run(updatedAt, target)

    it('findMemory lists normal rows before low rows, newer low rows included', () => {
      upsertTm(db, [{ source: 'Plugin', target: 'Eklenti', locale: 'tr' }])
      upsertTm(db, [{ source: 'Plugin', target: 'Eklentisi', locale: 'tr', weight: 'low' }])
      age('Eklenti', '2020-01-01T00:00:00.000Z')
      age('Eklentisi', '2026-01-01T00:00:00.000Z')
      const hits = findMemory(db, 'Plugin', 'tr')
      expect(hits.map((h) => h.target)).toEqual(['Eklenti', 'Eklentisi'])
      expect(hits[0]).not.toHaveProperty('weight')
      expect(hits[1]?.weight).toBe('low')
    })

    it('findExactTm prefers the normal row', () => {
      insertTmIfAbsent(db, [{ source: 'Plugin', target: 'Eklentisi', locale: 'tr', weight: 'low' }], '2026-10-16T03:00:00Z')
      insertTmIfAbsent(db, [{ source: 'Plugin', target: 'Eklenti', locale: 'tr' }], '2020-01-01T00:00:00Z')
      expect(findExactTm(db, 'Plugin', 'tr')?.target).toBe('Eklenti')
    })

    it('still answers from a low row when it is all there is', () => {
      insertTmIfAbsent(db, [{ source: 'Plugin', target: 'Eklentisi', locale: 'tr', weight: 'low' }], 't')
      expect(findExactTm(db, 'Plugin', 'tr')).toMatchObject({ target: 'Eklentisi', weight: 'low' })
    })

    it('searchTm ranks low below normal at equal score', () => {
      insertTmIfAbsent(db, [{ source: 'Save the draft', target: 'Taslağı kaydet (readme)', locale: 'tr', weight: 'low' }], 't')
      insertTmIfAbsent(db, [{ source: 'Save the draft', target: 'Taslağı kaydet', locale: 'tr' }], 't')
      const hits = searchTm(db, 'Save the draft', 'tr')
      expect(hits.map((h) => [h.target, h.score])).toEqual([
        ['Taslağı kaydet', 1],
        ['Taslağı kaydet (readme)', 1],
      ])
    })

    it('searchTm still puts a better low match above a worse normal one', () => {
      insertTmIfAbsent(db, [{ source: 'Save the draft', target: 'Taslağı kaydet', locale: 'tr', weight: 'low' }], 't')
      insertTmIfAbsent(db, [{ source: 'Save the draft now please', target: 'Şimdi kaydet', locale: 'tr' }], 't')
      expect(searchTm(db, 'Save the draft', 'tr')[0]?.target).toBe('Taslağı kaydet')
    })

    it('insertTmIfAbsent never changes the weight of a row already present', () => {
      upsertTm(db, [{ source: 'Plugin', target: 'Eklenti', locale: 'tr' }])
      upsertTm(db, [{ source: 'Theme', target: 'Tema', locale: 'tr', weight: 'low' }])
      insertTmIfAbsent(
        db,
        [
          { source: 'Plugin', target: 'Eklenti', locale: 'tr', weight: 'low' },
          { source: 'Theme', target: 'Tema', locale: 'tr' },
          { source: 'Readme', target: 'Benioku', locale: 'tr', weight: 'low' },
          { source: 'Label', target: 'Etiket', locale: 'tr' },
        ],
        't',
      )
      expect([weightOf('Eklenti'), weightOf('Tema'), weightOf('Benioku'), weightOf('Etiket')]).toEqual([1, 0, 0, 1])
    })

    it('upsertTm writes the weight on insert and on update', () => {
      upsertTm(db, [
        { source: 'Plugin', target: 'Eklenti', locale: 'tr', weight: 'low' },
        { source: 'Theme', target: 'Tema', locale: 'tr' },
      ])
      expect([weightOf('Eklenti'), weightOf('Tema')]).toEqual([0, 1])
      upsertTm(db, [
        { source: 'Plugin', target: 'Eklenti', locale: 'tr' },
        { source: 'Theme', target: 'Tema', locale: 'tr', weight: 'low' },
      ])
      expect([weightOf('Eklenti'), weightOf('Tema')]).toEqual([1, 0])
    })
  })

  /**
   * The fallback translate reaches for when no exact candidate uses the
   * glossary term: the same source in other capitals ("Social Icons" for
   * "Social icons"), which the exact lookup never sees. Same locale and the
   * same context rule as findMemory, and never the exact rows again.
   */
  describe('findMemoryIgnoringCase', () => {
    it('finds the rows whose source differs only in capitals, exact rows left out', () => {
      upsertTm(db, [
        { source: 'Social icons', target: 'Sociale pictogrammen', locale: 'nl' },
        { source: 'Social Icons', target: 'Sociale iconen', locale: 'nl' },
        { source: 'SOCIAL ICONS', target: 'SOCIALE ICONEN', locale: 'nl' },
        { source: 'Social Icons', target: 'Iconos sociales', locale: 'es' },
        { source: 'Social icons widget', target: 'Widget', locale: 'nl' },
      ])
      expect(findMemoryIgnoringCase(db, 'Social icons', 'nl').map((e) => [e.source, e.target]).sort()).toEqual([
        ['SOCIAL ICONS', 'SOCIALE ICONEN'],
        ['Social Icons', 'Sociale iconen'],
      ])
    })

    it('keeps to the context, falling back to the context-less rows as findMemory does', () => {
      upsertTm(db, [
        { source: 'Post', target: 'Gönder', locale: 'tr', context: 'verb' },
        { source: 'POST', target: 'GÖNDER', locale: 'tr', context: 'verb' },
        { source: 'POST', target: 'YAZI', locale: 'tr' },
      ])
      expect(findMemoryIgnoringCase(db, 'Post', 'tr', 'verb').map((e) => e.target)).toEqual(['GÖNDER'])
      expect(findMemoryIgnoringCase(db, 'Post', 'tr', 'noun').map((e) => e.target)).toEqual(['YAZI'])
    })

    // No index serves a case-blind match on source, and none is added:
    // polyglots.db cannot be regenerated. The FTS index the memory already
    // keeps narrows the rows instead. A row the index does not hold is
    // invisible to that path and visible to the scan, which is how these
    // tell the two apart without timing anything.
    const unindex = (source: string) => {
      const row = db.prepare('SELECT id, source FROM tm WHERE source = ?').get(source) as { id: number; source: string }
      db.prepare("INSERT INTO tm_fts(tm_fts, rowid, source) VALUES ('delete', ?, ?)").run(row.id, row.source)
    }

    it('narrows by the full-text index when the source has words', () => {
      upsertTm(db, [
        { source: 'Social Icons', target: 'Sociale iconen', locale: 'nl' },
        { source: 'SOCIAL ICONS', target: 'SOCIALE ICONEN', locale: 'nl' },
      ])
      unindex('SOCIAL ICONS')
      expect(findMemoryIgnoringCase(db, 'Social icons', 'nl').map((e) => e.target)).toEqual(['Sociale iconen'])
    })

    it('finds a source with a double quote in it', () => {
      upsertTm(db, [{ source: 'Use "Social" Icons', target: 'Gebruik "sociale" iconen', locale: 'nl' }])
      expect(findMemoryIgnoringCase(db, 'Use "social" icons', 'nl').map((e) => e.target)).toEqual(['Gebruik "sociale" iconen'])
    })

    // A source of punctuation alone gives the index nothing to match, and
    // has no capitals to differ in either, so the scan it falls back to finds
    // nothing; what matters is that it answers rather than throws.
    it('answers for a source with no words for the index to match', () => {
      upsertTm(db, [{ source: '-->', target: '-->', locale: 'nl' }])
      expect(findMemoryIgnoringCase(db, '-->', 'nl')).toEqual([])
      expect(findMemoryIgnoringCase(db, '"', 'nl')).toEqual([])
    })
  })
})
