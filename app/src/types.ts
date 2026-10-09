export type Locale = string

export interface TranslationUnit {
  key: string
  msgid: string
  msgctxt?: string
  msgidPlural?: string
  comments: string[]
  references: string[]
}

export interface DraftResult {
  key: string
  drafts: string[]
}

// What the user picks. Distinct from the engine's identity below: a choice is
// a stable name in config and on the command line, while an identity has to say
// which model produced a draft, because the draft cache keys on it.
//
// `local` was called `qwen` until 0.23, after the first model it ran, although
// any Ollama model could be configured. The old name is still read wherever a
// person can type it or have saved it (normalizeDraftEngine), and is never
// written.
//
// `none` drafts nothing: translate fills what the translation memory holds and
// leaves the rest untranslated. It has no engine and no identity below,
// because it never produces a draft to key.
export type DraftEngineChoice = 'deepl' | 'openai' | 'local' | 'none'

// Which protocol a local model server speaks. Stated in config rather than
// guessed per run: Ollama answers /v1/models too, and a run must not change
// protocol because a probe answered differently today.
export type LocalServerKind = 'ollama' | 'openai-compatible'

// How an engine identifies the drafts it produced. A local runner names the
// model it loaded: two models behind one name would serve one model's drafts
// as the other's, which is the defect the review side had with --model. An
// OpenAI-compatible server is named as well, because its model id is whatever
// that server calls it (see localModelId).
export type DraftEngineName = 'deepl' | 'openai' | `ollama:${string}` | `openai-compatible:${string}`

export interface DraftEngine {
  readonly name: DraftEngineName
  translate(units: TranslationUnit[], locale: Locale, nplurals: number): Promise<DraftResult[]>
}

export interface ReviewInput {
  key: string
  msgid: string
  msgctxt?: string
  msgidPlural?: string
  comments: string[]
  drafts: string[]
  // What the draft still fails after mechanical repairs, as "rule: message".
  // Absent for a clean draft, which keeps its cache key as it always was.
  automatedChecks?: string[]
  // A setting WordPress code reads, decided by the translator comment.
  control?: boolean
  // The glossary terms the source contains, with their approved translations.
  // Set only for a reviewer without tools (a local model), which cannot look
  // them up; the agents' prompt never renders it.
  glossary?: Array<{ term: string; translations: string[] }>
}

export interface ReviewResult {
  key: string
  text: string[]
  fuzzy: boolean
  reason: string
}

export interface TmEntry {
  source: string
  target: string
  locale: Locale
  context?: string
  project?: string
}

export interface TmMatch extends TmEntry {
  score: number
}

export interface GlossaryEntry {
  locale: Locale
  sourceTerm: string
  translation: string
  partOfSpeech?: string
  notes?: string
}

export interface AuditEntry extends TranslationUnit {
  msgstr: string[]
  fuzzy: boolean
}

export type Severity = 'error' | 'suspect'

export interface Finding {
  rule: string
  severity: Severity
  message: string
}

export interface ReviewSummary {
  file: string
  // The locale the run judged against. Carried so the requester message can
  // tell a project's slug from the locale in the export's file name, which is
  // otherwise ambiguous for any slug holding a hyphen.
  locale: Locale
  total: number
  skipped: number
  reviewed: number
  problems: number
  // Soft findings nothing adjudicated, only possible under --no-ai: reported for
  // a human to glance at rather than written into the problems file.
  needsReview: number
  approvable: number
  unreviewed: number
  // Entries in batches the run never attempted, because it was stopped part way.
  // Kept apart from `unreviewed`, which means a batch that was attempted and
  // failed, and excluded from `approvable`: nothing looked at these, so nothing
  // may invite the user to bulk-approve them.
  pending: number
  // Entries that carry a correction, whether the rules or the model made it. The
  // rest still need a human to write something.
  repaired: number
  // How many entries the output file holds. Reported rather than derived, because
  // `problems - repaired` is not it: an entry whose only fault was whitespace is
  // written out too, and it counts as neither a problem nor a soft finding.
  written: number
  byRule: Record<string, number>
  // The same findings folded into the handful of groups the requester message
  // names, counted over the repaired entries and once per entry per group.
  // Deliberately not derivable from `byRule`: that counts a rule firing, so an
  // entry both a rule and the model caught appears in it twice, and summing it
  // per group can exceed the number of entries actually fixed.
  byGroup: Record<string, number>
  problemsFile?: string
}

/**
 * One entry as its batch lands, for the run screens' list of recent entries.
 *
 * `msgid` is shortened for display (see shortMsgid) and is never the key: the
 * key carries the msgctxt glued on with a control character, which a terminal
 * renders as nothing at all. Nothing here reaches a prompt or a cache key.
 */
export type ReviewEntryOutcome = 'approved' | 'flagged' | 'repaired' | 'unreviewed'

export interface ReviewEntry {
  key: string
  msgid: string
  outcome: ReviewEntryOutcome
  // The rules that fired on it, and the categories the model named. Absent
  // rather than empty on an entry nothing fired on.
  rules?: string[]
}

