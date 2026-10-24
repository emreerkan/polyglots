import type { DraftEngineName } from './errors.js'

// printf: %[argnum$][flags][width][.precision]specifier, PHP's custom pad flag is
// a quote plus any char.
//
// The flag set deliberately omits printf's space flag. It is legal ("% d" asks
// for a blank where a plus sign would go) and essentially never used, while a
// percent sign followed by a space is everywhere in English UI copy: "100%
// satisfaction" parsed as %s, "30% off" as %o, "101% Growth" as %G. Turkish
// writes the sign before the number, %100, so the phantom placeholder went
// missing on every such translation: a warning on the draft side and, because
// the audit rules share this pattern, an error-severity verdict the model could
// not clear on the review side.
//
// Percent-encoded URLs still match: %2F reads as a width-2 float. That one is
// left alone. Both sides of a translation carry the same URL, so the counts
// cancel and nothing is reported; if a draft mangles the URL, saying so is
// right.
export const PRINTF_PLACEHOLDER = String.raw`%(?:\d+\$)?(?:[-+0#]|'[\s\S])*\d*(?:\.\d+)?[bcdeEfFgGosuxX]`

// Braces and ###TOKEN###, the non-printf shapes WordPress strings also carry.
export const BRACE_PLACEHOLDER = String.raw`\{[A-Za-z_][\w.-]*\}|###[A-Za-z0-9_]+###`

// Built per call: a /g regex carries lastIndex, and a shared one would skip
// matches across callers.
function placeholderPattern(): RegExp {
  return new RegExp(`${PRINTF_PLACEHOLDER}|${BRACE_PLACEHOLDER}`, 'g')
}

const NUMBERED = /^%\d+\$/

// sprintf fills the k-th unnumbered placeholder from the k-th argument, so in
// a text whose printf placeholders are all unnumbered, %s in second place is
// the same placeholder as %2$s. Comparing them that way lets a translation
// number them and move them, which word order often needs ("%s by %s" in
// Turkish) and a family-name-first locale needs for "%s %s". Comparing them as
// written called that correct translation broken. A text that mixes the two
// forms is compared as written: which argument a bare %s takes after a
// numbered one is not something to guess at.
/** Every placeholder in the text, one per occurrence, in the order written. */
export function placeholdersIn(text: string): string[] {
  return [...text.replaceAll('%%', '').matchAll(placeholderPattern())].map(([match]) => match)
}

/**
 * Every placeholder in the text as the comparison reads it, one per
 * occurrence, beside its spelling: in a text whose printf placeholders are all
 * unnumbered, the k-th is read as %k$.
 */
export function placeholderKeys(text: string): Array<{ key: string; shown: string }> {
  const found = placeholdersIn(text)
  const printf = found.filter((ph) => ph.startsWith('%'))
  const number = printf.length > 0 && !printf.some((ph) => NUMBERED.test(ph))
  let k = 0
  return found.map((ph) => ({ key: number && ph.startsWith('%') ? `%${++k}$${ph.slice(1)}` : ph, shown: ph }))
}

function countPlaceholders(text: string): Map<string, { n: number; shown: string }> {
  const counts = new Map<string, { n: number; shown: string }>()
  for (const { key, shown: ph } of placeholderKeys(text)) {
    const seen = counts.get(key)
    counts.set(key, { n: (seen?.n ?? 0) + 1, shown: ph })
  }
  return counts
}

/**
 * The source's unnumbered printf placeholders, when the draft has the same ones
 * in another order. missingPlaceholders reports those as lost, which is true of
 * the arguments they now receive but tells a contributor nothing they can act
 * on; this lets the message say what to do instead.
 */
export function movedPlaceholders(source: string, draft: string): string[] | undefined {
  const printf = (text: string) =>
    placeholdersIn(text).filter((ph) => ph.startsWith('%'))
  const from = printf(source)
  const to = printf(draft)
  if (from.length < 2 || [...from, ...to].some((ph) => NUMBERED.test(ph))) return undefined
  if (from.join('\u0000') === to.join('\u0000') || [...from].sort().join('\u0000') !== [...to].sort().join('\u0000')) return undefined
  return from
}

/** The source's placeholders the draft lacks, as the source writes them. */
export function missingPlaceholders(source: string, draft: string): string[] {
  const inDraft = countPlaceholders(draft)
  const missing: string[] = []
  for (const [key, { n, shown }] of countPlaceholders(source)) {
    if ((inDraft.get(key)?.n ?? 0) < n && !missing.includes(shown)) missing.push(shown)
  }
  return missing
}

export type WarningSink = (message: string) => void

export function warnMissingPlaceholders(
  engine: DraftEngineName,
  key: string,
  source: string,
  draft: string,
  onWarning?: WarningSink,
): void {
  if (!onWarning) return
  const missing = missingPlaceholders(source, draft)
  if (missing.length === 0) return
  onWarning(`${engine}: draft for ${JSON.stringify(key)} lost placeholder(s) ${missing.join(', ')}`)
}
