import { describe, expect, it } from 'vitest'
import {
  addRow, applyImport, blockingProblems, createModel, currentRows, diffOf, duplicateRow, isChanged, problemsOf,
  revertRow, rowChanged, setCell, toggleDelete, visibleRows,
} from '../../../src/glossary/editor/model.js'
import { sidecarKey } from '../../../src/glossary/editor/sidecar.js'
import type { EffectiveRow, GlossaryRow } from '../../../src/glossary/types.js'

const eff = (term: string, translation: string, pos = 'noun', origin: EffectiveRow['origin'] = 'wporg', notes = ''): EffectiveRow => ({
  term, pos, translation, notes, origin,
})

describe('createModel', () => {
  it('keeps effective rows with their origin and gives each an id', () => {
    const m = createModel([eff('post', 'yazı'), eff('quiz', 'sınav', 'noun', 'added')], 'db')
    expect(m.mode).toBe('db')
    expect(m.rows.map((r) => r.origin)).toEqual(['wporg', 'added'])
    expect(new Set(m.rows.map((r) => r.id)).size).toBe(2)
  })

  it('treats plain CSV rows as wporg, as loaded', () => {
    const m = createModel([{ term: 'a', pos: '', translation: 'b', notes: '' }], 'csv')
    expect(m.rows[0]!.origin).toBe('wporg')
    expect(m.rows[0]!.deleted).toBe(false)
  })
})

describe('setCell', () => {
  it('stores the normalised value', () => {
    const m = createModel([eff('post', 'yazı')], 'db')
    setCell(m, m.rows[0]!.id, 'translation', '  gönderi \n  yeni ')
    expect(m.rows[0]!.translation).toBe('gönderi yeni')
  })
})

describe('diffOf', () => {
  it('reports exactly one change when one of two post rows is edited', () => {
    const a = eff('post', 'yazı', 'noun')
    const b = eff('post', 'gönder', 'verb')
    const m = createModel([a, b], 'db')
    setCell(m, m.rows[1]!.id, 'translation', 'paylaş')
    const d = diffOf(m)
    expect(d.changed).toHaveLength(1)
    expect(d.changed[0]!.from).toEqual(b)
    expect(d.changed[0]!.to).toEqual({ term: 'post', pos: 'verb', translation: 'paylaş', notes: '' })
    expect(d.added).toEqual([])
    expect(d.deleted).toEqual([])
  })

  it('sends the loaded row, with origin and base, not the edited values', () => {
    const base: GlossaryRow = { term: 'x', pos: 'noun', translation: 'old', notes: '' }
    const loaded: EffectiveRow = { ...eff('x', 'mine', 'noun', 'changed'), base }
    const m = createModel([loaded], 'db')
    setCell(m, m.rows[0]!.id, 'translation', 'newer')
    expect(diffOf(m).changed[0]!.from).toEqual(loaded)
  })

  it('has no change when an edit is typed back to the loaded value', () => {
    const m = createModel([eff('post', 'yazı')], 'db')
    const id = m.rows[0]!.id
    setCell(m, id, 'translation', 'x')
    setCell(m, id, 'translation', 'yazı')
    expect(isChanged(m, id)).toBe(false)
    expect(diffOf(m).changed).toEqual([])
  })

  it('puts a deleted loaded row in deleted and out of currentRows', () => {
    const a = eff('post', 'yazı')
    const m = createModel([a, eff('quiz', 'sınav')], 'db')
    toggleDelete(m, m.rows[0]!.id)
    expect(diffOf(m).deleted).toEqual([a])
    expect(currentRows(m).map((r) => r.term)).toEqual(['quiz'])
    expect(isChanged(m, m.rows[0]!.id)).toBe(true)
  })

  it('lists new rows as added, and drops a new row that is deleted again', () => {
    const m = createModel([eff('post', 'yazı')], 'db')
    const id = addRow(m)
    setCell(m, id, 'term', 'quiz')
    setCell(m, id, 'translation', 'sınav')
    expect(diffOf(m).added).toEqual([{ term: 'quiz', pos: '', translation: 'sınav', notes: '' }])
    toggleDelete(m, id)
    expect(diffOf(m)).toEqual({ added: [], changed: [], deleted: [] })
  })
})

