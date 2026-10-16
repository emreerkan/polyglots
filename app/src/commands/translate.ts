import type Database from 'better-sqlite3'
import { controlSpec } from '../audit/control.js'
import { createDraftChecker } from '../translate/checks.js'
import { configuredProperNouns, shortMsgid } from './review.js'
import { intlTag } from '../wporg/locales.js'
import { chunk } from '../batch.js'
import type { RunControl } from '../run-control.js'
import { loadConfig, loadSecrets } from '../config.js'
import { configuredModel } from '../agent/providers.js'
import {
  draftEngineId,
  DraftQuotaError,
  DraftRateLimitError,
  getDraftEngine,
  normalizeDraftEngine,
  type DraftEngineInput,
} from '../draft/index.js'
import { createLocalChat, localIdleTimeoutMs, localModelId, resolveLocalTarget, type LocalChat } from '../draft/local-chat.js'
import { createLocalDraftReviewer, draftReviewPromptVariant } from '../review/local.js'
import {
  endRun,
  draftConfigHash,
  draftHash,
  finishRun,
  getDraft,
  getDraftVerdict,
  openJobsDb,
  reapAbandonedRuns,
  pruneStaleConfigs,
  putDraft,
  putDraftVerdict,
  draftSrcHash,
  engineId,
  startRun,
  translateConfigHash,
  type DraftReview,
} from '../jobs/index.js'
import { MCP_ENV, writeMcpConfig } from '../mcp/config.js'
import { loadPo, type ApplyResult, type PoFile } from '../po/po-file.js'
import { reviewBatch } from '../review/draft-review.js'
import { allGlossary, findMemory, openDb } from '../storage/index.js'
import { normalizeLocale } from '../tmx/parse.js'
import type {
  DraftEngine,
  Locale,
  ReviewChoice,
  ReviewInput,
  ReviewResult,
  Secrets,
  TranslationUnit,
} from '../types.js'

/**
 * One entry as it lands, for the run screen's list of recent entries.
 *
 * `memory` and `drafted` are written as they stand; `fuzzy` is written for a
 * human to confirm, and `from` says whether the memory offered more than one
 * approved wording or the reviewer doubted the engine's draft. `skipped` is a
 * batch that failed and left the entry as it was. `msgid` is shortened for
 * display, as in review's ReviewEntry.
 */
export type TranslateEntryOutcome = 'memory' | 'drafted' | 'fuzzy' | 'skipped'

export interface TranslateEntry {
  key: string
  msgid: string
  outcome: TranslateEntryOutcome
  from?: 'memory' | 'engine'
}

export type TranslateEvent =
  | { type: 'start'; file: string; total: number; pending: number }
  | { type: 'tm-hit'; count: number }
  // What the memory filled (right after tm-hit, without `index`) or what one
  // batch drafted or skipped (just before its batch-done or batch-skipped).
  // Once per batch, never per entry, and ignored by the CLI reporter.
  | { type: 'entries'; index?: number; entries: TranslateEntry[] }
  // `at` on the batch boundaries is what the remaining-time estimate is built
  // from; see the review events, which carry it for the same reason.
  | { type: 'batch-start'; index: number; of: number; size: number; at: number }
  // Emitted between the two long calls in a batch. The bar cannot move inside a
  // batch, so this and the elapsed clock are the only signs the run is alive.
  | { type: 'batch-phase'; index: number; phase: 'drafting' | 'reviewing'; at: number }
  | { type: 'batch-done'; index: number; translated: number; fuzzy: number; at: number }
  | { type: 'batch-skipped'; index: number; size: number; reason: string; at: number }
  | { type: 'warning'; message: string }
  | { type: 'saved' }
  // Intents, not facts: acted on at the next batch boundary. See the review
  // events, which carry the same three for the same reason.
  | { type: 'paused'; at: number }
  | { type: 'resumed'; at: number }
  | { type: 'stopping'; at: number }
  | { type: 'done'; summary: TranslateSummary }

