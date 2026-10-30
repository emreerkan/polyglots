import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { openDb, replaceGlossary } from '../../../src/storage/index.js'
import { openJobsDb } from '../../../src/jobs/index.js'
import { saveConfig } from '../../../src/config.js'
import { translateFile, type TranslateOptions } from '../../../src/commands/translate.js'
import type { LocalChatRequest } from '../../../src/draft/local-chat.js'
import { fakeEngine, fakeReview, makeWorkspace, PENDING_KEYS, type Workspace } from './helpers.js'
import { DEFAULT_QWEN_MODEL } from '../../../src/draft/qwen.js'

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
    mode: 'pending',
    draftEngine: 'deepl',
    mcpConfigPath: join(ws.home, 'mcp.json'),
    batchSize: 25,
    ...overrides,
  }
}

// One fake for both local calls a batch can make: the draft engine asks with
// the `drafts` schema and the reviewer with `review`. Each answers every id
// the prompt holds, echoing what it was given.
function localChat() {
  const requests: LocalChatRequest[] = []
  const chat = vi.fn(async (request: LocalChatRequest) => {
    requests.push(request)
    if (request.schemaName === 'drafts') {
      const { items } = JSON.parse(request.user) as { items: Array<{ id: number; msgid: string; msgidPlural?: string }> }
      return JSON.stringify({
        items: items.map((i) => ({ id: i.id, drafts: i.msgidPlural ? [`[l] ${i.msgid}`, `[l] ${i.msgidPlural}`] : [`[l] ${i.msgid}`] })),
      })
    }
    const lines = request.user.split('\n').filter((l) => /^\d+\. \{/.test(l))
    return JSON.stringify({
      results: lines.map((line) => {
        const entry = JSON.parse(line.replace(/^\d+\. /, '')) as { id: number; drafts: string[] }
        return { id: entry.id, text: entry.drafts, fuzzy: false, reason: 'ok' }
      }),
    })
  })
  return { chat, requests }
}

function lastRunEngine(): string {
  const jobs = openJobsDb()
  try {
    return (jobs.prepare('SELECT engine FROM run ORDER BY id DESC LIMIT 1').get() as { engine: string }).engine
  } finally {
    jobs.close()
  }
}

describe('translateFile with a local reviewer', () => {
  it('hands the reviewer its glossary terms and caches its answer under its own engine', async () => {
    const { chat, requests } = localChat()
    await translateFile(base({ engine: fakeEngine(), provider: 'local', localChat: chat }))
    const review = requests.filter((r) => r.schemaName === 'review')
    expect(review).toHaveLength(1)
    expect(review[0]!.user).toContain('"glossary":{"form":[{"tr":"form","pos":"noun"}]}')
    expect(review[0]!.user).not.toMatch(/glossary_lookup|tm_lookup|consistency_lookup/)

    const jobs = openJobsDb()
    const engines = jobs.prepare('SELECT DISTINCT engine FROM draft_verdict').all()
    jobs.close()
    expect(engines).toEqual([{ engine: `local:ollama:${DEFAULT_QWEN_MODEL}` }])
  })

  it('re-asks only when what it was told changes, the glossary included', async () => {
    await translateFile(base({ engine: fakeEngine(), provider: 'local', localChat: localChat().chat, mode: 'all', fresh: false }))
    const again = localChat()
    await translateFile(base({ engine: fakeEngine(), provider: 'local', localChat: again.chat, mode: 'all' }))
    expect(again.chat).not.toHaveBeenCalled()

    const db = openDb()
    replaceGlossary(db, 'tr', [{ locale: 'tr', sourceTerm: 'form', translation: 'formu', partOfSpeech: 'noun' }])
    db.close()
    const changed = localChat()
    await translateFile(base({ engine: fakeEngine(), provider: 'local', localChat: changed.chat, mode: 'all' }))
    const asked = changed.requests.flatMap((r) => r.user.split('\n').filter((l) => /^\d+\. \{/.test(l)))
    // Only the entries whose source holds the term were asked again.
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((l) => l.includes('"glossary"'))).toBe(true)
  })

  it('never reads an agent\'s draft review for the same entry', async () => {
    // A dry run caches claude's reviews without writing the file, so the very
    // same entries are still pending, with the very same drafts, for the
    // local pass. Every one of them must reach the local model: a cache hit
    // here would be claude's verdict served as the local model's.
    const review = fakeReview()
    await translateFile(base({ engine: fakeEngine(), review, provider: 'claude', dryRun: true }))
    const claudeAsked = review.calls.flatMap((c) => c.inputs.map((i) => i.msgid)).sort()
    expect(claudeAsked).toHaveLength(PENDING_KEYS.length)

    const local = localChat()
    await translateFile(base({ engine: fakeEngine(), provider: 'local', localChat: local.chat }))
    const localAsked = local.requests
      .filter((r) => r.schemaName === 'review')
      .flatMap((r) => r.user.split('\n').filter((l) => /^\d+\. \{/.test(l)))
      .map((l) => (JSON.parse(l.replace(/^\d+\. /, '')) as { msgid: string }).msgid)
      .sort()
    expect(localAsked).toEqual(claudeAsked)
  })
})

describe('translateFile with the local draft engine', () => {
  it('accepts qwen, the old name, and keeps the engine id cached drafts are stored under', async () => {
    await translateFile(base({ draftEngine: 'qwen', review: fakeReview(), localChat: localChat().chat }))
    expect(lastRunEngine()).toBe(`ollama:${DEFAULT_QWEN_MODEL}`)
  })

  it('takes a model for this run only, under that model\'s own id', async () => {
    const { chat, requests } = localChat()
    await translateFile(base({ draftEngine: 'local', localModel: 'llama3.2', review: fakeReview(), localChat: chat }))
    expect(lastRunEngine()).toBe('ollama:llama3.2')
    expect(requests.some((r) => r.schemaName === 'drafts')).toBe(true)
  })

  it('drafts on an OpenAI-compatible server under its own id', async () => {
    saveConfig({ localServerKind: 'openai-compatible', openaiCompatible: { baseUrl: 'http://localhost:1234/v1', model: 'qwen/qwen3-8b' } })
    await translateFile(base({ draftEngine: 'local', review: fakeReview(), localChat: localChat().chat }))
    expect(lastRunEngine()).toBe('openai-compatible:localhost:1234/qwen/qwen3-8b')
  })

  it('refuses an OpenAI-compatible server with no model before recording a run', async () => {
    saveConfig({ localServerKind: 'openai-compatible' })
    await expect(translateFile(base({ draftEngine: 'local', review: fakeReview(), localChat: localChat().chat }))).rejects.toThrow(
      /openaiCompatible\.model/,
    )
    const jobs = openJobsDb()
    const runs = jobs.prepare('SELECT COUNT(*) AS n FROM run').get() as { n: number }
    jobs.close()
    expect(runs.n).toBe(0)
  })
})
