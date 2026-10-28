import { describe, expect, it } from 'vitest'
import {
  DraftQuotaError,
  DraftRateLimitError,
  createDeepLEngine,
  createOpenAIEngine,
  getDraftEngine,
  missingPlaceholders,
  warnMissingPlaceholders,
} from '../../src/draft/index.js'
import { DraftQuotaError as ErrorsDraftQuotaError } from '../../src/draft/errors.js'
import { missingPlaceholders as placeholdersMissing } from '../../src/draft/placeholders.js'

describe('getDraftEngine', () => {
  it('builds a deepl engine when DEEPL_API_KEY is present', () => {
    expect(getDraftEngine('deepl', { DEEPL_API_KEY: '0000:fx' }).name).toBe('deepl')
  })

  it('builds an openai engine when OPENAI_API_KEY is present', () => {
    expect(getDraftEngine('openai', { OPENAI_API_KEY: 'sk-test' }).name).toBe('openai')
  })

  it('names DEEPL_API_KEY when the DeepL key is missing', () => {
    expect(() => getDraftEngine('deepl', { OPENAI_API_KEY: 'sk-test' })).toThrow(/DEEPL_API_KEY/)
  })

  it('names OPENAI_API_KEY when the OpenAI key is missing', () => {
    expect(() => getDraftEngine('openai', {})).toThrow(/OPENAI_API_KEY/)
  })

  it('rejects a blank key', () => {
    expect(() => getDraftEngine('deepl', { DEEPL_API_KEY: '   ' })).toThrow(/DEEPL_API_KEY/)
  })

  it('rejects an unknown engine name', () => {
    expect(() => getDraftEngine('bing' as never, {})).toThrow(/unknown draft engine/i)
  })

  it('re-exports the factories', () => {
    expect(typeof createDeepLEngine).toBe('function')
    expect(typeof createOpenAIEngine).toBe('function')
  })

  it('forwards onWarning so lost placeholders reach the caller (deepl)', async () => {
    const warnings: string[] = []
    const engine = getDraftEngine(
      'deepl',
      { DEEPL_API_KEY: '0000:fx' },
      {
        onWarning: (m) => warnings.push(m),
        deeplClient: { translateText: async (texts) => texts.map(() => ({ text: 'Merhaba' })) },
      },
    )
    await engine.translate([{ key: 'Hi %s', msgid: 'Hi %s', comments: [], references: [] }], 'tr', 2)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/deepl: .*%s/)
  })

  it('builds the local engine without any secret', () => {
    // A runner on this machine has no key to check, and demanding one would
    // make the engine unreachable.
    const engine = getDraftEngine('qwen', {}, { ollama: { model: 'test-model' } })
    expect(engine.name).toBe('ollama:test-model')
  })

  it('names the configured model, so two models never share a cache row', () => {
    expect(getDraftEngine('qwen', {}, { ollama: { model: 'a' } }).name).not.toBe(
      getDraftEngine('qwen', {}, { ollama: { model: 'b' } }).name,
    )
  })

  it('forwards onWarning so lost placeholders reach the caller (openai)', async () => {
    const warnings: string[] = []
    const engine = getDraftEngine(
      'openai',
      { OPENAI_API_KEY: 'sk-test' },
      {
        onWarning: (m) => warnings.push(m),
        openaiClient: {
          chat: {
            completions: {
              create: async () => ({
                choices: [{ message: { content: JSON.stringify({ items: [{ id: 1, drafts: ['Merhaba'] }] }) }, finish_reason: 'stop' }],
              }),
            },
          },
        },
      },
    )
    await engine.translate([{ key: 'Hi %s', msgid: 'Hi %s', comments: [], references: [] }], 'tr', 2)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/openai: .*%s/)
  })
})

describe('typed errors', () => {
  it('are distinguishable Error subclasses carrying the engine name', () => {
    const q = new DraftQuotaError('deepl', 'quota gone')
    const r = new DraftRateLimitError('openai', 'slow down')
    expect(q).toBeInstanceOf(Error)
    expect(q).not.toBeInstanceOf(DraftRateLimitError)
    expect(r).not.toBeInstanceOf(DraftQuotaError)
    expect(q.name).toBe('DraftQuotaError')
    expect(r.name).toBe('DraftRateLimitError')
    expect(q.engine).toBe('deepl')
    expect(r.engine).toBe('openai')
    expect(q.message).toContain('quota gone')
  })

  it('keep the original error as cause', () => {
    const cause = new Error('raw')
    expect(new DraftQuotaError('deepl', 'x', cause).cause).toBe(cause)
  })

  it('index re-exports the same classes and helpers that live outside the engine modules', () => {
    expect(DraftQuotaError).toBe(ErrorsDraftQuotaError)
    expect(missingPlaceholders).toBe(placeholdersMissing)
  })
})

describe('missingPlaceholders', () => {
  it('reports source placeholders absent from the draft', () => {
    expect(missingPlaceholders('Hello %1$s, you have %2$d {things}', 'Merhaba %1$s')).toEqual(['%2$d', '{things}'])
  })

  // sprintf fills unnumbered placeholders in turn, so moving %d in front of %s
  // hands the number to %s and the string to %d. This used to pass.
  it('reports unnumbered placeholders of different kinds moved out of order', () => {
    expect(missingPlaceholders('%s of %d', '%d içinden %s')).toEqual(['%s', '%d'])
    expect(missingPlaceholders('%s of %d', '%2$d içinden %1$s')).toEqual([])
  })

  it('ignores literal percent signs and plain braces text', () => {
    expect(missingPlaceholders('100%% done { }', 'yüzde yüz')).toEqual([])
  })

  it('counts repeated placeholders', () => {
    expect(missingPlaceholders('%s and %s', 'sadece %s')).toEqual(['%s'])
  })

  it('detects printf width, precision and flag forms', () => {
    expect(missingPlaceholders("%.2f MB, %5d, %-10s, %'.2f, %1$.1f, %05d", 'x')).toEqual([
      '%.2f',
      '%5d',
      '%-10s',
      "%'.2f",
      '%1$.1f',
      '%05d',
    ])
    expect(missingPlaceholders('%.2f MB', '%.2f MB')).toEqual([])
  })

  it('treats ###TOKEN### markers as placeholders', () => {
    expect(missingPlaceholders('Go to ###SITE_URL### now', 'Şimdi git')).toEqual(['###SITE_URL###'])
    expect(missingPlaceholders('Go to ###SITE_URL###', '###SITE_URL### adresine git')).toEqual([])
  })
})

describe('warnMissingPlaceholders', () => {
  it('is a no-op without a callback and reports engine, key and placeholders with one', () => {
    expect(() => warnMissingPlaceholders('deepl', 'k', '%s', 'x')).not.toThrow()
    const seen: string[] = []
    warnMissingPlaceholders('openai', 'Hello %s', 'Hello %s', 'Merhaba', (m) => seen.push(m))
    expect(seen).toEqual(['openai: draft for "Hello %s" lost placeholder(s) %s'])
  })
})