export interface TranslateSummary {
  file: string
  total: number
  pending: number
  fromTm: number
  translated: number
  fuzzy: number
  skipped: number
  // Entries left as they were because nothing was asked to draft them: set
  // only by --draft-engine none, which fills from the memory alone. Absent on
  // every other run, so their summaries read exactly as before.
  untranslated?: number
  // Entries a locale rule's fix pattern changed. Absent when none did, so a run
  // on a locale without fixes reports exactly what it always has.
  fixedByRules?: number
  stopped?: string
}

export interface TranslateOptions {
  file: string
  locale: Locale
  mode: 'pending' | 'all'
  // `qwen` is read as `local`, the name it has had since 0.23.
  draftEngine: DraftEngineInput
  // Ignore the cached draft and its review, and ask again. `--mode all` exists
  // to re-translate entries that already have a translation, and without this
  // it replayed a cached draft forever: a user re-running after a bad batch, or
  // after their engine shipped a better model, had no recourse short of
  // deleting jobs.db.
  fresh?: boolean
  dryRun?: boolean
  batchSize?: number
  // The review pass's model: an agent's, or the local reviewer's.
  model?: string
  // The local draft engine's model for this run only, instead of the
  // configured one. Part of the draft engine id, so its drafts key apart.
  localModel?: string
  // Stands in for the local transport, for both the draft engine and the
  // local reviewer, in tests.
  localChat?: LocalChat
  // Lets the caller park the run between batches, or end it early.
  control?: RunControl
  db?: Database.Database
  jobsDb?: Database.Database
  secrets?: Secrets
  engine?: DraftEngine
  review?: typeof reviewBatch
  mcpConfigPath?: string
  bin?: string
  // Which agent reviews the drafts. Defaults to the configured provider, so the
  // menu's choice reaches both halves of the tool rather than only review.
  // `local` is the experimental local reviewer.
  provider?: ReviewChoice
  onProgress?: (e: TranslateEvent) => void
}

type Emit = (e: TranslateEvent) => void

// The draft engines raise a typed quota error, but the claude review step just
// fails, and a run that keeps going past an exhausted subscription spends two
// process spawns per batch to learn the same thing again.
const MAX_CONSECUTIVE_SKIPS = 3

function isStopError(err: unknown): err is DraftQuotaError | DraftRateLimitError {
  return err instanceof DraftQuotaError || err instanceof DraftRateLimitError
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function resolveBatchSize(requested: number | undefined): number {
  const size = requested ?? loadConfig().batchSize
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`batch size must be a positive integer, got ${size}`)
  }
  return size
}

/**
 * Whether the memory offers a genuine choice for this source.
 *
 * Wordings that differ only in capitals say the same thing, so they are not a
 * choice; two different wordings are, and filling an entry has to pick one.
 */
function ambiguous(alternatives: readonly { target: string }[], locale: Locale): boolean {
  return new Set(alternatives.map((a) => a.target.toLocaleLowerCase(intlTag(locale)))).size > 1
}

// A TM row per msgid/msgidPlural only maps onto exactly two plural forms; other counts go through the engine.
//
// The memory can hold several approved wordings. The most recently updated is
// written, and the entry is marked fuzzy when there was more than one to choose
// between: the locale approved each of them, but nobody approved this one for
// this string, and a fuzzy entry is exactly the flag for a human to confirm.
function tmLookup(db: Database.Database, unit: TranslationUnit, locale: Locale, nplurals: number): ApplyResult | undefined {
  const singular = findMemory(db, unit.msgid, locale, unit.msgctxt)
  if (singular.length === 0) return undefined
  const fuzzy = ambiguous(singular, locale)
  if (unit.msgidPlural === undefined) return { key: unit.key, text: [singular[0]!.target], fuzzy }
  if (nplurals !== 2) return undefined
  const plural = findMemory(db, unit.msgidPlural, locale, unit.msgctxt)
  if (plural.length === 0) return undefined
  return {
    key: unit.key,
    text: [singular[0]!.target, plural[0]!.target],
    fuzzy: fuzzy || ambiguous(plural, locale),
  }
}

