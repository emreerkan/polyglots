import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openJobsDb } from '../../src/jobs/db.js'
import { endRun, finishRun, startRun, type StartRunInput } from '../../src/jobs/runs.js'
import { FINDING_KEYS } from '../../src/rules/names.js'
import { buildUsagePayload } from '../../src/usage/payload.js'

// Written out here rather than imported from the module under test, so adding
// a field to the payload fails this test until someone has decided, in this
// file, that the new field is allowed to leave the machine. Issue #19 is the
// list: totals, a project count, the version and the install id.
const ALLOWED_FIELDS = ['drafted', 'findings', 'installId', 'projects', 'repaired', 'reviewed', 'version']

const ID = '0b7c6f4e-3a52-4d8e-9a0f-1c2d3e4f5a6b'

let dir: string
let path: string
let db: Database.Database

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyglots-usage-'))
  path = join(dir, 'jobs.db')
  db = openJobsDb(path)
})

afterEach(async () => {
  if (db.open) db.close()
  await rm(dir, { recursive: true, force: true })
})

function run(
  input: Partial<StartRunInput> & Pick<StartRunInput, 'command'>,
  totals: { entries: number; repaired: number; byCategory?: Record<string, number> },
): number {
  const id = startRun(db, {
    file: '/home/someone/Downloads/plugin-tr.po',
    locale: 'tr',
    nplurals: 2,
    batchSize: 25,
    engine: 'claude',
    ...input,
  })
  finishRun(db, id, {
    entries: totals.entries,
    flagged: 0,
    repaired: totals.repaired,
    unreviewed: 0,
    approvable: 0,
    byCategory: totals.byCategory ?? {},
  })
  return id
}

