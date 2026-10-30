import type { EffectiveRow, GlossaryDiff, GlossaryRow } from './types.js'

/**
 * The diff an imported CSV makes: for every term the CSV names, matched
 * case-insensitively, every current row of that term goes and every CSV row
 * of it comes in. The CSV's term wins outright rather than being merged row by
 * row, because a reviewed project terminology is a decision about the term,
 * and a stale wp.org alternative left beside it would still reach the prompt.
 *
 * Pure and browser-safe: the editor runs it on the page to show an import as
 * unsaved changes, and the store runs it to save one, so both agree.
 */
export function importDiff(current: EffectiveRow[], rows: GlossaryRow[]): GlossaryDiff {
  const terms = new Set(rows.map((r) => r.term.toLowerCase()))
  return {
    added: rows.map((r) => ({ term: r.term, pos: r.pos, translation: r.translation, notes: r.notes })),
    changed: [],
    deleted: current.filter((r) => terms.has(r.term.toLowerCase())),
  }
}