describe('rows', () => {
  it('addRow inserts after the given id, or at the end', () => {
    const m = createModel([eff('a', '1'), eff('b', '2')], 'db')
    const first = m.rows[0]!.id
    const x = addRow(m, first)
    expect(m.rows.map((r) => r.id)[1]).toBe(x)
    const y = addRow(m)
    expect(m.rows[m.rows.length - 1]!.id).toBe(y)
    expect(m.rows.find((r) => r.id === x)!.origin).toBe('new')
  })

  it('duplicateRow copies the values as a new row beside the source', () => {
    const m = createModel([eff('a', '1', 'verb', 'wporg', 'n')], 'db')
    const id = duplicateRow(m, m.rows[0]!.id)
    const copy = m.rows[1]!
    expect(copy.id).toBe(id)
    expect(copy).toMatchObject({ term: 'a', pos: 'verb', translation: '1', notes: 'n', origin: 'new', deleted: false })
    expect(copy.base).toBeUndefined()
  })

  it('toggleDelete flips', () => {
    const m = createModel([eff('a', '1')], 'db')
    toggleDelete(m, m.rows[0]!.id)
    expect(m.rows[0]!.deleted).toBe(true)
    toggleDelete(m, m.rows[0]!.id)
    expect(m.rows[0]!.deleted).toBe(false)
  })
})

describe('revertRow', () => {
  it('restores the base values of a changed row', () => {
    const base: GlossaryRow = { term: 'x', pos: 'noun', translation: 'wporg', notes: 'n' }
    const m = createModel([{ ...eff('x', 'mine', 'noun', 'changed'), base }], 'db')
    revertRow(m, m.rows[0]!.id)
    expect(m.rows[0]).toMatchObject({ translation: 'wporg', notes: 'n', deleted: false })
    // Back at the wp.org row but not at the loaded one, so a save still has to drop the local edit.
    expect(diffOf(m).changed[0]!.to).toEqual(base)
  })

  it('restores the loaded values of an edited wporg row and undeletes it', () => {
    const m = createModel([eff('a', '1')], 'db')
    const id = m.rows[0]!.id
    setCell(m, id, 'translation', '2')
    toggleDelete(m, id)
    revertRow(m, id)
    expect(m.rows[0]).toMatchObject({ translation: '1', deleted: false })
    expect(isChanged(m, id)).toBe(false)
  })

  it('removes a new row', () => {
    const m = createModel([eff('a', '1')], 'db')
    const id = addRow(m)
    revertRow(m, id)
    expect(m.rows).toHaveLength(1)
  })
})

describe('problemsOf', () => {
  it('flags each kind', () => {
    const m = createModel(
      [
        eff('', 'x'),
        eff('a', ''),
        eff('b', 'x', 'weird'),
        eff('Dup', 'same', 'noun'),
        eff('dup', 'same', 'noun'),
        eff('dup', 'other', 'noun'),
        eff('ok', 'x', ''),
      ],
      'db',
    )
    const p = problemsOf(m)
    const at = (i: number) => p.get(m.rows[i]!.id)
    expect(at(0)).toEqual(['empty-term'])
    expect(at(1)).toEqual(['empty-translation'])
    expect(at(2)).toEqual(['bad-pos'])
    expect(at(3)).toEqual(['duplicate'])
    expect(at(4)).toEqual(['duplicate'])
    expect(at(5)).toBeUndefined()
    expect(at(6)).toBeUndefined()
  })

  it('ignores deleted rows, so deleting one of a pair clears the duplicate', () => {
    const m = createModel([eff('a', 'x'), eff('a', 'x')], 'db')
    toggleDelete(m, m.rows[1]!.id)
    expect(problemsOf(m).size).toBe(0)
  })
})