export type ReviewEvent =
  | { type: 'start'; file: string; total: number; reviewable: number }
  // Every entry a batch decided, emitted once per batch just before its
  // batch-done or batch-failed. Per batch rather than per entry, so a
  // seven-thousand-entry run is a few hundred events, not seven thousand. The
  // CLI reporter ignores it: the line it prints is the same with or without.
  | { type: 'entries'; index: number; entries: ReviewEntry[] }
  // What a previous run already judged, inherited from the job store before the
  // first batch. Resume is per entry, so without this a resumed run looks
  // exactly like a cold one: the same header, and a bar counting from zero out
  // of however many batches are left. `batches` is what those entries would
  // have cost at this run's batch size, which is what makes them comparable
  // with the batches still to run.
  | { type: 'cached'; entries: number; batches: number }
  // memoryApproved and memoryRepaired are what the memory settled without a
  // model: approved word for word, or left in English where it held the
  // approved text. Optional so an event recorded before there was a count
  // still reads.
  | { type: 'rules-done'; flagged: number; suspects: number; memoryApproved?: number; memoryRepaired?: number }
  // `at` lets a pure reducer measure how long each batch took, which is what the
  // remaining-time estimate is built from.
  | { type: 'batch-start'; index: number; of: number; size: number; at: number }
  | { type: 'batch-done'; index: number; problems: number; at: number }
  | { type: 'batch-failed'; index: number; size: number; reason: string; at: number }
  | { type: 'written'; file: string }
  // Emitted when the output file from a previous run still carries the
  // FORMAT=2-era marker: nothing reads it back any more, so the run is
  // starting from the top and this is the only way anyone would know.
  | { type: 'marker-ignored'; file: string }
  // Emitted by whichever surface owns the keyboard, not by the run itself, so a
  // progress line can say it is parked rather than wedged.
  //
  // All three are intents rather than facts. The run acts on them only at a
  // batch boundary, so between the keypress and the boundary the batch in
  // flight carries on and the bar does not move. On a hundred-entry batch that
  // is minutes of a screen that looks identical to one that dropped the key.
  | { type: 'paused'; at: number }
  | { type: 'resumed'; at: number }
  | { type: 'stopping'; at: number }
  | { type: 'done'; summary: ReviewSummary }

export type ConsistencyScope = 'core' | 'all'

export interface ConsistencyEntry {
  translation: string
  count: number
}

/**
 * Which agent CLI adjudicates a review.
 *
 * A setting rather than a per-run choice: it is a standing preference about
 * which subscription to spend. Each run still records the one it used, because
 * verdicts are cached per engine and the two providers do not agree.
 */
export type ReviewProvider = 'claude' | 'antigravity'

/**
 * What adjudicates a review: an agent CLI, or a local model.
 *
 * Kept apart from ReviewProvider, which is the set of CLIs polyglots spawns
 * and which discovery, doctor and the menu's `p` iterate. `local` is
 * experimental and opt-in only (`config set reviewProvider local`), so nothing
 * that cycles or auto-selects providers ever sees it.
 */
//
// `none` is no reviewer at all: review runs the rules only, as --no-ai does,
// and translate writes nothing a model would have had to judge. A choice a
// person makes on purpose, in setup or by config set, for working without AI
// or any third-party service; like `local`, nothing that cycles providers
// ever lands on it.
export type ReviewChoice = ReviewProvider | 'local' | 'none'

/** One local model server's settings. */
export interface LocalServerSettings {
  baseUrl: string
  model: string
  // The context window, in tokens, when the person knows it. For Ollama it is
  // also sent as num_ctx, which makes it true rather than advisory; other
  // servers fix their context when the model is loaded.
  contextLength?: number
}

export interface PolyglotsConfig {
  // Absent until the person chooses one; nothing is assumed. See src/cli/locale.ts.
  defaultLocale?: Locale
  defaultDraftEngine: DraftEngineChoice
  // Which agent CLI judges translations. `antigravity` needs the polyglots MCP
  // server registered with it first; notes/antigravity.md has the setup.
  // `local` is the experimental local-model reviewer (notes/local-models.md).
  reviewProvider: ReviewChoice
  // The reviewer's own login on translate.wordpress.org. Only used to build the
  // link in the requester message, which points at their translations in the
  // project they just reviewed. Empty means no link is built: an unfiltered
  // page would show everybody's work and the message would be claiming it.
  wporgUsername: string
  // Where the local runner lives and which model to load. Only read when the
  // chosen engine or reviewer is `local` and localServerKind is `ollama`.
  ollama: LocalServerSettings
  // Which of the two local server settings the `local` engine and reviewer use.
  localServerKind: LocalServerKind
  // An LM Studio, llama.cpp server or vLLM. The model is empty until chosen,
  // since there is no default model an arbitrary server can be assumed to hold.
  openaiCompatible: LocalServerSettings
  batchSize: number
  consistencyTtlDays: number
  // Per-locale names the built-in lists cannot cover (places, people,
  // institutions, historical events). Entries may be multi-word.
  properNouns: Record<string, string[]>
  // Extra local model servers to list models from, beyond the loopback ports
  // that are always tried. Read only by discovery, never by a run or a hash.
  localModelServers: string[]
  // Seconds a local server may send nothing, before its first chunk or
  // between two, before the reply is abandoned as cut off. Read by runs only,
  // never by a hash: it decides when to give up, not what is asked.
  localIdleTimeout: number
  // Opt-in anonymous usage totals (src/usage). Absent until the person has
  // answered, which counts as no: nothing is sent and no install id exists.
  // DO_NOT_TRACK turns it off whatever this says.
  usageStats?: boolean
  // Absent means on. Whether to ask npm once a day for a newer version (src/update).
  updateCheck?: boolean
}

export interface Secrets {
  DEEPL_API_KEY?: string
  OPENAI_API_KEY?: string
}
