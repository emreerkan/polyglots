import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type Database from 'better-sqlite3'
import { groupFor, OTHER_GROUP } from '../review/message.js'
import { configuredModel, type AgentRunOptions } from '../agent/run.js'
import { createLocalChat, localIdleTimeoutMs, localModelId, resolveLocalTarget, type LocalChat } from '../draft/local-chat.js'
import { auditPromptVariant, createLocalAdjudicator } from '../review/local.js'
import {
  auditEntries,
  DEFAULT_BATCH_SIZE,
  type Adjudicator,
  type Verdict,
  type VerdictCache,
} from '../audit/audit.js'
import {
  encodeMarker,
  MARKER_HEADER,
  writtenByEarlierVersion,
  type ReviewMarker,
} from '../audit/resume.js'
import {
  endRun,
  configHash as computeConfigHash,
  engineId,
  finishRun,
  getAuditVerdict,
  openJobsDb,
  reapAbandonedRuns,
  pruneStaleConfigs,
  putAuditVerdict,
  recordBatchFailure,
  startRun,
} from '../jobs/index.js'
import { writeMcpConfig, MCP_ENV } from '../mcp/config.js'
import { loadPo, type Annotation } from '../po/po-file.js'
import type { RunControl } from '../run-control.js'
import { loadConfig } from '../config.js'
import { languageOf } from '../wporg/locales.js'
import { tmKey } from '../audit/rules/index.js'
import { FIX_SUSPECT_RULE } from '../audit/repair.js'
import { allGlossary, findMemory, openDb } from '../storage/index.js'
import { isSkipFinding } from '../rules/custom.js'
import { takeSkipped } from '../rules/sandbox.js'
import type {
  AuditEntry,
  Locale,
  ReviewChoice,
  ReviewEntry,
  ReviewEntryOutcome,
  ReviewEvent,
  ReviewSummary,
} from '../types.js'

export interface ReviewOptions extends Partial<Omit<AgentRunOptions, 'provider'>> {
  // An agent CLI, or the experimental local reviewer. Defaults to the
  // configured one.
  provider?: ReviewChoice
  file: string
  locale: Locale
  outDir?: string
  noAi?: boolean
  batchSize?: number
  properNouns?: string[]
  // Ignore the verdicts an earlier run cached for this file and ask the model
  // again. The cache is still written, so the next run resumes from this one.
  fresh?: boolean
  // Lets the caller park the run between batches, or end it early and come back.
  control?: RunControl
  db?: Database.Database
  jobsDb?: Database.Database
  adjudicate?: Adjudicator
  // Stands in for the local model's transport, for tests.
  localChat?: LocalChat
  onProgress?: (event: ReviewEvent) => void
}

// The name says whether a model was in the loop, because that decides whether
// anything beyond mechanical whitespace could have been repaired.
const OUTPUT_SUFFIXES = { rules: 'problems', ai: 'repaired' } as const

// Exported so a batch can find, before anything runs, two inputs that would
// write the same file: with --out-dir, two folders' foo-tr.po both land on
// one foo-tr-repaired.po, and the last writer would silently win.
export function outputPath(file: string, opts: { outDir?: string; noAi?: boolean }): string {
  const dir = opts.outDir ?? dirname(file)
  const suffix = opts.noAi ? OUTPUT_SUFFIXES.rules : OUTPUT_SUFFIXES.ai
  return join(dir, `${basename(file, extname(file))}-${suffix}.po`)
}

/**
 * Whether a file is named as a review's output. Read from the name alone,
 * the way outputPath writes it: the menu's pickers refuse to mark one for a
 * batch, since reviewing a problems file is reviewing the review, and a
 * batch marked with `*` across a folder of finished reviews would otherwise
 * pick up every output beside its input.
 */
export function isReviewOutput(file: string): boolean {
  const name = basename(file).toLowerCase()
  return Object.values(OUTPUT_SUFFIXES).some((suffix) => name.endsWith(`-${suffix}.po`))
}

function readGlossary(locale: Locale, injected?: Database.Database) {
  if (injected) return allGlossary(injected, locale)
  const db = openDb()
  try {
    return allGlossary(db, locale)
  } finally {
    db.close()
  }
}

