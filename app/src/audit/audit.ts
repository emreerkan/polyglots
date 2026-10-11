import { chunk } from '../batch.js'
import { controlSpec } from './control.js'
import type { RunControl } from '../run-control.js'
import { runAgent, type AgentRunOptions } from '../agent/run.js'
import { auditSrcHash } from '../jobs/hash.js'
import type { CachedVerdict, VerdictKey } from '../jobs/verdicts.js'
import type { AuditEntry, Finding, GlossaryEntry, Locale } from '../types.js'
import { buildAuditPrompt, type AuditCandidate } from './prompt.js'
import { judgeFix, repairMechanically } from './repair.js'
import { applyFixPatterns } from '../rules/custom.js'
import { auditBatchJsonSchema, mapAuditResults, type AuditResult } from './schema.js'
import {
  buildRuleContext,
  glossaryMatches as glossaryFor,
  runRules,
  tmKey,
  type RuleContext,
} from './rules/index.js'
import { decideFromMemory } from './memory.js'

export interface Verdict {
  key: string
  problem: boolean
  findings: Finding[]
  reason: string
  unreviewed?: boolean
  needsReview?: boolean
  // The corrected translation, when a repair was made and accepted, and which
  // side made it. The rules repair what is computable; the model repairs the
  // rest.
  text?: string[]
  repairedBy?: 'rules' | 'model' | 'memory'
}

export type Adjudicator = (
  batch: AuditCandidate[],
  opts: { locale: Locale; nplurals: number; pluralForms?: string } & AgentRunOptions,
) => Promise<AuditResult[]>

export interface BatchStart {
  index: number
  of: number
  size: number
}

export interface BatchProgress extends BatchStart {
  problems: number
  // The verdicts this batch decided, so a caller can persist as it goes rather
  // than holding hours of work in memory until the run ends.
  verdicts: Verdict[]
  // Set when the batch could not be adjudicated and its entries were marked
  // unreviewed.
  failed?: string
}

// Narrow on purpose: auditEntries needs a map from a key to a verdict, not a
// database. Tests pass a Map; review.ts passes one backed by jobs.db.
export interface VerdictCache {
  get(key: VerdictKey): CachedVerdict | undefined
  put(key: VerdictKey, verdict: CachedVerdict): void
}

export interface AuditOptions extends Partial<AgentRunOptions> {
  entries: AuditEntry[]
  locale: Locale
  nplurals: number
  // The catalogue's Plural-Forms header, set only above two forms, where the
  // prompt carries it and so the verdict key must too.
  pluralForms?: string
  glossary: GlossaryEntry[]
  properNouns?: string[]
  // Every wording the memory holds for these sources, resolved by the caller.
  // The rules read no database, and the caller already has one open.
  tm?: Map<string, readonly string[]>
  // The keys in `tm` whose match was found under the entry's own context
  // rather than by falling back to a row without one. `tm` keeps the fallback
  // matches because they are a fair hint in a prompt; only these may settle an
  // entry without a model. Absent means none may.
  memoryExact?: ReadonlySet<string>
  noAi?: boolean
  batchSize?: number
  // Lets a caller park or end the run at a batch boundary. A subscription that
  // runs out of quota mid-review wants to stop between calls and come back, not
  // abandon a call it has already paid for.
  control?: RunControl
  adjudicate?: Adjudicator
  // memoryApproved and memoryRepaired count what the memory settled without a
  // model, so a run that sends fewer batches than its size suggests says why.
  onRules?: (summary: { flagged: number; suspects: number; memoryApproved: number; memoryRepaired: number }) => void
  onBatchStart?: (batch: BatchStart) => void
  // Awaited, so a caller writing to disk finishes before the next batch starts.
  onBatch?: (progress: BatchProgress) => void | Promise<void>
  // Called once if the run ended early. `lastGood` is the batch to resume after,
  // and `pending` counts every entry from there on, including a failed streak
  // that must be re-attempted rather than trusted. Reported rather than derived,
  // because a caller must never present an entry it did not look at as
  // approvable.
  onStopped?: (info: { pending: number; lastGood: number }) => void
  // When present, an entry whose verdict is already known is never sent to the
  // model, and every verdict the model reaches is written back. Absent, this
  // behaves exactly as it did before: every entry is asked about every time.
  store?: VerdictCache
  // Which model produced a verdict, so two engines' opinions coexist rather
  // than one overwriting the other.
  engine?: string
  // Identifies the glossary, rules and prompt a verdict was formed under.
  // Required whenever `store` is set.
  configHash?: string
  // Set when the prompt is not the agents' one (the local reviewer's), so its
  // verdicts key apart per entry. See AuditContext.promptVariant for why this
  // is not folded into configHash.
  promptVariant?: string
  // The verdicts answered from the cache, handed over once before the first
  // batch runs. A caller that writes the output file after every batch needs
  // these in it from the start: they never pass through onBatch, so without
  // this an interrupted resume would write a file missing every entry an
  // earlier run had flagged.
  onCached?: (verdicts: Verdict[]) => void | Promise<void>
}