async function persist(po: PoFile, results: ApplyResult[], dryRun: boolean | undefined): Promise<boolean> {
  po.apply(results)
  if (dryRun) return false
  await po.save()
  return true
}

type Drafts = Map<string, string[]>

async function draft(
  units: TranslationUnit[],
  engine: DraftEngine,
  locale: Locale,
  nplurals: number,
  cache?: DraftCache,
): Promise<Drafts> {
  const drafts: Drafts = new Map()
  const missing: TranslationUnit[] = []
  for (const unit of units) {
    // A setting the code reads never goes to a machine engine, which would
    // turn "on" into "açık". Its draft is the source value; the AI pass sets
    // it from the translator comment.
    if (controlSpec(unit)) {
      drafts.set(unit.key, unit.msgidPlural === undefined ? [unit.msgid] : Array.from({ length: nplurals }, () => unit.msgid))
      continue
    }
    const hit = cache?.get(unit)
    if (hit) drafts.set(unit.key, hit)
    else missing.push(unit)
  }
  if (missing.length > 0) {
    // Indexed rather than scanned: the engine returns one result per unit, so a
    // linear find inside the loop is quadratic in the batch size.
    const byKey = new Map(missing.map((u) => [u.key, u]))
    for (const d of await engine.translate(missing, locale, nplurals)) {
      drafts.set(d.key, d.drafts)
      const unit = byKey.get(d.key)
      if (unit) cache?.put(unit, d.drafts)
    }
  }
  const absent = units.filter((u) => !drafts.has(u.key)).map((u) => JSON.stringify(u.key))
  if (absent.length > 0) throw new Error(`${engine.name}: no draft returned for ${absent.join(', ')}`)
  return drafts
}

interface DraftCache {
  get: (unit: TranslationUnit) => string[] | undefined
  put: (unit: TranslationUnit, text: string[]) => void
}

interface ReviewCache {
  get: (unit: TranslationUnit, drafts: string[]) => DraftReview | undefined
  put: (unit: TranslationUnit, drafts: string[], review: DraftReview) => void
}

interface CacheSetup {
  nplurals: number
  // Above two forms only. Keys the draft review, whose prompt carries it, and
  // not the draft, whose engine prompt does not.
  pluralForms?: string
  locale: Locale
  // The draft engine's own prompt, and the review prompt, hash differently and
  // key different tables. Passing both rather than one avoids the mistake of
  // pruning or keying one cache by the other's configuration.
  draftConfig: string
  reviewConfig: string
  engineName: string
  // Which model judged a draft, as engineId renders it. Computed by the
  // caller, which is the one place that knows whether it is an agent or a
  // local model.
  reviewEngine: string
  fresh: boolean
}

/**
 * The two caches translate reads and writes, built together because they share
 * a key derivation and differ in exactly two places.
 */