/**
 * What the memory holds for each entry, and which of those matches may settle
 * an entry without a model.
 *
 * Resolved once, here, because the rules read no database and one indexed
 * lookup per entry is cheaper than the alternative: asking the model to look
 * them up, one round trip at a time, for the 45% of entries the memory has
 * nothing useful to say about.
 *
 * The lookup falls back to a row with no context when an entry's own msgctxt
 * finds nothing. That fallback stays in `memory`, where it is only a hint in the
 * prompt, and is kept out of `exact`, because a msgctxt exists exactly where a
 * source is ambiguous and deciding from a row that ignored it would be deciding
 * the ambiguous case blind. An entry with no msgctxt is only ever looked up
 * without one, so its match is exact by construction.
 *
 * `weak` holds the keys whose every row is long text. findMemory has already
 * put normal rows first, so the prompt lists those ahead of the readme
 * wordings without being told which is which; only tm-conflict needs the set.
 */
function readMemory(
  entries: AuditEntry[],
  locale: Locale,
  injected?: Database.Database,
): { memory: Map<string, readonly string[]>; exact: Set<string>; weak: Set<string> } {
  const db = injected ?? openDb()
  try {
    const memory = new Map<string, readonly string[]>()
    const exact = new Set<string>()
    const weak = new Set<string>()
    for (const entry of entries) {
      const hits = findMemory(db, entry.msgid, locale, entry.msgctxt)
      if (hits.length === 0) continue
      const key = tmKey(entry.msgid, entry.msgctxt)
      memory.set(key, hits.map((h) => h.target))
      if (hits.every((h) => h.weight === 'low')) weak.add(key)
      // Every alternative comes from one lookup, so they share a context and
      // the first answers for all of them.
      if (!entry.msgctxt || hits[0]!.context === entry.msgctxt) exact.add(key)
    }
    return { memory, exact, weak }
  } finally {
    if (!injected) db.close()
  }
}

function submitted(entry: AuditEntry): boolean {
  return entry.msgstr.some((s) => s !== '')
}

// byRule: how often each rule fired over the flagged entries, for the reviewer
// and the stats page, never for the requester. A locale rule skipped as a
// runaway is counted here, under `custom`, on an entry flagged for something
// else: the maintainer's own statistic should show the rules file misbehaving.
// An entry whose only finding is the skip is not flagged, so it is not counted.
function tally(verdicts: Verdict[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const verdict of verdicts) {
    if (!verdict.problem && !verdict.needsReview) continue
    for (const rule of new Set(verdict.findings.map((f) => f.rule))) {
      counts[rule] = (counts[rule] ?? 0) + 1
    }
  }
  return counts
}

// Counted over the entries that were actually repaired, so every group is a
// subset of the number the requester message leads with. Tallying flagged
// entries instead would let a group exceed the count of fixes stated in the same
// sentence, which is the kind of arithmetic a reader checks.
//
// One increment per entry per distinct group: an entry the glossary rule and the
// model both caught is one glossary fix, not two. `tally` above deliberately
// counts it twice, because there the question is how often a rule fired.
function groupTally(verdicts: Verdict[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const verdict of verdicts) {
    if (verdict.text === undefined) continue
    // A fix-suspect is what the model's own fix broke, so it is no fault of the
    // contributor's and the message posted back to them must not count it. Left
    // in, it would land in `other`, which claims every rule the named groups do
    // not, and add a fault to the public tally that nobody they wrote made. A
    // locale rule skipped as a runaway is left out for the same reason: the
    // fault is the rules file's (maintainer ruling 2026-10-16).
    const groups = new Set(
      verdict.findings.filter((f) => f.rule !== FIX_SUSPECT_RULE && !isSkipFinding(f)).map((f) => groupFor(f.rule)),
    )
    // A repaired entry with no findings is a mechanical fix nothing named. It
    // still happened, so it lands in `other` rather than leaving the groups
    // unable to account for every entry the message claims.
    if (groups.size === 0) groups.add(OTHER_GROUP)
    for (const group of groups) counts[group] = (counts[group] ?? 0) + 1
  }
  return counts
}

// Long enough for the widest frame (113 columns, less the outcome column), and
// short enough that a batch of help-text paragraphs does not ship kilobytes of
// prose to a screen that shows one line of each. The screen truncates again to
// its own width.
const MSGID_DISPLAY_MAX = 80

/**
 * A msgid as one display line: whitespace runs, newlines included, collapsed to
 * a space, and an ellipsis where it was cut. A msgid holding a newline would
 * otherwise push every line below it down a row, in a panel whose height is
 * fixed.
 */
