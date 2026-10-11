/**
 * Reply templates: the whole comment a reviewer posts back on a PTE request,
 * of which the requester message (src/review/message.ts) is only the middle.
 *
 * Each locale writes the same frame around that sentence every time: a
 * greeting, the verdict, whether the PTE request was approved, where the
 * team's guidelines are and where to find the team. A template holds that frame once, with
 * placeholders for the parts that change from one request to the next.
 *
 * Files rather than config keys, because the text runs to several paragraphs
 * and carries HTML, and `config set` is a single line in a shell's quoting.
 * They sit beside the locale rules under the config directory, one folder per
 * locale and one .txt per template, so the person edits them in their own
 * editor and a team can pass one around as a file.
 *
 * Nothing here reaches a prompt. A template is read after the review has
 * finished and only shapes what is printed and copied, so no cache key has to
 * cover it, and editing one never re-reviews anything.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { UsageError } from '../cli/args.js'
import { configDir } from '../paths.js'
import { localeFileTag, wpCodeOf } from '../wporg/locales.js'
import type { Locale } from '../types.js'

export const DEFAULT_TEMPLATE = 'approved'

// A PTE request ends one of two ways, approved or declined, and these are the
// two replies a reviewer writes. Named for that outcome rather than for the
// wording inside, so the name still fits after the text is rewritten. Offered
// as starters by `template edit`; any other name is the person's own.
export const STARTER_NAMES = ['approved', 'declined'] as const

const EXTENSION = '.txt'

// A name becomes a file name, so it is held to characters that are one on
// every system and can never climb out of the locale's folder.
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export interface Template {
  name: string
  text: string
}

// The root of every locale's folder.
export function templatesRoot(): string {
  return join(configDir(), 'templates')
}

// Named by the WordPress code, tr_TR rather than tr, for the reason the rules
// files are (localeRulesFile): the name translators recognise, and always a
// valid folder name, which nl/formal is not.
export function templatesDir(locale: Locale): string {
  return join(templatesRoot(), wpCodeOf(locale) ?? localeFileTag(locale))
}

export function templateFile(locale: Locale, name: string): string {
  if (!NAME.test(name)) {
    throw new UsageError(`"${name}" is not a valid template name: use letters, digits, - and _ only`)
  }
  return join(templatesDir(locale), `${name}${EXTENSION}`)
}

// Approved first, because it is the default and the one most often wanted;
// the rest by name, so the order a person cycles through is stable.
function ordered(names: string[]): string[] {
  return [...names].sort((a, b) => Number(b === DEFAULT_TEMPLATE) - Number(a === DEFAULT_TEMPLATE) || a.localeCompare(b))
}

function namesIn(dir: string): string[] {
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  return ordered(
    files.filter((f) => f.endsWith(EXTENSION)).map((f) => f.slice(0, -EXTENSION.length)).filter((n) => NAME.test(n)),
  )
}

/** The locale's template names, approved first. Empty when it has none. */
export function listTemplates(locale: Locale): string[] {
  return namesIn(templatesDir(locale))
}

/** Every locale folder that holds at least one template, by folder name. */
export function listTemplateLocales(): Array<{ dir: string; names: string[] }> {
  let dirs: string[]
  try {
    dirs = readdirSync(templatesRoot()).sort()
  } catch {
    return []
  }
  return dirs.map((dir) => ({ dir, names: namesIn(join(templatesRoot(), dir)) })).filter((d) => d.names.length > 0)
}

/** The locale's templates with their text, in listTemplates order. */
export function loadTemplates(locale: Locale): Template[] {
  return listTemplates(locale).map((name) => ({ name, text: readFileSync(templateFile(locale, name), 'utf8') }))
}

/**
 * Which template a reply uses: the one asked for, when it exists, or else
 * approved, or else the first there is.
 *
 * The fallback past approved is there so a locale that only ever writes one
 * kind of reply, under whatever name, still gets it without a flag on every
 * run. Every place that shows the reply names the template it used, so a
 * declined reply standing in for a missing approved one is never mistaken for
 * it.
 */
export function chooseTemplate(names: readonly string[], wanted?: string): string | undefined {
  if (wanted !== undefined) return names.includes(wanted) ? wanted : undefined
  return names.includes(DEFAULT_TEMPLATE) ? DEFAULT_TEMPLATE : names[0]
}

