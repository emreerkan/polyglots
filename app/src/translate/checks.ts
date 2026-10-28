import { repairMechanically } from '../audit/repair.js'
import { buildRuleContext, glossaryMatches, runRules, type GlossaryMatch, type RuleContext } from '../audit/rules/index.js'
import { automatedChecks } from '../audit/prompt.js'
import { applyFixPatterns } from '../rules/custom.js'
import { CUSTOM_RULE } from '../rules/names.js'
import type { AuditEntry, Finding, GlossaryEntry, Locale, ReviewResult, TranslationUnit } from '../types.js'

// The checks that mean something on a draft this tool wrote itself. Left out:
// `inconsistent`, which compares a contributor's file against itself, and
// `tm-conflict`, since an exact memory match never reaches the draft engine.
// The locale's own switches still apply: a rule its profile turns off stays off.
const DRAFT_RULES = new Set([
  'placeholder',
  'html',
  'plural-count',
  'whitespace',
  'escaping',
  'untranslated',
  'punctuation',
  'line-breaks',
  'ampersand',
  'number-format',
  'title-case',
  'glossary',
  'apostrophe',
  'control',
  'date-format',
  'name-order',
  CUSTOM_RULE,
])

export interface DraftChecker {
  /** Drafts with mechanical repairs and fix patterns applied, and what each still fails. */
  prepare(unit: TranslationUnit, drafts: string[]): { drafts: string[]; checks: string[] }
  /**
   * The AI's answer with fix patterns applied, fuzzy if an error-level check
   * still fails, with a note for each pattern that changed the entry here or
   * in `prepare`.
   */
  finalize(unit: TranslationUnit, result: ReviewResult): ReviewResult & { notes?: string[] }
  /**
   * The glossary terms the source contains, by the same matcher the glossary
   * rule and review's prompt use. Handed to a reviewer that cannot look them
   * up, so it and the rule never disagree about which terms apply.
   */
  terms(unit: TranslationUnit): GlossaryMatch[]
  /**
   * The glossary rule's findings on text this tool did not draft: a memory
   * match, written without a model. Only that rule, because the memory's
   * wording was approved by the locale and the rest of the checks would be
   * second-guessing a human; the glossary is the one thing a wording approved
   * for another project can still be wrong about here.
   */
  glossary(unit: TranslationUnit, forms: string[]): Finding[]
}

export interface DraftCheckerOptions {
  locale: Locale
  nplurals: number
  glossary: GlossaryEntry[]
  properNouns: string[]
  units: TranslationUnit[]
}

const asEntry = (unit: TranslationUnit, msgstr: string[]): AuditEntry => ({ ...unit, msgstr, fuzzy: false })

// Worded as review words the same fix in its findings, so a translator who
// meets both in a file reads one voice.
const FIX_NOTE_PREFIX = 'polyglots: locale rule: '

/**
 * Review's rules, run on translate's own drafts.
 *
 * Three points in the pipeline. Before the AI pass, mechanical repairs and the
 * locale file's fix patterns are applied, so the AI judges "Ön izleme" rather
 * than spending its attention on a mistake that needed none. Then each draft's
 * remaining findings travel with it as `automatedChecks`, which the AI fixes or
 * clears exactly as it does for a contributor's submission in review. After the
 * AI pass, the fixes are applied once more, since the AI can write a mistake
 * back in, and an error-level check that still fails marks the entry fuzzy.
 * A hint that still fails does not: the AI already weighed it.
 */
export function createDraftChecker(opts: DraftCheckerOptions): DraftChecker {
  const base = buildRuleContext({
    locale: opts.locale,
    glossary: opts.glossary,
    nplurals: opts.nplurals,
    entries: opts.units.map((u) => asEntry(u, [])),
    properNouns: opts.properNouns,
  })
  const ctx: RuleContext = {
    ...base,
    profile: { ...base.profile, rules: new Set([...base.profile.rules].filter((r) => DRAFT_RULES.has(r))) },
  }

  const fix = (unit: TranslationUnit, forms: string[]): { forms: string[]; notes: string[] } => {
    const restored = repairMechanically(asEntry(unit, forms)) ?? forms
    const fixed = applyFixPatterns({ msgid: unit.msgid, msgstr: restored }, ctx.customPatterns ?? [], ctx.locale)
    return { forms: fixed?.forms ?? restored, notes: fixed?.notes ?? [] }
  }
  // The notes of the fixes prepare made, held until finalize. Prepare's fix is
  // the one that usually counts: the AI pass sees the fixed draft and keeps it,
  // so by finalize there is nothing left to change, and a note taken only there
  // would name the rare entry the AI broke again and miss every other one. Kept
  // here rather than returned from prepare so its interface, and the caller's
  // plumbing of drafts and checks through the review, stay as they were.
  const prepared = new Map<string, string[]>()
  const findings = (unit: TranslationUnit, forms: string[]): Finding[] => runRules(asEntry(unit, forms), ctx)
  // Narrowed through the profile rather than by calling the rule directly, so
  // a locale that turns the glossary rule off, and a control string, which
  // answers to its own rule alone, are honoured here exactly as in review.
  const glossaryCtx: RuleContext = {
    ...ctx,
    profile: { ...ctx.profile, rules: new Set([...ctx.profile.rules].filter((r) => r === 'glossary')) },
  }

  return {
    prepare(unit, drafts) {
      const fixed = fix(unit, drafts)
      if (fixed.notes.length > 0) prepared.set(unit.key, fixed.notes)
      else prepared.delete(unit.key)
      // Rendered by the audit prompt's own function, so a locale pattern that
      // ran away on this draft is withheld here exactly as it is from a
      // contributor's entry: the rules file is at fault, and the AI cannot
      // answer for a regex it never sees. The caller keys the draft review on
      // this list, so the key follows what the prompt renders by construction.
      return { drafts: fixed.forms, checks: automatedChecks(findings(unit, fixed.forms)) }
    },
    terms(unit) {
      return glossaryMatches(unit.msgid, ctx)
    },
    glossary(unit, forms) {
      return runRules(asEntry(unit, forms), glossaryCtx)
    },
    finalize(unit, result) {
      const { forms: text, notes: late } = fix(unit, result.text)
      // One note per pattern, however many times it fired: a pattern prepare
      // applied and the AI then wrote back in is still one rule's doing.
      const said = [...new Set([...(prepared.get(unit.key) ?? []), ...late])]
      prepared.delete(unit.key)
      const notes = said.length > 0 ? { notes: said.map((n) => FIX_NOTE_PREFIX + n) } : {}
      const errors = findings(unit, text).filter((f) => f.severity === 'error')
      if (errors.length === 0) return { ...result, text, ...notes }
      const still = `Still failing: ${errors.map((f) => `${f.rule}: ${f.message}`).join('; ')}`
      return { ...result, text, ...notes, fuzzy: true, reason: result.reason ? `${result.reason} ${still}` : still }
    },
  }
}
