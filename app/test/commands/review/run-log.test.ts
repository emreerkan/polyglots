import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDb, replaceGlossary } from '../../../src/storage/index.js'
import { reviewFile, type ReviewOptions } from '../../../src/commands/review.js'
import { openJobsDb } from '../../../src/jobs/db.js'
import type { ReviewEvent } from '../../../src/types.js'
import { useLocaleFixture } from '../../locale-fixture.js'

// The same submission review.test.ts reviews: one msgstr below is the
// catalogue text the always-on log must never hold.
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

const logsDir = () => join(process.env.POLYGLOTS_HOME!, 'data', 'logs')

function runLogText(): string {
  const [file] = readdirSync(logsDir()).filter((n) => n.endsWith('.jsonl'))
  return readFileSync(join(logsDir(), file!), 'utf8')
}

describe('reviewFile: the run log', () => {
  let home: string
  let file: string
  let db: Database.Database

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'polyglots-review-log-'))
    file = join(home, 'plugin-tr.po')
    await writeFile(file, PO, 'utf8')
    db = openDb(join(home, 'polyglots.db'))
    replaceGlossary(db, 'tr', [
      { locale: 'tr', sourceTerm: 'sidebar', translation: 'kenar çubuğu', partOfSpeech: 'noun' },
    ])
  })

  useLocaleFixture('tr_TR.yaml')

  afterEach(async () => {
    db.close()
    await rm(home, { recursive: true, force: true })
  })

  const clearAll = vi.fn(async (batch: { id: number }[]) =>
    batch.map((c) => ({ id: c.id, problem: false, categories: [] as never[], reason: 'ok' })),
  )

  function run(overrides: Partial<ReviewOptions> = {}) {
    return reviewFile({ file, locale: 'tr', db, adjudicate: clearAll, ...overrides })
  }

  it('writes run-start, the batch events and run-end, and no catalogue text', async () => {
    const jobsDb = openJobsDb(join(home, 'jobs.db'))
    await run({ jobsDb })
    const text = runLogText()
    const kinds = text.trim().split('\n').map((l) => JSON.parse(l).kind)
    expect(kinds[0]).toBe('run-start')
    expect(kinds).toContain('batch-start')
    expect(kinds).not.toContain('entries')
    expect(kinds.at(-1)).toBe('run-end')
    expect(text).not.toContain('Tüm değişiklikleri kaydet')
    const start = JSON.parse(text.split('\n')[0]!)
    expect(start).toMatchObject({
      command: 'review',
      locale: 'tr',
      batchSize: expect.any(Number),
      version: expect.any(String),
      node: process.version,
      platform: process.platform,
      pid: process.pid,
    })
    expect(JSON.parse(text.trim().split('\n').at(-1)!)).toMatchObject({ kind: 'run-end', ended: 'done', reviewed: 3 })
    jobsDb.close()
  })

  it('records a run that threw as ended: failed', async () => {
    const jobsDb = openJobsDb(join(home, 'jobs.db'))
    // A progress handler that throws on the first batch makes reviewFile throw
    // from inside its try, which is the failed path.
    const onProgress = (e: ReviewEvent) => {
      if (e.type === 'batch-start') throw new Error('caller')
    }
    await expect(run({ jobsDb, onProgress })).rejects.toThrow('caller')
    const last = JSON.parse(runLogText().trim().split('\n').at(-1)!)
    expect(last).toMatchObject({ kind: 'run-end', ended: 'failed', error: 'caller' })
    jobsDb.close()
  })

  it('finishes with the same summary when the log folder cannot be written', async () => {
    const logs = logsDir()
    mkdirSync(logs, { recursive: true })
    chmodSync(logs, 0o500)
    const errs: string[] = []
    try {
      const summary = await run({ onWarn: (l: string) => errs.push(l) })
      expect(summary.reviewed).toBeGreaterThan(0)
    } finally {
      chmodSync(logs, 0o700)
    }
    expect(errs.filter((l) => /run log/.test(l))).toHaveLength(1)
  })

  it('says once, at the start, where a debug run keeps its files, and writes it in the log', async () => {
    const warned: string[] = []
    await run({ debug: true, onWarn: (l: string) => warned.push(l) })
    const notices = warned.filter((l) => l.startsWith('Debug mode: '))
    expect(notices).toHaveLength(1)
    const dir = notices[0]!.replace('Debug mode: prompts and agent output are saved in ', '')
    expect(dir.startsWith(logsDir())).toBe(true)
    const lines = runLogText().trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[1]).toMatchObject({ kind: 'debug', dir })
  })

  it('says nothing about debug mode when it is off', async () => {
    const warned: string[] = []
    await run({ onWarn: (l: string) => warned.push(l) })
    expect(warned).toEqual([])
    expect(runLogText()).not.toContain('"kind":"debug"')
  })
})