// Counted and cut by grapheme, not by UTF-16 unit, so an emoji's surrogate
// pair or a joined family sequence is kept whole or left out whole.
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function shortMsgid(msgid: string): string {
  const flat = msgid.replace(/\s+/g, ' ').trim()
  const parts = Array.from(graphemes.segment(flat), (g) => g.segment)
  return parts.length <= MSGID_DISPLAY_MAX ? flat : `${parts.slice(0, MSGID_DISPLAY_MAX - 1).join('').trimEnd()}…`
}

// The order matters: a failed batch's entries are also problems, and a repair is
// the more useful thing to say about an entry than that it was wrong, since
// the file already holds the fix.
function landed(verdict: Verdict, msgid: string): ReviewEntry {
  const outcome: ReviewEntryOutcome = verdict.unreviewed
    ? 'unreviewed'
    : verdict.text !== undefined
      ? 'repaired'
      : verdict.problem || verdict.needsReview
        ? 'flagged'
        : 'approved'
  // `repaired` is the rules' note to themselves that they rewrote the text,
  // not a fault anyone needs named.
  const rules = [...new Set(verdict.findings.map((f) => f.rule))].filter((r) => r !== 'repaired')
  return { key: verdict.key, msgid: shortMsgid(msgid), outcome, ...(rules.length > 0 ? { rules } : {}) }
}

function addTally(into: Record<string, number>, from: Record<string, number>): Record<string, number> {
  for (const [rule, n] of Object.entries(from)) into[rule] = (into[rule] ?? 0) + n
  return into
}

// Names the locale team maintains in config.json, keyed by language so a
// regional locale (pt-br) or a translation set (nl/formal) still picks up the
// language's list. languageOf rather than a split on - and _, which left
// nl/formal reading only its own key.
export function configuredProperNouns(locale: Locale): string[] {
  let all: Record<string, string[]>
  try {
    all = loadConfig().properNouns ?? {}
  } catch {
    return []
  }
  const language = languageOf(locale)
  return [...(all[locale] ?? []), ...(language === locale ? [] : (all[language] ?? []))]
}

