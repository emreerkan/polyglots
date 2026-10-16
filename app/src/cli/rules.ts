import { spawn } from 'node:child_process'
import { UsageError } from './args.js'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { renderDefaultRules, rulesHeader } from '../rules/defaults.js'
import { loadLocaleRules, localeRulesFile, parseLocaleRules, RulesFileError } from '../rules/load.js'
import { CAPITALIZATION_LIMIT, GUIDANCE_LIMIT, type LocaleRules, type PatternLevel } from '../rules/schema.js'
import { errorLine, okLine, hintLine } from '../ui/messages.js'
import { plainPainter, type Painter } from '../ui/paint.js'
import type { Locale } from '../types.js'

export type OpenEditor = (file: string) => Promise<void>

// $VISUAL, then $EDITOR, then vi, the order git and crontab use. Run through
// the shell so an editor configured with arguments ("code -w") works.
export const openInEditor: OpenEditor = (file) =>
  new Promise((resolve, reject) => {
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi'
    const child = spawn(`${editor} ${JSON.stringify(file)}`, { stdio: 'inherit', shell: true })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${editor} exited with ${code}`))))
  })

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * What a rules file sets, in counts rather than content: the answer to "does
 * this file read, and what will it do", for a person and for a script. The
 * shape is the JSON rules check --json prints, so a field added here is a
 * field every script reading that output sees.
 */
export type RulesReport =
  | {
      valid: true
      path: string
      schema: number
      rules?: { enable: string[]; disable: string[] }
      glossaryStemRatio?: number
      properNouns?: string[]
      mistakes: number
      patterns: { hint: number; error: number; fix: number }
      guidance: number
      capitalization: number
      register: boolean
      formality?: 'formal' | 'informal'
      sentenceEnd: boolean
    }
  // column only for a YAML syntax error, the one place the parser knows it.
  | { valid: false; path: string; error: string; line?: number; column?: number }

export const NO_SUCH_FILE = 'no such file'

/** The report for rules already parsed from `path`. */
export function summariseRules(rules: LocaleRules, path: string): RulesReport & { valid: true } {
  // Mistakes are hint patterns once normalised; counted apart, so the levels
  // describe only the patterns section and the two numbers add up to the list.
  const written = rules.patterns.filter((p) => p.kind === 'pattern')
  const count = (level: PatternLevel) => written.filter((p) => p.level === level).length
  return {
    valid: true,
    path,
    schema: rules.schema,
    ...(rules.rules === undefined ? {} : { rules: rules.rules }),
    ...(rules.glossaryStemRatio === undefined ? {} : { glossaryStemRatio: rules.glossaryStemRatio }),
    ...(rules.properNouns === undefined ? {} : { properNouns: Object.keys(rules.properNouns) }),
    mistakes: rules.patterns.length - written.length,
    patterns: { hint: count('hint'), error: count('error'), fix: count('fix') },
    guidance: rules.guidance?.length ?? 0,
    // Normalisation gives the text a final newline whichever block scalar
    // wrote it. Counted without it, so | and |- report the same number and a
    // file at the limit never reads as one character over.
    capitalization: rules.capitalization === undefined ? 0 : rules.capitalization.length - 1,
    register: rules.register !== undefined,
    ...(rules.formality === undefined ? {} : { formality: rules.formality }),
    sentenceEnd: rules.sentenceEnd !== undefined,
  }
}

/**
 * Reads and checks the rules file at `path`, any path: the locale's file in
 * the config folder, or one a locale team is about to publish. Needs no
 * config, so it works on a machine that has never run polyglots. Never
 * throws for a file that cannot be read or does not parse: either is a
 * report too.
 */
export function rulesReport(path: string): RulesReport {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    // Node's own message for EACCES already names the path, and the rendered
    // report puts the path first, so the line read it twice. The errno alone
    // is what the person needs beside a path they can see.
    const code = (error as NodeJS.ErrnoException).code
    return { valid: false, path, error: code === 'ENOENT' ? NO_SUCH_FILE : `cannot be read (${code ?? (error as Error).message})` }
  }
  try {
    return summariseRules(parseLocaleRules(text, path, { probe: true }), path)
  } catch (error) {
    if (!(error instanceof RulesFileError)) throw error
    return {
      valid: false,
      path,
      error: error.reason,
      ...(error.line === undefined ? {} : { line: error.line }),
      ...(error.col === undefined ? {} : { column: error.col }),
    }
  }
}

/** The person-facing account of a report. An invalid one is a single error line, meant for stderr. */
export function renderRulesReport(report: RulesReport, p: Painter = plainPainter): string[] {
  if (!report.valid) {
    const at = report.line === undefined ? '' : `:${report.line}${report.column === undefined ? '' : `:${report.column}`}`
    return [errorLine(p, `${report.path}${at} ${report.error}`)]
  }
  const { hint, error, fix } = report.patterns
  const levels = (
    [
      ['hint', hint],
      ['error', error],
      ['fix', fix],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([level, n]) => `${n} ${level}`)
  const patterns = hint + error + fix
  return [
    okLine(p, `${report.path} is valid.`),
    `  schema: ${report.schema}`,
    report.rules
      ? `  rules: ${plural(report.rules.enable.length, 'enabled extra')}, ${plural(report.rules.disable.length, 'disabled', 'disabled')}`
      : '  rules: built-in',
    ...(report.glossaryStemRatio === undefined ? [] : [`  glossaryStemRatio: ${report.glossaryStemRatio}`]),
    ...(report.properNouns ? [`  properNouns: ${report.properNouns.join(', ')} replaced`] : []),
    `  ${plural(report.mistakes, 'mistake')}, ${plural(patterns, 'pattern')}${levels.length ? ` (${levels.join(', ')})` : ''}`,
    `  guidance: ${report.guidance ? `${report.guidance} of ${GUIDANCE_LIMIT} characters` : 'none'}`,
    `  capitalization: ${report.capitalization ? `${report.capitalization} of ${CAPITALIZATION_LIMIT} characters` : 'none'}`,
    // "default" rather than "none": without the key the prompts still carry
    // the neutral register line, so something is in force either way.
    `  register: ${report.register ? 'set' : 'default'}`,
    ...(report.formality === undefined ? [] : [`  formality: ${report.formality}`]),
    ...(report.sentenceEnd ? ['  sentenceEnd: set'] : []),
  ]
}

// Without a file there is nothing language-specific at all: polyglots ships
// no locale's rules, so "the built-in defaults" would promise more than the
// universal checks. Fetching the team's file is the usual way out; writing
// one is for a locale whose team has published none.
export function noRulesFileLines(locale: Locale, p: Painter = plainPainter): string[] {
  return [
    `No rules file for ${locale}; only the universal checks run.`,
    hintLine(p, `Fetch your locale team's file with: polyglots rules fetch ${locale}`),
    hintLine(p, `Or write one with: polyglots rules edit ${locale}`),
  ]
}

