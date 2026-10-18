import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openDb, upsertTm } from '../../../src/storage/index.js'
import { DraftQuotaError, DraftRateLimitError } from '../../../src/draft/index.js'
import { ReviewError } from '../../../src/review/draft-review.js'
import { translateFile, type TranslateOptions } from '../../../src/commands/translate.js'
import {
  CTX,
  PENDING_KEYS,
  collect,
  entryOf,
  fakeEngine,
  fakeReview,
  makeWorkspace,
  ofType,
  parseFile,
  type Workspace,
} from './helpers.js'

let ws: Workspace

beforeEach(async () => {
  ws = await makeWorkspace()
})

afterEach(async () => {
  await ws.cleanup()
})

function base(overrides: Partial<TranslateOptions> = {}): TranslateOptions {
  return {
    file: ws.file,
    locale: 'tr',
    mode: 'pending',
    draftEngine: 'deepl',
    mcpConfigPath: join(ws.home, 'mcp.json'),
    batchSize: 25,
    ...overrides,
  }
}

describe('translateFile: selection', () => {
  it('translates only pending entries and leaves translated ones byte-identical', async () => {
    const engine = fakeEngine()
    const review = fakeReview()
    const { events, onProgress } = collect()

    const summary = await translateFile(base({ engine, review, onProgress }))

    expect(engine.calls).toEqual([PENDING_KEYS])
    expect(review.calls).toHaveLength(1)
    expect(review.calls[0]!.opts).toMatchObject({ locale: 'tr', nplurals: 2, mcpConfigPath: join(ws.home, 'mcp.json') })

    const before = (await import('gettext-parser')).po.parse(ws.original)
    const after = await parseFile(ws.file)
    for (const key of ['Settings', `post type general name${CTX}Forms`, '%d entry', 'Powered by Sample Forms', 'Your message has been sent.']) {
      expect(entryOf(after, key)).toEqual(entryOf(before, key))
    }
    expect(entryOf(after, 'Save Changes').msgstr).toEqual(['[draft] Save Changes'])
    expect(entryOf(after, 'One submission was deleted.').msgstr).toEqual([
      '[draft] One submission was deleted.',
      '[draft] %d submissions were deleted.',
    ])
    expect(entryOf(after, 'Form entries').msgstr).toEqual(['[draft] Form entries'])
    expect(entryOf(after, 'Form entries').comments?.flag).toBeUndefined()

    expect(summary).toEqual({
      file: ws.file,
      total: 12,
      pending: 7,
      fromTm: 0,
      translated: 7,
      fuzzy: 0,
      skipped: 0,
    })
    expect(events[0]).toEqual({ type: 'start', file: ws.file, total: 12, pending: 7 })
    expect(events.at(-1)).toEqual({ type: 'done', summary })
    // batch-phase twice: drafting, then reviewing, so the bar has something to say
    // during the two long calls a batch makes.
    expect(events.map((e) => e.type)).toEqual([
      'start',
      'tm-hit',
      'batch-start',
      'batch-phase',
      'batch-phase',
      'entries',
      'batch-done',
      'saved',
      'done',
    ])
  })

  it('reprocesses every entry in all mode', async () => {
    const engine = fakeEngine()
    const review = fakeReview()

    const summary = await translateFile(base({ mode: 'all', engine, review }))

    expect(engine.calls[0]).toHaveLength(12)
    expect(engine.calls[0]).toContain('Settings')
    expect(summary.pending).toBe(12)
    expect(summary.translated).toBe(12)
    const after = await parseFile(ws.file)
    expect(entryOf(after, 'Settings').msgstr).toEqual(['[draft] Settings'])
    expect(entryOf(after, '%d entry').msgstr).toEqual(['[draft] %d entry', '[draft] %d entries'])
  })

  it('does nothing but report when there is nothing pending', async () => {
    const engine = fakeEngine()
    const review = fakeReview()
    await translateFile(base({ engine, review }))
    const saved = await readFile(ws.file)

    const { events, onProgress } = collect()
    const summary = await translateFile(base({ engine, review, onProgress }))

    expect(engine.calls).toHaveLength(1)
    expect(summary).toMatchObject({ pending: 0, translated: 0, fromTm: 0, skipped: 0 })
    expect(events.map((e) => e.type)).toEqual(['start', 'tm-hit', 'done'])
    expect(await readFile(ws.file)).toEqual(saved)
  })
})

