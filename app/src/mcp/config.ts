import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataDir } from '../paths.js'
import { normalizeLocale } from '../tmx/parse.js'
import type { Locale, PolyglotsConfig } from '../types.js'

export interface McpConfigOptions {
  dir?: string
  locale?: Locale
  env?: Record<string, string>
}

export interface McpServerEntry {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface McpServerOptions {
  // Absent when neither POLYGLOTS_LOCALE nor config names one. The server
  // starts anyway and refuses only the calls that do not name a locale.
  locale?: Locale
  ttlDays: number
  dbPath: string | undefined
}

export const MCP_ENV = {
  home: 'POLYGLOTS_HOME',
  db: 'POLYGLOTS_DB',
  locale: 'POLYGLOTS_LOCALE',
  ttlDays: 'POLYGLOTS_CONSISTENCY_TTL_DAYS',
} as const

export function serverLaunch(here = fileURLToPath(import.meta.url)): Pick<McpServerEntry, 'command' | 'args'> {
  const isTs = here.endsWith('.ts')
  const entry = resolve(dirname(here), isTs ? 'server.ts' : 'server.js')
  if (!isTs) return { command: process.execPath, args: [entry] }
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')
  return { command: process.execPath, args: [tsxCli, entry] }
}

export function resolveServerOptions(env: NodeJS.ProcessEnv, config: PolyglotsConfig): McpServerOptions {
  const locale = env[MCP_ENV.locale]?.trim()
  const ttl = Number(env[MCP_ENV.ttlDays]?.trim() || NaN)
  const dbPath = env[MCP_ENV.db]?.trim()
  const chosen = locale || config.defaultLocale
  return {
    ...(chosen ? { locale: normalizeLocale(chosen) } : {}),
    ttlDays: Number.isInteger(ttl) && ttl > 0 ? ttl : config.consistencyTtlDays,
    dbPath: dbPath || undefined,
  }
}

// mcp.json is owner-only because opts.env is copied verbatim. env must still
// never hold a secret: codex takes the server as -c overrides
// (mcp_servers.polyglots.env.*, see codexMcpArgs), so every value here ends up
// on its command line, readable by anyone on the machine through ps.
export async function writeMcpConfig(opts: McpConfigOptions = {}): Promise<string> {
  const dir = resolve(opts.dir ?? dataDir())
  await mkdir(dir, { recursive: true })
  const env: Record<string, string> = {}
  const home = process.env[MCP_ENV.home]
  if (home) env[MCP_ENV.home] = resolve(home)
  if (opts.locale) env[MCP_ENV.locale] = normalizeLocale(opts.locale)
  Object.assign(env, opts.env)
  const polyglots: McpServerEntry = { ...serverLaunch(), env }
  const path = join(dir, 'mcp.json')
  await writeFile(path, JSON.stringify({ mcpServers: { polyglots } }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await chmod(path, 0o600)
  return path
}
