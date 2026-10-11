import { describe, expect, it, vi } from 'vitest'
import { auditEntries, type Adjudicator } from '../../src/audit/audit.js'
import type { CachedVerdict, VerdictKey } from '../../src/jobs/verdicts.js'
import type { AuditEntry, GlossaryEntry } from '../../src/types.js'

const glossary: GlossaryEntry[] = [{ sourceTerm: 'Settings', translation: 'Ayarlar', locale: 'tr' }]

const entry = (key: string, msgstr: string): AuditEntry => ({
  key,
  msgid: key,
  msgstr: [msgstr],
  comments: [],
  references: [],
  fuzzy: false,
})

function memoryCache() {
  const rows = new Map<string, CachedVerdict>()
  const id = (k: VerdictKey) => [k.srcHash, k.configHash, k.locale, k.engine].join('|')
  return {
    rows,
    get: (k: VerdictKey) => rows.get(id(k)),
    put: (k: VerdictKey, v: CachedVerdict) => void rows.set(id(k), v),
  }
}

const clean: Adjudicator = async (batch) =>
  batch.map((c) => ({ id: c.id, problem: false, categories: [], reason: '' }))

const base = {
  locale: 'tr' as const,
  nplurals: 2,
  glossary,
  configHash: 'cfg0cfg0cfg0cfg0',
  engine: 'claude',
}

describe('auditEntries with a verdict cache', () => {
  it('writes a verdict for every entry the model judged', async () => {
    const store = memoryCache()
    await auditEntries({ ...base, entries: [entry('Save', 'Kaydet')], store, adjudicate: clean })
    expect(store.rows.size).toBe(1)
  })

  it('does not ask the model about an entry already in the cache', async () => {
    const store = memoryCache()
    const adjudicate = vi.fn(clean)
    const entries = [entry('Save', 'Kaydet')]
    await auditEntries({ ...base, entries, store, adjudicate })
    expect(adjudicate).toHaveBeenCalledTimes(1)

    adjudicate.mockClear()
    await auditEntries({ ...base, entries, store, adjudicate })
    expect(adjudicate).not.toHaveBeenCalled()
  })

  it('reaches the same verdict from the cache as from the model', async () => {
    const store = memoryCache()
    const entries = [entry('Save', 'Kaydet')]
    const first = await auditEntries({ ...base, entries, store, adjudicate: clean })
    const second = await auditEntries({ ...base, entries, store, adjudicate: clean })
    expect(second).toEqual(first)
  })

  it('asks only about the entries that changed', async () => {
    const store = memoryCache()
    const adjudicate = vi.fn(clean)
    await auditEntries({
      ...base,
      entries: [entry('Save', 'Kaydet'), entry('Cancel', 'Iptal')],
      store,
      adjudicate,
    })

    adjudicate.mockClear()
    await auditEntries({
      ...base,
      entries: [entry('Save', 'Kaydet'), entry('Cancel', 'Vazgec')],
      store,
      adjudicate,
    })
    const asked = adjudicate.mock.calls.flatMap(([batch]) => batch.map((c) => c.key))
    expect(asked).toEqual(['Cancel'])
  })

  it('does not cache a failed batch, so a retry re-asks', async () => {
    const store = memoryCache()
    const failing: Adjudicator = async () => {
      throw new Error('quota exhausted')
    }
    await auditEntries({ ...base, entries: [entry('Save', 'Kaydet')], store, adjudicate: failing })
    expect(store.rows.size).toBe(0)
  })

  it('caches the entries a partly failed run did judge', async () => {
    // One batch succeeds, the next fails. The successful batch's verdicts are
    // worth keeping: re-asking about them is what the cache exists to prevent.
    const store = memoryCache()
    let call = 0
    const flaky: Adjudicator = async (batch) => {
      call += 1
      if (call > 1) throw new Error('quota exhausted')
      return batch.map((c) => ({ id: c.id, problem: false, categories: [], reason: '' }))
    }
    await auditEntries({
      ...base,
      entries: [entry('A', 'a'), entry('B', 'b')],
      batchSize: 1,
      store,
      adjudicate: flaky,
    })
    expect(store.rows.size).toBe(1)
  })

  it('hands over the verdicts it answered from the cache', async () => {
    const store = memoryCache()
    const entries = [entry('Save', 'Kaydet')]
    await auditEntries({ ...base, entries, store, adjudicate: clean })

    const cached: string[] = []
    await auditEntries({
      ...base,
      entries,
      store,
      adjudicate: clean,
      onCached: (verdicts) => void cached.push(...verdicts.map((v) => v.key)),
    })
    expect(cached).toEqual(['Save'])
  })

  it('does not call onCached on a first run, which answers nothing from cache', async () => {
    const onCached = vi.fn()
    await auditEntries({ ...base, entries: [entry('Save', 'Kaydet')], store: memoryCache(), adjudicate: clean, onCached })
    expect(onCached).not.toHaveBeenCalled()
  })

  it('behaves exactly as before when no store is given', async () => {
    const adjudicate = vi.fn(clean)
    const entries = [entry('Save', 'Kaydet')]
    const first = await auditEntries({ ...base, entries, adjudicate })
    const second = await auditEntries({ ...base, entries, adjudicate })
    expect(adjudicate).toHaveBeenCalledTimes(2)
    expect(second).toEqual(first)
  })
})

