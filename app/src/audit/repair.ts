import type { AuditEntry, Finding } from '../types.js'
import { matchSourceEscaping } from '../po/escapes.js'
import { isSkipFinding } from '../rules/custom.js'
import { runRules, type RuleContext } from './rules/index.js'

// Rules whose correct output is computable from the source, so no judgment and
// no model call is needed. A rule qualifies only if it is `error` severity and
// the correct text follows from the source: `punctuation` looks similar but is
// a `suspect`, meaning the locale team wants the model to decide, and forcing
// it here would overrule that.
//
// `escaping` qualifies in one direction only. A backslash the source does not
// have can be dropped, while a lost one cannot be put back, so the rule still
// fires for that case and the model handles it. Listed all the same, because
// what matters here is whether the rules repair anything on their own.
//
// This list is part of the resume fingerprint, so adding to it correctly
// refuses to resume a review that ran under the old set.
export const REPAIRABLE_RULES = ['whitespace', 'escaping'] as const

const LEAD = /^\s*/
const TRAIL = /\s*$/

function edges(value: string): { lead: string; trail: string; body: string } {
  const lead = LEAD.exec(value)![0]
  const trail = TRAIL.exec(value)![0]
  return { lead, trail, body: value.slice(lead.length, value.length - trail.length) }
}

// Gives every translated plural form the source's leading and trailing
// whitespace, and the source's way of spelling a quote. Returns undefined when
// there was nothing to fix, so the caller can tell a repair from a no-op.
//
// Only the direction that can be computed: a backslash the source does not have
// is dropped, while a translation that lost an escape the source carries is left
// for the model, since nothing here knows where the backslash belonged.
export function repairMechanically(entry: AuditEntry): string[] | undefined {
  const source = edges(entry.msgid)
  let changed = false

  const repaired = entry.msgstr.map((form) => {
    // Nothing but whitespace is not a translation whose edges can be fixed.
    // Trimming it to empty would be counted as a repair, when what it did was
    // blank the entry.
    if (form.trim() === '') return form
    const target = edges(form)
    const body = matchSourceEscaping(entry.msgid, target.body)
    if (target.lead === source.lead && target.trail === source.trail && body === target.body) return form
    changed = true
    return `${source.lead}${body}${source.trail}`
  })

  return changed ? repaired : undefined
}

// `suspect` is set when the accepted fix carries rule findings the submitted
// text did not. The fix is kept all the same: the model may well be right about
// the thing it was asked to fix, and what it broke on the way is for a person
// to weigh, not grounds for throwing the fix away.
export type FixVerdict = { accepted: string[]; suspect?: Finding } | { rejected: string }

export interface JudgeFixArgs {
  entry: AuditEntry
  fix: string[]
  nplurals: number
  ctx: RuleContext
}

// The rule name the finding is written under. Not the underlying rule's own
// name: a re-found `glossary` would be counted as the contributor's glossary
// error, in the run tally and in the message posted back to them, when it was
// the model that dropped the term.
export const FIX_SUSPECT_RULE = 'fix-suspect'

// Rules whose finding is about the file rather than the entry. `inconsistent`
// counts how many ways the submitted file translates a source, a set the fix is
// not part of, so whatever it says on the fix it says about the contributor's
// file. It fires on any non-empty text, so on an entry with text it fires on
// both and the diff drops it anyway. It does not when the entry as the model saw
// it was empty, and it is named here so that case, or a rule that one day
// compares the entry against that set, cannot report the file's spread as
// something the model brought in.
const WHOLE_FILE_RULES: ReadonlySet<string> = new Set(['inconsistent'])

/**
 * What a finding is about, as separate items, so two findings of one rule can
 * be compared item by item.
 *
 * Comparing whole messages was the obvious way and the wrong one. The glossary
 * message lists every term the text missed, so a fix that kept one term missing
 * and dropped another would read as entirely new and name both. The title-case
 * message changes its wording when the whole string mirrors the source, so a
 * fix that added one capital to a submission that already had another would
 * read as a different finding and name the old capital as the model's.
 *
 * Parsed from the message, because the message is all a finding carries. Each
 * parse falls back to the whole message, which is the old comparison: a rule
 * whose wording drifts from what is matched here degrades to being compared as
 * a sentence, never to being dropped.
 */
