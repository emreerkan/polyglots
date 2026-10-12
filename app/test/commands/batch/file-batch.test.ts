import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runFileBatch, type BatchItemEvent, type FileBatchJobs } from '../../../src/commands/batch.js'
import { reviewFile } from '../../../src/commands/review.js'
import type { TranslateOptions } from '../../../src/commands/translate.js'
import { jobsDbFile } from '../../../src/paths.js'
import { openDb, replaceGlossary } from '../../../src/storage/index.js'
import type { ReviewSummary } from '../../../src/types.js'
import { buildUsagePayload } from '../../../src/usage/payload.js'

// runFileBatch is fetch's run stage, fed files: the downloads it used to
// follow, or files marked in a picker, or `review a.po b.po`.

let dir: string

const PO = (project: string) => `msgid ""
msgstr ""
"Project-Id-Version: ${project}\\n"
"Language: tr\\n"
"MIME-Version: 1.0\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=2; plural=n > 1;\\n"

msgid "Save"
msgstr "Kaydet"

msgid "Cancel"
msgstr "Vazgeç"
`

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyglots-file-batch-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const summary = (file: string): ReviewSummary => ({
  file,
  locale: 'tr',
  total: 2,
  skipped: 0,
  reviewed: 2,
  problems: 0,
  needsReview: 0,
  approvable: 2,
  unreviewed: 0,
  repaired: 0,
  written: 0,
  pending: 0,
  byRule: {},
  byGroup: {},
})

const unused = async (opts: TranslateOptions) => {
  throw new Error(`translate was not expected: ${opts.file}`)
}

describe('runFileBatch', () => {
  it('runs each file in its own locale, and fails only the file whose locale cannot be found', async () => {
    const seen: Array<[string, string]> = []
    const jobs: FileBatchJobs = {
      reviewFile: async (opts) => {
        seen.push([opts.file, opts.locale])
        return summary(opts.file)
      },
      translateFile: unused,
    }
    const ends = await runFileBatch(
      [
        { input: 'a', file: '/x/a.po' },
        { input: 'b', file: '/x/b.po' },
        { input: 'c', file: '/x/c.po' },
      ],
      jobs,
      {
        review: true,
        localeOf: (file) => {
          if (file.endsWith('b.po')) throw new Error('b.po has no Language header')
          return file.endsWith('a.po') ? 'tr' : 'ja'
        },
        parallel: 1,
        batchSize: 10,
        draftEngine: 'deepl',
        wporgUsername: '',
      },
    )
    expect(seen).toEqual([
      ['/x/a.po', 'tr'],
      ['/x/c.po', 'ja'],
    ])
    expect(ends.map((e) => e.tally)).toEqual(['done', 'failed', 'done'])
    expect(ends[1]!.detail).toBe('b.po has no Language header')
  })

  it('reports each item as it starts and ends, by its input', async () => {
    const events: string[] = []
    await runFileBatch(
      [{ input: 'koji', file: '/x/a.po' }],
      { reviewFile: async (opts) => summary(opts.file), translateFile: unused },
      {
        review: true,
        localeOf: () => 'tr',
        parallel: 1,
        batchSize: 10,
        draftEngine: 'deepl',
        wporgUsername: '',
        onEvent: (e: BatchItemEvent) => events.push(`${e.type} ${e.item.input}`),
      },
    )
    expect(events).toEqual(['start koji', 'end koji'])
  })

  // Usage statistics are read from the job store's finished runs, and every
  // file in a batch is its own reviewFile call with its own run row, so a
  // batch of N counts as N runs, the same as fetch's batches always have.
  it('records one finished run per file, which is what usage statistics count', async () => {
    const a = join(dir, 'a-tr.po')
    const b = join(dir, 'b-tr.po')
    await writeFile(a, PO('Themes - Alpha'))
    await writeFile(b, PO('Themes - Beta'))
    // Review refuses to run without a glossary; this test's home has its own.
    const db = openDb()
    replaceGlossary(db, 'tr', [{ sourceTerm: 'Settings', translation: 'Ayarlar', locale: 'tr' }])
    db.close()
    const ends = await runFileBatch(
      [
        { input: a, file: a },
        { input: b, file: b },
      ],
      { reviewFile, translateFile: unused },
      { review: true, noAi: true, localeOf: () => 'tr', parallel: 2, batchSize: 10, draftEngine: 'deepl', wporgUsername: '' },
    )
    expect(ends.map((e) => e.tally)).toEqual(['done', 'done'])
    const payload = buildUsagePayload({ installId: 'id', version: '0', jobsPath: jobsDbFile() })
    expect(payload.reviewed).toBe(4)
    expect(payload.projects).toBe(2)
  })
})