export const DEFAULT_BATCH_SIZE = 25

// Each batch already retries once on its own, so this many in a row is six
// failed calls: past any transient blip and into something systemic, almost
// always an exhausted quota. Grinding on from here costs two process spawns per
// remaining batch and flags every entry it touches as needing a human look, for
// a reason that has nothing to do with the translations.
const MAX_CONSECUTIVE_FAILURES = 3

export const adjudicateWithAgent: Adjudicator = async (batch, opts) => {
  const payload = await runAgent(buildAuditPrompt(batch, opts.locale, opts.nplurals, opts.pluralForms), auditBatchJsonSchema, opts)
  return mapAuditResults(batch, payload)
}

function ruleReason(findings: Finding[]): string {
  return findings.map((f) => f.message).join('; ')
}

export async function auditEntries(opts: AuditOptions): Promise<Verdict[]> {
  const ctx = buildRuleContext({
    locale: opts.locale,
    glossary: opts.glossary,
    nplurals: opts.nplurals,
    entries: opts.entries,
    ...(opts.properNouns ? { properNouns: opts.properNouns } : {}),
    ...(opts.tm ? { tm: opts.tm } : {}),
  })

  const verdicts = new Map<string, Verdict>()
  const candidates: AuditCandidate[] = []
  let memoryApproved = 0
  let memoryRepaired = 0

  for (const original of opts.entries) {
    // Repair what needs no judgment first, then let the rules judge the result.
    // An entry whose only fault was whitespace comes out clean here and takes
    // the ordinary path, rather than being condemned to a file nobody can fix.
    const restored = repairMechanically(original)
    // Then the locale file's fix patterns, on the restored text: both are
    // mechanical, and the rules should judge what the two produced together.
    const fixed = applyFixPatterns({ msgid: original.msgid, msgstr: restored ?? original.msgstr }, ctx.customPatterns ?? [], ctx.locale)
    const repaired = fixed?.forms ?? restored
    const entry = repaired ? { ...original, msgstr: repaired } : original
    const mechanical: Finding[] = [
      ...(restored ? [{ rule: 'repaired', severity: 'suspect' as const, message: 'whitespace restored to match the source' }] : []),
      ...(fixed ? [{ rule: 'repaired', severity: 'suspect' as const, message: `locale rule: ${fixed.notes.join('; ')}` }] : []),
    ]
    const base = repaired ? { text: repaired, repairedBy: 'rules' as const } : {}

    const findings = [...mechanical, ...runRules(entry, ctx)]
    const errors = findings.filter((f) => f.severity === 'error')

    // Before the model and before --no-ai, because what the memory settles is
    // as decided on a rules-only run as on any other. Not cached with the
    // model's verdicts: it is recomputed from the memory on every run, so a
    // TMX import that changes an answer is seen at once, and nothing about it
    // can go stale in the verdict cache or needs the configuration hash to move.
    const key = tmKey(entry.msgid, entry.msgctxt)
    const decision = decideFromMemory(entry, opts.tm?.get(key) ?? [], opts.memoryExact?.has(key) ?? false, opts.locale)
    // An approved translation outranks a suspect rule. On the file this was
    // measured on, every title-case and untranslated hit on an identical match
    // was a label or a brand the locale had approved exactly as written. It
    // does not outrank an error, which is a rule having proved the text broken.
    if (decision?.kind === 'approve' && errors.length === 0) {
      verdicts.set(entry.key, {
        key: entry.key,
        problem: false,
        findings: [],
        reason: 'identical to a translation the locale already approved',
        ...base,
      })
      memoryApproved += 1
      continue
    }
    if (decision?.kind === 'repair') {
      // The approved text is judged like any repair before it is accepted, so
      // a memory row that has itself gone wrong cannot be written in unseen.
      const after = runRules({ ...entry, msgstr: decision.text }, ctx)
      if (!after.some((f) => f.severity === 'error')) {
        verdicts.set(entry.key, {
          key: entry.key,
          problem: true,
          findings: [
            ...findings.filter((f) => f.rule !== 'untranslated' && f.rule !== 'repaired'),
            { rule: 'untranslated', severity: 'error', message: 'left in English; replaced with the approved translation' },
          ],
          reason: 'left in English; the locale already approved a translation of this string',
          text: decision.text,
          repairedBy: 'memory',
        })
        memoryRepaired += 1
        continue
      }
    }

    if (errors.length > 0 && opts.noAi) {
      verdicts.set(entry.key, { key: entry.key, problem: true, findings, reason: ruleReason(findings), ...base })
      continue
    }
    if (opts.noAi) {
      // A mechanical repair is a settled fix, not an unadjudicated guess, so it
      // alone must not mark the entry as needing a human decision.
      const undecided = findings.filter((f) => f.rule !== 'repaired')
      verdicts.set(entry.key, {
        key: entry.key,
        problem: false,
        ...(undecided.length > 0 ? { needsReview: true } : {}),
        findings,
        reason: ruleReason(findings),
        ...base,
      })
      continue
    }
    // Resolved once per entry, from the same matcher the glossary rule uses, so
    // the prompt states the binding terms instead of making the model ask.
    // A setting the code reads takes no glossary term or memory wording: the
    // translator comment decides its value, and "kapalı" for "off" is exactly
    // the mistake a glossary match would invite.
    const control = controlSpec(entry) !== undefined
    const terms = control ? [] : glossaryFor(entry.msgid, ctx)
    const memory = control ? undefined : opts.tm?.get(key)
    candidates.push({
      id: 0,
      key: entry.key,
      msgid: entry.msgid,
      ...(entry.msgctxt ? { msgctxt: entry.msgctxt } : {}),
      ...(entry.msgidPlural ? { msgidPlural: entry.msgidPlural } : {}),
      msgstr: entry.msgstr,
      comments: entry.comments,
      references: entry.references,
      hints: findings,
      ...(terms.length > 0 ? { glossary: terms } : {}),
      ...(memory ? { memory } : {}),
      ...(errors.length > 0 ? { condemned: findings } : {}),
      ...(repaired ? { repaired: { text: repaired, repairedBy: 'rules' as const } } : {}),
      ...(control ? { control: true } : {}),
    })
  }

  // Both counts read from both places an entry can end up. A run with a model
  // leaves everything undecided in `candidates`; --no-ai decides every entry on
  // the spot and leaves `candidates` empty. Reading suspects from the candidate
  // list alone reported none on a rules-only run, which is the one run whose
  // entire output is what the rules were unsure about.
  opts.onRules?.({
    flagged: candidates.filter((c) => c.condemned).length + [...verdicts.values()].filter((v) => v.problem).length,
    // A mechanical repair is decided, so an entry whose only hint is that one is
    // nobody's open question and does not belong in the count.
    suspects:
      candidates.filter((c) => !c.condemned && c.hints.some((f) => f.rule !== 'repaired')).length +
      [...verdicts.values()].filter((v) => v.needsReview).length,
    memoryApproved,
    memoryRepaired,
  })

  const adjudicate = opts.adjudicate ?? adjudicateWithAgent

  // Keyed by the whole question the model was asked, not just by what the entry
  // says. The prompt also carries the references, the comments and the rule
  // findings, and the findings depend on every other entry in the same file,
  // so a key covering only the text would serve a verdict formed under one
  // file's evidence for another file's. The hints go in as the prompt renders
  // them, message and all, because a message can be file-derived too:
  // `inconsistent` counts how many ways this file translates the same source,
  // so editing one entry changes another entry's prompt without touching its
  // text or the names of the rules that fired. `repaired` is excluded because
  // the prompt withholds it, and auditSrcHash sorts, so the order they fired in
  // cannot turn a hit into a miss.
  const cacheKey = (candidate: AuditCandidate): VerdictKey => ({
    srcHash: auditSrcHash(
      {
        msgid: candidate.msgid,
        ...(candidate.msgctxt ? { msgctxt: candidate.msgctxt } : {}),
        ...(candidate.msgidPlural ? { msgidPlural: candidate.msgidPlural } : {}),
        msgstr: candidate.msgstr,
      },
      {
        references: candidate.references,
        comments: candidate.comments,
        hints: candidate.hints.filter((f) => f.rule !== 'repaired').map((f) => `${f.rule}: ${f.message}`),
        ...(candidate.memory ? { memory: candidate.memory } : {}),
        nplurals: opts.nplurals,
        ...(opts.pluralForms === undefined ? {} : { pluralForms: opts.pluralForms }),
        repaired: candidate.repaired !== undefined,
        ...(opts.promptVariant === undefined ? {} : { promptVariant: opts.promptVariant }),
      },
    ),
    configHash: opts.configHash ?? '',
    locale: opts.locale,
    engine: opts.engine ?? 'claude',
  })

  // An entry already judged under this configuration, in this file's context,
  // is settled, so it never reaches a batch. That is the whole of resume: a
  // first run finds nothing here and does all the work, a resumed one finds
  // most of it, and a re-run after an edit finds everything but the entries
  // that changed.
  const outstanding: AuditCandidate[] = []
  const fromCache: Verdict[] = []
  for (const candidate of candidates) {
    const hit = opts.store?.get(cacheKey(candidate))
    if (!hit) {
      outstanding.push(candidate)
      continue
    }
    const verdict = toVerdict(candidate, { id: 0, ...hit }, ctx, opts.nplurals)
    verdicts.set(candidate.key, verdict)
    fromCache.push(verdict)
  }
  if (fromCache.length > 0) await opts.onCached?.(fromCache)

  const batches = chunk(outstanding, opts.batchSize ?? DEFAULT_BATCH_SIZE)

  // 1-based index of the first batch in the current run of failures, so the
  // breaker can rewind past the whole streak rather than just the last one.
  let streakStart = 0
  let consecutiveFailures = 0

  // `at` is the 0-based index of the first batch that should NOT be trusted.
  // Everything from there on is pending, so its verdicts are dropped rather than
  // returned: an entry counted both as a problem and as still-to-do is counted
  // twice, and the arithmetic that follows goes negative.
  const stopAfter = (at: number): void => {
    for (const batch of batches.slice(at)) {
      for (const candidate of batch) verdicts.delete(candidate.key)
    }
    opts.onStopped?.({
      lastGood: at,
      pending: batches.slice(at).reduce((n, batch) => n + batch.length, 0),
    })
  }

  for (const [i, rawBatch] of batches.entries()) {
    // Before the batch, never inside it: whatever the previous batch decided has
    // already been persisted by its onBatch, so parking here loses nothing.
    if (opts.control && (await opts.control.gate()) === 'stop') {
      stopAfter(i)
      break
    }
    // Ids are per batch and 1-based: the model never has to echo a gettext key,
    // whose msgctxt separator does not survive a JSON schema round-trip.
    const batch = rawBatch.map((c, n) => ({ ...c, id: n + 1 }))
    const position = { index: i + 1, of: batches.length, size: batch.length }
    opts.onBatchStart?.(position)

    const outcome = await runBatch(adjudicate, batch, opts)

    let problems = 0
    const decided: Verdict[] = []
    for (const [n, candidate] of batch.entries()) {
      const verdict = outcome.results
        ? toVerdict(candidate, outcome.results[n]!, ctx, opts.nplurals)
        : unreviewed(candidate)
      if (verdict.problem) problems += 1
      verdicts.set(candidate.key, verdict)
      // Only what the model actually said, and only when it said something. A
      // failed batch produces `unreviewed` verdicts, and caching those would
      // turn a quota outage into a permanent verdict.
      if (opts.store && outcome.results) {
        const result = outcome.results[n]!
        opts.store.put(cacheKey(candidate), {
          problem: result.problem,
          categories: result.categories,
          reason: result.reason,
          ...(result.fix ? { fix: result.fix } : {}),
        })
      }
      decided.push(verdict)
    }
    await opts.onBatch?.({
      ...position,
      problems,
      verdicts: decided,
      ...(outcome.failed ? { failed: outcome.failed } : {}),
    })

    if (outcome.failed) {
      if (consecutiveFailures === 0) streakStart = position.index
      consecutiveFailures += 1
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        stopAfter(streakStart - 1)
        break
      }
    } else {
      consecutiveFailures = 0
    }
  }

  return opts.entries.map((e) => verdicts.get(e.key)!).filter(Boolean)
}

