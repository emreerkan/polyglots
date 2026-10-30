import { existsSync, globSync, statSync } from 'node:fs'
import { resolveLocale, suggestLocales } from '../wporg/locales.js'
import { resolve } from 'node:path'
import type { CsvDelimiter } from '../commands/glossary-export.js'
import { isReviewProvider, PROVIDERS } from '../agent/providers.js'
import { normalizeDraftEngine } from '../draft/index.js'
import type { DraftEngineChoice, Locale, ReviewChoice, Secrets } from '../types.js'

export class UsageError extends Error {
  readonly exitCode = 2
}

const GLOB_MAGIC = /[*?[\]{}]/

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function expandFileArgs(patterns: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (file: string) => {
    const key = resolve(file)
    if (seen.has(key)) return
    seen.add(key)
    out.push(file)
  }

  for (const pattern of patterns) {
    if (existsSync(pattern)) {
      if (!isFile(pattern)) throw new UsageError(`Not a file: ${pattern}`)
      push(pattern)
      continue
    }
    if (!GLOB_MAGIC.test(pattern)) throw new UsageError(`File not found: ${pattern}`)
    const matches = globSync(pattern).filter(isFile).sort()
    if (matches.length === 0) throw new UsageError(`No files match "${pattern}"`)
    for (const match of matches) push(match)
  }
  return out
}

/**
 * The files among the arguments that were written out by name rather than
 * found by a glob, resolved as expandFileArgs resolves them, so a caller can
 * tell the two apart in its output. A path that exists is a name even when it
 * holds glob characters, the same rule expandFileArgs follows.
 */
export function namedFiles(patterns: string[]): Set<string> {
  return new Set(patterns.filter((pattern) => existsSync(pattern) && isFile(pattern)).map((pattern) => resolve(pattern)))
}

export function parsePositiveInt(flag: string, raw: string): number {
  const value = Number(raw)
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(value) || value <= 0) {
    throw new UsageError(`${flag} must be a positive integer, got "${raw}"`)
  }
  return value
}

// Whatever a translator types (nl_NL_formal, nl-be, nl/formal) becomes the id
// polyglots uses: the wp.org slug, plus the translation set when it is not the
// default. The mapping is wp.org's own table, shipped with the build, because
// it cannot be computed: nl_NL is "nl" while nl_BE is "nl-be".
export function parseLocaleArg(raw: string): Locale {
  if (raw.trim() === '') throw new UsageError('--locale must not be empty')
  const resolved = resolveLocale(raw)
  if (resolved) return resolved.id
  const near = suggestLocales(raw)
  throw new UsageError(
    `Locale "${raw.trim()}" is not listed on translate.wordpress.org` + (near.length ? `; did you mean ${near.join(', ')}?` : ''),
  )
}

const SECRET_NAMES: ReadonlyArray<keyof Secrets> = ['DEEPL_API_KEY', 'OPENAI_API_KEY']

export function isSecretName(name: string): name is keyof Secrets {
  return (SECRET_NAMES as readonly string[]).includes(name)
}

export function parseSecretName(raw: string): keyof Secrets {
  if (isSecretName(raw)) return raw
  throw new UsageError(`Unknown key "${raw}"; expected one of ${SECRET_NAMES.join(', ')}`)
}

export const DRAFT_ENGINES: readonly DraftEngineChoice[] = ['deepl', 'openai', 'local', 'none']

export type { DraftEngineChoice }

// `qwen` is still accepted, as what `local` was called until 0.23: scripts and
// shell history have it, and refusing it would break them for a rename.
export function parseDraftEngine(raw: string): DraftEngineChoice {
  const engine = normalizeDraftEngine(raw)
  if (engine) return engine
  throw new UsageError(`--draft-engine must be one of ${DRAFT_ENGINES.join(', ')}, got "${raw}"`)
}

// Named for the setting rather than a flag: there is no --review-provider, so
// the only way in is `polyglots config set reviewProvider`, or the menu. The
// menu never offers `local`, which makes this the one door to it.
export function parseReviewProvider(raw: string): ReviewChoice {
  if (isReviewProvider(raw) || raw === 'local' || raw === 'none') return raw
  throw new UsageError(
    `reviewProvider must be one of ${PROVIDERS.join(', ')}, local (experimental) or none (rules only, no AI), got "${raw}"`,
  )
}

export function parseCsvDelimiter(raw: string): CsvDelimiter {
  if (raw === ';' || raw === ',') return raw
  throw new UsageError(`--delimiter must be ";" or ",", got "${raw}"`)
}

// `local` and `none` map to nothing: a local runner needs no secret, and mapping it to
// one would make the precheck demand a key that can never exist.
const ENGINE_SECRET: Record<DraftEngineChoice, keyof Secrets | undefined> = {
  deepl: 'DEEPL_API_KEY',
  openai: 'OPENAI_API_KEY',
  local: undefined,
  none: undefined,
}

export function secretForEngine(engine: DraftEngineChoice): keyof Secrets | undefined {
  return ENGINE_SECRET[engine]
}
