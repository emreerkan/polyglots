import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDb, replaceGlossary } from '../../../src/storage/index.js'
import { openJobsDb } from '../../../src/jobs/index.js'
import { reviewFile } from '../../../src/commands/review.js'
import { dataDir } from '../../../src/paths.js'
import type { LocalChatRequest } from '../../../src/draft/local-chat.js'
import { DEFAULT_QWEN_MODEL } from '../../../src/draft/qwen.js'

const PO = `msgid ""
msgstr ""
"Language: tr\\n"
"Plural-Forms: nplurals=2; plural=(n > 1);\\n"

msgid "Save all changes"
msgstr "Tüm değişiklikleri kaydet"

msgid "Open the sidebar"
msgstr "Yan menüyü aç"
`

// Answers every entry the prompt says it holds, as cleared. The count is read
// from the prompt's own sentence, the one written so nothing has to work it out.
function clearingChat() {
  const requests: LocalChatRequest[] = []
  const chat = vi.fn(async (request: LocalChatRequest) => {
    requests.push(request)
    const n = Number(/There are (\d+) entries below/.exec(request.user)![1])
    return JSON.stringify({
      results: Array.from({ length: n }, (_, i) => ({ id: i + 1, problem: false, categories: [], reason: 'ok' })),
    })
  })
  return { chat, requests }
}

describe('reviewFile with the local provider', () => {
  let home: string
  let file: string
  let db: Database.Database
  let jobs: Database.Database

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'polyglots-local-review-'))
    process.env.POLYGLOTS_HOME = home
    file = join(home, 'plugin-tr.po')
    await writeFile(file, PO, 'utf8')
    db = openDb(join(home, 'polyglots.db'))
    jobs = openJobsDb(join(home, 'jobs.db'))
    replaceGlossary(db, 'tr', [{ locale: 'tr', sourceTerm: 'sidebar', translation: 'kenar çubuğu', partOfSpeech: 'noun' }])
  })

  afterEach(async () => {
    db.close()
    jobs.close()
    await rm(home, { recursive: true, force: true })
  })

  it('asks the local model, with the glossary in the prompt and no tools promised', async () => {
    const { chat, requests } = clearingChat()
    const summary = await reviewFile({ file, locale: 'tr', db, jobsDb: jobs, provider: 'local', localChat: chat })
    expect(summary.reviewed).toBe(2)
    expect(chat).toHaveBeenCalled()
    expect(requests[0]!.user).toContain('kenar çubuğu')
    expect(requests[0]!.user).not.toMatch(/glossary_lookup|tm_lookup|consistency_lookup/)
  })

  it('writes no MCP config, since nothing will read it', async () => {
    await reviewFile({ file, locale: 'tr', db, jobsDb: jobs, provider: 'local', localChat: clearingChat().chat })
    expect(existsSync(join(dataDir(), 'mcp.json'))).toBe(false)
  })

  it('records and caches its verdicts under its own engine id', async () => {
    await reviewFile({ file, locale: 'tr', db, jobsDb: jobs, provider: 'local', localChat: clearingChat().chat })
    const run = jobs.prepare('SELECT engine FROM run ORDER BY id DESC LIMIT 1').get() as { engine: string }
    expect(run.engine).toBe(`local:ollama:${DEFAULT_QWEN_MODEL}`)
    const engines = jobs.prepare('SELECT DISTINCT engine FROM audit_verdict').all() as Array<{ engine: string }>
    expect(engines).toEqual([{ engine: `local:ollama:${DEFAULT_QWEN_MODEL}` }])
  })

  it('takes a per-run model, which keys apart from the configured one', async () => {
    await reviewFile({ file, locale: 'tr', db, jobsDb: jobs, provider: 'local', model: 'llama3.2', localChat: clearingChat().chat })
    const run = jobs.prepare('SELECT engine FROM run ORDER BY id DESC LIMIT 1').get() as { engine: string }
    expect(run.engine).toBe('local:ollama:llama3.2')
  })

  it('is never served a verdict claude reached, nor serves one to claude', async () => {
    const clearAll = vi.fn(async (batch: { id: number }[]) =>
      batch.map((c) => ({ id: c.id, problem: false, categories: [] as never[], reason: 'ok' })),
    )
    await reviewFile({ file, locale: 'tr', db, jobsDb: jobs, provider: 'claude', adjudicate: clearAll, mcpConfigPath: '' })
    const local = clearingChat()
    await reviewFile({ file, locale: 'tr', db, jobsDb: jobs, provider: 'local', localChat: local.chat })
    expect(local.chat).toHaveBeenCalled()
    clearAll.mockClear()
    await reviewFile({ file, locale: 'tr', db, jobsDb: jobs, provider: 'claude', adjudicate: clearAll, mcpConfigPath: '' })
    // Served from claude's own rows, untouched by the local run.
    expect(clearAll).not.toHaveBeenCalled()
  })

  // The local prompt is not the agents' one, and it is deliberately kept out
  // of the configuration hash (pruning would wipe the agents' rows), so it has
  // to be in each entry's key instead.
  it('keys its verdicts by its own prompt, not only by its engine name', async () => {
    const clearAll = vi.fn(async (batch: { id: number }[]) =>
      batch.map((c) => ({ id: c.id, problem: false, categories: [] as never[], reason: 'ok' })),
    )
    await reviewFile({ file, locale: 'tr', db, jobsDb: jobs, provider: 'claude', adjudicate: clearAll, mcpConfigPath: '' })
    await reviewFile({ file, locale: 'tr', db, jobsDb: jobs, provider: 'local', localChat: clearingChat().chat })
    const hashes = (engine: string) =>
      (jobs.prepare('SELECT src_hash FROM audit_verdict WHERE engine = ?').all(engine) as Array<{ src_hash: string }>).map((r) => r.src_hash)
    const agent = hashes('claude')
    const local = hashes(`local:ollama:${DEFAULT_QWEN_MODEL}`)
    expect(agent).toHaveLength(2)
    expect(local).toHaveLength(2)
    expect(local.filter((h) => agent.includes(h))).toEqual([])
  })

    it('resumes from its own cache on a second run', async () => {
    await reviewFile({ file, locale: 'tr', db, jobsDb: jobs, provider: 'local', localChat: clearingChat().chat })
    const again = clearingChat()
    await reviewFile({ file, locale: 'tr', db, jobsDb: jobs, provider: 'local', localChat: again.chat })
    expect(again.chat).not.toHaveBeenCalled()
  })
})