describe('translateFile: exact TM fast path', () => {
  it('fills singular and plural units from the TM, skipping the engine, with fuzzy=false', async () => {
    const db = openDb(join(ws.home, 'tm.db'))
    upsertTm(db, [
      { source: 'Save Changes', target: 'Değişiklikleri Kaydet', locale: 'tr' },
      { source: 'One submission was deleted.', target: 'Bir gönderim silindi.', locale: 'tr' },
      { source: '%d submissions were deleted.', target: '%d gönderim silindi.', locale: 'tr' },
      { source: 'Thank you for installing %s.', target: 'yalnızca de', locale: 'de' },
    ])
    const engine = fakeEngine()
    const review = fakeReview()
    const { events, onProgress } = collect()

    const summary = await translateFile(base({ db, engine, review, onProgress }))
    db.close()

    expect(engine.calls[0]).not.toContain('Save Changes')
    expect(engine.calls[0]).not.toContain('One submission was deleted.')
    expect(engine.calls[0]).toContain('Thank you for installing %s.')
    expect(engine.calls[0]).toHaveLength(5)

    const after = await parseFile(ws.file)
    expect(entryOf(after, 'Save Changes').msgstr).toEqual(['Değişiklikleri Kaydet'])
    expect(entryOf(after, 'Save Changes').comments?.flag).toBeUndefined()
    expect(entryOf(after, 'One submission was deleted.').msgstr).toEqual(['Bir gönderim silindi.', '%d gönderim silindi.'])
    expect(entryOf(after, 'One submission was deleted.').comments?.flag).toBeUndefined()

    expect(ofType(events, 'tm-hit')).toEqual([{ type: 'tm-hit', count: 2 }])
    expect(summary).toMatchObject({ pending: 7, fromTm: 2, translated: 5, skipped: 0 })
    expect(events.map((e) => e.type)).toEqual([
      'start',
      'tm-hit',
      'entries',
      'saved',
      'batch-start',
      'batch-phase',
      'batch-phase',
      'entries',
      'batch-done',
      'saved',
      'done',
    ])
  })

  /**
   * The memory can hold several approved wordings for one source. Filling an
   * entry means writing one of them, and nothing here says which, so the newest
   * goes in marked fuzzy: a translation to confirm rather than an approval
   * nobody made. With one wording, or several differing only in capitals, there
   * is no choice to confirm and it stays approved as before.
   */
  it('marks a TM fill fuzzy when the memory holds more than one approved wording', async () => {
    const db = openDb(join(ws.home, 'tm.db'))
    upsertTm(db, [{ source: 'Save Changes', target: 'Değişiklikleri Kaydet', locale: 'tr' }])
    upsertTm(db, [{ source: 'Save Changes', target: 'Değişiklikleri kaydet', locale: 'tr' }])
    upsertTm(db, [{ source: 'Thank you for installing %s.', target: '%s kurduğunuz için teşekkürler.', locale: 'tr' }])
    upsertTm(db, [{ source: 'Thank you for installing %s.', target: '%s yüklediğiniz için teşekkürler.', locale: 'tr' }])

    await translateFile(base({ db, engine: fakeEngine(), review: fakeReview() }))
    db.close()

    const after = await parseFile(ws.file)
    // Two wordings: filled with the newest, flagged for a human.
    expect(entryOf(after, 'Thank you for installing %s.').msgstr).toEqual(['%s yüklediğiniz için teşekkürler.'])
    // The entry already carries php-format, so the flag list gains fuzzy.
    expect(entryOf(after, 'Thank you for installing %s.').comments?.flag).toContain('fuzzy')
    // Same wording, different capitals: still settled.
    expect(entryOf(after, 'Save Changes').msgstr).toEqual(['Değişiklikleri kaydet'])
    expect(entryOf(after, 'Save Changes').comments?.flag).toBeUndefined()
  })

  it('falls through to the engine when only one plural form is in the TM', async () => {
    const db = openDb(join(ws.home, 'tm.db'))
    upsertTm(db, [{ source: 'One submission was deleted.', target: 'Bir gönderim silindi.', locale: 'tr' }])
    const engine = fakeEngine()

    const summary = await translateFile(base({ db, engine, review: fakeReview() }))
    db.close()

    expect(engine.calls[0]).toContain('One submission was deleted.')
    expect(summary.fromTm).toBe(0)
  })

  it('uses msgctxt as TM context and prefers the context-specific row', async () => {
    const db = openDb(join(ws.home, 'tm.db'))
    upsertTm(db, [
      { source: 'Form', target: 'Form (genel)', locale: 'tr' },
      { source: 'Form', target: 'Form (tekil)', locale: 'tr', context: 'post type singular name' },
    ])
    const engine = fakeEngine()

    await translateFile(base({ db, engine, review: fakeReview() }))
    db.close()

    const after = await parseFile(ws.file)
    expect(entryOf(after, `post type singular name${CTX}Form`).msgstr).toEqual(['Form (tekil)'])
    expect(engine.calls[0]).not.toContain(`post type singular name${CTX}Form`)
  })
})

