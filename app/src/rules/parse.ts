import { LineCounter, parseDocument } from 'yaml'
import { localeRulesSchema, MAX_SCHEMA, normalise, type LocaleRules } from './schema.js'

// The half of reading a rules file that needs no Node: text in, rules or a
// positioned error out. Split from load.ts, which reads the disk and probes
// regexes in a worker thread, so the website's rules builder can bundle this
// for the browser and validate with the app's own parser. A copy of the
// schema on the site would drift the way the placeholder regex once did, and
// a builder that accepts what the app refuses hands people a broken file.

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

export interface ParsedRules {
  rules: LocaleRules
  // The line a dotted path into the file starts on, when the document has
  // that node: what the probe in load.ts uses to place its own error.
  lineOf: (path: (string | number)[]) => number | undefined
}

/**
 * Parses and validates a rules file's text.
 *
 * A syntax error carries the line and column yaml reports. A schema error is
 * placed on the line of the value it is about, when the document can resolve
 * that path, so "patterns.2.find is not a valid regular expression" points at
 * the line to fix rather than leaving the person to count list items.
 */
export function parseRulesDocument(text: string, path: string): ParsedRules {
  const lines = new LineCounter()
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false })
  const lineOf = (at: (string | number)[]) => {
    const range = (doc.getIn(at, true) as { range?: [number, number, number] } | undefined)?.range
    return range ? lines.linePos(range[0]).line : undefined
  }
  const syntax = doc.errors[0]
  if (syntax) {
    const at = lines.linePos(syntax.pos[0])
    throw new RulesFileError(path, syntax.message.split('\n')[0] ?? 'invalid YAML', at.line, at.col)
  }
  const js: unknown = doc.toJS() ?? {}
  const declared = typeof js === 'object' && js !== null && 'schema' in js ? (js as { schema: unknown }).schema : undefined
  if (declared !== undefined) {
    const line = lineOf(['schema'])
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
    const line = issue.path.length > 0 ? lineOf(issue.path as (string | number)[]) : undefined
    throw new RulesFileError(path, `${dotted ? `${dotted} ` : ''}${issue.message}`, line)
  }
  return { rules: normalise(parsed.data), lineOf }
}

/** The rules a file's text holds; throws a RulesFileError when it is not a valid rules file. */
export function parseRulesText(text: string, path: string): LocaleRules {
  return parseRulesDocument(text, path).rules
}
