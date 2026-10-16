import { spawn } from 'node:child_process'
import { UsageError } from './args.js'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { renderDefaultRules, rulesHeader } from '../rules/defaults.js'
import { loadLocaleRules, localeRulesFile } from '../rules/load.js'
import { GUIDANCE_LIMIT } from '../rules/schema.js'
import { okLine, hintLine } from '../ui/messages.js'
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

/** A short account of what a locale's rules file sets. Throws RulesFileError. */
export function describeRules(locale: Locale, p: Painter = plainPainter): string[] {
  const file = localeRulesFile(locale)
  const rules = loadLocaleRules(locale)
  // Without a file there is nothing language-specific at all: polyglots ships
  // no locale's rules, so "the built-in defaults" would promise more than the
  // universal checks. Fetching the team's file is the usual way out; writing
  // one is for a locale whose team has published none.
  if (!rules) {
    return [
      `No rules file for ${locale}; only the universal checks run.`,
      hintLine(p, `Fetch your locale team's file with: polyglots rules fetch ${locale}`),
      hintLine(p, `Or write one with: polyglots rules edit ${locale}`),
    ]
  }
  const mistakes = rules.patterns.filter((p) => p.kind === 'mistake').length
  const patterns = rules.patterns.length - mistakes
  const levels = ['hint', 'error', 'fix']
    .map((level) => [level, rules.patterns.filter((p) => p.level === level).length] as const)
    .filter(([, n]) => n > 0)
    .map(([level, n]) => `${n} ${level}`)
  return [
    okLine(p, `${file} is valid.`),
    rules.rules
      ? `  rules: ${plural(rules.rules.enable.length, 'enabled extra')}, ${plural(rules.rules.disable.length, 'disabled')}`
      : '  rules: built-in',
    ...(rules.glossaryStemRatio === undefined ? [] : [`  glossaryStemRatio: ${rules.glossaryStemRatio}`]),
    ...(rules.properNouns ? [`  properNouns: ${Object.keys(rules.properNouns).join(', ')} replaced`] : []),
    `  ${plural(mistakes, 'mistake')}, ${plural(patterns, 'pattern')}${levels.length ? ` (${levels.join(', ')})` : ''}`,
    `  guidance: ${rules.guidance ? `${rules.guidance.length} of ${GUIDANCE_LIMIT} characters` : 'none'}`,
  ]
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
