import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse as parseDotenv } from 'dotenv'
import { z } from 'zod'
import { configFile, secretsFile } from './paths.js'
import { DEFAULT_QWEN_BASE_URL, DEFAULT_QWEN_MODEL } from './draft/qwen.js'
import { DEFAULT_LOCAL_IDLE_TIMEOUT_SECONDS } from './draft/local-chat.js'
import type { PolyglotsConfig, Secrets } from './types.js'

// LM Studio's port: the most common OpenAI-compatible server on a desktop, and
// the one whose documentation people will have open. llama.cpp's 8080 is the
// other default discovery probes.
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'http://localhost:1234'

// No defaultLocale: there is no locale that is a safe guess for a stranger.
// Through 0.25 this said tr, and a German translator's first review ran Turkish
// rules over German text without a word. A command that needs a locale and
// is given none now refuses and says how to set one (src/cli/locale.ts).
export const DEFAULT_CONFIG: PolyglotsConfig = {
  defaultDraftEngine: 'deepl',
  reviewProvider: 'claude',
  wporgUsername: '',
  ollama: { baseUrl: DEFAULT_QWEN_BASE_URL, model: DEFAULT_QWEN_MODEL },
  batchSize: 25,
  consistencyTtlDays: 30,
  properNouns: {},
  localModelServers: [],
  localServerKind: 'ollama',
  openaiCompatible: { baseUrl: DEFAULT_OPENAI_COMPATIBLE_BASE_URL, model: '' },
  localIdleTimeout: DEFAULT_LOCAL_IDLE_TIMEOUT_SECONDS,
}

/**
 * Whether `value` is an http or https URL.
 *
 * Narrower than a URL parse on purpose: `box:11434` parses, as a URL whose
 * scheme is `box:`, and would then be probed as nothing at all. A server list
 * typed by hand is where that mistake gets made.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host !== ''
  } catch {
    return false
  }
}

// Optional, so a config from before it existed parses unchanged. Positive and
// whole, because Ollama is sent it as num_ctx and anything else is a typo.
const contextLength = z.number().int().positive().optional()

const configSchema = z.object({
  // Optional, so a config with no locale parses: a fresh install, and every
  // install that relied on the old implicit tr. Empty is still refused.
  defaultLocale: z.string().min(1).optional(),
  // `qwen` is read as `local`, the name it has had since 0.23, so a saved
  // config keeps drafting with the same engine. Normalised on read rather than
  // kept as typed, so the next save writes the new name and nothing after this
  // has to know the old one. The cost: a downgrade after that save rejects the
  // file, which the changelog says.
  defaultDraftEngine: z
    .enum(['deepl', 'openai', 'local', 'none', 'qwen'])
    .transform((engine) => (engine === 'qwen' ? 'local' : engine)),
  // Defaulted rather than required, so a config written before there was a
  // second provider still parses, and keeps the provider its verdicts were
  // formed under. `local` is the experimental local reviewer, which only an
  // explicit `config set reviewProvider local` writes. `none` is rules only,
  // with no AI at all.
  reviewProvider: z.enum(['claude', 'antigravity', 'local', 'none']).default('claude'),
  // Defaulted rather than required, so a config written before the requester
  // message had a link still parses. Trimmed, because a stray space would be
  // pasted straight into a URL.
  wporgUsername: z
    .string()
    .trim()
    .default('')
    // A wp.org login is letters, digits, hyphens and underscores. Anything else
    // is a mistake this must not weld into a public link.
    .refine((v) => v === '' || /^[A-Za-z0-9_-]+$/.test(v), {
      message: 'wporgUsername may only hold letters, digits, hyphens and underscores',
    }),
  // Defaulted rather than required, so a config written before the local
  // engine existed still parses.
  ollama: z
    .object({ baseUrl: z.string().min(1), model: z.string().min(1), contextLength })
    .default({ baseUrl: DEFAULT_QWEN_BASE_URL, model: DEFAULT_QWEN_MODEL }),
  batchSize: z.number().int().positive(),
  consistencyTtlDays: z.number().int().nonnegative(),
  properNouns: z.record(z.string(), z.array(z.string())),
  // Defaulted rather than required, so a config written before discovery
  // existed still parses.
  localModelServers: z
    .array(z.string().refine(isHttpUrl, { message: 'must be an http or https URL' }))
    .default([]),
  // Defaulted, so a config from before there was a second kind of local server
  // keeps using Ollama, and every cached draft keeps its engine id.
  localServerKind: z.enum(['ollama', 'openai-compatible']).default('ollama'),
  // The model may be empty: there is no default an arbitrary server holds, and
  // a run with this kind refuses an empty one before it starts.
  openaiCompatible: z
    .object({
      baseUrl: z.string().refine(isHttpUrl, { message: 'must be an http or https URL' }),
      model: z.string(),
      contextLength,
    })
    .default({ baseUrl: DEFAULT_OPENAI_COMPATIBLE_BASE_URL, model: '' }),
  // Defaulted, so a config from before the limit existed parses. Whole
  // seconds and positive: zero would abandon every reply before it began.
  // Capped where setTimeout's 32-bit delay would overflow, which makes it fire
  // at once and abandon every reply.
  localIdleTimeout: z.number().int().positive().max(2_147_483).default(DEFAULT_LOCAL_IDLE_TIMEOUT_SECONDS),
  // Optional and never defaulted: absent means the question was never
  // answered, which the wizard needs to tell apart from an answered no.
  // Either way nothing is sent unless it is true (src/usage).
  usageStats: z.boolean().optional(),
  // Optional and absent means on: the update check is the default, and
  // writing it into every config would make an untouched one look set.
  updateCheck: z.boolean().optional(),
})

const SECRET_KEYS: ReadonlyArray<keyof Secrets> = ['DEEPL_API_KEY', 'OPENAI_API_KEY']

function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, content, { mode: 0o600 })
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
  chmodSync(path, 0o600)
}

function readConfigFile(): Record<string, unknown> {
  const path = configFile()
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid JSON in config file ${path}: ${detail}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config file ${path} must contain a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function validate(candidate: Record<string, unknown>): PolyglotsConfig {
  const result = configSchema.safeParse(candidate)
  if (result.success) return result.data
  const issues = result.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
  throw new Error(`Invalid config in ${configFile()}: ${issues}`)
}

export function loadConfig(): PolyglotsConfig {
  return validate({ ...DEFAULT_CONFIG, ...readConfigFile() })
}

/**
 * Removes a key from config.json, for a setting whose absence means
 * something: no defaultLocale lets each file's Language header decide.
 */