// The whole class of defect this file did not see: every test above reviews the
// same file twice, so a key that covers only what the entry says passes all of
// them. The prompt carries more than that (the references, the comments and
// the rule findings), and the findings are file-dependent, because the rule
// context learns brand words and prior translations from every other entry in
// the same file. Two submissions sharing a string are therefore not the same
// question, and must not share a verdict.
describe('a verdict formed in one file is not served for another', () => {
  // `Widgetly` is capitalized mid-string in the translation. The title-case rule
  // excuses that when it knows the word is a brand, and it learns brands from
  // the sentence-case sources of the other entries in the same file.
  const shared = (): AuditEntry => ({
    key: 'Reset the cache',
    msgid: 'Reset the cache',
    msgstr: ['Onbellegi Widgetly ile sifirla'],
    comments: [],
    references: ['admin/cache.php:12'],
    fuzzy: false,
  })

  // Only in file A. Its source is sentence case with a capital mid-string, which
  // is what teaches buildRuleContext that "Widgetly" is a brand.
  const teaches = (): AuditEntry => ({
    key: 'Configure Widgetly options',
    msgid: 'Configure Widgetly options',
    msgstr: ['Widgetly seceneklerini yapilandir'],
    comments: [],
    references: ['admin/options.php:4'],
    fuzzy: false,
  })

  // Stands in for a reviewer who confirms the check it was handed. An entry that
  // arrives with no title-case hint is never asked about it, and comes back
  // clean, which is exactly how a cross-file verdict lost a real finding.
  const confirmsTitleCase: Adjudicator = async (batch) =>
    batch.map((c) =>
      c.hints.some((h) => h.rule === 'title-case')
        ? { id: c.id, problem: true, categories: ['title-case' as const], reason: 'title case mid-string' }
        : { id: c.id, problem: false, categories: [], reason: '' },
    )

  const verdictFor = (verdicts: Awaited<ReturnType<typeof auditEntries>>) =>
    verdicts.find((v) => v.key === 'Reset the cache')!

  it('reviews the shared entry again when the other file taught the rules something', async () => {
    const store = memoryCache()

    // File A knows the brand, so no title-case hint fires and the entry clears.
    const fileA = await auditEntries({
      ...base,
      glossary: [],
      entries: [teaches(), shared()],
      store,
      adjudicate: confirmsTitleCase,
    })
    expect(verdictFor(fileA).problem).toBe(false)

    // File B does not, so the same string is a different question. Before the
    // key covered the rule findings, this hit file A's row and came back
    // approvable, with the finding that fired here discarded unadjudicated.
    const adjudicate = vi.fn(confirmsTitleCase)
    const fileB = await auditEntries({ ...base, glossary: [], entries: [shared()], store, adjudicate })
    const asked = adjudicate.mock.calls.flatMap(([batch]) => batch.map((c) => c.key))
    expect(asked).toEqual(['Reset the cache'])
    expect(verdictFor(fileB).problem).toBe(true)

    // And it reaches the verdict reviewing file B on its own would have.
    const alone = await auditEntries({
      ...base,
      glossary: [],
      entries: [shared()],
      store: memoryCache(),
      adjudicate: confirmsTitleCase,
    })
    expect(fileB).toEqual(alone)
  })

  it('reviews the shared entry again when only its references differ', async () => {
    // The prompt tells the model the references are the best clue to a string's
    // role, which is what decides whether a capital is an exempt UI label or an
    // error. Two files citing different source files are asking about different
    // strings.
    const store = memoryCache()
    await auditEntries({ ...base, glossary: [], entries: [shared()], store, adjudicate: clean })

    const adjudicate = vi.fn(clean)
    await auditEntries({
      ...base,
      glossary: [],
      entries: [{ ...shared(), references: ['help/intro.php:3'] }],
      store,
      adjudicate,
    })
    expect(adjudicate).toHaveBeenCalled()
  })

  // One layer down from the cross-file case, and reachable inside a single file.
  // `inconsistent`'s message is derived from the whole file: it says how many
  // different ways the file translates the same source. Editing one entry
  // changes another entry's message while that entry's own msgid, msgstr,
  // references and firing rules are all untouched, so a key covering only the
  // rule names would serve a verdict formed under a message that no longer
  // applies -- and quietly break the per-entry invalidation this project
  // promises.
  it('re-asks about an entry whose hint changed because a different entry was edited', async () => {
    const shares = (msgctxt: string, msgstr: string): AuditEntry => ({
      key: `${msgctxt}\u0004Save`,
      msgid: 'Save',
      msgctxt,
      msgstr: [msgstr],
      comments: [],
      references: [`admin/${msgctxt}.php:1`],
      fuzzy: false,
    })

    const store = memoryCache()
    // Two distinct translations of "Save", so every entry is told the file
    // translates it two different ways.
    const before = [shares('a', 'Kaydet'), shares('b', 'Sakla'), shares('c', 'Sakla')]
    const first = await auditEntries({ ...base, glossary: [], entries: before, store, adjudicate: clean })
    expect(first.every((v) => v.findings.length === 0 || v.problem)).toBe(true)

    // Only entry c is edited. Now the file translates "Save" three ways, so a
    // and b are asked a different question than they were the first time.
    const after = [shares('a', 'Kaydet'), shares('b', 'Sakla'), shares('c', 'Depola')]
    const adjudicate = vi.fn(clean)
    await auditEntries({ ...base, glossary: [], entries: after, store, adjudicate })

    const asked = adjudicate.mock.calls.flatMap(([batch]) => batch.map((c) => c.msgctxt))
    expect(asked).toEqual(['a', 'b', 'c'])
  })

  it('still answers the same file from the cache, which is what resume is', async () => {
    // The point of the narrowing is that reuse becomes same-file, not that it
    // stops. A file re-reviewed unchanged produces identical key inputs.
    const store = memoryCache()
    const entries = [teaches(), shared()]
    await auditEntries({ ...base, glossary: [], entries, store, adjudicate: confirmsTitleCase })

    const adjudicate = vi.fn(confirmsTitleCase)
    await auditEntries({ ...base, glossary: [], entries, store, adjudicate })
    expect(adjudicate).not.toHaveBeenCalled()
  })
})