/** A short account of what a locale's rules file sets. Throws RulesFileError. */
export function describeRules(locale: Locale, p: Painter = plainPainter): string[] {
  const rules = loadLocaleRules(locale)
  if (!rules) return noRulesFileLines(locale, p)
  return renderRulesReport(summariseRules(rules, localeRulesFile(locale)), p)
}

/**
 * The template lines that describe the locale a file was written for, made to
 * describe `to` instead: the header and the command that checks the file.
 * Renaming only the header left a copy from Swedish telling the Danish team
 * how to check the Swedish file.
 *
 * Only lines exactly as renderDefaultRules wrote them for `from` are touched,
 * and only in a file whose first line is the generated header. Anything the
 * team has reworded is theirs and stays verbatim, the commented examples
 * included.
 */
function retarget(text: string, from: Locale, to: Locale): string {
  const [first = '', ...rest] = text.split('\n')
  if (!first.startsWith('# polyglots rules for ')) return text
  const check = `# Check the file with: polyglots rules check ${from}`
  const lines = rest.map((line) => (line === check ? `# Check the file with: polyglots rules check ${to}` : line))
  return [rulesHeader(to), ...lines].join('\n')
}

/**
 * Duplicates one locale's rules file as another's: nl_NL to nl_BE, de_DE to
 * de_DE_formal. Duplication, not inheritance: the copy is its own file from
 * then on, and a later edit to either touches only that one.
 *
 * Verbatim, comments included, except a header line naming the source locale,
 * which is renamed. The source must be valid, since copying a broken file
 * makes two; an existing target is kept unless `force`.
 */
export async function copyRules(from: Locale, to: Locale, force = false, p: Painter = plainPainter): Promise<string[]> {
  const source = localeRulesFile(from)
  if (!existsSync(source)) throw new UsageError(`No rules file for ${from} to copy (${source})`)
  loadLocaleRules(from)
  const target = localeRulesFile(to)
  if (existsSync(target) && !force) {
    throw new UsageError(`${target} already exists; pass --force to replace it`)
  }
  const text = await readFile(source, 'utf8')
  const renamed = retarget(text, from, to)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, renamed, 'utf8')
  return [okLine(p, `Copied ${from} to ${to}.`), ...describeRules(to, p)]
}

/**
 * Opens the locale's rules file in the editor, writing the commented defaults
 * first when there is none, and checks it once the editor closes. An existing
 * file is never overwritten.
 */
export async function editRules(locale: Locale, openEditor: OpenEditor, p: Painter = plainPainter): Promise<string[]> {
  const file = localeRulesFile(locale)
  if (!existsSync(file)) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, renderDefaultRules(locale), 'utf8')
  }
  await openEditor(file)
  return describeRules(locale, p)
}