describe('buildUsagePayload', () => {
  it('holds exactly the fields issue #19 allows, and nothing else', () => {
    run({ command: 'review', project: 'wp-plugins/akismet' }, { entries: 10, repaired: 2, byCategory: { glossary: 3 } })
    db.close()
    const payload = buildUsagePayload({ installId: ID, version: '1.2.3', jobsPath: path })
    expect(Object.keys(payload).sort()).toEqual(ALLOWED_FIELDS)
    for (const key of ['drafted', 'projects', 'repaired', 'reviewed'] as const) expect(Number.isInteger(payload[key])).toBe(true)
    for (const [key, value] of Object.entries(payload.findings)) {
      expect(FINDING_KEYS).toContain(key)
      expect(Number.isInteger(value)).toBe(true)
    }
  })

  it('totals finished runs: reviewed, drafted, repairs, findings and a count of projects', () => {
    run({ command: 'review', project: 'wp-plugins/akismet' }, { entries: 100, repaired: 7, byCategory: { glossary: 3, 'ai:meaning': 2 } })
    run({ command: 'review', project: 'wp-plugins/akismet' }, { entries: 50, repaired: 1, byCategory: { glossary: 1 } })
    // No project: counted by its file, never named.
    run({ command: 'review', file: '/x/other-tr.po' }, { entries: 5, repaired: 0 })
    run({ command: 'translate', project: 'wp-themes/twentytwenty' }, { entries: 40, repaired: 30 })
    // Not finished: froze no totals, so it counts for nothing.
    const stopped = startRun(db, { file: '/x/a.po', command: 'review', locale: 'tr', nplurals: 2, batchSize: 25, engine: 'claude' })
    endRun(db, stopped, 'stopped')
    db.close()

    expect(buildUsagePayload({ installId: ID, version: '1.2.3', jobsPath: path })).toEqual({
      installId: ID,
      version: '1.2.3',
      reviewed: 155,
      drafted: 30,
      repaired: 8,
      projects: 3,
      findings: { glossary: 4, 'ai:meaning': 2 },
    })
  })

  // The opt-in rules run only for the locales whose pack enables them
  // (apostrophe for Turkish, title-case for Turkish and Swedish), so a count
  // under their own names would say which locale an install reviews. They
  // travel as one locale-rule count.
  it('sends the locale-specific rules as one count, so no finding names the locale', () => {
    run({ command: 'review', project: 'wp-plugins/akismet' }, { entries: 10, repaired: 0, byCategory: { apostrophe: 2, 'title-case': 1, ampersand: 1, glossary: 1 } })
    db.close()
    const { findings } = buildUsagePayload({ installId: ID, version: '1.2.3', jobsPath: path })
    expect(findings).toEqual({ 'locale-rule': 4, glossary: 1 })
  })

  // The reviewer is told about capitalization only where title-case is on,
  // so its title-case category hints at the locale exactly as the rule did.
  it('sends the AI title-case category in the same locale-rule count', () => {
    run({ command: 'review', project: 'wp-plugins/akismet' }, { entries: 10, repaired: 0, byCategory: { 'ai:title-case': 3, 'title-case': 1, 'ai:meaning': 2 } })
    db.close()
    const { findings } = buildUsagePayload({ installId: ID, version: '1.2.3', jobsPath: path })
    expect(findings).toEqual({ 'locale-rule': 4, 'ai:meaning': 2 })
  })

  // A fix-suspect runs for every locale, wherever the model's fix lands, so its
  // count says nothing about which locale an install reviews. It travels under
  // its own name beside fix-rejected, and not inside the underlying rule's count:
  // that would add the model's slip to the contributors' tally of that check.
  it('sends the checks on the model fix under their own names', () => {
    run({ command: 'review', project: 'wp-plugins/akismet' }, { entries: 10, repaired: 3, byCategory: { 'fix-suspect': 2, 'fix-rejected': 1, glossary: 1 } })
    db.close()
    const { findings } = buildUsagePayload({ installId: ID, version: '1.2.3', jobsPath: path })
    expect(findings).toEqual({ 'fix-suspect': 2, 'fix-rejected': 1, glossary: 1 })
  })

  it('gives zeros when there is no job store, and creates none', async () => {
    db.close()
    await rm(path)
    const payload = buildUsagePayload({ installId: ID, version: '1.2.3', jobsPath: path })
    expect(payload).toEqual({ installId: ID, version: '1.2.3', reviewed: 0, drafted: 0, repaired: 0, projects: 0, findings: {} })
    expect(existsSync(path)).toBe(false)
  })

  it('lets no slug, file name, locale, username, provider or model string reach the payload', () => {
    // Every identifying string a real store holds, in every column it can sit
    // in, including finding keys that are not among the known ones.
    const secrets = [
      'wp-plugins/very-identifying-plugin',
      'very-identifying-plugin',
      '/Users/janedoe/Downloads/very-identifying-plugin-pt_BR.po',
      'janedoe',
      'pt_BR',
      'pt-br',
      'antigravity',
      'claude-opus-4-1',
      'gemini-2.5-flash',
      'qwen3:8b',
      'openai-compatible',
      'custom:janedoe-mistake',
    ]
    run(
      { command: 'review', project: secrets[0]!, file: secrets[2]!, locale: 'pt_BR', engine: 'antigravity:gemini-2.5-flash' },
      { entries: 12, repaired: 3, byCategory: { glossary: 1, 'custom:janedoe-mistake': 4, 'pt_BR-only': 1 } },
    )
    run(
      { command: 'translate', project: secrets[0]!, file: secrets[2]!, locale: 'pt_BR', engine: 'local:qwen3:8b@openai-compatible' },
      { entries: 9, repaired: 9 },
    )
    run({ command: 'review', project: secrets[0]!, file: secrets[2]!, locale: 'pt-br', engine: 'claude:claude-opus-4-1' }, { entries: 1, repaired: 0 })
    db.close()

    const payload = buildUsagePayload({ installId: ID, version: '1.2.3', jobsPath: path })
    const sent = JSON.stringify(payload)
    for (const secret of secrets) expect(sent).not.toContain(secret)
    expect(sent.toLowerCase()).not.toMatch(/pt[_-]br|janedoe|identifying|gemini|claude|qwen|antigravity|downloads/)
    // The known key survives; the unknown ones are dropped, not renamed.
    expect(payload.findings).toEqual({ glossary: 1 })
    expect(payload.projects).toBe(1)
  })
})