export function unsetConfig(key: 'defaultLocale'): PolyglotsConfig {
  const { [key]: _gone, ...rest } = readConfigFile()
  const merged = validate({ ...DEFAULT_CONFIG, ...rest })
  writePrivate(configFile(), JSON.stringify(rest, null, 2) + '\n')
  return merged
}

export function saveConfig(patch: Partial<PolyglotsConfig>): PolyglotsConfig {
  const fromFile = readConfigFile()
  const merged = validate({ ...DEFAULT_CONFIG, ...fromFile, ...patch })
  writePrivate(configFile(), JSON.stringify({ ...fromFile, ...merged }, null, 2) + '\n')
  return merged
}

function readSecretsFile(): Record<string, string> {
  const path = secretsFile()
  if (!existsSync(path)) return {}
  return parseDotenv(readFileSync(path, 'utf8'))
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined
}

export function loadSecrets(): Secrets {
  const fromFile = readSecretsFile()
  const secrets: Secrets = {}
  for (const key of SECRET_KEYS) {
    secrets[key] = nonEmpty(process.env[key]) ?? nonEmpty(fromFile[key])
  }
  return secrets
}

function formatDotenvValue(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Secret value cannot contain control characters such as newlines')
  }
  if (!/[\s#"'`]/.test(value)) return value
  // dotenv strips wrapping quotes but does not unescape, so pick a quote the value lacks.
  // Double quotes come last because dotenv expands \n and \r inside them.
  for (const quote of ["'", '`']) {
    if (!value.includes(quote)) return `${quote}${value}${quote}`
  }
  if (value.includes('"')) {
    throw new Error('Secret value cannot contain single, double and backtick quotes at once')
  }
  if (/\\[nr]/.test(value)) {
    throw new Error('Secret value cannot contain a backslash-n or backslash-r escape together with both single and backtick quotes')
  }
  return `"${value}"`
}

export function saveSecret(name: keyof Secrets, value: string): void {
  const path = secretsFile()
  const line = `${name}=${formatDotenvValue(value)}`
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const keyPattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*[=:]`)

  const lines = existing.length > 0 ? existing.split(/\r?\n/) : []
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  // dotenv is last-wins, so later duplicates must go or they would shadow the new value.
  let replaced = false
  const next = lines.flatMap((current) => {
    if (!keyPattern.test(current)) return [current]
    if (replaced) return []
    replaced = true
    return [line]
  })
  if (!replaced) next.push(line)

  writePrivate(path, next.join('\n') + '\n')
}

export function maskSecret(value?: string): string {
  if (!value) return '(not set)'
  if (value.length < 12) return '••••'
  return `${value.slice(0, 4)}…${value.slice(-2)}`
}
