import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import { auditEntries, type Adjudicator } from '../../src/audit/audit.js'
import { openJobsDb } from '../../src/jobs/db.js'
import type { CachedVerdict, VerdictKey } from '../../src/jobs/verdicts.js'
import { openDb, replaceGlossary } from '../../src/storage/index.js'
import { reviewFile } from '../../src/commands/review.js'
import { replyCaution } from '../../src/reply/templates.js'
import { localeRulesFile } from '../../src/rules/load.js'
import { isSkipFinding } from '../../src/rules/custom.js'
import { resetSandbox } from '../../src/rules/sandbox.js'
import type { AuditEntry } from '../../src/types.js'

// Review Focus 4: a pattern that can run away is given up on after the
// budget, the review carries on, and the person hears about it once: one
// finding on the entry where it hung and one line in the summary, not one
// per entry it would have run on.
const RUNAWAY = 'a'.repeat(30) + 'b'
const PO = `msgid ""
msgstr ""
"Language: tr\\n"
"MIME-Version: 1.0\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=2; plural=n > 1;\\n"

msgid "First"
msgstr "${RUNAWAY}"

msgid "Second"
msgstr "${RUNAWAY}"

msgid "Third"
msgstr "${RUNAWAY}"
`

const RULES = `schema: 1
patterns:
  - find: '^(a+)+$'
    level: hint
    note: nested repetition
`

let dir: string
let file: string
let db: Database.Database
let jobsDb: Database.Database

beforeEach(async () => {
  resetSandbox()
  dir = await mkdtemp(join(tmpdir(), 'polyglots-sandbox-review-'))
  file = join(dir, 'plugin-tr.po')
  await writeFile(file, PO)
  db = openDb(join(dir, 'polyglots.db'))
  jobsDb = openJobsDb(join(dir, 'jobs.db'))
  replaceGlossary(db, 'tr', [{ sourceTerm: 'Settings', translation: 'Ayarlar', locale: 'tr' }])
  const rules = localeRulesFile('tr')
  await mkdir(dirname(rules), { recursive: true })
  await writeFile(rules, RULES)
})

afterEach(async () => {
  resetSandbox()
  db.close()
  jobsDb.close()
  await rm(dir, { recursive: true, force: true })
})

// The entry's comment block in the output file, which is where a rules-only
// run puts each finding for the person to read.
function block(po: string, msgid: string): string {
  const at = po.indexOf(`msgid "${msgid}"`)
  const start = po.lastIndexOf('\n\n', at)
  return po.slice(start, at)
}

describe('review with a runaway locale pattern', () => {
  it('finishes, names the pattern once, and reports it on the first entry only', async () => {
    const t0 = Date.now()
    const summary = await reviewFile({ file, locale: 'tr', db, jobsDb, noAi: true })
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(summary.skippedRules).toEqual(['nested repetition'])
    const out = await readFile(summary.problemsFile!, 'utf8')
    const first = block(out, 'First')
    expect(first.match(/locale rule skipped/g)).toHaveLength(1)
    expect(first).toContain('locale rule skipped: nested repetition took longer than 100 ms')
    expect(out.match(/locale rule skipped/g)).toHaveLength(1)
  })

  // The summary names a pattern by its note, and two patterns may share one.
  // Named twice, the line repeats and the TUI renders two rows under one key.
  it('names two runaway patterns that share a note once', async () => {
    await writeFile(
      localeRulesFile('tr'),
      "schema: 1\npatterns:\n  - find: '^(a+)+$'\n    level: hint\n    note: nested repetition\n  - find: '^((a+))+$'\n    level: hint\n    note: nested repetition\n",
    )
    const summary = await reviewFile({ file, locale: 'tr', db, jobsDb, noAi: true })
    expect(summary.skippedRules).toEqual(['nested repetition'])
  })

  it('leaves skippedRules out of a run that skipped nothing', async () => {
    await writeFile(localeRulesFile('tr'), "schema: 1\npatterns:\n  - find: 'zzz'\n    level: hint\n")
    const summary = await reviewFile({ file, locale: 'tr', db, jobsDb, noAi: true })
    expect(summary).not.toHaveProperty('skippedRules')
  })
})