// wp.org's own glossary carries case-only twins ("Post" and "post", same
// translation). In polyglots mode they are shown, but a save of an unrelated
// edit must not wait on the person fixing rows that are not theirs.
describe('blockingProblems', () => {
  const twins = (mode: 'db' | 'csv') => createModel([eff('Post', 'yazı'), eff('post', 'yazı'), eff('quiz', 'sınav')], mode)

  it('shows untouched wp.org duplicates in db mode but does not block on them', () => {
    const m = twins('db')
    setCell(m, m.rows[2]!.id, 'translation', 'test')
    expect(problemsOf(m).size).toBe(2)
    expect(blockingProblems(m).size).toBe(0)
  })

  it('blocks on the whole group once one of its rows is edited', () => {
    const m = twins('db')
    setCell(m, m.rows[1]!.id, 'notes', 'a note')
    expect([...blockingProblems(m).keys()]).toEqual([m.rows[0]!.id, m.rows[1]!.id])
  })

  it('blocks when a row new in this session duplicates a wp.org row', () => {
    const m = createModel([eff('post', 'yazı')], 'db')
    const id = addRow(m)
    setCell(m, id, 'term', 'Post')
    setCell(m, id, 'pos', 'noun')
    setCell(m, id, 'translation', 'yazı')
    expect(blockingProblems(m).size).toBe(2)
  })

  it('blocks when a loaded local edit duplicates a wp.org row', () => {
    const m = createModel([eff('post', 'yazı'), eff('Post', 'yazı', 'noun', 'added')], 'db')
    expect(blockingProblems(m).size).toBe(2)
  })

  it('still blocks on an untouched row with any other problem', () => {
    const m = createModel([eff('post', '')], 'db')
    expect(blockingProblems(m).get(m.rows[0]!.id)).toEqual(['empty-translation'])
  })

  it('blocks on every duplicate in CSV mode, touched or not', () => {
    const m = twins('csv')
    expect(blockingProblems(m).size).toBe(2)
  })
})

// The page asks this of every row on every redraw, so it reads the row alone;
// it must still say exactly what isChanged says.
describe('rowChanged', () => {
  it('agrees with isChanged for every origin, edited or not, deleted or not', () => {
    const m = createModel(
      [eff('a', 'x'), { ...eff('b', 'y', 'noun', 'changed'), base: eff('b', 'z') }, eff('c', 'w', 'noun', 'added')],
      'db',
    )
    addRow(m)
    const variants: Array<(id: number) => void> = [
      () => {},
      (id) => setCell(m, id, 'notes', 'edited'),
      (id) => toggleDelete(m, id),
      (id) => {
        setCell(m, id, 'notes', 'edited')
        setCell(m, id, 'notes', '')
      },
    ]
    const ids = m.rows.map((r) => r.id)
    for (const variant of variants) {
      for (const id of ids) variant(id)
      for (const r of m.rows) expect([r.origin, rowChanged(r)]).toEqual([r.origin, isChanged(m, r.id)])
      for (const id of ids) revertRow(m, id)
      addRow(m)
      ids.splice(0, ids.length, ...m.rows.map((r) => r.id))
    }
  })
})

describe('visibleRows', () => {
  const m = createModel(
    [eff('Quiz', 'sınav', 'noun', 'wporg', 'test'), eff('post', 'yazı', 'verb'), eff('lesson', 'ders', 'noun', 'added')],
    'db',
  )
  it('matches the query on term, translation and notes, case-insensitively', () => {
    expect(visibleRows(m, { query: 'QUIZ' })).toHaveLength(1)
    expect(visibleRows(m, { query: 'yazı' })).toHaveLength(1)
    expect(visibleRows(m, { query: 'TEST' })).toHaveLength(1)
    expect(visibleRows(m, { query: '' })).toHaveLength(3)
  })
  it('filters by pos and local', () => {
    expect(visibleRows(m, { query: '', pos: 'verb' }).map((r) => r.term)).toEqual(['post'])
    expect(visibleRows(m, { query: '', local: true }).map((r) => r.term)).toEqual(['lesson'])
  })
  it('filters by problems', () => {
    const p = createModel([eff('a', ''), eff('b', 'x')], 'db')
    expect(visibleRows(p, { query: '', problems: true }).map((r) => r.term)).toEqual(['a'])
  })
  it('filters contested rows with a sidecar', () => {
    const rec = { en: 'post', pos: 'verb', confidence: 'contested' } as never
    const side = new Map([[sidecarKey('post', 'verb'), rec]])
    expect(visibleRows(m, { query: '', contested: true }, side).map((r) => r.term)).toEqual(['post'])
    expect(visibleRows(m, { query: '', contested: true })).toEqual([])
  })
})

