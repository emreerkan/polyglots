import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { syncGlossary } from '../../src/commands/glossary-sync.js'
import { importTmx } from '../../src/commands/tm-import.js'
import { translateFile } from '../../src/commands/translate.js'
import { writeMcpConfig } from '../../src/mcp/config.js'
import { dataDir, dbFile } from '../../src/paths.js'
import type { GlossaryEntry, TmMatch } from '../../src/types.js'
import { glossaryUrl } from '../../src/wporg/glossary.js'
import {
  callJson,
  connectMcp,
  fakeClaude,
  fakeEngine,
  glossaryCsv,
  makeWorkspace,
  snapshotEnv,
  writeTmx,
  type McpJson,
  type McpSession,
  type Workspace,
} from './helpers.js'

let ws: Workspace
let restoreEnv: () => void
let session: McpSession | undefined

beforeEach(async () => {
  restoreEnv = snapshotEnv()
  ws = await makeWorkspace()
})

afterEach(async () => {
  await session?.close()
  session = undefined
  restoreEnv()
  await ws.cleanup()
})

async function fixtureFetch(url: string): Promise<string> {
  if (!url.startsWith(glossaryUrl('tr'))) throw new Error(`unexpected url ${url}`)
  return readFile(glossaryCsv, 'utf8')
}

describe('E. the MCP server the review subprocess launches reads the same DB the commands write', () => {
  it('serves glossary_lookup and tm_lookup from data written by glossary sync and tm import', async () => {
    const synced = await syncGlossary({ locale: 'tr', fetch: fixtureFetch })
    expect(synced.entries).toBeGreaterThan(100)
    const tmxPath = await writeTmx(ws.home, 'poedit.tmx', [{ source: 'Save Changes', target: 'Değişiklikleri Kaydet' }])
    await importTmx([tmxPath], { locale: 'tr' })

    // As review writes it: the run's locale in the server's environment.
    const configPath = await writeMcpConfig({ env: { POLYGLOTS_LOCALE: 'tr' } })
    const { mcpServers } = JSON.parse(await readFile(configPath, 'utf8')) as McpJson
    expect(mcpServers.polyglots?.env.POLYGLOTS_HOME).toBe(ws.home)
    expect(dbFile()).toBe(join(ws.home, 'data', 'polyglots.db'))

    session = await connectMcp(configPath)
    const { tools } = await session.client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['consistency_lookup', 'glossary_lookup', 'tm_lookup'])

    const glossary = await callJson<GlossaryEntry[]>(session, 'glossary_lookup', { term: 'settings' })
    expect(glossary).toContainEqual({
      locale: 'tr',
      sourceTerm: 'sharing settings',
      translation: 'paylaşım ayarları',
      partOfSpeech: 'noun',
    })
    expect(glossary.every((e) => e.locale === 'tr' && /settings/i.test(e.sourceTerm))).toBe(true)

    const tm = await callJson<TmMatch[]>(session, 'tm_lookup', { text: 'Save Changes' })
    expect(tm).toEqual([{ source: 'Save Changes', target: 'Değişiklikleri Kaydet', locale: 'tr', score: 1 }])

    expect(await callJson<GlossaryEntry[]>(session, 'glossary_lookup', { term: 'settings', locale: 'de' })).toEqual([])
    expect(session.stderr()).toBe('')
  })

  it('sees writes that happen after the server started (no stale snapshot)', async () => {
    // As review writes it: the run's locale in the server's environment.
    const configPath = await writeMcpConfig({ env: { POLYGLOTS_LOCALE: 'tr' } })
    session = await connectMcp(configPath)
    expect(await callJson<GlossaryEntry[]>(session, 'glossary_lookup', { term: 'settings' })).toEqual([])

    await syncGlossary({ locale: 'tr', fetch: fixtureFetch })

    const glossary = await callJson<GlossaryEntry[]>(session, 'glossary_lookup', { term: 'sharing settings' })
    expect(glossary[0]).toMatchObject({ sourceTerm: 'sharing settings', translation: 'paylaşım ayarları' })
  })

  it('launches from the mcp.json translateFile hands to claude, with tool defaults following the run locale', async () => {
    const anyLocaleFetch = async (): Promise<string> => readFile(glossaryCsv, 'utf8')
    await syncGlossary({ locale: 'de', fetch: anyLocaleFetch })
    const argsOut = join(ws.home, 'claude-args.json')
    process.env.FAKE_CLAUDE_ARGS_OUT = argsOut

    const summary = await translateFile({
      file: ws.file,
      locale: 'de',
      mode: 'pending',
      draftEngine: 'deepl',
      engine: fakeEngine(),
      bin: fakeClaude,
      batchSize: 25,
    })
    expect(summary).toMatchObject({ translated: 7, skipped: 0 })

    const argv = JSON.parse(await readFile(argsOut, 'utf8')) as string[]
    const configPath = argv[argv.indexOf('--mcp-config') + 1]!
    expect(configPath).toBe(join(dataDir(), 'mcp.json'))
    const { mcpServers } = JSON.parse(await readFile(configPath, 'utf8')) as McpJson
    expect(mcpServers.polyglots?.env).toMatchObject({ POLYGLOTS_HOME: ws.home, POLYGLOTS_LOCALE: 'de' })

    session = await connectMcp(configPath)
    const byDefault = await callJson<GlossaryEntry[]>(session, 'glossary_lookup', { term: 'sharing settings' })
    expect(byDefault).toEqual([
      { locale: 'de', sourceTerm: 'sharing settings', translation: 'paylaşım ayarları', partOfSpeech: 'noun' },
    ])
    expect(await callJson<GlossaryEntry[]>(session, 'glossary_lookup', { term: 'sharing settings', locale: 'tr' })).toEqual([])
    expect(session.stderr()).toBe('')
  })
})