// Maintainer ruling 2026-10-16: the skip stays on the entry in the problems
// file, where the maintainer reads which entry the pattern hung on, and is
// never put to the model. Those two halves pull apart once a model is in the
// run: the model clears an entry it found nothing wrong with, and a cleared
// entry otherwise keeps only its repair note.
describe('review with a model and a runaway locale pattern', () => {
  const clean: Adjudicator = async (batch) =>
    batch.map((c) => ({ id: c.id, problem: false, categories: [], reason: '' }))

  it('keeps the skip on the entry in the problems file when the model clears it', async () => {
    const summary = await reviewFile({ file, locale: 'tr', db, jobsDb, adjudicate: clean })
    expect(summary.skippedRules).toEqual(['nested repetition'])
    const out = await readFile(summary.problemsFile!, 'utf8')
    expect(block(out, 'First')).toContain('locale rule skipped: nested repetition took longer than 100 ms')
    expect(out.match(/locale rule skipped/g)).toHaveLength(1)
  })

  // The key covers what the prompt renders, and the prompt does not render
  // the skip. Keyed on the unfiltered hints, the entry the pattern hung on
  // would be stored under one key on the run that hit the skip and looked up
  // under another on the next, where the pattern is already given up on and
  // reports nothing: the same question asked twice and paid for twice.
  it('stores the verdict under the key of the prompt the model was actually sent', async () => {
    const rows = new Map<string, CachedVerdict>()
    const id = (k: VerdictKey) => [k.srcHash, k.configHash, k.locale, k.engine].join('|')
    const store = { get: (k: VerdictKey) => rows.get(id(k)), put: (k: VerdictKey, v: CachedVerdict) => void rows.set(id(k), v) }
    const entries: AuditEntry[] = [{ key: 'First', msgid: 'First', msgstr: [RUNAWAY], comments: [], references: [], fuzzy: false }]
    const opts = { locale: 'tr' as const, nplurals: 2, glossary: [], configHash: 'cfg0cfg0cfg0cfg0', engine: 'claude', entries, store }

    const first = vi.fn(clean)
    await auditEntries({ ...opts, adjudicate: first })
    expect(first).toHaveBeenCalledTimes(1)
    // The first run is the one the pattern hung on: the candidate carries it.
    expect(first.mock.calls[0]![0][0]!.hints.some(isSkipFinding)).toBe(true)

    const second = vi.fn(clean)
    await auditEntries({ ...opts, adjudicate: second })
    expect(second).not.toHaveBeenCalled()
  })
})

// Maintainer ruling 2026-10-16, second half: a rules-file fault reaches
// nothing a contributor reads. The reply's caution and its verdict branch
// count needsReview, and the requester message counts byGroup, so a skip
// left in either would tell a contributor their entry was doubted, or fixed
// for "smaller issues", over a regex they never wrote.
describe('a runaway locale pattern and what the contributor is told', () => {
  it('does not make a rules-only run count the entry as a guess, and still writes the skip', async () => {
    const summary = await reviewFile({ file, locale: 'tr', db, jobsDb, noAi: true })
    expect(summary.needsReview).toBe(0)
    expect(replyCaution(summary)).toBeUndefined()
    const out = await readFile(summary.problemsFile!, 'utf8')
    expect(block(out, 'First')).toContain('locale rule skipped: nested repetition took longer than 100 ms')
  })

  it('does not count the entry among the suspects the rules report, with or without a model', async () => {
    const entries: AuditEntry[] = [{ key: 'First', msgid: 'First', msgstr: [RUNAWAY], comments: [], references: [], fuzzy: false }]
    const suspects: number[] = []
    const opts = { locale: 'tr' as const, nplurals: 2, glossary: [], entries, onRules: (r: { suspects: number }) => void suspects.push(r.suspects) }
    await auditEntries({ ...opts, noAi: true })
    resetSandbox()
    await auditEntries({ ...opts, adjudicate: async (batch) => batch.map((c) => ({ id: c.id, problem: false, categories: [], reason: '' })) })
    expect(suspects).toEqual([0, 0])
  })

  it('leaves the skip out of the groups the requester message counts', async () => {
    const fixFirst: Adjudicator = async (batch) =>
      batch.map((c) =>
        c.msgid === 'First'
          ? { id: c.id, problem: true, categories: ['glossary'], reason: 'wrong term', fix: ['Birinci'] }
          : { id: c.id, problem: false, categories: [], reason: '' },
      )
    const summary = await reviewFile({ file, locale: 'tr', db, jobsDb, adjudicate: fixFirst })
    expect(summary.repaired).toBe(1)
    expect(summary.byGroup).toEqual({ glossary: 1 })
  })
})