describe('translateFile: fuzzy flags', () => {
  it('marks fuzzy review results in the saved file and clears the flag on confident ones', async () => {
    const review = fakeReview()
    review.fuzzyKeys.add('Thank you for installing %s.')
    const { events, onProgress } = collect()

    const summary = await translateFile(base({ engine: fakeEngine(), review, onProgress }))

    const after = await parseFile(ws.file)
    expect(entryOf(after, 'Thank you for installing %s.').comments?.flag).toBe('php-format, fuzzy')
    expect(entryOf(after, 'Save Changes').comments?.flag).toBeUndefined()
    expect(entryOf(after, 'Form entries').comments?.flag).toBeUndefined()
    expect(summary.fuzzy).toBe(1)
    expect(ofType(events, 'batch-done')).toMatchObject([{ type: 'batch-done', index: 1, translated: 7, fuzzy: 1 }])
  })
})

describe('translateFile: batching and incremental save', () => {
  it('respects batchSize in the emitted batch events', async () => {
    const engine = fakeEngine()
    const { events, onProgress } = collect()

    await translateFile(base({ engine, review: fakeReview(), batchSize: 3, onProgress }))

    expect(engine.calls.map((c) => c.length)).toEqual([3, 3, 1])
    expect(ofType(events, 'batch-start')).toMatchObject([
      { type: 'batch-start', index: 1, of: 3, size: 3 },
      { type: 'batch-start', index: 2, of: 3, size: 3 },
      { type: 'batch-start', index: 3, of: 3, size: 1 },
    ])
    expect(ofType(events, 'saved')).toHaveLength(3)
  })

  it('falls back to config.batchSize when none is given', async () => {
    const { saveConfig } = await import('../../../src/config.js')
    saveConfig({ batchSize: 4 })
    const engine = fakeEngine()

    await translateFile(base({ engine, review: fakeReview(), batchSize: undefined }))

    expect(engine.calls.map((c) => c.length)).toEqual([4, 3])
  })

  it('saves after every batch so earlier batches are on disk before later ones run', async () => {
    const review = fakeReview()
    let onDiskDuringBatch2: string | undefined
    review.failWith = async (index) => {
      if (index === 1) onDiskDuringBatch2 = await readFile(ws.file, 'utf8')
      return undefined
    }

    await translateFile(base({ engine: fakeEngine(), review, batchSize: 2 }))

    expect(onDiskDuringBatch2).toBeDefined()
    expect(onDiskDuringBatch2).toContain('msgstr "[draft] Save Changes"')
    expect(onDiskDuringBatch2).toContain('msgstr "[draft] Form entries"')
    expect(onDiskDuringBatch2).not.toContain('[draft] Form"')
  })
})