export interface FillInput {
  // The requester's wp.org username. Absent or empty leaves {username} in the
  // text for the person to fill in by hand, rather than greeting nobody.
  username?: string
  // Entries the review repaired, and entries it left for the reviewer
  // (needsReview plus unreviewed). Together they pick the branch of a choice.
  repaired: number
  flagged: number
  // The requester message, or empty when there was nothing to report.
  results: string
}

/**
 * The line shown above a reply whose verdict polyglots cannot settle: entries
 * left for the reviewer mean the outcome is theirs to decide, after the run.
 * Kept out of the reply itself, which is pasted as is, and said where the
 * reply is copied, the one moment it can still change. Undefined when nothing
 * is left for the reviewer.
 */
export function replyCaution(counts: { needsReview: number; unreviewed: number }): string | undefined {
  const n = counts.needsReview + counts.unreviewed
  if (n === 0) return undefined
  return `${n === 1 ? '1 entry is' : `${n} entries are`} flagged for you. Check the verdict sentence before you post.`
}

/**
 * The requester's username as typed, ready for {username}: trimmed, and
 * without a leading @. Templates write @{username}, and a name copied from a
 * mention or a profile often arrives with its @ already on, which would
 * greet @@someone. Blank is undefined, which leaves the placeholder in place.
 */
export function normaliseRequester(raw: string | undefined): string | undefined {
  const name = (raw ?? '').trim().replace(/^@+/, '')
  return name === '' ? undefined : name
}

const RESULTS = '{results_copy}'

/**
 * The template with its placeholders filled.
 *
 * Three forms are read, and nothing else:
 *
 * - `{username}`, the requester.
 * - `{results_copy}`, the requester message exactly as buildReport wrote it,
 *   so its rounding and wording rules hold inside the reply too.
 * - `{zero|some}`, braces holding exactly one bar: the first branch when the
 *   review repaired nothing and left nothing for the reviewer, the second
 *   otherwise. Repairing nothing is not finding nothing: a flagged entry the
 *   reviewer has not looked at yet may still be a problem they fix by hand,
 *   and "there were no problems" posted on a public request cannot be taken
 *   back, while "a few problems" over-says at worst, on a reply the reviewer
 *   reads before posting (replyCaution tells them to). Two-way on purpose. The
 *   branches are whole clauses, because "no problems, and I fixed them" says
 *   nothing sensible, and a third branch would need thresholds nobody has
 *   asked for yet.
 *
 * Every other brace group is left as written, so a template can carry literal
 * braces with no escaping. The one thing it cannot carry literally is a pair
 * with a single bar between them, which reads as a choice. Braces do not nest,
 * and what was substituted is never read again: a username with braces in it
 * stays a username.
 *
 * The output is pasted as is into an o2 comment, which takes HTML, so nothing
 * is wrapped, escaped or coloured. The trailing newline an editor leaves on
 * the file is dropped, since it would only become a stray empty paragraph.
 */
export function fillTemplate(text: string, input: FillInput): string {
  let source = text
  if (input.results === '') {
    // A clean run has no message, and a line that held only the placeholder
    // would become a hole between two paragraphs. The line goes, and so does
    // one of the blank lines that would then stand next to each other.
    const lines = source.split('\n')
    const kept: string[] = []
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trim() !== RESULTS) {
        kept.push(lines[i]!)
        continue
      }
      const before = kept.length > 0 && kept[kept.length - 1]!.trim() === ''
      const after = i + 1 < lines.length && lines[i + 1]!.trim() === ''
      if (before && after) i++
    }
    source = kept.join('\n')
  }
  const filled = source.replace(/\{([^{}]*)\}/g, (whole, inner: string) => {
    if (inner === 'username') return input.username ? input.username : whole
    if (inner === 'results_copy') return input.results
    const branches = inner.split('|')
    if (branches.length === 2) return input.repaired === 0 && input.flagged === 0 ? branches[0]! : branches[1]!
    return whole
  })
  return filled.replace(/\s+$/, '')
}

