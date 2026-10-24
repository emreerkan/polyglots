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

/** Every placeholder in the text, one per occurrence, in the order written. */
export function placeholdersIn(text: string): string[] {
  return [...text.replaceAll('%%', '').matchAll(placeholderPattern())].map(([match]) => match)
}

function countPlaceholders(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const match of placeholdersIn(text)) {
    counts.set(match, (counts.get(match) ?? 0) + 1)
  }
  return counts
}

export function missingPlaceholders(source: string, draft: string): string[] {
  const inDraft = countPlaceholders(draft)
  const missing: string[] = []
  for (const [ph, n] of countPlaceholders(source)) {
    if ((inDraft.get(ph) ?? 0) < n) missing.push(ph)
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