function buildCaches(
  jobs: Database.Database,
  setup: CacheSetup,
): { draftCache: DraftCache; reviewCache: ReviewCache } {
  // What the draft prompt shows the engine, and nothing it does not: the
  // comments are handed over as disambiguation hints and the plural count
  // decides how many drafts are asked for, so a draft formed under one of them
  // must not be served under another. References are absent because the draft
  // prompt does not carry them.
  const unitHash = (unit: TranslationUnit, withPlural = false): string =>
    draftSrcHash(
      {
        msgid: unit.msgid,
        ...(unit.msgctxt !== undefined ? { msgctxt: unit.msgctxt } : {}),
        ...(unit.msgidPlural !== undefined ? { msgidPlural: unit.msgidPlural } : {}),
        // Keyed by the source alone: an entry is drafted because it has no
        // translation yet, so including msgstr would key every row on the empty
        // string it is about to stop being.
        msgstr: [],
      },
      {
        comments: unit.comments,
        nplurals: setup.nplurals,
        ...(withPlural && setup.pluralForms !== undefined ? { pluralForms: setup.pluralForms } : {}),
      },
    )

  const draftKey = (unit: TranslationUnit) => ({
    srcHash: unitHash(unit),
    configHash: setup.draftConfig,
    locale: setup.locale,
    engine: setup.engineName,
  })

  // The draft review is keyed by the review prompt, not the draft prompt, so
  // its own configHash replaces the draft's, and by the model that judged it:
  // two models answer differently and must not read each other's rows.
  // The Plural-Forms header is in the review prompt above two forms, so it is
  // in this key and not in the draft's: a cached draft stays served, and only
  // the review of it is asked again.
  const verdictKey = (unit: TranslationUnit, text: string[]) => ({
    ...draftKey(unit),
    srcHash: unitHash(unit, true),
    draftHash: draftHash(text),
    configHash: setup.reviewConfig,
    engine: setup.reviewEngine,
  })

  return {
    draftCache: {
      // Bypasses the read and keeps the write, exactly as review's --fresh does.
      get: (unit) => (setup.fresh ? undefined : getDraft(jobs, draftKey(unit))),
      put: (unit, text) => putDraft(jobs, draftKey(unit), text),
    },
    reviewCache: {
      get: (unit, text) => (setup.fresh ? undefined : getDraftVerdict(jobs, verdictKey(unit, text))),
      put: (unit, text, value) => putDraftVerdict(jobs, verdictKey(unit, text), value),
    },
  }
}

// What a reviewer without tools is told beyond the agents' prompt: which
// prompt variant it was asked, and each entry's glossary terms. Absent for an
// agent, whose keys stay exactly as they were.
interface LocalAsk {
  variant: string
  terms: (unit: TranslationUnit) => Array<{ term: string; translations: string[] }>
}

async function reviewDrafts(
  units: TranslationUnit[],
  drafts: Drafts,
  review: typeof reviewBatch,
  // The provider here is the resolved one, not TranslateOptions.provider. The
  // CLI and both TUI screens leave that unset and let the setting decide, and
  // reading it here sent every such run to the default, claude, while the
  // cache key named the configured provider. Narrowing the type makes the
  // caller hand over what it resolved rather than what it was given.
  opts: Pick<TranslateOptions, 'bin' | 'model'> & { provider: ReviewChoice },
  locale: Locale,
  nplurals: number,
  pluralForms: string | undefined,
  mcpConfigPath: string,
  cache?: ReviewCache,
  checks?: Map<string, string[]>,
  local?: LocalAsk,
): Promise<ReviewResult[]> {
  const byKey = new Map(units.map((u) => [u.key, u]))
  const inputs: ReviewInput[] = units.map((u) => {
    const failed = checks?.get(u.key) ?? []
    const terms = local?.terms(u) ?? []
    return {
      key: u.key,
      msgid: u.msgid,
      ...(u.msgctxt !== undefined ? { msgctxt: u.msgctxt } : {}),
      ...(u.msgidPlural !== undefined ? { msgidPlural: u.msgidPlural } : {}),
      comments: u.comments,
      drafts: drafts.get(u.key) ?? [],
      ...(failed.length > 0 ? { automatedChecks: failed } : {}),
      ...(controlSpec(u) ? { control: true } : {}),
      ...(terms.length > 0 ? { glossary: terms } : {}),
    }
  })
  // The checks are part of what the AI was asked, so they key its answer: a
  // glossary or rule edit that changes one entry's checks re-asks for that
  // entry alone. A clean draft keys exactly as it did before checks existed.
  //
  // A local reviewer is also told which prompt it was asked, which is not in
  // the configuration hash (see AuditContext.promptVariant), and each entry's
  // glossary terms, which the agents look up themselves. Both go in the same
  // way, so a glossary edit re-asks a local review only for the entries whose
  // terms it changed.
  const asked = (input: ReviewInput) => [
    ...input.drafts,
    ...(input.automatedChecks ?? []).map((c) => `\u0000check ${c}`),
    ...(local ? [`\u0000prompt ${local.variant}`] : []),
    ...(input.glossary ?? []).map((g) => `\u0000glossary ${g.term}=${g.translations.join('|')}`),
  ]

  const cached: ReviewResult[] = []
  const missing: ReviewInput[] = []
  for (const input of inputs) {
    const unit = byKey.get(input.key)
    const hit = unit && cache?.get(unit, asked(input))
    if (hit) cached.push({ key: input.key, text: hit.text, fuzzy: hit.fuzzy, reason: hit.reason })
    else missing.push(input)
  }

  const fresh =
    missing.length > 0
      ? await review(missing, {
          locale,
          nplurals,
          ...(pluralForms === undefined ? {} : { pluralForms }),
          mcpConfigPath,
          // Agent options only: a local reviewer has none, and `local` must
          // never reach an agent spawn as a provider name.
          ...(!local && opts.bin ? { bin: opts.bin } : {}),
          // Never `none` in practice, which skips this pass, but narrowed
          // here so it cannot reach a spawn as a provider name either.
          ...(opts.provider !== 'local' && opts.provider !== 'none' ? { provider: opts.provider } : {}),
          ...(!local && opts.model ? { model: opts.model } : {}),
        })
      : []

  const askedByKey = new Map(missing.map((input) => [input.key, asked(input)]))
  for (const result of fresh) {
    const unit = byKey.get(result.key)
    if (unit) {
      cache?.put(unit, askedByKey.get(result.key) ?? drafts.get(result.key) ?? [], {
        text: result.text,
        fuzzy: result.fuzzy,
        reason: result.reason,
      })
    }
  }

  const allowed = new Set(units.map((u) => u.key))
  return [...cached, ...fresh].filter((r) => allowed.has(r.key))
}

