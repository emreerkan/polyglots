import { z } from 'zod'
import { BUILT_IN_RULES } from './names.js'

export const GUIDANCE_LIMIT = 1500

// The highest rules-file schema this polyglots understands. A file written for
// a newer one is refused with "update polyglots" rather than read in part: a
// review run on half-understood rules looks like a review and is not one.
//
// Raising MAX_SCHEMA is the rule for any new key, a key removed, a key whose
// meaning changes, and a new name accepted in rules.enable. That last one is
// easy to miss: an older polyglots rejects an unknown rule name without any key
// changing, so a new rule name is a schema change too, and the number is what
// lets the older app say why instead of naming the rule as a typo.
export const MAX_SCHEMA = 2
export const CAPITALIZATION_LIMIT = 2500
export const REGISTER_LIMIT = 500
export const SENTENCE_REGEX_LIMIT = 1000

// Keys a file may use only when it says schema: 2. Accepting them silently
// under schema 1 would let a file that an older polyglots refuses for an
// unknown key pass here unannounced, and the person sharing it would never
// learn that it needs a declaration to travel.
export const SCHEMA_2_KEYS = ['capitalization', 'register', 'formality', 'sentenceEnd'] as const

export type PatternLevel = 'hint' | 'error' | 'fix'

/**
 * One custom check, in the form the rule engine runs. A `mistakes` entry from
 * the file arrives here as a `hint` pattern with `right` kept for its message.
 */
export interface CustomPattern {
  // Which section of the file it was written in. A mistake is reported as
  // wrong -> right; a pattern by its note.
  kind: 'mistake' | 'pattern'
  text?: string
  find?: string
  ignoreCase: boolean
  replace?: string
  // The suggested wording of a common mistake, shown in its finding.
  right?: string
  level: PatternLevel
  whenSource?: string
  note?: string
}

/**
 * How a language marks the end of a sentence, for the punctuation rule. The
 * strings are regex sources; consumers compile them with flag u, the flag they
 * were validated under.
 */
export interface SentenceEndRules {
  // Extra ways a translation can answer a source that ends a sentence. Only
  // ever consulted in that direction.
  answers?: { text: string; source?: string }[]
  // The language writes no final mark, so a missing one is not reported.
  unmarked?: true
  // A final mark that looks like a stop and is not one.
  notEnding?: string
}

export interface LocaleRules {
  // 1 when the file does not say. Kept out of the fingerprint: two files that
  // differ only in the number mean the same rules.
  schema: number
  rules?: { enable: string[]; disable: string[] }
  glossaryStemRatio?: number
  properNouns?: { always?: string[]; dateOnly?: string[] }
  patterns: CustomPattern[]
  guidance?: string
  // Ends in a newline after normalisation, whichever block scalar wrote it.
  capitalization?: string
  register?: { audit?: string; translate?: string }
  formality?: 'formal' | 'informal'
  sentenceEnd?: SentenceEndRules
}

const ruleName = z.string().superRefine((name, ctx) => {
  if (!(BUILT_IN_RULES as readonly string[]).includes(name)) {
    ctx.addIssue({ code: 'custom', message: `"${name}" is not a built-in rule. Valid names: ${BUILT_IN_RULES.join(', ')}` })
  }
})

const compiles = (source: string) => {
  try {
    new RegExp(source, 'u')
    return true
  } catch {
    return false
  }
}

const regex = z
  .string()
  .min(1)
  .max(SENTENCE_REGEX_LIMIT, { message: `is longer than ${SENTENCE_REGEX_LIMIT} characters` })
  .refine(compiles, { message: 'is not a valid regular expression' })
const registerLine = z.string().min(1).max(REGISTER_LIMIT, { message: `is longer than ${REGISTER_LIMIT} characters` })

const mistake = z
  .object({
    wrong: z.string().min(1),
    right: z.string().optional(),
    note: z.string().optional(),
  })
  .strict()

const pattern = z
  .object({
    text: z.string().min(1).optional(),
    find: z.string().min(1).refine(compiles, { message: 'is not a valid regular expression' }).optional(),
    ignoreCase: z.boolean().optional(),
    replace: z.string().optional(),
    level: z.enum(['hint', 'error', 'fix']).optional(),
    when: z.object({ source: z.string().min(1) }).strict().optional(),
    note: z.string().optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if ((p.text === undefined) === (p.find === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'needs exactly one of "text" or "find"' })
    }
    if (p.level === 'fix' && p.replace === undefined) {
      ctx.addIssue({ code: 'custom', path: ['replace'], message: 'is required when level is fix' })
    }
  })

