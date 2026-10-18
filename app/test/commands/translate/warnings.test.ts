import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DraftEngine, DraftResult, Secrets } from '../../../src/types.js'
import type { GetDraftEngineOptions } from '../../../src/draft/index.js'
import { collect, draftFor, fakeReview, makeWorkspace, ofType, type Workspace } from './helpers.js'

const seen: { name: string; secrets: Secrets; options: GetDraftEngineOptions }[] = []

vi.mock('../../../src/draft/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/draft/index.js')>()
  return {
    ...actual,
    getDraftEngine: (name: 'deepl' | 'openai', secrets: Secrets, options: GetDraftEngineOptions = {}): DraftEngine => {
      seen.push({ name, secrets, options })
      return {
        name,
        async translate(units, _locale, nplurals): Promise<DraftResult[]> {
          options.onWarning?.(`${name}: draft for "Thank you for installing %s." lost placeholder(s) %s`)
          return units.map((u) => ({ key: u.key, drafts: draftFor(u, nplurals) }))
        },
      }
    },
  }
})

const { translateFile } = await import('../../../src/commands/translate.js')

let ws: Workspace

beforeEach(async () => {
  ws = await makeWorkspace()
})

afterEach(async () => {
  seen.length = 0
  delete process.env.OPENAI_API_KEY
  await ws.cleanup()
})

describe('translateFile: default engine and warnings', () => {
  it('builds the engine from secrets and forwards its warnings as events', async () => {
    const { events, onProgress } = collect()

    await translateFile({
      file: ws.file,
      locale: 'tr',
      mode: 'pending',
      draftEngine: 'openai',
      secrets: { OPENAI_API_KEY: 'sk-test' },
      review: fakeReview(),
      mcpConfigPath: join(ws.home, 'mcp.json'),
      batchSize: 25,
      onProgress,
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ name: 'openai', secrets: { OPENAI_API_KEY: 'sk-test' } })
    expect(ofType(events, 'warning')).toEqual([
      { type: 'warning', message: 'openai: draft for "Thank you for installing %s." lost placeholder(s) %s' },
    ])
    const order = events.map((e) => e.type)
    expect(order.indexOf('warning')).toBeGreaterThan(order.indexOf('batch-start'))
    expect(order.indexOf('warning')).toBeLessThan(order.indexOf('batch-done'))
  })

  it('writes the warning to the run log without the msgid it quotes', async () => {
    await translateFile({
      file: ws.file,
      locale: 'tr',
      mode: 'pending',
      draftEngine: 'openai',
      secrets: { OPENAI_API_KEY: 'sk-test' },
      review: fakeReview(),
      mcpConfigPath: join(ws.home, 'mcp.json'),
      batchSize: 25,
    })

    const logs = join(ws.home, 'data', 'logs')
    const [name] = readdirSync(logs).filter((n) => n.endsWith('.jsonl'))
    const text = readFileSync(join(logs, name!), 'utf8')
    expect(text.trim().split('\n').map((l) => JSON.parse(l).kind)).toContain('warning')
    expect(text).not.toContain('Thank you for installing')
  })

  it('loads secrets from the environment when none are injected', async () => {
    process.env.OPENAI_API_KEY = 'sk-from-env'

    await translateFile({
      file: ws.file,
      locale: 'tr',
      mode: 'pending',
      draftEngine: 'openai',
      review: fakeReview(),
      mcpConfigPath: join(ws.home, 'mcp.json'),
      batchSize: 25,
    })

    expect(seen[0]!.secrets.OPENAI_API_KEY).toBe('sk-from-env')
  })

  it('does not build an engine when nothing is left after the TM pass', async () => {
    const { saveSecret } = await import('../../../src/config.js')
    saveSecret('DEEPL_API_KEY', 'x')
    const { openDb, upsertTm } = await import('../../../src/storage/index.js')
    const { loadPo } = await import('../../../src/po/po-file.js')
    const po = await loadPo(ws.file)
    const db = openDb(join(ws.home, 'tm.db'))
    upsertTm(
      db,
      po.units('pending').flatMap((u) => [
        { source: u.msgid, target: `tm:${u.msgid}`, locale: 'tr', context: u.msgctxt },
        ...(u.msgidPlural ? [{ source: u.msgidPlural, target: `tm:${u.msgidPlural}`, locale: 'tr', context: u.msgctxt }] : []),
      ]),
    )

    const summary = await translateFile({
      file: ws.file,
      locale: 'tr',
      mode: 'pending',
      draftEngine: 'deepl',
      db,
      review: fakeReview(),
      mcpConfigPath: join(ws.home, 'mcp.json'),
      batchSize: 25,
    })
    db.close()

    expect(seen).toHaveLength(0)
    expect(summary).toMatchObject({ pending: 7, fromTm: 7, translated: 0 })
  })
})
