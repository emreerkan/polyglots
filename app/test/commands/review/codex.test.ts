import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openJobsDb } from '../../../src/jobs/db.js'
import { openDb, replaceGlossary } from '../../../src/storage/index.js'
import { reviewFile } from '../../../src/commands/review.js'
import { saveConfig } from '../../../src/config.js'

// Review with codex as the provider, end to end through a stand-in codex that
// records its argv. The argv is the proof that model and effort reach the
// spawn, and the engine id on the cached verdicts is the proof they reach the
// cache key. The real codex is never run, and CODEX_HOME points at a
// temporary folder so the developer's own config.toml cannot leak in.

const PO = `msgid ""
msgstr ""
"Language: tr\\n"
"MIME-Version: 1.0\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=2; plural=n > 1;\\n"

msgid "Save %s"
msgstr "Kaydet"

msgid "Cancel"
msgstr "İptal"
`

const line = (o: unknown): string => `${JSON.stringify(o)}\n`
// Both entries reach the model, as ids 1 and 2. An id the batch never held
// would fail the batch, so this is exactly as long as the catalogue.
const ANSWER = {
  results: [1, 2].map((id) => ({ id, problem: false, categories: [], reason: 'ok', fix: null })),
}
const OUTPUT =
  line({ type: 'thread.started', thread_id: 't1' }) +
  line({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: JSON.stringify(ANSWER) } }) +
  line({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } })

let dir: string
let file: string
let bin: string
let db: Database.Database
let jobsDb: Database.Database
let saved: NodeJS.ProcessEnv

beforeEach(() => {
  saved = { ...process.env }
  dir = mkdtempSync(join(tmpdir(), 'polyglots-review-codex-'))
  process.env.CODEX_HOME = join(dir, 'codex-home')
  mkdirSync(process.env.CODEX_HOME)
  file = join(dir, 'plugin-tr.po')
  writeFileSync(file, PO)
  bin = join(dir, 'codex')
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs')",
      `fs.appendFileSync(${JSON.stringify(join(dir, 'argv.jsonl'))}, JSON.stringify(process.argv.slice(2)) + '\\n')`,
      "process.stdin.resume().on('end', () => process.stdout.write(" + JSON.stringify(OUTPUT) + '))',
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  db = openDb(join(dir, 'polyglots.db'))
  jobsDb = openJobsDb(join(dir, 'jobs.db'))
  replaceGlossary(db, 'tr', [{ sourceTerm: 'Settings', translation: 'Ayarlar', locale: 'tr' }])
})

afterEach(() => {
  db.close()
  jobsDb.close()
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  rmSync(dir, { recursive: true, force: true })
})

const toml = (text: string) => writeFileSync(join(process.env.CODEX_HOME!, 'config.toml'), text)
const spawns = (): string[][] => {
  try {
    return readFileSync(join(dir, 'argv.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as string[])
  } catch {
    return []
  }
}
const engines = (): string[] =>
  jobsDb
    .prepare<[], { engine: string }>('SELECT DISTINCT engine FROM audit_verdict ORDER BY engine')
    .all()
    .map((r) => r.engine)
const review = (extra: { model?: string; fresh?: boolean } = {}) =>
  reviewFile({ file, locale: 'tr', db, jobsDb, provider: 'codex', bin, ...extra })

describe('review with codex: model and effort', () => {
  it('passes codex config.toml model and effort to every batch and names the engine with both', async () => {
    toml('model = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"\n')
    await review()
    const argv = spawns()
    expect(argv.length).toBeGreaterThan(0)
    for (const a of argv) {
      expect(a).toContain('-m')
      expect(a[a.indexOf('-m') + 1]).toBe('gpt-5.6-luna')
      expect(a).toContain('model_reasoning_effort="low"')
    }
    expect(engines()).toEqual(['codex:gpt-5.6-luna (low)'])
  })

  it('lets polyglots config set the effort, and does not serve verdicts cached under another one', async () => {
    toml('model = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"\n')
    await review()
    const first = spawns().length
    saveConfig({ reviewProvider: 'codex', codex: { effort: 'high' } })
    await review()
    const after = spawns()
    expect(after.length).toBeGreaterThan(first)
    expect(after.at(-1)).toContain('model_reasoning_effort="high"')
    expect(after.at(-1)).not.toContain('model_reasoning_effort="low"')
    expect(engines()).toEqual(['codex:gpt-5.6-luna (high)', 'codex:gpt-5.6-luna (low)'])
  })

  it('passes no model and no effort when nothing names them, and records the bare engine', async () => {
    await review()
    const argv = spawns()
    expect(argv.length).toBeGreaterThan(0)
    for (const a of argv) {
      expect(a).not.toContain('-m')
      expect(a.some((x) => x.startsWith('model_reasoning_effort'))).toBe(false)
    }
    expect(engines()).toEqual(['codex'])
  })

  it('lets --model override the model and leaves the effort alone', async () => {
    toml('model = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"\n')
    await review({ model: 'gpt-5.5' })
    const a = spawns()[0]!
    expect(a[a.indexOf('-m') + 1]).toBe('gpt-5.5')
    expect(a).toContain('model_reasoning_effort="low"')
    expect(engines()).toEqual(['codex:gpt-5.5 (low)'])
  })
})