export const localeRulesSchema = z
  .object({
    rules: z
      .object({ enable: z.array(ruleName).default([]), disable: z.array(ruleName).default([]) })
      .strict()
      .optional(),
    glossaryStemRatio: z.number().gt(0).max(1).optional(),
    properNouns: z
      .object({ always: z.array(z.string()).optional(), dateOnly: z.array(z.string()).optional() })
      .strict()
      .optional(),
    mistakes: z.array(mistake).default([]),
    patterns: z.array(pattern).default([]),
    guidance: z.string().max(GUIDANCE_LIMIT, { message: `is longer than ${GUIDANCE_LIMIT} characters` }).optional(),
    // The loader has already refused anything but a whole number from 1 to
    // MAX_SCHEMA, with its own wording; this is the type, not the message.
    schema: z.number().int().min(1).max(MAX_SCHEMA).optional(),
    capitalization: z
      .string()
      .min(1)
      .max(CAPITALIZATION_LIMIT, { message: `is longer than ${CAPITALIZATION_LIMIT} characters` })
      .optional(),
    register: z
      .union([registerLine, z.object({ audit: registerLine.optional(), translate: registerLine.optional() }).strict()])
      .optional(),
    formality: z.enum(['formal', 'informal']).optional(),
    sentenceEnd: z
      .object({
        answers: z.array(z.object({ text: regex, source: regex.optional() }).strict()).optional(),
        unmarked: z.literal(true).optional(),
        notEnding: regex.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((raw, ctx) => {
    if ((raw.schema ?? 1) >= 2) return
    for (const key of SCHEMA_2_KEYS) {
      if (raw[key] !== undefined) ctx.addIssue({ code: 'custom', path: [key], message: 'needs schema: 2 at the top of the file' })
    }
  })

export type RawLocaleRules = z.infer<typeof localeRulesSchema>

// Mistakes and patterns become one list, mistakes first, in the order written.
// Optional fields are only set when present, which keeps the normalised value
// (and so its fingerprint) free of keys the person never wrote.
export function normalise(raw: RawLocaleRules): LocaleRules {
  const patterns: CustomPattern[] = [
    ...raw.mistakes.map((m) => ({
      kind: 'mistake' as const,
      text: m.wrong,
      replace: undefined,
      ...(m.right === undefined ? {} : { right: m.right }),
      level: 'hint' as const,
      ignoreCase: true,
      ...(m.note === undefined ? {} : { note: m.note }),
    })),
    ...raw.patterns.map((p) => ({
      kind: 'pattern' as const,
      ...(p.text === undefined ? {} : { text: p.text }),
      ...(p.find === undefined ? {} : { find: p.find }),
      ...(p.replace === undefined ? {} : { replace: p.replace }),
      level: p.level ?? 'hint',
      // A literal is always matched case-insensitively; only a regex opts in.
      ignoreCase: p.text !== undefined ? true : (p.ignoreCase ?? false),
      ...(p.when === undefined ? {} : { whenSource: p.when.source }),
      ...(p.note === undefined ? {} : { note: p.note }),
    })),
  ]
  const guidance = raw.guidance?.trim()
  // A | block keeps the final newline and a |- block drops it. The prompt is
  // built as though the text always ends in one, as the packs' text did, so
  // the two spellings must not render different prompts or hash differently.
  const capitalization =
    raw.capitalization === undefined
      ? undefined
      : raw.capitalization.endsWith('\n')
        ? raw.capitalization
        : `${raw.capitalization}\n`
  const register =
    raw.register === undefined
      ? undefined
      : typeof raw.register === 'string'
        ? { audit: raw.register, translate: raw.register }
        : {
            ...(raw.register.audit === undefined ? {} : { audit: raw.register.audit }),
            ...(raw.register.translate === undefined ? {} : { translate: raw.register.translate }),
          }
  const sentenceEnd =
    raw.sentenceEnd === undefined
      ? undefined
      : {
          ...(raw.sentenceEnd.answers === undefined
            ? {}
            : {
                answers: raw.sentenceEnd.answers.map((a) => ({
                  text: a.text,
                  ...(a.source === undefined ? {} : { source: a.source }),
                })),
              }),
          ...(raw.sentenceEnd.unmarked === undefined ? {} : { unmarked: raw.sentenceEnd.unmarked }),
          ...(raw.sentenceEnd.notEnding === undefined ? {} : { notEnding: raw.sentenceEnd.notEnding }),
        }
  return {
    schema: raw.schema ?? 1,
    ...(raw.rules === undefined ? {} : { rules: raw.rules }),
    ...(raw.glossaryStemRatio === undefined ? {} : { glossaryStemRatio: raw.glossaryStemRatio }),
    ...(raw.properNouns === undefined ? {} : { properNouns: raw.properNouns }),
    patterns,
    ...(guidance ? { guidance } : {}),
    ...(capitalization === undefined ? {} : { capitalization }),
    ...(register === undefined ? {} : { register }),
    ...(raw.formality === undefined ? {} : { formality: raw.formality }),
    ...(sentenceEnd === undefined ? {} : { sentenceEnd }),
  }
}
