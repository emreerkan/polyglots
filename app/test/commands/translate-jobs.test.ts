import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openJobsDb } from '../../src/jobs/db.js'
import { openDb, replaceGlossary } from '../../src/storage/index.js'
import { translateFile } from '../../src/commands/translate.js'
import type { DraftEngine, ReviewInput, ReviewResult } from '../../src/types.js'
import { DEFAULT_QWEN_MODEL } from '../../src/draft/qwen.js'

let dir: string
let jobsDb: Database.Database
let db: Database.Database

const PO = `msgid ""
msgstr ""
"Language: tr\\n"
"MIME-Version: 1.0\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=2; plural=n > 1;\\n"

msgid "Save"
msgstr ""

msgid "Cancel"
msgstr ""
`

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyglots-translate-jobs-'))
  jobsDb = openJobsDb(join(dir, 'jobs.db'))
  db = openDb(join(dir, 'polyglots.db'))
  replaceGlossary(db, 'tr', [{ sourceTerm: 'Save', translation: 'Kaydet', locale: 'tr' }])
  await writeFile(join(dir, 'plugin-tr.po'), PO)
})

afterEach(async () => {
  jobsDb.close()
  db.close()
  await rm(dir, { recursive: true, force: true })
})

// DraftEngine.name is the union 'deepl' | 'openai', not a free string, so a
// fake still has to claim one of them.
const engine = (): DraftEngine => ({
  name: 'deepl',
  translate: async (units) => units.map((u) => ({ key: u.key, drafts: [`${u.msgid}-tr`] })),
})

const review = async (inputs: ReviewInput[]): Promise<ReviewResult[]> =>
  inputs.map((i) => ({ key: i.key, text: i.drafts, fuzzy: false, reason: '' }))

const run = (
  fake: DraftEngine,
  reviewDrafts: typeof review,
  mode: 'pending' | 'all' = 'pending',
  extra: { model?: string } = {},
) =>
  translateFile({
    file: join(dir, 'plugin-tr.po'),
    locale: 'tr',
    mode,
    draftEngine: 'deepl',
    engine: fake,
    // The injected seam is called `review`, not `reviewBatch`.
    review: reviewDrafts as never,
    db,
    jobsDb,
    mcpConfigPath: '',
    ...extra,
  })

