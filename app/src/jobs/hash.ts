import { createHash } from 'node:crypto'
import { fingerprintReview } from '../audit/resume.js'
import { draftSystemPrompt } from '../draft/prompt.js'
import { buildReviewPrompt } from '../review/prompt.js'
import type { GlossaryEntry, Locale } from '../types.js'

const HASH_LENGTH = 16

// Written as escapes, not literal control bytes, so the file stays text to git
// and grep. Same convention as resume.ts.
const FIELD = '\u0001'
const PART = '\u0002'

function hash(...parts: string[]): string {
  return createHash('sha256').update(parts.join(PART)).digest('hex').slice(0, HASH_LENGTH)
}

// Deliberately the minimum: what the entry says, and nothing about how it is
// judged or what else the model was shown. The parameter is narrowed to exactly
// the fields hashed, so that a call site cannot go on *looking* like it hashes
// context this never reads. Everything a prompt carries beyond the text belongs
// in the wrappers below, which say so in their own signatures.
export interface SourceText {
  msgid: string
  msgctxt?: string
  msgidPlural?: string
  msgstr: string[]
}

export function srcHash(entry: SourceText): string {
  return hash(entry.msgid, entry.msgctxt ?? '', entry.msgidPlural ?? '', entry.msgstr.join(FIELD))
}

// Everything the audit prompt carries beyond the entry's own text.
export interface AuditContext {
  // The prompt tells the model these are the best clue to a string's role,
  // which is what decides whether a capitalised label is an exempt UI label or
  // a title-case error. They differ between files, which is exactly why they
  // belong in the key.
  references: string[]
  // gettext's own disambiguation mechanism, handed to the model verbatim.
  comments: string[]
  // The hints the prompt lists as automatedChecks, as the prompt renders them:
  // the output of automatedChecks in audit/prompt.ts, which withholds the
  // `repaired` note and a locale rule skipped as a runaway. The rendered list
  // and not the findings, so what the prompt never shows cannot move the key.
  //
  // The message and not just the rule name, because a message can be derived
  // from the whole file: `inconsistent` says how many different ways the same
  // source is translated in it. Editing one entry changes another entry's
  // message while that entry's own text, references and firing rules are all
  // untouched, and keying on names alone would serve its now-stale verdict.
  // That is the per-entry invalidation this project promises, so it is not
  // optional.
  //
  // File-dependent in the first place for the same reason the rest of this is:
  // the rule context learns brand words and prior translations from every other
  // entry in the same file, so the same string can fire a rule in one
  // submission and not in another.
  hints: string[]
  // Every wording the memory holds for this exact source, as the prompt states
  // them. The memory is not part of the configuration hash, so nothing else in
  // this key would notice a TMX import changing what the model was told. Order
  // is part of it: the prompt lists them as they come, so a reordering is a
  // different prompt and deserves a different key.
  memory?: readonly string[]
  nplurals: number
  // The catalogue's Plural-Forms header, set only when the prompt renders it,
  // which is above two forms. Appended as a part only when present, so every
  // key for one or two forms is the joined string it always was.
  pluralForms?: string
  // Whether a mechanical repair was applied before the model was asked. The
  // prompt says so, and the hash is taken after the repair, so without this an
  // entry whose whitespace was fixed and the same entry submitted already
  // clean would share a key while having been asked different questions.
  repaired: boolean
  // A digest of the prompt template when it is not the agents' one: the local
  // reviewer has no tools, so its prompt says so and states the reply shape.
  // Per entry rather than in the configuration hash, because pruning deletes
  // every row whose configuration differs, whatever its engine, and a local
  // run would then wipe the agents' verdicts. Appended only when set, so every
  // agent key is the joined string it always was.
  promptVariant?: string
}

// The key a review verdict is stored under. It covers the whole question the
// model was asked, not just the entry: a verdict formed under one file's
// evidence must never be served for another file's. Sorting the hints is
// load-bearing, because the order rules ran in must not turn a hit into a miss.
//
// This errs towards a miss, the way an unreadable row does. The cache is an
// optimisation and re-asking is always a correct answer; serving a verdict
// formed under evidence that has since moved is not.
//
// The practical consequence is that reuse is same-file, since references differ
// between files. That is intended; see "Why verdicts are not reused across
// files" in the design. Resume, per-entry invalidation and partial-batch
// recovery are unaffected, because the same file re-reviewed produces identical
// inputs here.
export function auditSrcHash(entry: SourceText, context: AuditContext): string {
  return hash(
    srcHash(entry),
    context.references.join(FIELD),
    context.comments.join(FIELD),
    [...context.hints].sort().join(FIELD),
    (context.memory ?? []).join(FIELD),
    String(context.nplurals),
    // The prompt tells the model when the text it is judging was already
    // repaired mechanically. Without this, an entry whose whitespace was fixed
    // and the same entry submitted already clean hash the same, because the
    // hash is taken after the repair and the `repaired` hint is excluded.
    context.repaired ? 'repaired' : '',
    ...(context.pluralForms === undefined ? [] : [context.pluralForms]),
    ...(context.promptVariant === undefined ? [] : [`prompt ${context.promptVariant}`]),
  )
}