export async function reviewFile(opts: ReviewOptions): Promise<ReviewSummary> {
  // Read once, at the top: a run must not change agent part way because the
  // setting moved underneath it, and every verdict it caches is keyed by this.
  const provider = opts.provider ?? loadConfig().reviewProvider
  // `none` is a standing choice to review without AI, so it is --no-ai
  // without having to say so on every run. Folded in here rather than at each
  // caller, so the CLI, both TUI screens and fetch cannot disagree about it,
  // and so nothing below can reach for an agent the person never set up.
  const noAi = opts.noAi === true || provider === 'none'
  // A local model has no CLI and no MCP. It gets its own adjudicator, its own
  // prompt variant in every key, and an engine id that names the server and
  // model (`local:ollama:<model>`), so its verdicts can never be served as an
  // agent's or the other way round. Resolved here, before the run row exists,
  // so a target with no model is refused rather than recorded as a failure.
  const localSettings = provider === 'local' && !noAi ? loadConfig() : undefined
  const local = localSettings ? resolveLocalTarget(localSettings, opts.model) : undefined
  const agent = provider === 'local' || provider === 'none' ? undefined : provider
  // What the engine id records. An explicit --model settles it; otherwise ask
  // the provider what it is configured to run, because antigravity chooses its
  // own from its own settings file and a verdict Flash formed must not be
  // served as Pro's. Undefined for claude, and for an antigravity whose
  // settings cannot be read, which records the bare provider name exactly as
  // every row written before this did.
  const engine = local
    ? engineId(localModelId(local), 'local')
    : engineId(opts.model ?? (agent ? configuredModel(agent) : undefined), provider)
  const adjudicate = local ? (opts.adjudicate ?? createLocalAdjudicator(opts.localChat ?? createLocalChat(local, { idleTimeoutMs: localIdleTimeoutMs(localSettings!) }), engine)) : opts.adjudicate
  const glossary = readGlossary(opts.locale, opts.db)
  if (glossary.length === 0) {
    throw new Error(
      `No cached glossary for locale "${opts.locale}"; run: polyglots glossary sync --locale ${opts.locale}`,
    )
  }

  const po = await loadPo(opts.file)
  // Before the job row and before any agent: a run that would write the wrong
  // number of forms is refused, not recorded as one that failed.
  po.requirePluralForms(opts.locale)
  const pluralForms = po.promptPluralForms()
  const all = po.auditEntries()
  const reviewable = all.filter(submitted)
  const emit = opts.onProgress ?? (() => {})
  // Whatever an earlier run in this process left unreported (a rules try in
  // the TUI, say) is not this run's to name. A pattern skipped back then is
  // named again below if this run asks for it.
  takeSkipped()

  const target = outputPath(opts.file, { ...(opts.outDir === undefined ? {} : { outDir: opts.outDir }), noAi })
  const properNouns = opts.properNouns ?? configuredProperNouns(opts.locale)
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE

  // An unfinished review used to be recovered from a marker in the output
  // file's header, with the flagged entries read back out of the file itself.
  // Both are gone: what a previous run decided is in the job store, keyed by
  // what it looked at, so resuming is just a cache that already has most of
  // its answers. A marker written by 0.2.0 through 0.4.0 is ignored, and the
  // run starts over, exactly as the FORMAT=2 bump did in 0.3.0.
  const jobs = opts.jobsDb ?? openJobsDb()
  const ownsJobsDb = opts.jobsDb === undefined
  // Clear rows a hard kill left at `running` before opening a new one, so the
  // history this run joins does not already claim two jobs are in flight. Only
  // rows whose process is gone are touched; a genuinely concurrent run is left
  // alone. Deliberately not done in `stats`, which promises to write nothing.
  reapAbandonedRuns(jobs)

  // Everything below opens a run in `jobs` and does real work against it, so
  // from here on a throw (a caller's onProgress blowing up, a batch that
  // could not even produce an unreviewed verdict) must not leak the handle
  // this call opened, nor leave history claiming the run is still going.
  let runId: number | undefined
  let summary: ReviewSummary
  try {
    const config = computeConfigHash({ locale: opts.locale, glossary, properNouns })
    // The cache holds verdicts for the current configuration and nothing else.
    //
    // Not on a rules-only run, which neither reads nor writes a verdict. The
    // rows it would delete are an agent's, formed under a glossary or rule set
    // that has since changed, and they come back into use if that change is
    // undone. A run that judged nothing is not the one to decide they are
    // garbage; the next run that does judge prunes them exactly as before.
    if (!noAi) pruneStaleConfigs(jobs, 'audit_verdict', opts.locale, config)

    // A marker written by 0.2.0 through 0.4.0 no longer means anything, and this
    // run will review the file from the top. Saying nothing would look like a
    // resume that silently redid five hours of work.
    //
    // Only for those, though. This build writes a marker on every save, so
    // firing on the header's mere presence told a reviewer their unfinished
    // work had been discarded every time they re-ran over the same submission,
    // when in fact the run was about to serve most of it from the cache.
    if (!opts.fresh) {
      const previous = await loadPo(target).catch(() => undefined)
      const header = previous?.headers[MARKER_HEADER]
      if (header !== undefined && writtenByEarlierVersion(header)) emit({ type: 'marker-ignored', file: target })
    }

    // --no-ai reaches no model, so there is nothing to cache and nothing to reuse.
    const store: VerdictCache | undefined = noAi
      ? undefined
      : {
          get: (key) => (opts.fresh ? undefined : getAuditVerdict(jobs, key)),
          put: (key, verdict) => putAuditVerdict(jobs, key, verdict),
        }

    runId = startRun(jobs, {
      file: opts.file,
      ...(po.headers['Project-Id-Version'] ? { project: po.headers['Project-Id-Version'] } : {}),
      command: 'review',
      locale: opts.locale,
      nplurals: po.nplurals,
      batchSize,
      // --no-ai reaches no model, so nothing in this run was judged by one.
      // History cannot be backfilled, and a per-engine quality breakdown built
      // on it later would be reading rule findings as Claude's opinions.
      engine: noAi ? 'rules' : engine,
    })

    emit({
      type: 'start',
      file: opts.file,
      total: all.length,
      reviewable: reviewable.length,
    })

    // Nothing reads it on --no-ai or for a local model, which has no MCP.
    const mcpConfigPath =
      opts.mcpConfigPath ?? (noAi || local ? '' : await writeMcpConfig({ env: { [MCP_ENV.locale]: opts.locale } }))

    const marker: ReviewMarker = {
      done: 0,
      of: 0,
      problems: 0,
      unreviewed: 0,
      repaired: 0,
      byRule: {},
    }

    // A large submission is hundreds of batches and hours of wall clock, so the file
    // is rewritten after every one, marker and all. Losing it to a Ctrl+C is not
    // acceptable, and re-parsing the source each time is cheaper than the AI call
    // that preceded it.
    const decided: Verdict[] = []
    // Entries in batches the run never reached. Reported by auditEntries rather
    // than derived here, so a stopped run cannot mis-state what it looked at.
    let pending = 0
    let wrote = false
    const persist = async (): Promise<number> => {
      const annotations = new Map<string, Annotation>()
      for (const verdict of decided) {
        // A repair with nothing else wrong is neither a problem nor a guess, and it
        // still belongs in the file: it is the only copy of the correction. So
        // does an entry a locale pattern ran away on, which the model may have
        // cleared without ever being asked about the pattern: the problems file
        // is where the maintainer learns which entry it hung on.
        if (!verdict.problem && !verdict.needsReview && verdict.text === undefined && !verdict.findings.some(isSkipFinding)) continue
        const notes = verdict.findings.map((f) => f.message)
        annotations.set(verdict.key, {
          // A verdict with no findings still has to say something: keepOnly would
          // otherwise fall back to a generic note, and the model's own reason is
          // the better line to give the human reading the file.
          notes: notes.length > 0 ? notes : [verdict.reason],
          ...(verdict.text === undefined ? {} : { text: verdict.text }),
        })
      }
      if (opts.outDir) await mkdir(opts.outDir, { recursive: true })
      const out = await loadPo(opts.file)
      out.keepOnly(annotations)
      out.setHeader(MARKER_HEADER, encodeMarker(marker))
      await out.save(target)
      // A file holding nothing but the marker is bookkeeping, not a result, so it
      // is not announced.
      if (!wrote && annotations.size > 0) {
        wrote = true
        emit({ type: 'written', file: target })
      }
      return annotations.size
    }

    const remembered = readMemory(reviewable, opts.locale, opts.db)
    // A verdict carries the key, which glues the msgctxt on; the list shows the msgid.
    const msgidOf = new Map(reviewable.map((e) => [e.key, e.msgid]))
    const verdicts = await auditEntries({
      entries: reviewable,
      tm: remembered.memory,
      memoryExact: remembered.exact,
      ...(remembered.weak.size > 0 ? { tmWeak: remembered.weak } : {}),
      locale: opts.locale,
      nplurals: po.nplurals,
      ...(pluralForms === undefined ? {} : { pluralForms }),
      glossary,
      properNouns,
      mcpConfigPath,
      batchSize,
      engine,
      configHash: config,
      ...(local ? { promptVariant: auditPromptVariant(opts.locale) } : {}),
      ...(noAi ? { noAi: true } : opts.noAi === undefined ? {} : { noAi: opts.noAi }),
      ...(store ? { store } : {}),
      ...(opts.control ? { control: opts.control } : {}),
      onStopped: (info) => {
        pending = info.pending
        // Rewind past a failed streak, so the marker written into the file does
        // not claim batches whose verdicts were dropped. Nothing reads `done`
        // back: this is about what a person opening the file is told, not about
        // what the next run does. The next run re-attempts those entries because
        // no verdict was ever cached for them.
        marker.done = Math.min(marker.done, info.lastGood)
      },
      ...(adjudicate ? { adjudicate } : {}),
      // The agent options mean nothing to a local model, and `provider` must
      // never reach runAgent as `local`: the audit would spawn the default CLI.
      ...(agent && opts.bin ? { bin: opts.bin } : {}),
      ...(agent ? { provider: agent } : {}),
      ...(agent && opts.model ? { model: opts.model } : {}),
      onRules: (r) =>
        emit({
          type: 'rules-done',
          flagged: r.flagged,
          suspects: r.suspects,
          memoryApproved: r.memoryApproved,
          memoryRepaired: r.memoryRepaired,
        }),
      onBatchStart: (b) => emit({ type: 'batch-start', index: b.index, of: b.of, size: b.size, at: Date.now() }),
      // Entries an earlier run already judged. They belong in the output file
      // from the first write, not only in the last one, or a run interrupted
      // part way through a resume would write a file that had lost them.
      onCached: async (cached) => {
        emit({ type: 'cached', entries: cached.length, batches: Math.ceil(cached.length / batchSize) })
        decided.push(...cached)
        await persist()
      },
      onBatch: async (b) => {
        // Before anything that can throw, so the reason outlives the run. The
        // last attempt gave the batch up only when the batch is marked failed;
        // otherwise the retry rescued it and every row is an attempt that failed.
        for (const a of b.attempts ?? []) {
          recordBatchFailure(jobs, {
            runId: runId!,
            batch: b.index,
            attempt: a.attempt,
            size: b.size,
            phase: 'review',
            reason: a.reason,
            ms: a.ms,
            final: b.failed !== undefined && a.attempt === b.attempts!.length,
            at: Date.now(),
          })
        }
        decided.push(...b.verdicts)
        marker.done = b.index
        marker.of = b.of
        marker.problems += b.verdicts.filter((v) => v.problem).length
        marker.unreviewed += b.verdicts.filter((v) => v.unreviewed).length
        marker.repaired += b.verdicts.filter((v) => v.text !== undefined).length
        addTally(marker.byRule, tally(b.verdicts))
        await persist()
        // Before the batch's terminal event, so a screen that redraws on that one
        // already has the entries it is about to list.
        emit({ type: 'entries', index: b.index, entries: b.verdicts.map((v) => landed(v, msgidOf.get(v.key) ?? v.key)) })
        // One terminal event per batch: the reducer counts either as progress, so
        // emitting both would advance the bar twice.
        if (b.failed) emit({ type: 'batch-failed', index: b.index, size: b.size, reason: b.failed, at: Date.now() })
        else emit({ type: 'batch-done', index: b.index, problems: b.problems, at: Date.now() })
      },
    })

    const problems = verdicts.filter((v) => v.problem)
    // Set only when the run was stopped part way, by auditEntries, which is the
    // only thing that knows exactly which batches it never reached.

    const needsReview = verdicts.filter((v) => v.needsReview)

    // The marker is accumulated per batch so a Ctrl+C between batches leaves a
    // usable one, but these are the authority at the end: a run that dropped an
    // untrusted tail must not leave those counts behind in the header. The summary
    // then reads the same numbers, so the file and the report cannot disagree.
    marker.problems = problems.length
    marker.unreviewed = verdicts.filter((v) => v.unreviewed).length
    marker.repaired = verdicts.filter((v) => v.text !== undefined).length
    marker.byRule = tally(verdicts)

    // The rules-only path decides everything up front, so nothing was persisted yet.
    decided.length = 0
    decided.push(...verdicts)
    const written = await persist()

    summary = {
      file: opts.file,
      locale: opts.locale,
      total: all.length,
      skipped: all.length - reviewable.length,
      reviewed: reviewable.length,
      problems: marker.problems,
      needsReview: needsReview.length,
      approvable: reviewable.length - problems.length - needsReview.length - pending,
      pending,
      unreviewed: marker.unreviewed,
      repaired: marker.repaired,
      written,
      byRule: marker.byRule,
      byGroup: groupTally(verdicts),
    }

    if (written > 0) summary.problemsFile = target
    // Nothing was flagged, so the only thing left in the file is the marker,
    // which nothing reads back. A finished review has said all it has to say, so
    // the file goes rather than sitting there looking like a result. A run that
    // was stopped part way keeps it: it has entries nothing has looked at yet,
    // and no file at all reads as "nothing to fix here".
    else if (pending === 0) await rm(target, { force: true })

    // Written once, from the same numbers the caller is about to be given, so the
    // history and the report cannot disagree. A run stopped part way is ended
    // rather than marked done: it has no totals worth freezing. It ends as
    // `stopped`, not as a fault: the operator asked for it, and what it got
    // through is cached for the run that resumes it.
    if (pending > 0) endRun(jobs, runId, 'stopped')
    else {
      finishRun(jobs, runId, {
        entries: summary.reviewed,
        flagged: summary.problems,
        repaired: summary.repaired,
        unreviewed: summary.unreviewed,
        approvable: summary.approvable,
        byCategory: summary.byRule,
      })
    }
  } catch (err) {
    // A run in progress when this throws is neither done nor still running: mark
    // it stopped so history does not claim otherwise, before the handle it needs
    // to do that is closed underneath it.
    if (runId !== undefined) endRun(jobs, runId, 'failed')
    throw err
  } finally {
    if (ownsJobsDb) jobs.close()
  }

  // Outside the try on purpose: by here the run's history is settled, and a
  // caller whose progress handler throws must not be able to rewrite it. A
  // failed notification is not a failed review.
  // Each runaway pattern once per run, however many entries it would have
  // run on: the entry where it hung carries the finding, this the summary line.
  // Named by label, and two patterns can share a note, so the same line once.
  const skippedRules = [...new Set(takeSkipped().map((s) => s.label))]
  if (skippedRules.length > 0) summary.skippedRules = skippedRules
  emit({ type: 'done', summary })
  return summary
}