describe('applyImport', () => {
  it('deletes the current rows of an imported term and adds the CSV rows as new', () => {
    const m = createModel([eff('Post', 'yazı'), eff('post', 'gönder', 'verb'), eff('quiz', 'sınav')], 'db')
    applyImport(m, [{ term: 'post', pos: 'noun', translation: 'gönderi', notes: '' }])
    expect(m.rows.filter((r) => r.deleted).map((r) => r.translation)).toEqual(['yazı', 'gönder'])
    expect(m.rows[m.rows.length - 1]).toMatchObject({ origin: 'new', translation: 'gönderi', deleted: false })
    const d = diffOf(m)
    expect(d.deleted).toHaveLength(2)
    expect(d.added).toHaveLength(1)
    expect(currentRows(m).map((r) => r.translation)).toEqual(['sınav', 'gönderi'])
  })

  // An imported row lands as a cell typed by hand would: trimmed, so a padded
  // term matches the row it replaces and a blank one shows as a problem.
  it('normalises every field of an imported row', () => {
    const m = createModel([eff('post', 'yazı')], 'db')
    applyImport(m, [
      { term: '  post ', pos: ' noun', translation: ' gönderi \n yeni ', notes: '  a   note ' },
      { term: '   ', pos: '', translation: 'boş', notes: '' },
    ])
    expect(m.rows[0]!.deleted).toBe(true)
    expect(m.rows.slice(1).map((r) => [r.term, r.pos, r.translation, r.notes])).toEqual([
      ['post', 'noun', 'gönderi yeni', 'a note'],
      ['', '', 'boş', ''],
    ])
    expect([...problemsOf(m).values()]).toEqual([['empty-term']])
  })

  it('replaces a term that is already a local add or change', () => {
    const m = createModel([eff('lesson', 'ders', 'noun', 'added'), { ...eff('page', 'sayfacık', 'noun', 'changed'), base: eff('page', 'sayfa') }], 'db')
    applyImport(m, [
      { term: 'Lesson', pos: 'noun', translation: 'eğitim', notes: '' },
      { term: 'page', pos: 'noun', translation: 'yaprak', notes: '' },
    ])
    const d = diffOf(m)
    expect(d.deleted.map((r) => [r.translation, r.origin])).toEqual([['ders', 'added'], ['sayfacık', 'changed']])
    expect(d.added.map((r) => r.translation)).toEqual(['eğitim', 'yaprak'])
  })
})

describe('visibleRows search options', () => {
  const m = createModel(
    [
      { term: 'post', pos: 'noun', translation: 'yazı', notes: '' },
      { term: 'repost', pos: 'verb', translation: 'yeniden paylaş', notes: 'not a post' },
    ],
    'csv',
  )
  const terms = (f: Parameters<typeof visibleRows>[1]) => visibleRows(m, f).map((r) => r.term)

  it('searches the term alone when asked, not the comment', () => {
    expect(terms({ query: 'post' })).toEqual(['post', 'repost'])
    expect(terms({ query: 'post', searchIn: 'term' })).toEqual(['post', 'repost'])
    expect(terms({ query: 'not', searchIn: 'term' })).toEqual([])
  })

  it('matches whole words only when asked', () => {
    expect(terms({ query: 'post', searchIn: 'term', wholeWord: true })).toEqual(['post'])
    expect(terms({ query: 'post', wholeWord: true })).toEqual(['post', 'repost'])
  })
})