// Everything the draft prompt carries beyond the source text. The draft engine
// is told to use the comments as disambiguation hints and is given the locale's
// plural count, so a draft formed under one of them must not be served under
// another. References are absent on purpose: the draft prompt does not carry
// them.
export interface DraftContext {
  comments: string[]
  nplurals: number
  // As in AuditContext: the header the draft review prompt renders above two
  // forms, absent otherwise. Translate passes it for the draft review's key
  // and not for the draft's, because the draft engines' own prompt does not
  // carry it yet and a paid-for draft should not miss over a line it never saw.
  pluralForms?: string
}

export function draftSrcHash(entry: SourceText, context: DraftContext): string {
  return hash(
    srcHash(entry),
    context.comments.join(FIELD),
    String(context.nplurals),
    ...(context.pluralForms === undefined ? [] : [context.pluralForms]),
  )
}

export interface ConfigHashInput {
  locale: Locale
  glossary: GlossaryEntry[]
  properNouns: string[]
}

// Everything about *how* we ask, so that changing any of it invalidates every
// cached verdict at once. Deliberately coarse: a finer scheme that invalidated
// only the entries a glossary edit could affect was designed and discarded,
// because rules and glossary change while developing this tool rather than
// during a review, and starting over is the wanted behaviour when they do.
//
// fingerprintReview already hashes the glossary, and hashes the rule profile
// together with the prompt template, which is exactly the split needed here.
// The source and batch size it also returns are deliberately not used: the
// source is per entry now, and batch size cannot change a verdict.
export function configHash(input: ConfigHashInput): string {
  const fingerprint = fingerprintReview({
    source: '',
    locale: input.locale,
    batchSize: 0,
    noAi: false,
    glossary: input.glossary,
    properNouns: input.properNouns,
  })
  return hash(fingerprint.glossary, fingerprint.rules)
}

// Translate's equivalent, and deliberately narrower: it runs no rules, and the
// glossary terms its prompt inlines are per entry, so they key each entry's
// draft review (see reviewDrafts in commands/translate.ts) rather than this.
// The only thing left to invalidate every draft review at once is the prompt
// template itself, the agents' tool rules included. Kept as its own function rather than a
// flag on configHash, because the two produce different values and the tables
// they key are pruned separately.
export function translateConfigHash(locale: Locale): string {
  return hash(buildReviewPrompt([], locale, 2))
}

// What invalidates a cached draft: the draft engine's own prompt. Without it a
// draft would be immortal, never invalidated by a prompt change and never
// pruned, and it is the one cache whose contents are written straight into the
// user's .po rather than into an annotation.
//
// Deliberately not per engine, even though the draft table is keyed by engine:
// pruning deletes every row for a locale whose config_hash differs, so an
// engine-specific value would have a DeepL run delete every OpenAI draft and an
// OpenAI run delete them straight back. One value for both means a prompt edit
// invalidates both, which is the wanted behaviour anyway. nplurals is not in
// here because it is part of the per-entry key instead.
export function draftConfigHash(locale: Locale): string {
  return hash(draftSystemPrompt(locale, 2))
}

export function draftHash(text: string[]): string {
  return hash(text.join(FIELD))
}

/**
 * Which model produced a verdict, as the cache key records it.
 *
 * Two Claude models answer the same question differently, so a verdict formed
 * by one must not be served as the other's. Recording them both as `claude`
 * would make the escalation project's whole premise, running two engines and
 * comparing what they say, quietly unmeasurable, because the second engine
 * would read the first one's rows.
 */
/**
 * Which agent formed a verdict, as a cache key and a stats row.
 *
 * `provider` defaults to claude so every row written before there was a choice
 * still reads back: the id was `claude` then and is `claude` now. Two providers
 * do not agree about the same translation, so a verdict one reached must never
 * be served as the other's, and the same goes for two models behind one
 * provider.
 *
 * Takes a string rather than the provider union on purpose. This module keys
 * caches and knows nothing about which CLIs exist; making it import that would
 * tie the hashing to the process of spawning.
 */
export function engineId(model?: string, provider = 'claude'): string {
  return model ? `${provider}:${model}` : provider
}