async function runBatch(
  adjudicate: Adjudicator,
  batch: AuditCandidate[],
  opts: AuditOptions,
): Promise<{ results?: AuditResult[]; failed?: string }> {
  // Assembled field by field rather than spread, so that an option meant for
  // the audit never leaks into an agent invocation. The cost is that a new
  // option is silently dropped until it is added here: `provider` was, and
  // every review that recorded `antigravity` spawned `claude`, cached its
  // verdicts under the other agent's key and spent the wrong subscription.
  const agentOpts = {
    locale: opts.locale,
    nplurals: opts.nplurals,
    ...(opts.pluralForms === undefined ? {} : { pluralForms: opts.pluralForms }),
    mcpConfigPath: opts.mcpConfigPath ?? '',
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.bin ? { bin: opts.bin } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  }
  let failed = 'unknown error'
  // Every failure gets the second attempt, including one where the agent ran
  // to completion and refused to answer. 0.12.0 skipped that one on the
  // reasoning that an identical prompt buys an identical refusal, and lost a
  // hundred entries to it within the hour.
  //
  // The reasoning generalised from a single batch that reached for a shell on
  // both attempts, and that batch was provoked by its own content: it wanted
  // to count its entries, which the prompt now states. What is left is an
  // agent that asks for a shell on its first turn, before it has read an
  // entry, on roughly one batch in seven. Nothing about the prompt decides it.
  //
  // A retry is not a replay. Each attempt spawns the CLI afresh, so the second
  // is a new conversation sampled again, and a refusal costs four seconds
  // rather than the minutes a real batch takes. The expensive mistake is
  // skipping it.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { results: await adjudicate(batch, agentOpts) }
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err)
    }
  }
  return { failed }
}