describe('translateFile: failures', () => {
  it('retries a failing review once (reusing the drafts), then skips it and continues; a later run picks exactly those up', async () => {
    const review = fakeReview()
    const engine = fakeEngine()
    review.failWith = (_index, inputs) =>
      inputs.some((i) => i.key === `post type singular name${CTX}Form`) ? new ReviewError('boom') : undefined
    const { events, onProgress } = collect()

    const summary = await translateFile(base({ engine, review, batchSize: 2, onProgress }))

    expect(review.calls).toHaveLength(5)
    expect(engine.calls).toHaveLength(4)
    expect(review.calls[1]!.inputs).toEqual(review.calls[2]!.inputs)
    expect(ofType(events, 'batch-skipped')).toMatchObject([{ type: 'batch-skipped', index: 2, size: 2, reason: 'boom' }])
    expect(ofType(events, 'batch-done').map((e) => e.index)).toEqual([1, 3, 4])
    expect(summary).toMatchObject({ pending: 7, fromTm: 0, translated: 5, skipped: 2 })
    expect(summary.stopped).toBeUndefined()

    const after = await parseFile(ws.file)
    expect(entryOf(after, `post type singular name${CTX}Form`).msgstr).toEqual([''])
    expect(entryOf(after, 'One submission was deleted.').msgstr).toEqual(['', ''])
    expect(entryOf(after, 'Thank you for installing %s.').msgstr).toEqual(['[draft] Thank you for installing %s.'])

    const engine2 = fakeEngine()
    const second = await translateFile(base({ engine: engine2, review: fakeReview() }))
    // The first run already bought and cached these drafts; only its review
    // of them failed. Resuming re-runs the review, not the draft, so the
    // second run never re-pays the engine for work already on hand.
    expect(engine2.calls).toEqual([])
    // But the entries the first run gave up on are not stuck: the resumed run
    // completes them using the cached drafts.
    expect(second).toMatchObject({ pending: 2, translated: 2, skipped: 0 })
    const resumed = await parseFile(ws.file)
    expect(entryOf(resumed, `post type singular name${CTX}Form`).msgstr).toEqual(['[draft] Form'])
    expect(entryOf(resumed, 'One submission was deleted.').msgstr).toEqual([
      '[draft] One submission was deleted.',
      '[draft] %d submissions were deleted.',
    ])
  })

  it('treats a non-quota engine error like a review failure: retry once, then skip', async () => {
    const engine = fakeEngine()
    engine.failWith = (_index, units) => (units[0]!.key === 'Save Changes' ? new Error('deepl: expected 2 got 1') : undefined)
    const { events, onProgress } = collect()

    const summary = await translateFile(base({ engine, review: fakeReview(), batchSize: 2, onProgress }))

    expect(ofType(events, 'batch-skipped')).toMatchObject([
      { type: 'batch-skipped', index: 1, size: 2, reason: 'deepl: expected 2 got 1' },
    ])
    expect(summary).toMatchObject({ translated: 5, skipped: 2 })
  })

  it('stops cleanly on a quota error, keeping already saved work, without throwing', async () => {
    const engine = fakeEngine()
    engine.failWith = (index) => (index === 1 ? new DraftQuotaError('deepl', 'Quota exceeded') : undefined)
    const { events, onProgress } = collect()

    const summary = await translateFile(base({ engine, review: fakeReview(), batchSize: 2, onProgress }))

    expect(summary.stopped).toBe('deepl: Quota exceeded')
    expect(summary).toMatchObject({ pending: 7, translated: 2, skipped: 0, fromTm: 0 })
    expect(engine.calls).toHaveLength(2)
    expect(ofType(events, 'batch-start').map((e) => e.index)).toEqual([1, 2])
    expect(ofType(events, 'batch-skipped')).toMatchObject([])
    expect(events.at(-1)).toEqual({ type: 'done', summary })

    const after = await parseFile(ws.file)
    expect(entryOf(after, 'Save Changes').msgstr).toEqual(['[draft] Save Changes'])
    expect(entryOf(after, `post type singular name${CTX}Form`).msgstr).toEqual([''])
  })

  it('stops cleanly on a rate-limit error raised during the retry', async () => {
    const engine = fakeEngine()
    let calls = 0
    engine.failWith = () => {
      calls++
      if (calls === 1) return new Error('transient')
      if (calls === 2) return new DraftRateLimitError('deepl', 'Too many requests')
      return undefined
    }

    const summary = await translateFile(base({ engine, review: fakeReview(), batchSize: 2 }))

    expect(summary.stopped).toBe('deepl: Too many requests')
    expect(summary.translated).toBe(0)
    expect(engine.calls).toHaveLength(2)
  })

  it('never applies review results for keys outside the batch', async () => {
    const review = fakeReview()
    const leaky = async (inputs: Parameters<typeof review>[0], opts: Parameters<typeof review>[1]) => {
      const results = await review(inputs, opts)
      return [...results, { key: 'Settings', text: ['HACKED'], fuzzy: false, reason: 'leak' }]
    }

    await translateFile(base({ engine: fakeEngine(), review: leaky }))

    const after = await parseFile(ws.file)
    expect(entryOf(after, 'Settings').msgstr).toEqual(['Ayarlar'])
  })
})

