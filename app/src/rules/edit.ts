import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isMap, isNode, parseDocument, Scalar } from 'yaml'
import { builtInProfileFor } from '../audit/rules/profiles.js'
import { builtInProperNounsFor, type ProperNouns } from '../audit/rules/proper-nouns.js'
import type { Locale } from '../types.js'
import { renderDefaultRules } from './defaults.js'
import { localeRulesFile, parseLocaleRules } from './load.js'
import { localeRulesSchema, SCHEMA_2_KEYS, type RawLocaleRules } from './schema.js'

// The sections a person edits, in the form they write them: mistakes and
// patterns kept apart, a regex as its source text, guidance as typed.
export type RulesValue = Omit<RawLocaleRules, 'mistakes' | 'patterns'> & {
  mistakes: RawLocaleRules['mistakes']
  patterns: Array<Partial<RawLocaleRules['patterns'][number]>>
}

export interface RulesDraft {
  locale: Locale
  path: string
  exists: boolean
  // The file's text when it was opened, to refuse overwriting a later edit.
  text: string
  value: RulesValue
  // What runs when a section is left out, for the editor to show.
  builtIn: { rules: string[]; glossaryStemRatio: number; properNouns: ProperNouns }
}

const SECTIONS = ['rules', 'glossaryStemRatio', 'properNouns', 'mistakes', 'patterns', 'guidance', ...SCHEMA_2_KEYS] as const
// Prompt text a person writes as several lines, one point per line.
const PROSE = new Set<string>(['guidance', 'capitalization'])

const clean = (value: RulesValue): RulesValue =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as RulesValue

/**
 * A locale's rules as an editable value, with what the file said and what the
 * built-ins are. Throws for an invalid file: an editor that started from a
 * guess about a broken file would save that guess over it.
 */
export function openRulesDraft(locale: Locale): RulesDraft {
  const path = localeRulesFile(locale)
  const exists = existsSync(path)
  const text = exists ? readFileSync(path, 'utf8') : ''
  if (exists) parseLocaleRules(text, path)
  const raw = localeRulesSchema.parse(exists ? (parseDocument(text).toJS() ?? {}) : {})
  const profile = builtInProfileFor(locale)
  return {
    locale,
    path,
    exists,
    text,
    value: clean(raw as RulesValue),
    builtIn: {
      rules: [...profile.rules],
      glossaryStemRatio: profile.glossaryStemRatio,
      properNouns: builtInProperNounsFor(locale),
    },
  }
}

const empty = (v: unknown) => v === undefined || (Array.isArray(v) && v.length === 0)

/**
 * Writes the edited rules, changing only the sections that differ from what
 * was opened.
 *
 * The file is edited as a YAML document rather than written afresh, so the
 * comments a person wrote by hand and every section the editor did not touch
 * come back exactly as they were. A section emptied in the editor is removed
 * rather than left as an empty list or blank text.
 *
 * Nothing reaches the disk unless the result loads: it is validated with the
 * parser `rules check` uses, then written through a temporary name. A file
 * changed on disk since it was opened is refused, since saving would discard
 * that edit without anyone seeing it.
 */
export async function saveRulesDraft(draft: RulesDraft, next: RulesValue): Promise<RulesDraft> {
  const now = existsSync(draft.path) ? readFileSync(draft.path, 'utf8') : undefined
  if (draft.exists ? now !== draft.text : now !== undefined) {
    throw new Error(`${draft.path} changed on disk since it was opened; reopen it to see the change`)
  }

  const doc = parseDocument(draft.exists ? draft.text : renderDefaultRules(draft.locale))
  for (const key of SECTIONS) {
    const before = draft.value[key]
    const after = next[key]
    if (JSON.stringify(before) === JSON.stringify(after)) continue
    if (empty(after)) {
      doc.delete(key)
    } else if (PROSE.has(key) && typeof after === 'string' && after.includes('\n')) {
      const node = new Scalar(after)
      node.type = Scalar.BLOCK_LITERAL
      doc.set(key, node)
    } else {
      doc.set(key, doc.createNode(after))
    }
  }

  // The editor offers "When source lacks" and the four schema-2 sections,
  // which only a schema-2 file may use, but has no field for the schema
  // itself, and most hand-written files predate the schema line. Refusing such a save would send the person out
  // to add one line by hand, so the line is added for them, at the top where
  // the loader's message says it belongs. It is added only when something in
  // the saved value needs it: declaring 2 on a file that does not use it
  // would make an older polyglots refuse a file it can read.
  const needsSchema2 =
    SCHEMA_2_KEYS.some((key) => next[key] !== undefined) || next.patterns.some((p) => p.when?.notSource !== undefined)
  const declared = doc.get('schema')
  if (needsSchema2 && !(typeof declared === 'number' && declared >= 2)) {
    if (doc.has('schema')) doc.set('schema', 2)
    else if (isMap(doc.contents)) {
      // A file's opening comment block, when a blank line separates it from
      // the first key's own comment, parses as one comment on that first
      // key. Put in front of it unsplit, the schema line would sit above the
      // file's title; the part before the last blank line is the file's
      // header, so it moves above the schema line and the rest stays with
      // the key it describes.
      const pair = doc.createPair('schema', 2)
      const first = doc.contents.items[0]?.key
      const comment = isNode(first) ? first.commentBefore : undefined
      const split = comment?.lastIndexOf('\n\n') ?? -1
      if (isNode(first) && comment && split >= 0) {
        (pair.key as Scalar).commentBefore = comment.slice(0, split)
        first.commentBefore = comment.slice(split + 2)
        first.spaceBefore = true
      }
      doc.contents.items.unshift(pair as (typeof doc.contents.items)[number])
    } else doc.set('schema', 2)
  }

  const text = doc.toString()
  parseLocaleRules(text, draft.path)
  await mkdir(dirname(draft.path), { recursive: true })
  const tmp = `${draft.path}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, draft.path)
  return openRulesDraft(draft.locale)
}
