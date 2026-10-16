import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import type { DataClient } from '../data/download.js'
import { compareVersions, DataError, findRulesEntry, type RulesManifestEntry } from '../data/manifest.js'
import { localeRulesFile, parseLocaleRules, RulesFileError } from '../rules/load.js'
import { MAX_SCHEMA, type CustomPattern, type LocaleRules } from '../rules/schema.js'
import type { Locale } from '../types.js'
import { VERSION } from '../version.js'

// A rules file is a few kB. The cap exists so a wrong URL in the manifest, or
// a server answering with something else entirely, costs a megabyte at most.
const RULES_MAX_BYTES = 1 << 20

export interface RulesFetchPlan {
  locale: Locale
  path: string
  entry: RulesManifestEntry
  text: string
  /**
   * The local file's bytes when the summary was made, absent when there was
   * none. writeRulesFetch compares the file against them before replacing it.
   */
  local?: Buffer
  state: 'new' | 'same' | 'changed'
  summary: string[]
}

// Fatal, so a file that is not UTF-8 refuses rather than being decoded with
// replacement characters and written back as bytes the manifest never
// hashed. ignoreBOM keeps a byte order mark in the text for the same reason:
// the default decoder drops it, and the file written would then be three
// bytes short of the one that was verified.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * Every check rules fetch makes, in the spec's order, and the summary of what
 * the published file changes; nothing is written. The order matters to the
 * person reading the refusal: a manifest or a file too new for this polyglots
 * says "update polyglots" before anything is downloaded, and a file that
 * does not verify is never parsed.
 *
 * The download goes to the system temp folder and is read and removed here,
 * rather than being kept for the write: between the two sits a question that
 * can take as long as the person likes, and a verified file waiting in the
 * config folder for an answer is one more thing a crash leaves behind.
 */