describe('translateFile: dry run', () => {
  it('runs the engine and review but leaves the file untouched and emits no saved events', async () => {
    const engine = fakeEngine()
    const review = fakeReview()
    const db = openDb(join(ws.home, 'tm.db'))
    upsertTm(db, [{ source: 'Save Changes', target: 'Değişiklikleri Kaydet', locale: 'tr' }])
    const { events, onProgress } = collect()

    const summary = await translateFile(base({ db, engine, review, dryRun: true, batchSize: 3, onProgress }))
    db.close()

    expect(engine.calls.map((c) => c.length)).toEqual([3, 3])
    expect(review.calls).toHaveLength(2)
    expect(await readFile(ws.file)).toEqual(ws.original)
    expect(ofType(events, 'saved')).toEqual([])
    expect(summary).toMatchObject({ pending: 7, fromTm: 1, translated: 6, skipped: 0 })
  })
})

describe('translateFile: summary arithmetic', () => {
  it('pending = fromTm + translated + skipped + remaining across a stopped run', async () => {
    const db = openDb(join(ws.home, 'tm.db'))
    upsertTm(db, [{ source: 'Save Changes', target: 'Değişiklikleri Kaydet', locale: 'tr' }])
    const engine = fakeEngine()
    const review = fakeReview()
    review.failWith = (index) => (index <= 1 ? new ReviewError('bad batch') : undefined)
    engine.failWith = (index) => (index === 2 ? new DraftQuotaError('deepl', 'Quota exceeded') : undefined)

    const summary = await translateFile(base({ db, engine, review, batchSize: 2 }))
    db.close()

    expect(summary).toMatchObject({ pending: 7, fromTm: 1, skipped: 2, translated: 2, stopped: 'deepl: Quota exceeded' })

    const second = await translateFile(base({ engine: fakeEngine(), review: fakeReview() }))
    expect(second.pending).toBe(4)
    const remaining = second.pending - summary.skipped
    expect(summary.pending).toBe(summary.fromTm + summary.translated + summary.skipped + remaining)
  })
})

describe('translateFile: resources', () => {
  it('opens its own db under POLYGLOTS_HOME when none is injected', async () => {
    const engine = fakeEngine()
    await translateFile(base({ engine, review: fakeReview() }))
    const { dbFile } = await import('../../../src/paths.js')
    expect(dbFile().startsWith(ws.home)).toBe(true)
    expect((await readFile(dbFile())).length).toBeGreaterThan(0)
  })

  it('leaves an injected db open', async () => {
    const db = openDb(join(ws.home, 'tm.db'))
    await translateFile(base({ db, engine: fakeEngine(), review: fakeReview() }))
    expect(db.open).toBe(true)
    db.close()
  })

  it('forwards model and bin to the review step', async () => {
    const review = fakeReview()
    await translateFile(base({ engine: fakeEngine(), review, model: 'claude-x', bin: '/bin/fake' }))
    expect(review.calls[0]!.opts).toMatchObject({ model: 'claude-x', bin: '/bin/fake' })
  })
})