// The tr_TR team's reply, as its locale manager wrote it. It is carried word
// for word, so its "Please see below:" stays outside a choice even though a
// clean run has nothing below to see. The starters written here instead put
// that pointer in a choice with an empty first branch, which says nothing when
// the review repaired nothing; the docs show the same edit for this one.
// Rewriting the manager's own sentence on their behalf was the alternative,
// and it is theirs to change, not ours.
const TR_APPROVED = `Hello @{username},

I have reviewed your translations. {There were no problems.|There were a few problems, and I fixed them.} I have granted you PTE rights. Please see below:

{results_copy}

As the #tr_TR translation team, we follow certain guidelines for carrying out translations, making corrections, getting help, etc. We expect the same from our new contributors.

Please join our <a href="https://www.wp-tr.org/slack/">local slack</a> and the #ceviri channel so we can meet, guide you to improve your translations, and keep in touch.

Cheers!
`

const TR_DECLINED = `Hello @{username},

I have reviewed your translations. {There were no problems.|There were some problems, and I fixed them.} I am not granting you PTE rights yet: I would like to see more of your translations first.{| Please see below:}

{results_copy}

As the #tr_TR translation team, we follow certain guidelines for carrying out translations, making corrections, getting help, etc. We expect the same from our new contributors.

Please join our <a href="https://www.wp-tr.org/slack/">local slack</a> and the #ceviri channel so we can meet, guide you to improve your translations, and keep in touch.

Cheers!
`

const APPROVED = `Hello @{username},

I have reviewed your translations. {There were no problems.|There were a few problems, and I fixed them.} I have granted you PTE rights.{| Please see below:}

{results_copy}

Our translation team follows a set of guidelines for translating, making corrections and asking for help. Please read them, and get in touch with the team if anything is unclear.

Thank you!
`

const DECLINED = `Hello @{username},

I have reviewed your translations. {There were no problems.|There were some problems, and I fixed them.} I am not granting you PTE rights yet: I would like to see more of your translations first.{| Please see below:}

{results_copy}

Our translation team follows a set of guidelines for translating, making corrections and asking for help. Please read them, and get in touch with the team if anything is unclear.

Thank you!
`

/**
 * What `template edit` writes into a template that does not exist yet.
 *
 * Plain text with no comment syntax, because every character of the file is
 * part of the reply: a header explaining the placeholders would be pasted
 * into a contributor's thread the first time somebody forgot to delete it.
 * The docs explain them instead. A name other than the two starters begins
 * from approved, as something to edit rather than an empty file.
 */
export function starterTemplate(locale: Locale, name: string): string {
  const tr = wpCodeOf(locale) === 'tr_TR'
  if (name === 'declined') return tr ? TR_DECLINED : DECLINED
  return tr ? TR_APPROVED : APPROVED
}

/**
 * Writes a new template from its starter and returns the file. The app owns
 * these files, so the CLI and the TUI both create through here rather than
 * telling anyone where the folder is. An existing template is never
 * overwritten: it may be months of a locale manager's wording, and the
 * starter is one keypress away from replacing it.
 */
export function createTemplate(locale: Locale, name: string): string {
  const file = templateFile(locale, name)
  if (existsSync(file)) throw new UsageError(`A reply template named "${name}" already exists for ${locale}`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, starterTemplate(locale, name), { encoding: 'utf8', flag: 'wx' })
  return file
}

/**
 * Replaces a template's text, from the TUI's editor. Written beside the file
 * and renamed over it, so a crash or a full disk part way leaves the old
 * wording rather than half of the new one. The temporary name starts with a
 * dot and has no .txt, so a listing taken meanwhile never shows it as a
 * template of its own.
 */
export function saveTemplate(locale: Locale, name: string, text: string): string {
  const file = templateFile(locale, name)
  mkdirSync(dirname(file), { recursive: true })
  const temp = join(dirname(file), `.${name}.${process.pid}.tmp`)
  writeFileSync(temp, text, 'utf8')
  renameSync(temp, file)
  return file
}

/**
 * Removes a template. False when there was none, so a caller can say so
 * rather than claim a deletion that did not happen. The locale's folder is
 * left in place even when it empties: listing an empty folder costs nothing,
 * and removing it would race a create from another process.
 */
export function deleteTemplate(locale: Locale, name: string): boolean {
  const file = templateFile(locale, name)
  if (!existsSync(file)) return false
  rmSync(file)
  return true
}
