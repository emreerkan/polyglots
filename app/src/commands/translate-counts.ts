import type { TranslateSummary } from './translate.js'

/**
 * Every fuzzy entry a run wrote, from the engine and from the memory: what the
 * summaries show and the history records as flagged. Counted from the engine
 * alone, a run reported 10 fuzzy on a file it had left 121 in.
 *
 * In a module of its own because the CLI's summaries and the TUI import only
 * types from translate.ts, and a value from it would load the whole command,
 * database and engines included, into code that only formats numbers.
 */
export function fuzzyTotal(summary: Pick<TranslateSummary, 'fuzzy' | 'fromTmFuzzy'>): number {
  return summary.fuzzy + (summary.fromTmFuzzy ?? 0)
}