export async function translateFile(opts: TranslateOptions): Promise<TranslateSummary> {
  const emit: Emit = opts.onProgress ?? (() => undefined)
  const batchSize = resolveBatchSize(opts.batchSize)
  const locale = normalizeLocale(opts.locale)
  const po = await loadPo(opts.file)
  // Before either database is opened and before any engine is built: a run
  // that would write the wrong number of forms is refused, not recorded.
  po.requirePluralForms(locale)
  const pluralForms = po.promptPluralForms()
  const units = po.units(opts.mode)
  const summary: TranslateSummary = {
    file: opts.file,
    total: po.units('all').length,
    pending: units.length,
    fromTm: 0,
    translated: 0,
    fuzzy: 0,
    skipped: 0,
  }
  emit({ type: 'start', file: opts.file, total: summary.total, pending: summary.pending })

  const ownsDb = opts.db === undefined
  const db = opts.db ?? openDb()
  const ownsJobsDb = opts.jobsDb === undefined
  // Opening the job store can throw, and until the try below is entered nothing
  // closes the handle already open on polyglots.db. That one holds the
  // translation memory, months of TMX imports, and in the long-lived TUI the
  // leak outlives the command.
  let jobs: Database.Database
  try {
    jobs = opts.jobsDb ?? openJobsDb()
  } catch (err) {
    if (ownsDb) db.close()
    throw err
  }
  // Clear rows a hard kill left at `running` before opening a new one, so the
  // history this run joins does not already claim two jobs are in flight. Only
  // rows whose process is gone are touched; a genuinely concurrent run is left
  // alone. Deliberately not done in `stats`, which promises to write nothing.
  reapAbandonedRuns(jobs)

  // Everything below opens a run in `jobs` and does real work against it, so
  // from here on a throw (a caller's onProgress blowing up, a batch that
  // could not even produce a draft) must not leak the handle this call
  // opened, nor leave history claiming the run is still going.
  let runId: number | undefined
  try {
    // The prompt is what this hash covers. The rules' findings on each draft
    // are part of that entry's own cache key instead (see reviewDrafts), so a
    // rule or glossary edit re-asks only the entries it changes. The
    // draft has its own configuration, the draft engine's prompt, and its own
    // pruning: a cached draft is written straight into the user's .po, so it
    // must not outlive the instructions that produced it.
    const config = translateConfigHash(locale)
    const draftConfig = draftConfigHash(locale)
    const draftChoice = normalizeDraftEngine(opts.draftEngine)
    // No engine: the memory fills what it can and nothing else is asked. An
    // injected engine wins, as it does everywhere else here, so a test that
    // hands one over is never quietly turned into a memory-only run.
    const memoryOnly = draftChoice === 'none' && !opts.engine
    // Only a run that reads or writes these caches prunes them. One that drafts
    // nothing would otherwise delete drafts a paid engine wrote under an
    // earlier prompt, rows it never had any use for.
    // Review verdicts likewise: with no reviewer the run never touches them.
    const noReviewer = (opts.provider ?? loadConfig().reviewProvider) === 'none'
    if (!memoryOnly) {
      if (!noReviewer) pruneStaleConfigs(jobs, 'draft_verdict', locale, config)
      pruneStaleConfigs(jobs, 'draft', locale, draftConfig)
    }

    // Derived rather than read off the engine, which does not exist yet: it is
    // built only once there is a batch to translate, so a fully cached run
    // needs no API key and no reachable Ollama. The fallback this replaces was
    // the chosen engine's name, which for the local engine is `qwen` rather
    // than the model it loaded, so every model shared one cache key.
    const settings = loadConfig()
    // The configured provider unless the caller named one. Read once: a run
    // must not change agent part way because the setting moved underneath it.
    const provider = opts.provider ?? settings.reviewProvider
    // With no reviewer, the engine's drafts are written for a human to check
    // rather than judged: fuzzy, after the same mechanical repairs and checks a
    // reviewed draft gets, and with no verdict cached, since none was formed.
    const unreviewed = provider === 'none'
    // Both local targets are resolved before the run row exists, so an
    // OpenAI-compatible server with no model is refused, not recorded as a
    // run that failed. The draft engine and the reviewer may use different
    // models: --local-model is the one, --model the other.
    const localDraft = draftChoice === 'local' && !opts.engine ? resolveLocalTarget(settings, opts.localModel) : undefined
    // Not resolved when nothing is drafted: there is nothing for it to review,
    // and a reviewer with no model chosen must not refuse a run that never
    // asks it anything.
    const localReview = provider === 'local' && !memoryOnly ? resolveLocalTarget(settings, opts.model) : undefined
    const engineName =
      opts.engine?.name ?? (memoryOnly ? 'none' : localDraft ? localModelId(localDraft) : draftEngineId(opts.draftEngine))
    // Without --model, antigravity runs whatever its own settings file names,
    // so the bare provider let a switch from Flash to Pro serve Flash's
    // verdicts as Pro's on every entry already seen. The same fallback review
    // uses, for the same reason. Only the key learns the model: the spawn
    // below still passes opts.model alone, and antigravity keeps choosing.
    const reviewEngine = localReview
      ? engineId(localModelId(localReview), 'local')
      : engineId(opts.model ?? (provider === 'local' || provider === 'none' ? undefined : configuredModel(provider)), provider)
    const { draftCache, reviewCache } = buildCaches(jobs, {
      nplurals: po.nplurals,
      ...(pluralForms === undefined ? {} : { pluralForms }),
      locale,
      draftConfig,
      reviewConfig: config,
      engineName,
      reviewEngine,
      fresh: opts.fresh === true,
    })

    runId = startRun(jobs, {
      file: opts.file,
      ...(po.headers['Project-Id-Version'] ? { project: po.headers['Project-Id-Version'] } : {}),
      command: 'translate',
      locale,
      nplurals: po.nplurals,
      batchSize,
      engine: engineName,
    })

    const hits: ApplyResult[] = []
    const rest: TranslationUnit[] = []
    for (const unit of units) {
      const hit = tmLookup(db, unit, locale, po.nplurals)
      if (hit) hits.push(hit)
      else rest.push(unit)
    }
    const savedHits = hits.length > 0 && (await persist(po, hits, opts.dryRun))
    summary.fromTm = hits.length
    emit({ type: 'tm-hit', count: hits.length })
    if (hits.length > 0) {
      const sourceOf = new Map(units.map((u) => [u.key, u.msgid]))
      emit({
        type: 'entries',
        entries: hits.map(
          (h): TranslateEntry => ({
            key: h.key,
            msgid: shortMsgid(sourceOf.get(h.key) ?? h.key),
            ...(h.fuzzy ? { outcome: 'fuzzy', from: 'memory' } : { outcome: 'memory' }),
          }),
        ),
      })
    }
    if (savedHits) emit({ type: 'saved' })

    if (memoryOnly) summary.untranslated = rest.length
    const batches = memoryOnly ? [] : chunk(rest, batchSize)
    if (batches.length > 0) {
      const engine =
        opts.engine ??
        getDraftEngine(opts.draftEngine, opts.secrets ?? loadSecrets(), {
          onWarning: (message) => emit({ type: 'warning', message }),
          // Where the local runner lives and which model it should load,
          // resolved above from config so a user who set it gets what they
          // asked for, and so the engine and its cache key agree.
          ...(localDraft ? { local: localDraft } : {}),
          ...(opts.localChat ? { localChat: opts.localChat } : {}),
          idleTimeoutMs: localIdleTimeoutMs(settings),
        })
      const review =
        opts.review ??
        (localReview ? createLocalDraftReviewer(
              opts.localChat ?? createLocalChat(localReview, { idleTimeoutMs: localIdleTimeoutMs(settings) }),
              reviewEngine,
            ) : reviewBatch)
      // A local reviewer has no MCP, so nothing would read the file, and with
      // no reviewer there is nothing to start it.
      const mcpConfigPath =
        opts.mcpConfigPath ?? (localReview || unreviewed ? '' : await writeMcpConfig({ env: { [MCP_ENV.locale]: locale } }))

      // Review's rules, on translate's own drafts: built once for the file.
      const checker = createDraftChecker({
        locale,
        nplurals: po.nplurals,
        glossary: allGlossary(db, locale),
        properNouns: configuredProperNouns(locale),
        units: rest,
      })
      const unitOf = new Map(rest.map((u) => [u.key, u]))
      const localAsk: LocalAsk | undefined = localReview
        ? {
            variant: draftReviewPromptVariant(locale),
            // A setting the code reads takes no glossary term, as in review:
            // its translator comment decides the value, and "kapalı" for
            // "off" is exactly the mistake a glossary match would invite.
            terms: (u) => (controlSpec(u) ? [] : checker.terms(u)),
          }
        : undefined

      let consecutiveSkips = 0

      batchLoop: for (const [i, batch] of batches.entries()) {
        // Between batches, never inside one: the batch in flight has already been
        // paid for, so it finishes and saves before anything parks.
        if (opts.control && (await opts.control.gate()) === 'stop') {
          summary.stopped = 'stopped before batch ' + String(i + 1)
          break batchLoop
        }
        const index = i + 1
        emit({ type: 'batch-start', index, of: batches.length, size: batch.length, at: Date.now() })
        emit({ type: 'batch-phase', index, phase: 'drafting', at: Date.now() })

        let drafts: Drafts | undefined
        let results: Array<ReviewResult & { notes?: string[] }> | undefined
        let lastError: unknown
        for (let attempt = 0; attempt < 2 && results === undefined; attempt++) {
          try {
            drafts ??= await draft(batch, engine, locale, po.nplurals, draftCache)
            // Fixed after the draft cache, never before it: editing a fix
            // pattern must not throw away what the engine was paid to write.
            const prepared = new Map(batch.map((u) => [u.key, checker.prepare(u, drafts!.get(u.key) ?? [])]))
            const fixedDrafts: Drafts = new Map([...prepared].map(([k, p]) => [k, p.drafts]))
            const checks = new Map([...prepared].map(([k, p]) => [k, p.checks]))
            if (unreviewed) {
              // Nothing judged these, so every one is written for a human to
              // confirm, and finalize still applies the fix patterns and names
              // whatever check the draft fails.
              results = batch.map((u) =>
                checker.finalize(u, {
                  key: u.key,
                  text: fixedDrafts.get(u.key) ?? [],
                  fuzzy: true,
                  reason: 'Not reviewed: no review provider is set.',
                }),
              )
              break
            }
            emit({ type: 'batch-phase', index, phase: 'reviewing', at: Date.now() })
            results = (
              await reviewDrafts(batch, fixedDrafts, review, { ...opts, provider }, locale, po.nplurals, pluralForms, mcpConfigPath, reviewCache, checks, localAsk)
            ).map((r) => {
              const unit = unitOf.get(r.key)
              return unit ? checker.finalize(unit, r) : r
            })
          } catch (err) {
            if (isStopError(err)) {
              summary.stopped = err.message
              break batchLoop
            }
            lastError = err
          }
        }

        if (results === undefined) {
          summary.skipped += batch.length
          emit({
            type: 'entries',
            index,
            entries: batch.map((u): TranslateEntry => ({ key: u.key, msgid: shortMsgid(u.msgid), outcome: 'skipped' })),
          })
          emit({ type: 'batch-skipped', index, size: batch.length, reason: errorMessage(lastError), at: Date.now() })
          if (++consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
            summary.stopped = `${consecutiveSkips} batches failed in a row: ${errorMessage(lastError)}`
            break batchLoop
          }
          continue
        }
        consecutiveSkips = 0

        const saved = await persist(po, results, opts.dryRun)
        const fuzzy = results.filter((r) => r.fuzzy).length
        summary.translated += results.length
        summary.fuzzy += fuzzy
        const fixed = results.filter((r) => r.notes?.length).length
        if (fixed > 0) summary.fixedByRules = (summary.fixedByRules ?? 0) + fixed
        emit({
          type: 'entries',
          index,
          entries: results.map(
            (r): TranslateEntry => ({
              key: r.key,
              msgid: shortMsgid(unitOf.get(r.key)?.msgid ?? r.key),
              ...(r.fuzzy ? { outcome: 'fuzzy', from: 'engine' } : { outcome: 'drafted' }),
            }),
          ),
        })
        emit({ type: 'batch-done', index, translated: results.length, fuzzy, at: Date.now() })
        if (saved) emit({ type: 'saved' })
      }
    }

    // Written once, from the same numbers the caller is about to be handed, so
    // the history and the report cannot disagree. A run stopped part way is
    // ended rather than marked done: it has no totals worth freezing. It ends
    // as `stopped`, not as a fault: the operator asked for it, and its drafts
    // are cached for the run that resumes it.
    if (summary.stopped !== undefined) {
      endRun(jobs, runId, 'stopped')
    } else {
      finishRun(jobs, runId, {
        // The entries this run worked on, which is what review freezes in the
        // same column. `total` is every unit in the file including ones nothing
        // touched, and a throughput query grouping over a column that means two
        // different things reports neither. `skipped` is what the failure
        // breaker gave up on, which is precisely what `unreviewed` means:
        // recording 0 filed a run that gave up as clean and complete.
        entries: summary.pending,
        flagged: summary.fuzzy,
        repaired: summary.translated,
        unreviewed: summary.skipped,
        approvable: summary.translated - summary.fuzzy,
        byCategory: {},
      })
    }
  } catch (err) {
    // A run in progress when this throws is neither done nor still running:
    // mark it stopped so history does not claim otherwise, before the handle
    // it needs to do that is closed underneath it.
    if (runId !== undefined) endRun(jobs, runId, 'failed')
    throw err
  } finally {
    if (ownsDb) db.close()
    if (ownsJobsDb) jobs.close()
  }

  // Outside the try on purpose: by here the run's history is settled, and a
  // caller whose progress handler throws must not be able to rewrite it. A
  // failed notification is not a failed translation.
  emit({ type: 'done', summary })
  return summary
}