// The one place a candidate genuinely has to become an entry again: judgeFix
// re-runs the rules over the model's proposed text, and the rules read the
// whole entry. Nothing else reconstructs one, so nothing else can look like it
// is feeding context to a hash that would ignore it.
function candidateToEntry(candidate: AuditCandidate): AuditEntry {
  return {
    key: candidate.key,
    msgid: candidate.msgid,
    ...(candidate.msgctxt ? { msgctxt: candidate.msgctxt } : {}),
    ...(candidate.msgidPlural ? { msgidPlural: candidate.msgidPlural } : {}),
    msgstr: candidate.msgstr,
    comments: candidate.comments,
    references: candidate.references,
    fuzzy: false,
  }
}

function toVerdict(candidate: AuditCandidate, result: AuditResult, ctx: RuleContext, nplurals: number): Verdict {
  // A rule error is a mechanical fact. The model was asked for a fix, not for a
  // second opinion, so it cannot clear one.
  const problem = candidate.condemned !== undefined || result.problem

  const aiFindings: Finding[] = result.problem
    ? result.categories.map((category) => ({
        rule: `ai:${category}`,
        severity: 'error' as const,
        message: result.reason,
      }))
    : []
  // A cleared entry keeps the note for a repair the rules already made. Nothing
  // else records that the text in the file is not what was submitted, and an
  // entry with no note at all is invisible to a resume, which would revert it.
  const findings = problem ? [...candidate.hints, ...aiFindings] : candidate.hints.filter((f) => f.rule === 'repaired')

  const base: Verdict = { key: candidate.key, problem, findings, reason: result.reason, ...(candidate.repaired ?? {}) }
  if (!problem || !result.fix) return base

  const verdict = judgeFix({ entry: candidateToEntry(candidate), fix: result.fix, nplurals, ctx })
  // What the fix brought in is checked here, where a verdict becomes a result,
  // and not where the model is asked. That keeps it out of the prompt and so out
  // of the cache key, and a verdict served from the cache comes through this
  // same line and is checked the same way: no cached verdict had to be pruned
  // for the check to apply to it.
  if ('accepted' in verdict) {
    return {
      ...base,
      ...(verdict.suspect ? { findings: [...findings, verdict.suspect] } : {}),
      text: verdict.accepted,
      repairedBy: 'model',
    }
  }
  // Say so rather than dropping it. Silence here looks like the model declined,
  // which is a different thing and hides a real signal about the prompt.
  return { ...base, findings: [...findings, { rule: 'fix-rejected', severity: 'suspect', message: verdict.rejected }] }
}

// A batch we failed to review is never silently approved: a false negative ships a
// bad translation, a false positive costs one retranslation.
function unreviewed(candidate: AuditCandidate): Verdict {
  return {
    key: candidate.key,
    problem: true,
    unreviewed: true,
    findings: [
      ...candidate.hints,
      { rule: 'unreviewed', severity: 'error', message: 'automated review failed for this entry' },
    ],
    reason: 'this entry could not be reviewed automatically and needs a human look',
    ...(candidate.repaired ?? {}),
  }
}
