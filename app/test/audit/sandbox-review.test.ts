import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import { openJobsDb } from '../../src/jobs/db.js'
import { openDb, replaceGlossary } from '../../src/storage/index.js'
import { reviewFile } from '../../src/commands/review.js'
import { localeRulesFile } from '../../src/rules/load.js'
import { resetSandbox } from '../../src/rules/sandbox.js'

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

  it('leaves skippedRules out of a run that skipped nothing', async () => {
    await writeFile(localeRulesFile('tr'), "schema: 1\npatterns:\n  - find: 'zzz'\n    level: hint\n")
    const summary = await reviewFile({ file, locale: 'tr', db, jobsDb, noAi: true })
    expect(summary).not.toHaveProperty('skippedRules')
  })
})
