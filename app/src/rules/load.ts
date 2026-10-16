import { readFileSync, statSync } from 'node:fs'
import { localeFileTag, wpCodeOf } from '../wporg/locales.js'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { LineCounter, parseDocument } from 'yaml'
import { configDir } from '../paths.js'
import type { Locale } from '../types.js'
import { localeRulesSchema, MAX_SCHEMA, normalise, type LocaleRules } from './schema.js'

export class RulesFileError extends Error {
  readonly path: string
  readonly line: number | undefined
  readonly col: number | undefined
  // The message without the path and position in front of it, for a caller
  // that reports those in fields of their own (rules check --json).
  readonly reason: string

  constructor(path: string, message: string, line?: number, col?: number) {
    super(`${path}${line === undefined ? '' : `:${line}${col === undefined ? '' : `:${col}`}`} ${message}`)
    this.name = 'RulesFileError'
    this.path = path
    this.line = line
    this.col = col
    this.reason = message
  }
}

// Named by the WordPress code (tr_TR.yaml, nl_NL_formal.yaml): the name
// translators recognise, and always a valid file name, which nl/formal is not.
// A locale missing from the wp.org table falls back to its id, slash replaced.
export function localeRulesFile(locale: Locale): string {
  return join(configDir(), 'locales', `${wpCodeOf(locale) ?? localeFileTag(locale)}.yaml`)
}

/**
 * Parses and validates a rules file's text.
 *
 * A syntax error carries the line and column yaml reports. A schema error is
 * placed on the line of the value it is about, when the document can resolve
 * that path, so "patterns.2.find is not a valid regular expression" points at
 * the line to fix rather than leaving the person to count list items.
 */
export function parseLocaleRules(text: string, path: string): LocaleRules {
  const lines = new LineCounter()
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false })
  const syntax = doc.errors[0]
  if (syntax) {
    const at = lines.linePos(syntax.pos[0])
    throw new RulesFileError(path, syntax.message.split('\n')[0] ?? 'invalid YAML', at.line, at.col)
  }
  const js: unknown = doc.toJS() ?? {}
  const declared = typeof js === 'object' && js !== null && 'schema' in js ? (js as { schema: unknown }).schema : undefined
  if (declared !== undefined) {
    const node = doc.get('schema', true) as { range?: [number, number, number] } | undefined
    const line = node?.range ? lines.linePos(node.range[0]).line : undefined
    const whole = typeof declared === 'number' && Number.isInteger(declared)
    // Checked before the shape: a newer file may use keys this polyglots has
    // never heard of, and "update polyglots" is the useful answer, not the
    // first unknown key it happens to reach.
    if (whole && declared > MAX_SCHEMA) {
      throw new RulesFileError(path, `needs rules schema ${declared}; this polyglots reads up to ${MAX_SCHEMA}. Update polyglots.`, line)
    }
    if (!whole || declared < 1) {
      throw new RulesFileError(path, `schema must be a whole number from 1 to ${MAX_SCHEMA}`, line)
    }
  }
  const parsed = localeRulesSchema.safeParse(js)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    const dotted = issue.path.join('.')
    const node = issue.path.length > 0 ? doc.getIn(issue.path, true) : undefined
    const range = (node as { range?: [number, number, number] } | undefined)?.range
    const line = range ? lines.linePos(range[0]).line : undefined
    throw new RulesFileError(path, `${dotted ? `${dotted} ` : ''}${issue.message}`, line)
  }
  return normalise(parsed.data)
}

// Keyed by path and modification time, so a file edited between two runs of
// one menu session applies to the second run without a restart, and an
// unchanged file is not re-read for every entry the rules look at.
const cache = new Map<string, { mtimeMs: number; rules: LocaleRules }>()

/** The locale's rules file, or undefined when there is none. Throws on an invalid file. */
export function loadLocaleRules(locale: Locale): LocaleRules | undefined {
  const path = localeRulesFile(locale)
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    cache.delete(path)
    return undefined
  }
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === mtimeMs) return hit.rules
  const rules = parseLocaleRules(readFileSync(path, 'utf8'), path)
  cache.set(path, { mtimeMs, rules })
  return rules
}

const isEmpty = (r: LocaleRules) =>
  r.rules === undefined &&
  r.glossaryStemRatio === undefined &&
  r.properNouns === undefined &&
  r.patterns.length === 0 &&
  r.guidance === undefined &&
  r.capitalization === undefined &&
  r.register === undefined &&
  r.formality === undefined &&
  r.sentenceEnd === undefined

/**
 * A stable fingerprint of a locale's rules, for the review fingerprint and so
 * for configHash. Empty when there is no file, which keeps every existing
 * cache key exactly as it was for anyone who never writes one.
 */
export function rulesFingerprint(rules: LocaleRules | undefined): string {
  // A file that sets nothing is no file. The defaults rules edit writes are
  // commented out, and opening the editor must not re-review anything.
  if (!rules || isEmpty(rules)) return ''
  // The schema number is left out: it says which keys the file may use, not
  // what the rules are, so adding schema: 2 to a file changes no cache key.
  // Stripping it also keeps the hash of every schema-1 file exactly what it
  // was before the field existed.
  const { schema: _schema, ...meaning } = rules
  return createHash('sha256').update(JSON.stringify(meaning)).digest('hex')
}
