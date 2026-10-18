import { describe, expect, it, vi } from 'vitest'
import { buildAuditPrompt, type AuditCandidate } from '../../src/audit/prompt.js'
import { auditBatchJsonSchema } from '../../src/audit/schema.js'
import { buildReviewPrompt } from '../../src/review/prompt.js'
import { reviewBatchJsonSchema } from '../../src/review/schema.js'
import {
  auditPromptVariant,
  createLocalAdjudicator,
  createLocalDraftReviewer,
  DEFAULT_LOCAL_REVIEW_BATCH,
  draftReviewPromptVariant,
  estimateBatchTokens,
  estimateTokens,
  localBatchAdvice,
  localReviewBatchSize,
} from '../../src/review/local.js'
import { LocalReplyTruncatedError, type LocalChatRequest } from '../../src/draft/local-chat.js'
import type { ReviewInput } from '../../src/types.js'

const TOOL_NAMES = /glossary_lookup|tm_lookup|consistency_lookup|lookup tools/

function fakeChat(replies: string[]) {
  const requests: LocalChatRequest[] = []
  const chat = vi.fn(async (request: LocalChatRequest) => {
    requests.push(request)
    const next = replies.shift()
    if (next === undefined) throw new Error('fake chat: no reply queued')
    return next
  })
  return { chat, requests }
}

const candidate = (over: Partial<AuditCandidate> = {}): AuditCandidate => ({
  id: 1,
  key: 'Open the sidebar',
  msgid: 'Open the sidebar',
  msgstr: ['Yan menüyü aç'],
  comments: [],
  references: ['admin/menu.php:3'],
  hints: [],
  glossary: [{ term: 'sidebar', translations: ['kenar çubuğu'] }],
  ...over,
})

describe('the audit prompt without tools', () => {
  it('names no tool, and says there are none', () => {
    const prompt = buildAuditPrompt([candidate()], 'tr', 2, undefined, { tools: false })
    expect(prompt).not.toMatch(TOOL_NAMES)
    expect(prompt).toMatch(/no tools/i)
    // The reply shape is stated, since a chat model gets no schema flag.
    expect(prompt).toContain('"results"')
    // What the tools would have answered is already on the entry.
    expect(prompt).toContain('"glossary":{"sidebar":["kenar çubuğu"]}')
  })

  it('leaves the agents\' prompt exactly as it was', () => {
    // The configuration hash covers this text; the pinned hashes in
    // test/rules/integration.test.ts are the real proof, this is the cheap one.
    const withTools = buildAuditPrompt([candidate()], 'tr', 2)
    expect(buildAuditPrompt([candidate()], 'tr', 2, undefined, { tools: true })).toBe(withTools)
    expect(withTools).toMatch(/glossary_lookup/)
    expect(withTools).toMatch(/the three lookup tools are everything you have/)
  })
})

describe('the draft review prompt without tools', () => {
  const input: ReviewInput = {
    key: 'Open the sidebar',
    msgid: 'Open the sidebar',
    comments: [],
    drafts: ['Kenar çubuğunu aç'],
    glossary: [{ term: 'sidebar', translations: ['kenar çubuğu'] }],
  }

  it('carries the glossary terms on the entry and names no tool', () => {
    const prompt = buildReviewPrompt([input], 'tr', 2, undefined, { tools: false })
    expect(prompt).not.toMatch(TOOL_NAMES)
    expect(prompt).toContain('"glossary":{"sidebar":["kenar çubuğu"]}')
  })

  it('renders the entry exactly as the agents\' prompt does, glossary field and all', () => {
    const entryLine = (prompt: string) => prompt.split('\n').find((l) => l.startsWith('1. {'))
    expect(entryLine(buildReviewPrompt([input], 'tr', 2, undefined, { tools: false }))).toBe(
      entryLine(buildReviewPrompt([input], 'tr', 2)),
    )
  })
})

describe('the prompt variants', () => {
  it('differ by locale and between the two prompts, and are stable', () => {
    expect(auditPromptVariant('tr')).toBe(auditPromptVariant('tr'))
    expect(auditPromptVariant('tr')).not.toBe(auditPromptVariant('de'))
    expect(auditPromptVariant('tr')).not.toBe(draftReviewPromptVariant('tr'))
  })
})

describe('createLocalAdjudicator', () => {
  const opts = { locale: 'tr', nplurals: 2, mcpConfigPath: '' }

  it('sends the no-tools prompt and the audit schema, and maps the reply by id', async () => {
    const { chat, requests } = fakeChat([
      'Sure: {"results":[{"id":1,"problem":true,"categories":["glossary"],"reason":"use kenar çubuğu","fix":["Kenar çubuğunu aç"]}]}',
    ])
    const results = await createLocalAdjudicator(chat, 'local:ollama:m')([candidate()], opts)
    expect(results).toEqual([
      { id: 1, problem: true, categories: ['glossary'], reason: 'use kenar çubuğu', fix: ['Kenar çubuğunu aç'] },
    ])
    expect(requests[0]!.schema).toBe(auditBatchJsonSchema)
    expect(requests[0]!.user).not.toMatch(TOOL_NAMES)
  })

  it('fails the batch on a reply that is missing an entry, naming the model', async () => {
    const { chat } = fakeChat(['{"results":[]}'])
    await expect(createLocalAdjudicator(chat, 'local:ollama:m')([candidate()], opts)).rejects.toThrow(/local:ollama:m/)
  })

  it('names the model once when the reply was cut off', async () => {
    const chat = vi.fn(async () => {
      throw new LocalReplyTruncatedError()
    })
    await expect(createLocalAdjudicator(chat, 'local:ollama:m')([candidate()], opts)).rejects.toThrow(
      /^local:ollama:m: the reply was cut off/,
    )
  })

  it('fails the batch on a reply that is not JSON', async () => {
    const { chat } = fakeChat(['I cannot help with that'])
    await expect(createLocalAdjudicator(chat, 'local:ollama:m')([candidate()], opts)).rejects.toThrow(/JSON/)
  })
})

