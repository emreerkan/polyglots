import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDb, replaceGlossary } from '../../../src/storage/index.js'
import { reviewFile } from '../../../src/commands/review.js'
import type { AuditCandidate } from '../../../src/audit/prompt.js'
import { useLocaleFixture } from '../../locale-fixture.js'

// The Swedish rules file end to end, against a fake agent: what reaches the model as
// automatedChecks is what a contributor's review is built on.
const PO = `msgid ""
msgstr ""
"MIME-Version: 1.0\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Language: sv_SE\\n"
"Plural-Forms: nplurals=2; plural=n != 1;\\n"

msgid "Save All Changes"
msgstr "Spara Alla Ändringar"

msgid "Discard all changes"
msgstr "Kasta alla ändringar"

msgid "Open the dashboard for Acme"
msgstr "Öppna panelen för Acme"

msgid "Date & Time"
msgstr "Datum & tid"

msgid "Progress: 25%"
msgstr "Förlopp: % 25"

msgid "Connect to WordPress"
msgstr "Anslut till WordPressen"
`

describe('reviewFile: Swedish', () => {
  let home: string
  let file: string
  let db: Database.Database

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'polyglots-review-sv-'))
    file = join(home, 'plugin-sv.po')
    await writeFile(file, PO, 'utf8')
    db = openDb(join(home, 'polyglots.db'))
    replaceGlossary(db, 'sv', [{ locale: 'sv', sourceTerm: 'dashboard', translation: 'panel', partOfSpeech: 'noun' }])
  })

  // The Swedish rules come from the Swedish rules file, as for a reviewer.
  useLocaleFixture('sv_SE.yaml')

  afterEach(async () => {
    db.close()
    await rm(home, { recursive: true, force: true })
  })

  async function hints(): Promise<Map<string, string[]>> {
    const seen = new Map<string, string[]>()
    await reviewFile({
      file,
      locale: 'sv',
      db,
      adjudicate: async (batch: AuditCandidate[]) => {
        for (const c of batch) seen.set(c.msgid, c.hints.map((h) => h.rule))
        return batch.map((c) => ({ id: c.id, problem: false, categories: [], reason: 'ok' }))
      },
    })
    return seen
  }

  it('flags a Title Case calque', async () => {
    expect((await hints()).get('Save All Changes')).toContain('title-case')
  })

  it('leaves sentence case and a brand mid-sentence alone', async () => {
    const seen = await hints()
    expect(seen.get('Discard all changes') ?? []).not.toContain('title-case')
    expect(seen.get('Open the dashboard for Acme') ?? []).not.toContain('title-case')
  })

  it('runs none of the Turkish conventions', async () => {
    const fired = [...(await hints()).values()].flat()
    for (const rule of ['apostrophe', 'ampersand', 'number-format']) expect(fired).not.toContain(rule)
  })
})