/**
 * The check on an accepted fix runs where a verdict becomes a result, not where
 * the model is asked, so it adds nothing to the prompt and nothing to the key.
 * A verdict served from the cache passes through the same place and gets the
 * same check, which is what lets this ship without pruning a single verdict.
 */
describe('the check on a model fix, from the cache', () => {
  const widget: GlossaryEntry[] = [{ sourceTerm: 'widget', translation: 'bileşen', locale: 'tr' }]
  const dropsTheTerm: Adjudicator = async (batch) =>
    batch.map((c) => ({
      id: c.id,
      problem: true,
      categories: ['register' as const],
      reason: 'use the formal imperative',
      fix: ['Widget ayarlarını güncelleyin'],
    }))

  it('reports what the fix brought in on a cached verdict as on a fresh one', async () => {
    const store = memoryCache()
    const entries = [entry('Update the widget settings', 'Bileşen ayarlarını güncelle')]
    const [fresh] = await auditEntries({ ...base, glossary: widget, entries, store, adjudicate: dropsTheTerm })
    expect(fresh?.findings.map((f) => f.rule)).toContain('fix-suspect')

    const adjudicate = vi.fn(async () => {
      throw new Error('the cache should have answered')
    })
    const [cached] = await auditEntries({ ...base, glossary: widget, entries, store, adjudicate })
    expect(adjudicate).not.toHaveBeenCalled()
    expect(cached).toEqual(fresh)
    expect(cached?.text).toEqual(['Widget ayarlarını güncelleyin'])
    expect(cached?.repairedBy).toBe('model')
  })
})
