import { existsSync } from 'node:fs'
import { UsageError } from './args.js'
import type { OpenEditor } from './rules.js'
import {
  chooseTemplate,
  createTemplate,
  fillTemplate,
  listTemplateLocales,
  listTemplates,
  templateFile,
} from '../reply/templates.js'
import { buildReport } from '../review/message.js'
import { hintLine, okLine } from '../ui/messages.js'
import { plainPainter, type Painter } from '../ui/paint.js'
import type { Locale, ReviewSummary } from '../types.js'

/**
 * Opens a reply template in the editor, writing the starter first when there
 * is none. An existing file is never overwritten, as with `rules edit`.
 */
export async function editTemplate(
  locale: Locale,
  name: string,
  openEditor: OpenEditor,
  p: Painter = plainPainter,
): Promise<string[]> {
  const file = templateFile(locale, name)
  if (!existsSync(file)) createTemplate(locale, name)
  await openEditor(file)
  return [okLine(p, `Reply template ${name} for ${locale}: ${file}`)]
}

const HOW = 'Create one with: polyglots template edit <locale> [name]'

/** One locale's templates with their paths, or every locale's names. */
export function describeTemplates(locale: Locale | undefined, p: Painter = plainPainter): string[] {
  if (locale !== undefined) {
    const names = listTemplates(locale)
    if (names.length === 0) {
      return [`No reply templates for ${locale}.`, hintLine(p, `Create one with: polyglots template edit ${locale}`)]
    }
    return names.map((name) => `${name}  ${p.paint('path', templateFile(locale, name))}`)
  }
  const locales = listTemplateLocales()
  if (locales.length === 0) return ['No reply templates yet.', hintLine(p, HOW)]
  return locales.map(({ dir, names }) => `${dir}: ${names.join(', ')}`)
}

/**
 * The template a review's reply will use, settled before the run so a name
 * that does not exist is refused before any batch is paid for. Undefined when
 * the locale has no templates and none was asked for: then there is no reply,
 * and a review prints exactly what it printed before templates existed.
 */
export function resolveReplyTemplate(locale: Locale, wanted: string | undefined): string | undefined {
  // Validated first, so a name with a slash in it gets the name error rather
  // than a "no such template" that implies it could exist.
  if (wanted !== undefined) templateFile(locale, wanted)
  const names = listTemplates(locale)
  const chosen = chooseTemplate(names, wanted)
  if (wanted !== undefined && chosen === undefined) {
    throw new UsageError(
      `No reply template "${wanted}" for ${locale} (${templateFile(locale, wanted)}). ` +
        `Create it with: polyglots template edit ${locale} ${wanted}`,
    )
  }
  return chosen
}

export interface ReplyInput {
  locale: Locale
  name: string
  summary: ReviewSummary
  // The reviewer's own wp.org login, for the link inside the requester message.
  wporgUsername: string | undefined
  // The requester's, for {username}.
  requester: string | undefined
}

/**
 * The filled reply, read from disk at the end of the run so an edit made
 * while it ran is the one used. Undefined for a run that stopped early: its
 * unreached entries have been judged by nobody, and a reply saying there were
 * no problems, or granting PTE, would be a verdict on work not done.
 */
export function renderReply(input: ReplyInput, read: (file: string) => string): string | undefined {
  if (input.summary.pending > 0) return undefined
  const text = read(templateFile(input.locale, input.name))
  return fillTemplate(text, {
    ...(input.requester === undefined ? {} : { username: input.requester }),
    repaired: input.summary.repaired,
    flagged: input.summary.needsReview + input.summary.unreviewed,
    results: buildReport(input.summary, input.wporgUsername ?? '') ?? '',
  })
}
