import type { AuditEntry, Locale } from '../types.js'
import { comparable } from './rules/text.js'
import { matchSourceEscaping } from '../po/escapes.js'

/**
 * What the memory can settle about an entry on its own, without a model.
 *
 * `approve`: the submission is a translation the locale already approved for
 * this exact source, word for word, capitals aside. `repair`: the contributor
 * left the English in place where the memory holds the approved Turkish, so
 * the approved string is the fix and there is nothing to weigh.
 */
export type MemoryDecision = { kind: 'approve' } | { kind: 'repair'; text: string[] }

/**
 * Settles an entry from the memory, or returns undefined to leave it to the
 * model as before.
 *
 * The memory holds every wording the locale approved for a source, so a
 * submission matching any of them is approved. A real export had 6,480 sources
 * with more than one, nearly all synonyms: "Tepeye kaydır" and "Yukarı kaydır"
 * are both right and which one a contributor reached for is not a finding.
 * Repairing is the exception, since it writes one wording into the file: with
 * several to choose from there is nothing here to choose by, so the model
 * decides with all of them in front of it.
 *
 * Measured on wp-themes-business-roy-tr.po against a 94,435-row memory: 71 of
 * 1,359 submissions were identical to an approved translation and 173 had been
 * left in English where the memory held the approved text. Every one of them
 * went to a batch anyway. The memory has been in the prompt since 0.11.0, so
 * the model was being handed the answer and asked the question.
 *
 * A difference only of case is approved as written. Labels keep their capitals
 * by the locale team's own rule and the memory cannot tell a label from prose,
 * so the locale manager's ruling was that either casing is acceptable. The
 * contributor's is kept rather than rewritten to the memory's, since nothing
 * is gained by changing one acceptable text into another. Compared the way
 * the locale's own language folds case, through the same comparable() the
 * rules use: for Turkish that is I and İ lowering to ı and i, and a comparison
 * that ignored it would match words that differ and miss words that do not.
 * For every other language it is the ordinary mapping. Folding everyone the
 * Turkish way made "Ix" and "ıx" one word in German, and lowered "DIE" to
 * "dıe" so it no longer matched "die". comparable() also makes two encodings
 * of one letter the same text, so a submission that differs from the memory
 * only in encoding is approved as written too.
 *
 * Different wording is a judgement even when the memory looks better, which on
 * the sampled file it nearly always did, because the same source can mean
 * something else in another project and that is exactly what a model is asked
 * to notice.
 *
 * `exact` says the match was found under the entry's own context. The lookup
 * falls back to a row with no context when the scoped one is missing, which is
 * a fair hint for a prompt and no basis for deciding without one: a msgctxt
 * exists exactly where a source is ambiguous.
 *
 * A plural entry is never settled, since the memory holds one string per source
 * and nothing says which form it would be.
 */
export function decideFromMemory(
  entry: AuditEntry,
  memory: readonly string[],
  exact: boolean,
  locale: Locale,
): MemoryDecision | undefined {
  if (memory.length === 0 || !exact) return undefined
  if (entry.msgidPlural !== undefined || entry.msgstr.length !== 1) return undefined
  const submitted = entry.msgstr[0]!
  const fold = (s: string) => comparable(s, locale)

  // A submission left in English is never approved from the memory, even when
  // the memory holds the same English. The memory carries English for
  // everything the locale keeps that way, brands, icon slugs, place names and
  // Lorem ipsum, alongside a few leftovers nobody ever translated, and there is
  // no telling them apart from here. Approving on that basis would approve a
  // contributor for leaving the English exactly where the memory is weakest.
  // It can still be repaired, because a memory that holds one Turkish wording
  // for the source has answered the question. Measured at about 15 entries in
  // 1,359 moved back into a batch.
  if (submitted === entry.msgid) {
    const wordings = new Set(memory.map(fold))
    if (wordings.size !== 1 || wordings.has(fold(entry.msgid))) return undefined
    // The memory carries the same stray escaping in a handful of rows,
    // imported from work that had it. The source decides here as everywhere.
    return { kind: 'repair', text: [matchSourceEscaping(entry.msgid, memory[0]!)] }
  }

  if (memory.some((m) => m === submitted || fold(m) === fold(submitted))) return { kind: 'approve' }
  return undefined
}
