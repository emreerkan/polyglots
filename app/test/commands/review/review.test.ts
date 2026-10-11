import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDb, replaceGlossary, upsertTm } from '../../../src/storage/index.js'
import { loadPo } from '../../../src/po/po-file.js'
import { reviewFile } from '../../../src/commands/review.js'
import type { ReviewEvent } from '../../../src/types.js'

const PO = `msgid ""
msgstr ""
"MIME-Version: 1.0\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Language: tr\\n"
"Plural-Forms: nplurals=2; plural=(n > 1);\\n"

msgid "Save all changes"
msgstr "Tüm değişiklikleri kaydet"

msgid "%s comments"
msgstr "yorumlar"

msgid "Open the sidebar"
msgstr "Yan menüyü aç"

msgid "Never submitted"
msgstr ""
`

describe('reviewFile', () => {
  let home: string
  let file: string
  let db: Database.Database

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'polyglots-review-'))
    file = join(home, 'plugin-tr.po')
    await writeFile(file, PO, 'utf8')
    db = openDb(join(home, 'polyglots.db'))
    replaceGlossary(db, 'tr', [
      { locale: 'tr', sourceTerm: 'sidebar', translation: 'kenar çubuğu', partOfSpeech: 'noun' },
    ])
  })

  afterEach(async () => {
    db.close()
    await rm(home, { recursive: true, force: true })
  })

  const clearAll = vi.fn(async (batch: { id: number }[]) =>
    batch.map((c) => ({ id: c.id, problem: false, categories: [] as never[], reason: 'ok' })),
  )

  function run(overrides = {}) {
    return reviewFile({ file, locale: 'tr', db, adjudicate: clearAll, ...overrides })
  }

  it('derives the output name from the input file', async () => {
    const summary = await run()
    expect(summary.problemsFile).toBe(join(home, 'plugin-tr-repaired.po'))
    expect(await readdir(home)).not.toContain('plugin-tr-report.md')
  })

  it('honours outDir while keeping the derived name', async () => {
    const outDir = join(home, 'out')
    const summary = await run({ outDir })
    expect(summary.problemsFile).toBe(join(outDir, 'plugin-tr-repaired.po'))
    expect(await readdir(outDir)).toEqual(['plugin-tr-repaired.po'])
  })

  it('names the file for what it contains', async () => {
    const summary = await run({
      adjudicate: vi.fn(async (batch: { id: number }[]) =>
        batch.map((c) => ({
          id: c.id,
          problem: true,
          categories: ['meaning'] as never[],
          reason: 'no',
          fix: ['Düzeltildi'],
        })),
      ),
    })
    expect(summary.problemsFile).toBe(join(home, 'plugin-tr-repaired.po'))
  })

  it('keeps the problems name when nothing could be repaired by a model', async () => {
    const summary = await run({ noAi: true })
    expect(summary.problemsFile).toBe(join(home, 'plugin-tr-problems.po'))
  })

  it('writes the repaired translation into the file', async () => {
    const summary = await run({
      adjudicate: vi.fn(async (batch: { id: number; msgid: string }[]) =>
        batch.map((c) => ({
          id: c.id,
          problem: c.msgid === 'Save all changes',
          categories: ['meaning'] as never[],
          reason: 'says the opposite',
          ...(c.msgid === 'Save all changes' ? { fix: ['Tüm değişiklikleri kaydedin'] } : {}),
        })),
      ),
    })
    const text = await readFile(summary.problemsFile!, 'utf8')
    expect(text).toContain('Tüm değişiklikleri kaydedin')
  })

  it('counts what it repaired', async () => {
    const summary = await run({
      adjudicate: vi.fn(async (batch: { id: number; msgid: string }[]) =>
        batch.map((c) => ({
          id: c.id,
          problem: c.msgid === 'Save all changes',
          categories: ['meaning'] as never[],
          reason: 'x',
          ...(c.msgid === 'Save all changes' ? { fix: ['Tüm değişiklikleri kaydedin'] } : {}),
        })),
      ),
    })
    expect(summary.repaired).toBe(1)
  })

  // A whitespace repair is settled, not a problem and not a guess, so it carries
  // neither flag. It still has to reach the file: review never touches the
  // submission, so dropping it here would throw the correction away.
  it('writes an entry whose only fault the rules repaired outright', async () => {
    await writeFile(file, PO.replace('kaydet"', 'kaydet "'), 'utf8')
    const summary = await run()

    const entries = await loadPo(summary.problemsFile!).then((p) => p.auditEntries())
    expect(entries.map((e) => e.msgid)).toContain('Save all changes')
    expect(entries.find((e) => e.msgid === 'Save all changes')!.msgstr).toEqual(['Tüm değişiklikleri kaydet'])
    expect(summary.repaired).toBe(1)
  })

  it('reports how many entries it wrote', async () => {
    const summary = await run()
    const entries = await loadPo(summary.problemsFile!).then((p) => p.auditEntries())
    expect(summary.written).toBe(entries.length)
  })

  it('skips entries with nothing submitted and counts them', async () => {
    const summary = await run()
    expect(summary.total).toBe(4)
    expect(summary.skipped).toBe(1)
    expect(summary.reviewed).toBe(3)
  })

  it('writes only flagged entries, with their reasons, marking what it could not fix', async () => {
    const summary = await run()
    const problems = await loadPo(summary.problemsFile!)
    const entries = problems.auditEntries()

    expect(entries.map((e) => e.msgid)).toEqual(['%s comments'])
    // No fix came back for it, so it is one of the "left for you" entries.
    expect(entries[0]!.fuzzy).toBe(true)
    expect(entries[0]!.msgstr).toEqual(['yorumlar'])
    const text = await readFile(summary.problemsFile!, 'utf8')
    expect(text).toContain('polyglots:')
    expect(text).toMatch(/placeholder/i)
  })

  it('counts approvable entries as the reviewed ones it did not flag', async () => {
    const summary = await run()
    expect(summary.problems).toBe(1)
    expect(summary.approvable).toBe(2)
  })

  it('groups findings by rule in the summary', async () => {
    const summary = await run()
    expect(summary.byRule).toMatchObject({ placeholder: 1 })
  })

  // byGroup answers a different question from byRule: how many entries the
  // requester message can claim, not how often a rule fired. It counts only
  // repaired entries, and folds a rule and its model equivalent into one group,
  // so an entry both caught contributes once.
  it('folds repaired findings into the groups the requester message names', async () => {
    const adjudicate = vi.fn(async (batch: { id: number; msgid: string }[]) =>
      batch.map((c) => ({
        id: c.id,
        problem: c.msgid === 'Save all changes',
        categories: c.msgid === 'Save all changes' ? (['glossary'] as never[]) : ([] as never[]),
        reason: 'wrong term',
        // An array, as the schema requires. Written as a bare string here once,
        // which judgeFix used to reject as having 25 plural forms, so the test
        // passed while exercising a path the real adjudicator cannot produce.
        fix: c.msgid === 'Save all changes' ? ['Tüm değişiklikleri kaydet'] : undefined,
      })),
    )
    const summary = await run({ adjudicate })

    // Every group total is a subset of the entries actually fixed, which is what
    // lets the message state both numbers in one sentence without contradiction.
    for (const n of Object.values(summary.byGroup)) {
      expect(n).toBeLessThanOrEqual(summary.repaired)
    }
  })

  it('leaves byGroup empty when nothing was repaired', async () => {
    await writeFile(file, PO.replace('msgstr "yorumlar"', 'msgstr "%s yorum"'), 'utf8')
    const summary = await run()

    expect(summary.repaired).toBe(0)
    expect(summary.byGroup).toEqual({})
  })

  /**
   * The model's own fix is checked with the rules, and what it brought in is
   * written beside it, where the reviewer reads the entry. It is the model's
   * mistake, not the contributor's, so the requester message must not count it:
   * an unknown rule lands in "other", which would blame the contributor.
   */
  describe('when an accepted fix brings in a finding the submission did not have', () => {
    const SUBMISSION = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Language: tr\\n"
"Plural-Forms: nplurals=2; plural=(n > 1);\\n"

msgid "Update the widget settings"
msgstr "Bileşen ayarlarını güncelle"
`
    const register = vi.fn(async (batch: { id: number }[]) =>
      batch.map((c) => ({
        id: c.id,
        problem: true,
        categories: ['register'] as never[],
        reason: 'use the formal imperative',
        fix: ['Widget ayarlarını güncelleyin'],
      })),
    )

    beforeEach(async () => {
      await writeFile(file, SUBMISSION, 'utf8')
      replaceGlossary(db, 'tr', [{ locale: 'tr', sourceTerm: 'widget', translation: 'bileşen', partOfSpeech: 'noun' }])
    })

    it('keeps the fix and writes what it broke into the entry comments', async () => {
      const summary = await run({ adjudicate: register })
      expect(summary.repaired).toBe(1)

      const [fixed] = await loadPo(summary.problemsFile!).then((p) => p.auditEntries())
      expect(fixed?.msgstr).toEqual(['Widget ayarlarını güncelleyin'])
      const comments = fixed!.comments.join('\n')
      expect(comments).toMatch(/fix/i)
      expect(comments).toContain('"widget" -> "bileşen"')
    })

    it('leaves it out of the groups the requester message names', async () => {
      const summary = await run({ adjudicate: register })
      expect(summary.byGroup).toEqual({ meaning: 1 })
    })

    // byRule counts how often each finding fired over flagged entries. A fix
    // only lands on an entry already flagged, so counting this adds no entry,
    // and how often the model's fixes break something is worth knowing.
    it('still counts it among the findings that fired', async () => {
      const summary = await run({ adjudicate: register })
      expect(summary.byRule['fix-suspect']).toBe(1)
    })
  })

  it('writes nothing at all when the submission is clean', async () => {
    await writeFile(file, PO.replace('msgstr "yorumlar"', 'msgstr "%s yorum"'), 'utf8')
    const summary = await run()

    expect(summary.problems).toBe(0)
    expect(summary.problemsFile).toBeUndefined()
    expect(await readdir(home)).not.toContain('plugin-tr-repaired.po')
    expect(await readdir(home)).not.toContain('plugin-tr-report.md')
  })

  it('flags what the AI reports as a problem', async () => {
    const adjudicate = vi.fn(async (batch: { id: number; msgid: string }[]) =>
      batch.map((c) => ({
        id: c.id,
        problem: c.msgid === 'Save all changes',
        categories: c.msgid === 'Save all changes' ? (['meaning'] as never[]) : ([] as never[]),
        reason: 'says the opposite',
      })),
    )
    const summary = await run({ adjudicate })

    expect(summary.problems).toBe(2)
    expect(summary.byRule).toMatchObject({ 'ai:meaning': 1, placeholder: 1 })
  })

  it('skips the AI entirely with noAi', async () => {
    const adjudicate = vi.fn()
    const summary = await run({ noAi: true, adjudicate })
    expect(adjudicate).not.toHaveBeenCalled()
    expect(summary.problems).toBeGreaterThan(0)
  })

  // Both kinds go into the file now that every entry carries its reasons as
  // comments, so an unadjudicated guess is legible rather than looking certain.
  it('writes soft findings into the problems file with their reasons under noAi', async () => {
    const summary = await run({ noAi: true })

    // %s comments is a placeholder error; Open the sidebar is only a glossary suspect.
    expect(summary.problems).toBe(1)
    expect(summary.needsReview).toBe(1)
    expect(summary.approvable).toBe(1)

    const problems = await loadPo(summary.problemsFile!)
    expect(problems.auditEntries().map((e) => e.msgid)).toEqual(['%s comments', 'Open the sidebar'])

    const text = await readFile(summary.problemsFile!, 'utf8')
    expect(text).toMatch(/polyglots:.*glossary/i)
  })

  it('reports zero needsReview when the model adjudicates', async () => {
    const summary = await run()
    expect(summary.needsReview).toBe(0)
  })

  it('counts entries whose review failed as unreviewed problems', async () => {
    const adjudicate = vi.fn().mockRejectedValue(new Error('claude exited with exit code 1'))
    const summary = await run({ adjudicate })
    // The hard-error entry now reaches the model too, so it fails to adjudicate
    // right along with the others; it was already a problem either way.
    expect(summary.unreviewed).toBe(3)
    expect(summary.problems).toBe(3)
  })

  it('reports what the rules found before the model runs', async () => {
    const events: ReviewEvent[] = []
    await run({ onProgress: (e: ReviewEvent) => events.push(e) })
    const rules = events.find((e) => e.type === 'rules-done')
    expect(rules).toMatchObject({ flagged: 1 })
  })

  it('announces a batch before it runs', async () => {
    const order: string[] = []
    const adjudicate = vi.fn(async (batch: { id: number }[]) => {
      order.push('adjudicate')
      return batch.map((c) => ({ id: c.id, problem: false, categories: [] as never[], reason: 'ok' }))
    })
    await run({
      adjudicate,
      onProgress: (e: ReviewEvent) => {
        if (e.type === 'batch-start' || e.type === 'batch-done') order.push(e.type)
      },
    })
    expect(order).toEqual(['batch-start', 'adjudicate', 'batch-done'])
  })

  it('reports a failed batch rather than swallowing it', async () => {
    const events: ReviewEvent[] = []
    const adjudicate = vi.fn().mockRejectedValue(new Error('claude exited with exit code 1'))
    await run({ adjudicate, onProgress: (e: ReviewEvent) => events.push(e) })
    expect(events.find((e) => e.type === 'batch-failed')).toMatchObject({ reason: expect.stringMatching(/exit code 1/) })
    // One terminal event per batch, or the progress bar counts it twice.
    expect(events.filter((e) => e.type === 'batch-done')).toHaveLength(0)
  })

  // A 2831-entry submission is ~114 batches and hours of wall clock; losing all
  // of it to one Ctrl+C would be unacceptable.
  it('writes the problems file after every batch, not only at the end', async () => {
    const seen: number[] = []
    const adjudicate = vi.fn(async (batch: { id: number; msgid: string }[]) => {
      const target = join(home, 'plugin-tr-repaired.po')
      seen.push(await readFile(target, 'utf8').then((t) => t.length).catch(() => 0))
      return batch.map((c) => ({ id: c.id, problem: true, categories: ['meaning'] as never[], reason: 'nope' }))
    })

    await run({ adjudicate, batchSize: 1 })

    // Three candidates now reach the model ("%s comments" included, to be
    // repaired), so batchSize 1 makes three batches. The second and third each
    // start with the previous batch already on disk.
    expect(seen).toHaveLength(3)
    expect(seen[0]).toBe(0)
    expect(seen[1]).toBeGreaterThan(0)
    expect(seen[2]).toBeGreaterThan(seen[1]!)
  })

  it('emits progress ending in done', async () => {
    const events: ReviewEvent[] = []
    const summary = await run({ onProgress: (e: ReviewEvent) => events.push(e) })

    expect(events[0]).toMatchObject({ type: 'start', total: 4, reviewable: 3 })
    expect(events.at(-1)).toEqual({ type: 'done', summary })
    expect(events.some((e) => e.type === 'written')).toBe(true)
  })

  // Run with noAi so rule findings land in the summary directly; with the model in
  // the loop a cleared suspect would make this pass whether or not it was wired.
  it('passes configured proper nouns to the rules so a name is not flagged', async () => {
    await writeFile(
      file,
      PO.replace('msgstr "Yan menüyü aç"', 'msgstr "Türk Dil Kurumu tarafından onaylandı"'),
      'utf8',
    )

    const without = await run({ noAi: true, outDir: join(home, 'a') })
    expect(without.byRule['title-case']).toBe(1)

    const withNames = await run({ noAi: true, outDir: join(home, 'b'), properNouns: ['Türk Dil Kurumu'] })
    expect(withNames.byRule['title-case']).toBeUndefined()
  })

  it('fails with a sync hint when the locale has no cached glossary', async () => {
    await expect(run({ locale: 'de' })).rejects.toThrow(/glossary sync/)
  })

  it('leaves the reviewed file untouched', async () => {
    const before = await readFile(file, 'utf8')
    await run()
    expect(await readFile(file, 'utf8')).toBe(before)
  })
})

/**
 * Through the real lookup, because the exact-context rule lives in how the
 * caller reads the memory: an entry with a msgctxt whose only match is the
 * row without context must still reach the model, while the same text with
 * no msgctxt at all is settled.
 */
describe('reviewFile settling entries from the memory', () => {
  const MEMORY_PO = `msgid ""
msgstr ""
"MIME-Version: 1.0\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Language: tr\\n"
"Plural-Forms: nplurals=2; plural=(n > 1);\\n"

msgid "Font Size"
msgstr "Yazı Tipi Boyutu"

msgid "Large"
msgstr "Large"

msgctxt "button shape"
msgid "Sharp"
msgstr "Sharp"

msgid "Hide Details"
msgstr "Ayrıntıları Gizle"
`
  let home: string
  let file: string
  let db: Database.Database

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'polyglots-review-memory-'))
    file = join(home, 'wp-themes-demo-tr.po')
    await writeFile(file, MEMORY_PO, 'utf8')
    db = openDb(join(home, 'polyglots.db'))
    replaceGlossary(db, 'tr', [{ locale: 'tr', sourceTerm: 'sidebar', translation: 'kenar çubuğu', partOfSpeech: 'noun' }])
    upsertTm(db, [
      { source: 'Font Size', target: 'Yazı Tipi Boyutu', locale: 'tr' },
      { source: 'Large', target: 'Geniş', locale: 'tr' },
      // Only a row without context: the msgctxt entry may use it as a hint,
      // never as a decision.
      { source: 'Sharp', target: 'Keskin', locale: 'tr' },
      { source: 'Hide Details', target: 'Ayrıntıları gizle', locale: 'tr' },
    ])
  })

  afterEach(async () => {
    db.close()
    await rm(home, { recursive: true, force: true })
  })

  it('sends the model only what the memory could not settle', async () => {
    const adjudicate = vi.fn(async (batch: { id: number; msgid: string }[]) =>
      batch.map((c) => ({ id: c.id, problem: false, categories: [] as never[], reason: 'ok' })),
    )
    const events: ReviewEvent[] = []
    await reviewFile({ file, locale: 'tr', db, adjudicate, onProgress: (e) => events.push(e) })

    const sent = adjudicate.mock.calls.flatMap(([batch]) => batch.map((c) => c.msgid)).sort()
    expect(sent).toEqual(['Sharp'])
    expect(events).toContainEqual(expect.objectContaining({ type: 'rules-done', memoryApproved: 2, memoryRepaired: 1 }))
  })

  it('writes the approved translation into the repaired file', async () => {
    const summary = await reviewFile({ file, locale: 'tr', db, adjudicate: clearAll(), noAi: false })
    const repaired = await loadPo(summary.problemsFile!)
    const large = repaired.auditEntries().find((e) => e.msgid === 'Large')
    expect(large?.msgstr).toEqual(['Geniş'])
  })

  function clearAll() {
    return vi.fn(async (batch: { id: number }[]) =>
      batch.map((c) => ({ id: c.id, problem: false, categories: [] as never[], reason: 'ok' })),
    )
  }
})

/**
 * What the run screens list as each batch lands. One event per batch rather
 * than one per entry: a seven-thousand-entry run is then a few hundred events,
 * not seven thousand re-renders.
 */
describe('reviewFile per-entry events', () => {
  let home: string
  let file: string
  let db: Database.Database

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'polyglots-review-entries-'))
    file = join(home, 'plugin-tr.po')
    await writeFile(file, PO, 'utf8')
    db = openDb(join(home, 'polyglots.db'))
    replaceGlossary(db, 'tr', [{ locale: 'tr', sourceTerm: 'sidebar', translation: 'kenar çubuğu', partOfSpeech: 'noun' }])
  })

  afterEach(async () => {
    db.close()
    await rm(home, { recursive: true, force: true })
  })

  const entriesOf = (events: ReviewEvent[]) => events.flatMap((e) => (e.type === 'entries' ? e.entries : []))

  it('names each entry of a batch with its outcome, before the batch closes', async () => {
    const events: ReviewEvent[] = []
    const adjudicate = vi.fn(async (batch: { id: number; msgid: string }[]) =>
      batch.map((c) =>
        c.msgid === 'Open the sidebar'
          ? { id: c.id, problem: true, categories: ['glossary'] as never[], reason: 'wrong term' }
          : c.msgid === '%s comments'
            ? { id: c.id, problem: true, categories: ['placeholders'] as never[], reason: 'lost %s', fix: ['%s yorum'] }
            : { id: c.id, problem: false, categories: [] as never[], reason: 'ok' },
      ),
    )
    await reviewFile({ file, locale: 'tr', db, adjudicate, onProgress: (e) => events.push(e) })

    const landed = entriesOf(events)
    expect(landed.map((e) => e.msgid).sort()).toEqual(['%s comments', 'Open the sidebar', 'Save all changes'])
    expect(landed.find((e) => e.msgid === 'Save all changes')).toEqual({
      key: 'Save all changes',
      msgid: 'Save all changes',
      outcome: 'approved',
    })
    const sidebar = landed.find((e) => e.msgid === 'Open the sidebar')!
    expect(sidebar.outcome).toBe('flagged')
    expect(sidebar.rules).toContain('glossary')
    expect(landed.find((e) => e.msgid === '%s comments')).toMatchObject({ outcome: 'repaired', rules: expect.any(Array) })

    const types = events.map((e) => e.type)
    expect(types.indexOf('entries')).toBeGreaterThan(types.indexOf('batch-start'))
    expect(types.indexOf('entries')).toBeLessThan(types.indexOf('batch-done'))
    expect(events.find((e) => e.type === 'entries')).toMatchObject({ index: 1 })
  })

  it('marks every entry of a failed batch unreviewed', async () => {
    const events: ReviewEvent[] = []
    const adjudicate = vi.fn().mockRejectedValue(new Error('claude exited with exit code 1'))
    await reviewFile({ file, locale: 'tr', db, adjudicate, onProgress: (e) => events.push(e) })

    const landed = entriesOf(events)
    expect(landed).toHaveLength(3)
    expect(new Set(landed.map((e) => e.outcome))).toEqual(new Set(['unreviewed']))
  })
})
