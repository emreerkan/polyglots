import type { EffectiveRow, GlossaryDiff, GlossaryRow } from './types.js'

/**
 * The diff an imported CSV makes: for every term the CSV names, matched
 * case-insensitively, every current row of that term goes and every CSV row
 * of it comes in. The CSV's term wins outright rather than being merged row by
 * row, because a reviewed project terminology is a decision about the term,
 * and a stale wp.org alternative left beside it would still reach the prompt.
 *
 * One exception: a CSV row identical to a current row of its term (term
 * matched case-insensitively, the other three fields exactly) leaves that row
 * where it is. Deleting a wp.org row and adding it back unchanged gives the
 * same glossary, but as two local edits, and a re-import of the same CSV
 * would turn every untouched wp.org row into an add that the next sync may
 * then remove. The two are paired one to one, so a CSV that names a row once
 * keeps one of two identical twins, not both.
 *
 * Pure and browser-safe: the editor runs it on the page to show an import as
 * unsaved changes, and the store runs it to save one, so both agree.
 */
export function importDiff(current: EffectiveRow[], rows: GlossaryRow[]): GlossaryDiff {
  const terms = new Set(rows.map((r) => r.term.toLowerCase()))
  const named = current.filter((r) => terms.has(r.term.toLowerCase()))
  const kept = new Set<EffectiveRow>()
  const added: GlossaryRow[] = []
  for (const r of rows) {
    const same = named.find((c) => !kept.has(c) && sameRow(c, r))
    if (same) kept.add(same)
    else added.push({ term: r.term, pos: r.pos, translation: r.translation, notes: r.notes })
  }
  return { added, changed: [], deleted: named.filter((r) => !kept.has(r)) }
}

const sameRow = (a: GlossaryRow, b: GlossaryRow): boolean =>
  a.term.toLowerCase() === b.term.toLowerCase() && a.pos === b.pos && a.translation === b.translation && a.notes === b.notes