describe('translateFile: review engine id', () => {
  // configuredModel reads antigravity's settings from under the home
  // directory, which the test setup points at a temporary folder for each
  // test, so the model written here is the only one it can find.
  async function withAntigravityModel<T>(model: string, run: () => Promise<T>): Promise<T> {
    const dir = join(homedir(), '.gemini', 'antigravity-cli')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ model }))
    return run()
  }

  async function runWith(model: string): Promise<ReturnType<typeof fakeReview>> {
    // Every run starts from the untouched catalogue, so the entries are
    // pending again and only the review cache decides whether they are asked.
    await writeFile(ws.file, ws.original)
    const review = fakeReview()
    await withAntigravityModel(model, () => translateFile(base({ engine: fakeEngine(), review, provider: 'antigravity' })))
    return review
  }

  it('serves cached verdicts when the configured antigravity model is unchanged', async () => {
    expect((await runWith('Gemini 3.8 Flash (Low)')).calls.length).toBeGreaterThan(0)
    expect((await runWith('Gemini 3.8 Flash (Low)')).calls).toEqual([])
  })

  it('re-reviews when antigravity is switched to another model without --model', async () => {
    expect((await runWith('Gemini 3.8 Flash (Low)')).calls.length).toBeGreaterThan(0)
    const second = await runWith('Gemini 3.8 Pro (High)')
    expect(second.calls.flatMap((c) => c.inputs.map((i) => i.key)).sort()).toEqual([...PENDING_KEYS].sort())
    // The model stays out of the spawn: antigravity picks its own from that
    // same settings file, and only the cache key needed to learn it.
    expect(second.calls[0]!.opts.model).toBeUndefined()
  })
})

describe('translateFile: review provider from settings', () => {
  // The CLI and both TUI screens leave provider unset and let the setting
  // decide. The setting reached the cache key but not the spawn, which then
  // fell back to claude: claude's verdicts filed under antigravity's name.
  it('spawns the configured provider when the caller names none', async () => {
    const { saveConfig } = await import('../../../src/config.js')
    saveConfig({ reviewProvider: 'antigravity' })
    const review = fakeReview()
    await translateFile(base({ engine: fakeEngine(), review }))
    expect(review.calls.length).toBeGreaterThan(0)
    expect(review.calls[0]!.opts.provider).toBe('antigravity')
  })

  it('lets an explicit provider override the setting', async () => {
    const { saveConfig } = await import('../../../src/config.js')
    saveConfig({ reviewProvider: 'antigravity' })
    const review = fakeReview()
    await translateFile(base({ engine: fakeEngine(), review, provider: 'claude' }))
    expect(review.calls[0]!.opts.provider).toBe('claude')
  })
})

describe('translateFile: codex model and effort', () => {
  // codex is given the model and effort that resolved, since --ignore-user-config
  // stops it reading its own file. CODEX_HOME is a temporary folder, so the
  // developer's own config.toml cannot decide any of these.
  let codexHome: string
  let savedHome: string | undefined
  beforeEach(() => {
    savedHome = process.env.CODEX_HOME
    codexHome = mkdtempSync(join(tmpdir(), 'polyglots-translate-codex-'))
    process.env.CODEX_HOME = codexHome
  })
  afterEach(() => {
    if (savedHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = savedHome
  })
  const toml = (text: string) => writeFileSync(join(codexHome, 'config.toml'), text)

  async function runCodex(extra: Partial<TranslateOptions> = {}): Promise<ReturnType<typeof fakeReview>> {
    // Untouched catalogue each time, so only the review cache decides whether
    // the entries are asked again.
    await writeFile(ws.file, ws.original)
    const review = fakeReview()
    await translateFile(base({ engine: fakeEngine(), review, provider: 'codex', ...extra }))
    return review
  }

  it('hands the review pass the model and effort from codex config.toml', async () => {
    toml('model = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"\n')
    const review = await runCodex()
    expect(review.calls[0]!.opts).toMatchObject({ provider: 'codex', model: 'gpt-5.6-luna', effort: 'low' })
  })

  it('lets --model override the model and keeps the effort', async () => {
    toml('model = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"\n')
    const review = await runCodex({ model: 'gpt-5.5' })
    expect(review.calls[0]!.opts).toMatchObject({ model: 'gpt-5.5', effort: 'low' })
  })

  it('passes neither when nothing names them', async () => {
    const review = await runCodex()
    expect(review.calls[0]!.opts.model).toBeUndefined()
    expect(review.calls[0]!.opts.effort).toBeUndefined()
  })

  it('serves cached reviews until the effort changes, then asks again', async () => {
    const { saveConfig } = await import('../../../src/config.js')
    toml('model = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"\n')
    expect((await runCodex()).calls.length).toBeGreaterThan(0)
    expect((await runCodex()).calls).toEqual([])
    saveConfig({ reviewProvider: 'codex', codex: { effort: 'high' } })
    const again = await runCodex()
    expect(again.calls.length).toBeGreaterThan(0)
    expect(again.calls[0]!.opts.effort).toBe('high')
  })
})
