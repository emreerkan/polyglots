import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDb, upsertTm } from '../../../src/storage/index.js'
import { replaceGlossary } from '../../../src/storage/glossary.js'
import { openJobsDb } from '../../../src/jobs/db.js'
import { translateFile, type TranslateOptions } from '../../../src/commands/translate.js'
import type { TmEntry } from '../../../src/types.js'
import { entryOf, parseFile } from './helpers.js'

// An exact memory match is written without a model, so it never went through
// the rules: the nl run filled "Social icons" with "Sociale pictogrammen",
// the newest of two wordings, while the glossary says "iconen". These pin how
// translate now weighs the memory's candidates against the glossary.

const PO = `msgid ""
msgstr ""
"Language: nl\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=2; plural=(n != 1);\\n"

msgid "Social icons"
msgstr ""

msgid "Save Changes"
msgstr ""

msgid "Social icons widget"
msgid_plural "Social icons widgets"
msgstr[0] ""
msgstr[1] ""
`

let home: string
let file: string
let db: Database.Database
let jobsDb: Database.Database

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyglots-memory-glossary-'))
  process.env.POLYGLOTS_HOME = home
  file = join(home, 'nl.po')
  await writeFile(file, PO)
  db = openDb(join(home, 'tm.db'))
  jobsDb = openJobsDb(join(home, 'jobs-test.db'))
  replaceGlossary(db, 'nl', [{ locale: 'nl', sourceTerm: 'icons', translation: 'iconen' }])
})

afterEach(async () => {
  db.close()
  jobsDb.close()
  delete process.env.POLYGLOTS_HOME
  await rm(home, { recursive: true, force: true })
})

// One row per call, oldest first: findMemory ranks the newest first, and rows
// written in the same millisecond fall back to insertion order.
function remember(...rows: Array<Omit<TmEntry, 'locale'>>): void {
  for (const row of rows) upsertTm(db, [{ ...row, locale: 'nl' }])
}

function base(overrides: Partial<TranslateOptions> = {}): TranslateOptions {
  return { file, locale: 'nl', mode: 'pending', draftEngine: 'none', batchSize: 25, db, jobsDb, ...overrides }
}

async function written(key: string) {
  const entry = entryOf(await parseFile(file), key)
  return {
    msgstr: entry.msgstr,
    fuzzy: (entry.comments?.flag ?? '').includes('fuzzy'),
    note: entry.comments?.translator ?? '',
  }
}

describe('translate: memory matches checked against the glossary', () => {
  it('prefers a candidate that uses the glossary term over a newer one that does not', async () => {
    remember(
      { source: 'Social icons', target: 'Sociale iconen' },
      { source: 'Social icons', target: 'Social pictogrammen' },
    )
    await translateFile(base())
    const entry = await written('Social icons')
    expect(entry.msgstr).toEqual(['Sociale iconen'])
    // Still a choice between two wordings, so a human still confirms it.
    expect(entry.fuzzy).toBe(true)
    expect(entry.note).not.toContain('glossary')
  })

  it('writes the newest candidate fuzzy, naming the term, when none uses it', async () => {
    remember(
      { source: 'Social icons', target: 'Social pictogrammen' },
      { source: 'Social icons', target: 'Sociale pictogrammen' },
    )
    await translateFile(base())
    const entry = await written('Social icons')
    expect(entry.msgstr).toEqual(['Sociale pictogrammen'])
    expect(entry.fuzzy).toBe(true)
    expect(entry.note).toBe('polyglots: glossary term not used: "icons" -> "iconen"')
  })

  it('marks a single wording fuzzy when it misses the glossary term', async () => {
    remember({ source: 'Social icons', target: 'Sociale pictogrammen' })
    await translateFile(base())
    const entry = await written('Social icons')
    expect(entry.msgstr).toEqual(['Sociale pictogrammen'])
    expect(entry.fuzzy).toBe(true)
    expect(entry.note).toContain('glossary term not used')
  })

  it('leaves a source with no glossary term exactly as before', async () => {
    remember({ source: 'Save Changes', target: 'Wijzigingen opslaan' })
    await translateFile(base())
    expect(await written('Save Changes')).toEqual({ msgstr: ['Wijzigingen opslaan'], fuzzy: false, note: '' })
  })

  it('checks a plural entry by its forms together', async () => {
    remember(
      { source: 'Social icons widget', target: 'Widget voor sociale iconen' },
      { source: 'Social icons widget', target: 'Widget voor sociale pictogrammen' },
      { source: 'Social icons widgets', target: 'Widgets voor sociale iconen' },
    )
    await translateFile(base())
    const entry = await written('Social icons widget')
    expect(entry.msgstr).toEqual(['Widget voor sociale iconen', 'Widgets voor sociale iconen'])
    expect(entry.note).not.toContain('glossary')
  })
})

/**
 * The glossary-conforming wording may sit under the same source in other
 * capitals: "Sociale iconen" was in the memory only under "Social Icons",
 * which the exact lookup never sees. Asked only when no exact candidate
 * passes, and always written fuzzy: it is a guess about a string nobody
 * translated in this form.
 */
describe('translate: case variants as a fallback', () => {
  it('writes a case variant that uses the glossary term, fuzzy, saying where it came from', async () => {
    remember(
      { source: 'Social Icons', target: 'Sociale iconen' },
      { source: 'Social icons', target: 'Social pictogrammen' },
      { source: 'Social icons', target: 'Sociale pictogrammen' },
    )
    await translateFile(base())
    const entry = await written('Social icons')
    expect(entry.msgstr).toEqual(['Sociale iconen'])
    expect(entry.fuzzy).toBe(true)
    expect(entry.note).toBe('polyglots: from the memory of "Social Icons"; glossary: icons → iconen')
  })

  it('marks a case variant fuzzy even when it is the only wording', async () => {
    remember({ source: 'Social Icons', target: 'Sociale iconen' }, { source: 'Social icons', target: 'Sociale pictogrammen' })
    await translateFile(base())
    const entry = await written('Social icons')
    expect(entry.msgstr).toEqual(['Sociale iconen'])
    expect(entry.fuzzy).toBe(true)
  })

  it('ignores case variants when an exact candidate already passes', async () => {
    remember(
      { source: 'Social Icons', target: 'Iconen voor sociale media' },
      { source: 'Social icons', target: 'Sociale iconen' },
    )
    await translateFile(base())
    expect(await written('Social icons')).toEqual({ msgstr: ['Sociale iconen'], fuzzy: false, note: '' })
  })

  it('falls back to the exact result when no case variant passes either', async () => {
    remember({ source: 'Social Icons', target: 'Social pictogrammen' }, { source: 'Social icons', target: 'Sociale pictogrammen' })
    await translateFile(base())
    const entry = await written('Social icons')
    expect(entry.msgstr).toEqual(['Sociale pictogrammen'])
    expect(entry.note).toBe('polyglots: glossary term not used: "icons" -> "iconen"')
  })

  // Only a source the memory already knows exactly is helped: an entry with no
  // exact row goes to the engine as before, so the scan runs on the rare
  // fallback and not for every untranslated entry with a glossary term.
  it('does not fill an entry that has no exact candidate at all', async () => {
    remember({ source: 'Social Icons', target: 'Sociale iconen' })
    await translateFile(base())
    expect((await written('Social icons')).msgstr).toEqual([''])
  })
})
