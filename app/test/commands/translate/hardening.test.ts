import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openDb, upsertTm } from '../../../src/storage/index.js'
import { dataDir } from '../../../src/paths.js'
import { translateFile, type TranslateOptions } from '../../../src/commands/translate.js'
import { openJobsDb } from '../../../src/jobs/db.js'
import { batchFailures } from '../../../src/jobs/runs.js'
import type { DraftResult } from '../../../src/types.js'
import { collect, draftFor, entryOf, fakeEngine, fakeReview, makeWorkspace, ofType, parseFile, type Workspace } from './helpers.js'

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

const THREE_FORMS_PO = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Language: ru\\n"
"Plural-Forms: nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);\\n"

msgid "Save Changes"
msgstr ""

msgid "%d entry"
msgid_plural "%d entries"
msgstr[0] ""
msgstr[1] ""
msgstr[2] ""
`

describe('translateFile: default mcp config carries the run locale', () => {
  it('writes mcp.json under dataDir with POLYGLOTS_LOCALE set to the run locale', async () => {
    const review = fakeReview()

    await translateFile(base({ locale: 'de', engine: fakeEngine(), review, mcpConfigPath: undefined }))

    const expectedPath = join(dataDir(), 'mcp.json')
    expect(review.calls[0]!.opts.mcpConfigPath).toBe(expectedPath)
    const written = JSON.parse(await readFile(expectedPath, 'utf8')) as {
      mcpServers: { polyglots: { env: Record<string, string> } }
    }
    expect(written.mcpServers.polyglots.env).toMatchObject({ POLYGLOTS_LOCALE: 'de', POLYGLOTS_HOME: ws.home })
  })
})

describe('translateFile: plural TM fast path is limited to two-form locales', () => {
  it('sends plural units of an nplurals=3 file to the engine even when both forms are in the TM', async () => {
    const file = join(ws.home, 'three.po')
    await writeFile(file, THREE_FORMS_PO)
    const db = openDb(join(ws.home, 'tm.db'))
    upsertTm(db, [
      { source: 'Save Changes', target: 'Сохранить', locale: 'ru' },
      { source: '%d entry', target: '%d запись', locale: 'ru' },
      { source: '%d entries', target: '%d записей', locale: 'ru' },
    ])
    const engine = fakeEngine()

    const summary = await translateFile(base({ file, locale: 'ru', db, engine, review: fakeReview() }))
    db.close()

    expect(summary).toMatchObject({ pending: 2, fromTm: 1, translated: 1 })
    expect(engine.calls).toEqual([['%d entry']])
    const after = await parseFile(file)
    expect(entryOf(after, 'Save Changes').msgstr).toEqual(['Сохранить'])
    expect(entryOf(after, '%d entry').msgstr).toEqual(['[draft] %d entry', '[draft] %d entries', '[draft] %d entries'])
  })
})

describe('translateFile: engine must return a draft for every unit', () => {
  // A skipped batch said why on screen and nowhere else.
  it('records each failed attempt of a skipped batch in jobs.db', async () => {
    const engine = fakeEngine()
    engine.translate = async (units, _locale, nplurals): Promise<DraftResult[]> => {
      engine.calls.push(units.map((u) => u.key))
      return units.filter((u) => u.key !== 'Form entries').map((u) => ({ key: u.key, drafts: draftFor(u, nplurals) }))
    }
    const jobsDb = openJobsDb(join(ws.home, 'jobs-failures.db'))
    await translateFile(base({ engine, review: fakeReview(), batchSize: 2, jobsDb }))
    const runId = (jobsDb.prepare('SELECT max(id) AS id FROM run').get() as { id: number }).id
    const rows = batchFailures(jobsDb, runId)
    jobsDb.close()
    expect(rows.map((r) => [r.batch, r.attempt, r.final])).toEqual([
      [1, 1, false],
      [1, 2, true],
    ])
    expect(rows[0]!.reason).toMatch(/Form entries/)
    expect(rows[0]).toMatchObject({ phase: 'drafting', size: 2 })
  })

  it('treats a missing draft as an engine error: retry once, then skip the batch naming the key', async () => {
    const engine = fakeEngine()
    engine.translate = async (units, _locale, nplurals): Promise<DraftResult[]> => {
      engine.calls.push(units.map((u) => u.key))
      return units.filter((u) => u.key !== 'Form entries').map((u) => ({ key: u.key, drafts: draftFor(u, nplurals) }))
    }
    const review = fakeReview()
    const { events, onProgress } = collect()

    const summary = await translateFile(base({ engine, review, batchSize: 2, onProgress }))

    // The retry on batch 1 asks the engine for only 'Form entries', not the
    // whole batch again: 'Save Changes' drafted fine on the first attempt and
    // is cached, so the retry is a targeted re-ask of the one unit that
    // actually failed rather than a re-buy of a draft already paid for.
    expect(engine.calls.map((c) => c.length)).toEqual([2, 1, 2, 2, 1])
    expect(review.calls).toHaveLength(3)
    expect(review.calls.flatMap((c) => c.inputs.map((i) => i.key))).not.toContain('Form entries')
    const skipped = ofType(events, 'batch-skipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ index: 1, size: 2 })
    expect(skipped[0]!.reason).toMatch(/Form entries/)
    expect(summary).toMatchObject({ pending: 7, translated: 5, skipped: 2 })
    const after = await parseFile(ws.file)
    expect(entryOf(after, 'Save Changes').msgstr).toEqual([''])
    expect(entryOf(after, 'Form entries').comments?.flag).toBe('fuzzy')
  })
})

describe('translateFile: batchSize is validated before any side effect', () => {
  it.each([0, -1, 1.5, Number.NaN])('rejects batchSize %s before reading the file or touching the TM', async (batchSize) => {
    const db = openDb(join(ws.home, 'tm.db'))
    upsertTm(db, [{ source: 'Save Changes', target: 'Değişiklikleri Kaydet', locale: 'tr' }])
    const engine = fakeEngine()
    const { events, onProgress } = collect()

    await expect(translateFile(base({ db, engine, review: fakeReview(), batchSize, onProgress }))).rejects.toThrow(RangeError)
    db.close()

    expect(events).toEqual([])
    expect(engine.calls).toEqual([])
    expect(await readFile(ws.file)).toEqual(ws.original)
  })
})

describe('translateFile: locale normalization', () => {
  it('normalizes the locale once so TM lookups hit and the reviewer sees the canonical form', async () => {
    const db = openDb(join(ws.home, 'tm.db'))
    upsertTm(db, [{ source: 'Save Changes', target: 'Değişiklikleri Kaydet', locale: 'tr' }])
    const engine = fakeEngine()
    const review = fakeReview()
    const seenLocales: string[] = []
    engine.translate = async (units, locale, nplurals): Promise<DraftResult[]> => {
      seenLocales.push(locale)
      return units.map((u) => ({ key: u.key, drafts: draftFor(u, nplurals) }))
    }

    const summary = await translateFile(base({ locale: ' TR ', db, engine, review }))
    db.close()

    expect(summary.fromTm).toBe(1)
    expect(review.calls[0]!.opts.locale).toBe('tr')
    expect(seenLocales).toEqual(['tr'])
    expect(entryOf(await parseFile(ws.file), 'Save Changes').msgstr).toEqual(['Değişiklikleri Kaydet'])
  })
})