export async function planRulesFetch(locale: Locale, client: DataClient): Promise<RulesFetchPlan> {
  const manifest = await client.manifest()
  const entry = findRulesEntry(manifest, locale)
  if (entry.schema > MAX_SCHEMA) {
    throw new DataError(`needs rules schema ${entry.schema}; this polyglots reads up to ${MAX_SCHEMA}. Update polyglots.`)
  }
  if (compareVersions(VERSION, entry.minPolyglots) < 0) {
    throw new DataError(`${entry.locale} rules need polyglots ${entry.minPolyglots} or later; this is ${VERSION}. Update polyglots.`)
  }
  const temp = await client.download(entry.url, { maxBytes: RULES_MAX_BYTES, sha512: entry.sha512, dir: tmpdir() })
  let downloaded: Buffer
  try {
    downloaded = await readFile(temp)
  } finally {
    await rm(temp, { force: true }).catch(() => undefined)
  }
  let text: string
  try {
    text = utf8.decode(downloaded)
  } catch {
    throw new DataError(`${entry.url} is not UTF-8, so it is not a rules file; nothing was written`)
  }
  const after = parseLocaleRules(text, entry.url, { probe: true })

  const path = localeRulesFile(locale)
  let local: Buffer | undefined
  try {
    local = await readFile(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const status = `status: ${entry.status} · maintainers (wordpress.org): ${entry.maintainers.length > 0 ? entry.maintainers.join(', ') : 'none listed'}`
  if (local === undefined) return { locale, path, entry, text, state: 'new', summary: visible([...diffRules(undefined, after), status]) }
  if (local.equals(downloaded)) return { locale, path, entry, text, local, state: 'same', summary: [] }

  // A local file that no longer parses is the case fetching most often
  // repairs, so it must not refuse the fetch. It is compared against nothing,
  // and the summary says so, so a list of "changed" lines for keys the person
  // knows they had is not mistaken for a file that dropped none of them.
  let before: LocaleRules | undefined
  const notes: string[] = []
  try {
    before = parseLocaleRules(local.toString('utf8'), path)
  } catch (err) {
    if (!(err instanceof RulesFileError)) throw err
    notes.push(`The local file is not valid (${err.message}); compared against nothing.`)
  }
  return { locale, path, entry, text, local, state: 'changed', summary: visible([...notes, ...diffRules(before, after), status]) }
}

// Every summary line carries text from a file and a manifest someone else
// published, and YAML's "\e" is an ESC byte. Printed raw, a replace ending in
// an erase sequence wipes its own "fix added:" line, and the summary exists
// so that no fix rewrites drafts unseen; the sha512 is no defence, because
// the manifest names it. So C0 and C1 controls are shown as escapes, here,
// once, for the CLI and the TUI alike. The newline stays: diffRules has
// already split prompt text on it, and one left inside a note is a line
// break, not a cursor command. Tab goes too, since Ink measures it as one
// column and the frame would tear.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g
const visible = (lines: string[]) =>
  lines.map((line) => line.replace(CONTROL, (c) => `\\u{${c.charCodeAt(0).toString(16)}}`))

/**
 * Writes the planned file exactly as downloaded, so its sha512 still matches
 * the manifest. Temp file and rename in the same folder, as saveTemplate
 * does: a review reading the rules part way through a write sees the old
 * file or the new one, never half of each.
 *
 * The summary the person agreed to described the file as it was when the plan
 * was made, and the question in between can stay open for as long as they
 * like, long enough to edit the file in another window. So the file is read
 * again first, and anything other than the bytes the summary saw (a changed
 * file, or one created after a summary that found none) refuses the write
 * rather than replacing work nobody was shown. The read and the rename are
 * still two steps; what is left between them is milliseconds, not a prompt.
 */
export async function writeRulesFetch(plan: RulesFetchPlan): Promise<void> {
  let now: Buffer | undefined
  try {
    now = await readFile(plan.path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const unchanged = now === undefined ? plan.local === undefined : plan.local !== undefined && now.equals(plan.local)
  if (!unchanged) throw new DataError(`${plan.path} changed since the summary; nothing was written. Run rules fetch again.`)
  await mkdir(dirname(plan.path), { recursive: true })
  const temp = `${plan.path}.tmp-${randomUUID()}`
  try {
    await writeFile(temp, plan.text, 'utf8')
    await rename(temp, plan.path)
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw err
  }
}

const PROMPT_TEXT = [
  ['guidance', (r: LocaleRules) => r.guidance],
  ['capitalization', (r: LocaleRules) => r.capitalization],
  ['register.audit', (r: LocaleRules) => r.register?.audit],
  ['register.translate', (r: LocaleRules) => r.register?.translate],
] as const

const fixCondition = (p: CustomPattern) =>
  [
    ...(p.whenSource === undefined ? [] : [`has ${p.whenSource}`]),
    ...(p.whenNotSource === undefined ? [] : [`lacks ${p.whenNotSource}`]),
  ].join(' and ')

const fixLine = (p: CustomPattern) => {
  const condition = fixCondition(p)
  return `${p.find ?? p.text} → ${p.replace ?? ''}${condition === '' ? '' : ` (when the source ${condition})`}`
}

// Everything that decides what a fix does, so a change in any of it shows,
// as the old fix removed and the new one added.
const fixKey = (p: CustomPattern) =>
  JSON.stringify([p.find ?? null, p.text ?? null, p.replace ?? null, p.ignoreCase, p.whenSource ?? null, p.whenNotSource ?? null])

/**
 * What `after` changes against `before` (or against nothing), as lines for a
 * person deciding whether to let it replace their file.
 *
 * Text that reaches a prompt is printed in full where it differs, because
 * that text is what the model is told and a count of it would hide the one
 * sentence that matters. Fix patterns are listed, because they rewrite
 * drafts without asking. The rest (switches, proper nouns, hint and error
 * patterns) shows only whether it changed: it is long, it only reports, and
 * rules check describes it after the write.
 *
 * Formality is not in the spec's list, but it changes every draft DeepL
 * makes, so a file that flips it says so on a line of its own.
 */
export function diffRules(before: LocaleRules | undefined, after: LocaleRules): string[] {
  const lines: string[] = []
  for (const [key, read] of PROMPT_TEXT) {
    const was = before === undefined ? undefined : read(before)
    const now = read(after)
    if (was === now) continue
    if (now === undefined) lines.push(`${key} removed`)
    else lines.push(`${key} changed:`, ...now.replace(/\n$/, '').split('\n').map((line) => `  ${line}`))
  }
  if (before?.formality !== after.formality) {
    lines.push(after.formality === undefined ? 'formality removed' : `formality changed: ${after.formality}`)
  }

  // A note or a suggested wording is shown when the old file had no such
  // text anywhere, so moving a pattern does not repeat its note.
  const oldNotes = new Set(before?.patterns.map((p) => p.note).filter((n) => n !== undefined))
  const oldRights = new Set(before?.patterns.map((p) => p.right).filter((r) => r !== undefined))
  const shown = new Set<string>()
  const show = (line: string) => {
    if (shown.has(line)) return
    shown.add(line)
    lines.push(line)
  }
  for (const p of after.patterns) {
    if (p.right !== undefined && !oldRights.has(p.right)) show(`right: ${p.right}`)
    if (p.note !== undefined && !oldNotes.has(p.note)) show(`note: ${p.note}`)
  }

  const fixes = (r: LocaleRules | undefined) => (r?.patterns ?? []).filter((p) => p.level === 'fix')
  const oldFixes = new Set(fixes(before).map(fixKey))
  const newFixes = new Set(fixes(after).map(fixKey))
  for (const p of fixes(before)) if (!newFixes.has(fixKey(p))) show(`fix removed: ${fixLine(p)}`)
  for (const p of fixes(after)) if (!oldFixes.has(fixKey(p))) show(`fix added: ${fixLine(p)}`)

  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  lines.push(`sentenceEnd: ${same(before?.sentenceEnd, after.sentenceEnd) ? 'unchanged' : 'changed'}`)

  const rest = (r: LocaleRules | undefined) => ({
    rules: r?.rules,
    glossaryStemRatio: r?.glossaryStemRatio,
    properNouns: r?.properNouns,
    patterns: (r?.patterns ?? []).filter((p) => p.level !== 'fix'),
  })
  const hints = after.patterns.filter((p) => p.level === 'hint').length
  const errors = after.patterns.filter((p) => p.level === 'error').length
  lines.push(`rules.enable, proper nouns, ${hints} hint and ${errors} error patterns: ${same(rest(before), rest(after)) ? 'unchanged' : 'changed'}`)
  return lines
}