describe('translate backed by the job store', () => {
  it('does not re-draft an entry it has already drafted', async () => {
    await run(engine(), review)
    const second = engine()
    const translate = vi.fn(second.translate)
    // `mode: 'pending'` would find nothing left to do on an unchanged file
    // and skip drafting entirely regardless of the cache, which would let
    // this pass with the feature removed. `mode: 'all'` forces both entries
    // back through draft() so the assertion actually exercises the cache.
    await run({ ...second, translate }, review, 'all')
    expect(translate).not.toHaveBeenCalled()
  })

  it('does not re-review a draft it has already reviewed', async () => {
    await run(engine(), review)
    const reviewDrafts = vi.fn(review)
    // Same reasoning as above: 'all' is required so the entries are actually
    // resubmitted, giving the review cache something to be tested against.
    await run(engine(), reviewDrafts, 'all')
    expect(reviewDrafts).not.toHaveBeenCalled()
  })

  // The draft table is invalidated by nothing but a prompt change, so --mode
  // all, whose whole purpose is to translate an entry again, replayed the same
  // cached draft forever.
  it('re-drafts and re-reviews when asked for a fresh translation', async () => {
    await run(engine(), review)

    const second = engine()
    const translate = vi.fn(second.translate)
    const reviewDrafts = vi.fn(review)
    await translateFile({
      file: join(dir, 'plugin-tr.po'),
      locale: 'tr',
      mode: 'all',
      draftEngine: 'deepl',
      fresh: true,
      engine: { ...second, translate },
      review: reviewDrafts as never,
      db,
      jobsDb,
      mcpConfigPath: '',
    })
    expect(translate).toHaveBeenCalled()
    expect(reviewDrafts).toHaveBeenCalled()
  })

  it('re-drafts only the entry whose source changed', async () => {
    await run(engine(), review)
    await writeFile(join(dir, 'plugin-tr.po'), PO.replace('msgid "Cancel"', 'msgid "Dismiss"'))
    const second = engine()
    const translate = vi.fn(second.translate)
    await run({ ...second, translate }, review)
    const asked = translate.mock.calls.flatMap(([units]) => units.map((u) => u.msgid))
    expect(asked).toEqual(['Dismiss'])
  })

  // The run table is history that cannot be backfilled. `entries` means the
  // entries a run worked on, which is what review freezes in the same column;
  // recording every unit in the file made a throughput query over the column
  // mix two definitions.
  it('freezes the entries it worked on, not every unit in the file', async () => {
    await writeFile(
      join(dir, 'plugin-tr.po'),
      PO.replace('msgid "Cancel"\nmsgstr ""', 'msgid "Cancel"\nmsgstr "Iptal"'),
    )
    const summary = await run(engine(), review)
    expect(summary.total).toBe(2)
    expect(summary.pending).toBe(1)
    const row = jobsDb
      .prepare<[], { entries: number; unreviewed: number }>(
        'SELECT entries, unreviewed FROM run ORDER BY id DESC LIMIT 1',
      )
      .get()!
    expect(row.entries).toBe(1)
    expect(row.unreviewed).toBe(0)
  })

  // A run that gave up on a batch under the failure breaker was recorded with
  // unreviewed = 0, so history said it was clean and complete.
  it('records the batches it gave up on as unreviewed', async () => {
    let call = 0
    const flaky = async (inputs: ReviewInput[]): Promise<ReviewResult[]> => {
      // The first batch fails both of its attempts, the second succeeds.
      if (++call <= 2) throw new Error('review failed')
      return review(inputs)
    }
    const summary = await translateFile({
      file: join(dir, 'plugin-tr.po'),
      locale: 'tr',
      mode: 'pending',
      draftEngine: 'deepl',
      engine: engine(),
      review: flaky as never,
      batchSize: 1,
      db,
      jobsDb,
      mcpConfigPath: '',
    })
    expect(summary.skipped).toBe(1)
    expect(summary.stopped).toBeUndefined()

    const row = jobsDb
      .prepare<[], { state: string; entries: number; unreviewed: number }>(
        'SELECT state, entries, unreviewed FROM run ORDER BY id DESC LIMIT 1',
      )
      .get()!
    expect(row.state).toBe('done')
    expect(row.entries).toBe(2)
    expect(row.unreviewed).toBe(1)
  })

  it('does not serve one model\'s draft review as another model\'s', async () => {
    // Same reason as the review command: two models answer differently, and
    // the comparison the engine project is for needs them kept apart.
    await run(engine(), review, 'pending', { model: 'opus' })
    // mode 'all' re-submits the entries the first run translated; with
    // 'pending' there would be nothing left to review and this would pass
    // without exercising the key at all.
    const second = vi.fn(review)
    await run(engine(), second, 'all', { model: 'sonnet' })
    expect(second).toHaveBeenCalled()
  })

  it('still reuses a draft review when the same model runs again', async () => {
    await run(engine(), review, 'pending', { model: 'opus' })
    const second = vi.fn(review)
    await run(engine(), second, 'all', { model: 'opus' })
    expect(second).not.toHaveBeenCalled()
  })

  it('records the run in history', async () => {
    await run(engine(), review)
    const row = jobsDb
      .prepare<[], { command: string; state: string }>('SELECT command, state FROM run ORDER BY id DESC LIMIT 1')
      .get()!
    expect(row.command).toBe('translate')
    expect(row.state).toBe('done')
  })
})

// The bug this covers: engineName was read off `opts.engine`, which every other
// test in this file injects and no real caller passes. The production fallback
// was the chosen engine's name, identical to the engine id for the metered
// engines and wrong for the local one, so it passed everywhere it was tested.
//
// Nothing is injected here. The catalogue is fully translated, so `pending`
// yields no units and the engine is never constructed, which is what lets this
// run without a reachable Ollama.
describe('the engine a run records', () => {
  const TRANSLATED = `msgid ""
msgstr ""
"Language: tr\\n"
"MIME-Version: 1.0\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=2; plural=n > 1;\\n"

msgid "Save"
msgstr "Kaydet"
`

  const runWithoutInjectedEngine = async (draftEngine: 'qwen' | 'deepl') => {
    const file = join(dir, 'done-tr.po')
    await writeFile(file, TRANSLATED)
    process.env.POLYGLOTS_HOME = dir
    try {
      await translateFile({ file, locale: 'tr', mode: 'pending', draftEngine, db, jobsDb, mcpConfigPath: '' })
    } finally {
      delete process.env.POLYGLOTS_HOME
    }
    return jobsDb
      .prepare<[], { engine: string }>(`SELECT engine FROM run ORDER BY id DESC LIMIT 1`)
      .get()!.engine
  }

  // Storing every local model as `qwen` meant switching models served one
  // model's drafts as the other's, and collapsed them into one row in stats.
  it('names the local model rather than the menu choice', async () => {
    expect(await runWithoutInjectedEngine('qwen')).toBe(`ollama:${DEFAULT_QWEN_MODEL}`)
  })

  it('leaves a metered engine as its own name', async () => {
    expect(await runWithoutInjectedEngine('deepl')).toBe('deepl')
  })
})
