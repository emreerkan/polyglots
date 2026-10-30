import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { openDb, replaceGlossary } from '../../../src/storage/index.js'
import { openJobsDb } from '../../../src/jobs/index.js'
import { translateFile, type TranslateOptions } from '../../../src/commands/translate.js'
import { fakeEngine, fakeReview, makeWorkspace, type Workspace } from './helpers.js'

let ws: Workspace

beforeEach(async () => {
  ws = await makeWorkspace()
  const db = openDb()
  replaceGlossary(db, 'tr', [{ locale: 'tr', sourceTerm: 'form', translation: 'form', partOfSpeech: 'noun' }])
  db.close()
})

afterEach(async () => {
  await ws.cleanup()
})

function base(overrides: Partial<TranslateOptions> = {}): TranslateOptions {
  return {
    file: ws.file,
    locale: 'tr',
    mode: 'all',
    draftEngine: 'deepl',
    provider: 'claude',
    mcpConfigPath: join(ws.home, 'mcp.json'),
    batchSize: 25,
    ...overrides,
  }
}

describe('translateFile with an agent reviewer', () => {
  it('hands the agent each entry\'s glossary terms, as it does a local reviewer', async () => {
    const review = fakeReview()
    await translateFile(base({ engine: fakeEngine(), review }))
    const inputs = review.calls.flatMap((c) => c.inputs)
    const form = inputs.find((i) => i.msgid === 'Form entries')
    expect(form?.glossary).toEqual([{ term: 'form', translations: ['form'], rows: [{ translation: 'form', pos: 'noun' }] }])
    const save = inputs.find((i) => i.msgid === 'Save Changes')
    expect(save).toBeDefined()
    expect(save?.glossary).toBeUndefined()
  })

  it('re-asks the agent only for the entries whose glossary terms changed', async () => {
    await translateFile(base({ engine: fakeEngine(), review: fakeReview() }))
    const again = fakeReview()
    await translateFile(base({ engine: fakeEngine(), review: again }))
    expect(again.calls).toHaveLength(0)

    const db = openDb()
    replaceGlossary(db, 'tr', [{ locale: 'tr', sourceTerm: 'form', translation: 'formu', partOfSpeech: 'noun' }])
    db.close()
    const changed = fakeReview()
    await translateFile(base({ engine: fakeEngine(), review: changed }))
    const asked = changed.calls.flatMap((c) => c.inputs)
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((i) => i.glossary?.some((g) => g.term === 'form'))).toBe(true)
  })

  // The prompt shows each row's note, so a note is part of what the agent was
  // asked: changing only the note re-asks the entries that carry the term.
  it('re-asks the agent when only a glossary row\'s note changed', async () => {
    await translateFile(base({ engine: fakeEngine(), review: fakeReview() }))
    const db = openDb()
    replaceGlossary(db, 'tr', [{ locale: 'tr', sourceTerm: 'form', translation: 'form', partOfSpeech: 'noun', notes: 'a web form' }])
    db.close()
    const changed = fakeReview()
    await translateFile(base({ engine: fakeEngine(), review: changed }))
    const asked = changed.calls.flatMap((c) => c.inputs)
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((i) => i.glossary?.some((g) => g.term === 'form'))).toBe(true)
  })

  // A run resumed after an upgrade finds its draft reviews under the old
  // prompt's configuration hash. It must ask again, not fail and not serve them.
  it('asks again, rather than failing, when its cached reviews were formed under another prompt', async () => {
    await translateFile(base({ engine: fakeEngine(), review: fakeReview() }))
    const jobs = openJobsDb()
    jobs.prepare("UPDATE draft_verdict SET config_hash = 'an-older-prompt'").run()
    jobs.close()
    const resumed = fakeReview()
    const summary = await translateFile(base({ engine: fakeEngine(), review: resumed }))
    expect(resumed.calls.flatMap((c) => c.inputs).length).toBe(summary.translated + summary.fuzzy)
    expect(resumed.calls.length).toBeGreaterThan(0)
  })
})