describe('createLocalDraftReviewer', () => {
  it('sends the review schema and returns ReviewResult, as reviewBatch does', async () => {
    const { chat, requests } = fakeChat(['{"results":[{"id":1,"text":["Kenar çubuğunu aç"],"fuzzy":false,"reason":"ok"}]}'])
    const review = createLocalDraftReviewer(chat, 'local:ollama:m')
    const out = await review(
      [{ key: 'k', msgid: 'Open the sidebar', comments: [], drafts: ['Yan menüyü aç'], glossary: [{ term: 'sidebar', translations: ['kenar çubuğu'] }] }],
      { locale: 'tr', nplurals: 2, mcpConfigPath: '' },
    )
    expect(out).toEqual([{ key: 'k', text: ['Kenar çubuğunu aç'], fuzzy: false, reason: 'ok' }])
    expect(requests[0]!.schema).toBe(reviewBatchJsonSchema)
    expect(requests[0]!.user).toContain('kenar çubuğu')
  })

  it('returns nothing for nothing, without a request', async () => {
    const { chat } = fakeChat([])
    expect(await createLocalDraftReviewer(chat, 'x')([], { locale: 'tr', nplurals: 2, mcpConfigPath: '' })).toEqual([])
    expect(chat).not.toHaveBeenCalled()
  })
})

describe('batch size and context', () => {
  it('defaults local review to a small batch, and never raises a smaller configured one', () => {
    expect(localReviewBatchSize(100)).toBe(DEFAULT_LOCAL_REVIEW_BATCH)
    expect(localReviewBatchSize(10)).toBe(10)
  })

  // Three characters a token: Turkish and JSON both tokenize denser than
  // English prose, and an estimate that runs low lets a prompt overflow.
  it('estimates tokens conservatively from characters', () => {
    expect(estimateTokens('x'.repeat(300))).toBe(100)
  })

  it('fits the default batch in a 4,096-token context with room to spare', () => {
    expect(estimateBatchTokens('tr', DEFAULT_LOCAL_REVIEW_BATCH)).toBeLessThanOrEqual(4096 * 0.9)
  })

  it('says when the context cannot hold the review prompt at all', () => {
    const advice = localBatchAdvice({ batchSize: 5, locale: 'tr', contextLength: 1024, model: 'm', kind: 'openai-compatible' })
    expect(advice).toMatch(/cannot hold the review prompt/)
    expect(advice).not.toMatch(/batch size of/)
  })

  it('always tells an Ollama user with no context set to set one', () => {
    const advice = localBatchAdvice({ batchSize: DEFAULT_LOCAL_REVIEW_BATCH, locale: 'tr', model: 'm', kind: 'ollama' })
    expect(advice).toMatch(/config set ollama\.contextLength/)
    expect(advice?.split('\n')).toHaveLength(1)
    expect(localBatchAdvice({ batchSize: DEFAULT_LOCAL_REVIEW_BATCH, locale: 'tr', model: 'm', kind: 'ollama', contextLength: 8192 })).toBeUndefined()
  })

  it('warns when a batch will not fit the context, and names a size that does', () => {
    const advice = localBatchAdvice({ batchSize: 100, locale: 'tr', contextLength: 8192, model: 'local:ollama:m', kind: 'ollama' })
    expect(advice).toMatch(/8,?192/)
    const fits = Number(/batch size of (\d+)/.exec(advice ?? '')?.[1])
    expect(fits).toBeGreaterThan(0)
    expect(fits).toBeLessThan(100)
    expect(localBatchAdvice({ batchSize: fits, locale: 'tr', contextLength: 8192, model: 'm', kind: 'ollama' })).toBeUndefined()
  })

  it('says nothing when the batch fits a known context', () => {
    expect(localBatchAdvice({ batchSize: 20, locale: 'tr', contextLength: 32768, model: 'm', kind: 'ollama' })).toBeUndefined()
  })

  it('points at the docs when an OpenAI-compatible context is unknown and the batch is above the default', () => {
    expect(localBatchAdvice({ batchSize: 100, locale: 'tr', model: 'm', kind: 'openai-compatible' })).toContain('https://ada.tools/polyglots/docs/local-models/')
    expect(localBatchAdvice({ batchSize: DEFAULT_LOCAL_REVIEW_BATCH, locale: 'tr', model: 'm', kind: 'openai-compatible' })).toBeUndefined()
  })
})
