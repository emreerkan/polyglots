import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { po } from 'gettext-parser'
import type { GetTextTranslation, GetTextTranslations } from 'gettext-parser'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { TranslateEvent } from '../../src/commands/translate.js'
import type { DraftEngine, DraftResult, TranslationUnit } from '../../src/types.js'

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))

export const samplePo = here('../fixtures/po/sample.po')
export const hooksPo = here('../fixtures/integration/hooks.po')
export const fakeClaude = here('../fixtures/fake-claude/claude')
export const glossaryCsv = here('../fixtures/wporg/glossary-tr.csv')
export const cliEntry = here('../../src/cli.ts')
export const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')

export const CTX = '\x04'

export const SAMPLE_PENDING_KEYS = [
  'Save Changes',
  'Form entries',
  `post type singular name${CTX}Form`,
  'One submission was deleted.',
  'Thank you for installing %s.',
  'Drag fields from the left panel onto the canvas to build your form. You can reorder fields at any time.',
  'You have %1$s new entries. <a href="%2$s">View them</a>.',
]

export const SAMPLE_TRANSLATED_KEYS = [
  'Settings',
  `post type general name${CTX}Forms`,
  '%d entry',
  'Powered by Sample Forms',
  'Your message has been sent.',
]

export interface Workspace {
  home: string
  file: string
  original: Buffer
  cleanup(): Promise<void>
}

export async function makeWorkspace(fixture: string = samplePo): Promise<Workspace> {
  const home = await mkdtemp(join(tmpdir(), 'polyglots-integration-'))
  const file = join(home, 'work.po')
  await copyFile(fixture, file)
  process.env.POLYGLOTS_HOME = home
  return {
    home,
    file,
    original: await readFile(file),
    cleanup: async () => {
      await rm(home, { recursive: true, force: true })
    },
  }
}

export function snapshotEnv(): () => void {
  const saved = { ...process.env }
  return () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
}

export async function parseFile(path: string): Promise<GetTextTranslations> {
  return po.parse(await readFile(path))
}

export function entryOf(parsed: GetTextTranslations, key: string): GetTextTranslation {
  const at = key.indexOf(CTX)
  const ctx = at === -1 ? '' : key.slice(0, at)
  const msgid = at === -1 ? key : key.slice(at + 1)
  const entry = parsed.translations[ctx]?.[msgid]
  if (!entry) throw new Error(`entry not found: ${JSON.stringify(key)}`)
  return entry
}

export function blocks(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
}

export function blockFor(text: string, key: string): string {
  const at = key.indexOf(CTX)
  const msgid = at === -1 ? key : key.slice(at + 1)
  const ctx = at === -1 ? undefined : key.slice(0, at)
  const needle = `msgid ${JSON.stringify(msgid)}`
  const hit = blocks(text).find((b) => b.includes(needle) && (ctx === undefined || b.includes(`msgctxt ${JSON.stringify(ctx)}`)))
  if (!hit) throw new Error(`block not found for ${JSON.stringify(key)}`)
  return hit
}

export function tmx(pairs: { source: string; target: string }[]): string {
  const tus = pairs
    .map(
      (p) => `    <tu>
      <tuv xml:lang="en"><seg>${escapeXml(p.source)}</seg></tuv>
      <tuv xml:lang="tr"><seg>${escapeXml(p.target)}</seg></tuv>
    </tu>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<tmx version="1.4">
  <header creationtool="Poedit" srclang="en" segtype="sentence" o-tmf="PoeditTM" adminlang="en" datatype="plaintext"/>
  <body>
${tus}
  </body>
</tmx>
`
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export async function writeTmx(dir: string, name: string, pairs: { source: string; target: string }[]): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, tmx(pairs), 'utf8')
  return path
}

export interface FakeEngine extends DraftEngine {
  calls: string[][]
  failWith?: (callIndex: number, units: TranslationUnit[]) => Error | undefined
  seenKeys(): string[]
}

export function fakeEngine(): FakeEngine {
  const engine: FakeEngine = {
    name: 'deepl',
    calls: [],
    seenKeys: () => engine.calls.flat(),
    async translate(units, _locale, nplurals): Promise<DraftResult[]> {
      const index = engine.calls.length
      engine.calls.push(units.map((u) => u.key))
      const err = engine.failWith?.(index, units)
      if (err) throw err
      return units.map((u) => ({
        key: u.key,
        drafts:
          u.msgidPlural === undefined
            ? [`[draft] ${u.msgid}`]
            : Array.from({ length: nplurals }, (_, i) => `[draft] ${i === 0 ? u.msgid : u.msgidPlural}`),
      }))
    },
  }
  return engine
}

export function collect(): { events: TranslateEvent[]; onProgress: (e: TranslateEvent) => void } {
  const events: TranslateEvent[] = []
  return { events, onProgress: (e) => events.push(e) }
}

export function ofType<T extends TranslateEvent['type']>(
  events: TranslateEvent[],
  type: T,
): Extract<TranslateEvent, { type: T }>[] {
  return events.filter((e): e is Extract<TranslateEvent, { type: T }> => e.type === type)
}

export interface McpJson {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
}

export interface McpSession {
  client: Client
  pid: number
  stderr(): string
  close(): Promise<void>
}

export async function connectMcp(configPath: string): Promise<McpSession> {
  const { mcpServers } = JSON.parse(await readFile(configPath, 'utf8')) as McpJson
  const entry = mcpServers.polyglots
  if (!entry) throw new Error('mcp.json has no polyglots server entry')
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    env: { ...(process.env as Record<string, string>), ...entry.env },
    stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  const client = new Client({ name: 'integration', version: '0.0.0' })
  await client.connect(transport)
  const pid = transport.pid
  if (pid === null) throw new Error('mcp server did not start')
  return {
    client,
    pid,
    stderr: () => stderr,
    close: async () => {
      await client.close().catch(() => undefined)
      const exited = await waitForExit(pid, 3000)
      if (!exited) process.kill(pid, 'SIGKILL')
    },
  }
}

export async function callJson<T>(session: McpSession, name: string, args: Record<string, unknown>): Promise<T> {
  const result = (await session.client.callTool({ name, arguments: args })) as {
    isError?: boolean
    content: { type: string; text?: string }[]
  }
  const text = result.content[0]?.text ?? ''
  if (result.isError) throw new Error(`tool ${name} failed: ${text}`)
  return JSON.parse(text) as T
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !pidAlive(pid)
}