function offendingItems(finding: Finding): string[] {
  const { rule, message } = finding
  const list = (body: string | undefined, separator: string): string[] =>
    body === undefined || body === '' ? [message] : body.split(separator)
  switch (rule) {
    case 'glossary':
      return list(/^glossary term not used: (.*)$/s.exec(message)?.[1], '; ')
    case 'apostrophe':
      return list(/^proper noun takes a suffix without an apostrophe: (.*)$/s.exec(message)?.[1], ', ')
    case 'title-case':
      return list((/^title case mirrors the English source \((.*?)\); /s.exec(message) ?? /^capitalizes (.*?) mid-string; /s.exec(message))?.[1], ', ')
    default:
      return [message]
  }
}

/**
 * The rule findings on an accepted fix that the submitted text did not have,
 * as one `fix-suspect` finding naming each underlying rule and what it found.
 * Undefined when the fix brought in nothing.
 *
 * Errors cannot appear here, since judgeFix has already rejected a fix with
 * one; what is left are the suspects the rules raise and the model is trusted
 * to weigh. It weighed them on the submitted text, never on its own.
 */
function broughtIn(before: Finding[], after: Finding[]): Finding | undefined {
  const had = new Set(before.flatMap((f) => offendingItems(f).map((item) => `${f.rule}\0${item}`)))
  const added = new Map<string, string[]>()
  for (const finding of after) {
    // A pattern that first ran away on the fix would read as new here only
    // because it was never tried that far on the submission. It is the rules
    // file's fault, and the run summary already names it.
    if (WHOLE_FILE_RULES.has(finding.rule) || isSkipFinding(finding)) continue
    for (const item of offendingItems(finding)) {
      if (had.has(`${finding.rule}\0${item}`)) continue
      const items = added.get(finding.rule) ?? []
      if (!items.includes(item)) items.push(item)
      added.set(finding.rule, items)
    }
  }
  if (added.size === 0) return undefined
  const named = [...added].map(([rule, items]) => `${rule} (${items.join(', ')})`).join('; ')
  return {
    rule: FIX_SUSPECT_RULE,
    severity: 'suspect',
    message: `the model's fix was kept, but brought in what the submitted text did not have: ${named}`,
  }
}
// A proposed fix is only worth taking if it is actually different, actually
// shaped like a translation of this entry, and does not break something the
// rules can prove. Soft findings are not grounds for rejection: the model just
// weighed those, and rejecting on them would mean no fix could ever land.
export function judgeFix({ entry, fix: proposed, nplurals, ctx }: JudgeFixArgs): FixVerdict {
  // Before anything judges it: an agent that escaped a quote the source leaves
  // plain wrote the file's spelling instead of the string's, and that is a
  // stray character rather than a reason to throw away a good translation.
  const source = `${entry.msgid}${entry.msgidPlural ?? ''}`
  const fix = proposed.map((form) => matchSourceEscaping(source, form))
  const forms = entry.msgidPlural === undefined ? 1 : nplurals
  if (fix.length !== forms) {
    return { rejected: `the proposed fix has ${fix.length} plural forms where this entry needs ${forms}` }
  }
  if (fix.some((form) => form.trim() === '')) return { rejected: 'the proposed fix was empty' }
  if (fix.length === entry.msgstr.length && fix.every((form, i) => form === entry.msgstr[i])) {
    return { rejected: 'the proposed fix was unchanged from what was submitted' }
  }

  const after = runRules({ ...entry, msgstr: fix }, ctx)
  const errors = after.filter((f) => f.severity === 'error')
  if (errors.length > 0) {
    return { rejected: `the proposed fix was rejected: ${errors.map((f) => f.message).join('; ')}` }
  }
  // Against the rules on the entry as the model saw it, which is the submitted
  // text after any mechanical repair: that repair is not the model's doing and
  // neither is anything it left behind.
  const suspect = broughtIn(runRules(entry, ctx), after)
  return suspect ? { accepted: fix, suspect } : { accepted: fix }
}
