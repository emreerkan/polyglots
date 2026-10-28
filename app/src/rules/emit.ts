import { Document, isMap, isScalar, isSeq, type Node, type Pair, type Scalar } from 'yaml'
import { RULES_BUILDER_URL } from './builder-url.js'
import { SCHEMA_3_RULES, type LocaleRules, type PatternLevel } from './schema.js'

// What the website's rules builder holds while someone fills it in, and the
// rules file it writes from that. Here rather than on the site so that the
// file is written with the same yaml package the app reads it with, and so
// the round trip through parse.ts is tested beside the parser.
//
// Every field is a plain form value: an empty string or an empty list means
// "not set", which keeps the state JSON for the page's localStorage and lets
// a half-typed row exist without being written out.

export interface BuilderMistake {
  wrong: string
  right: string
  note: string
}

export interface BuilderPattern {
  mode: 'text' | 'find'
  value: string
  level: PatternLevel
  replace: string
  // Only a regex opts in; a literal is always matched without case.
  ignoreCase: boolean
  whenSource: string
  whenNotSource: string
  note: string
}

export interface BuilderState {
  // The WordPress code, as in tr_TR; empty before one is picked.
  locale: string
  enable: string[]
  disable: string[]
  glossaryStemRatio: number | null
  formality: '' | 'formal' | 'informal'
  register: { audit: string; translate: string }
  capitalization: string
  guidance: string
  properNouns: { always: string[]; dateOnly: string[] }
  mistakes: BuilderMistake[]
  patterns: BuilderPattern[]
  sentenceEnd: { answers: { text: string; source: string }[]; unmarked: boolean; notEnding: string }
  // The page has no fields for it yet. Carried so that starting from the
  // published rules and downloading the file keeps the locale's dateTime.
  dateTime: { clock: '' | '12h' | '24h'; order: '' | 'dmy' | 'mdy' | 'ymd'; formats: { source: string; target: string }[] }
  names: { order: '' | 'given-first' | 'family-first' }
}

export function emptyBuilderState(locale: string): BuilderState {
  return {
    locale,
    enable: [],
    disable: [],
    glossaryStemRatio: null,
    formality: '',
    register: { audit: '', translate: '' },
    capitalization: '',
    guidance: '',
    properNouns: { always: [], dateOnly: [] },
    mistakes: [],
    patterns: [],
    sentenceEnd: { answers: [], unmarked: false, notEnding: '' },
    dateTime: { clock: '', order: '', formats: [] },
    names: { order: '' },
  }
}

/** A parsed rules file as builder state, for "Start from the published rules". */
export function stateFromRules(rules: LocaleRules, locale: string): BuilderState {
  const state = emptyBuilderState(locale)
  for (const p of rules.patterns) {
    if (p.kind === 'mistake') {
      state.mistakes.push({ wrong: p.text ?? '', right: p.right ?? '', note: p.note ?? '' })
      continue
    }
    state.patterns.push({
      mode: p.find === undefined ? 'text' : 'find',
      value: p.find ?? p.text ?? '',
      level: p.level,
      replace: p.replace ?? '',
      ignoreCase: p.find !== undefined && p.ignoreCase,
      whenSource: p.whenSource ?? '',
      whenNotSource: p.whenNotSource ?? '',
      note: p.note ?? '',
    })
  }
  return {
    ...state,
    enable: [...(rules.rules?.enable ?? [])],
    disable: [...(rules.rules?.disable ?? [])],
    glossaryStemRatio: rules.glossaryStemRatio ?? null,
    formality: rules.formality ?? '',
    register: { audit: rules.register?.audit ?? '', translate: rules.register?.translate ?? '' },
    capitalization: rules.capitalization ?? '',
    guidance: rules.guidance ?? '',
    properNouns: { always: [...(rules.properNouns?.always ?? [])], dateOnly: [...(rules.properNouns?.dateOnly ?? [])] },
    sentenceEnd: {
      answers: (rules.sentenceEnd?.answers ?? []).map((a) => ({ text: a.text, source: a.source ?? '' })),
      unmarked: rules.sentenceEnd?.unmarked === true,
      notEnding: rules.sentenceEnd?.notEnding ?? '',
    },
    dateTime: {
      clock: rules.dateTime?.clock ?? '',
      order: rules.dateTime?.order ?? '',
      formats: Object.entries(rules.dateTime?.formats ?? {}).map(([source, target]) => ({ source, target })),
    },
    names: { order: rules.names?.order ?? '' },
  }
}

// One comment above each section, saying what it is for, in the words the
// docs use. The file is read by the person who downloads it and by whoever
// reviews it for polyglots-data, neither of whom may have the docs open.
const SECTION_COMMENTS: Record<string, string> = {
  rules: ' Built-in checks turned on (enable) or off (disable) for this locale.',
  glossaryStemRatio: ' How much of a glossary term an inflected form must keep, between 0 and 1.',
  formality: ' How a draft addresses the reader.',
  register: ' The tone and form of address both AI prompts ask for.',
  properNouns: ' Names the title-case check leaves alone: everywhere, and only inside a date.',
  capitalization: ' How the language capitalizes, for the review prompt where title-case runs.',
  guidance: ' Added to the AI review prompts: the style guide\'s most important lines.',
  mistakes: ' Wordings the team rejects, found anywhere in a translation, without regard to case.',
  patterns: ' Literal text or regular expressions: a hint to weigh, an error, or a fix.',
  sentenceEnd: ' How a sentence ends in this script, for the punctuation check.',
  dateTime: ' The clock, the date order and the usual date formats, for the date-format check.',
  names: ' Whether a person\'s given name or family name comes first, for the name-order check.',
}

const filled = (s: string) => s.trim() !== ''
const list = (items: string[]) => items.map((s) => s.trim()).filter(filled)

// The plain object the file holds, in the order a reader meets it: switches
// first, prompt text in the middle, the long lists last.
function contents(state: BuilderState): Record<string, unknown> {
  const enable = list(state.enable)
  const disable = list(state.disable)
  const formats = state.dateTime.formats.filter((f) => filled(f.source) && filled(f.target))
  const dateTime = {
    ...(state.dateTime.clock === '' ? {} : { clock: state.dateTime.clock }),
    ...(state.dateTime.order === '' ? {} : { order: state.dateTime.order }),
    ...(formats.length === 0 ? {} : { formats: Object.fromEntries(formats.map((f) => [f.source.trim(), f.target.trim()])) }),
  }
  // The lowest schema the file needs, and never below 2, which every
  // released polyglots reads. Declaring the highest this app knows, as it
  // once did, would have made polyglots 1.1 refuse every file the builder
  // wrote from the day schema 3 existed, whatever was in it.
  const needs3 = Object.keys(dateTime).length > 0 || state.names.order !== '' || [...enable, ...disable].some((name) => SCHEMA_3_RULES.includes(name))
  const out: Record<string, unknown> = { schema: needs3 ? 3 : 2 }
  if (enable.length > 0 || disable.length > 0) out.rules = { enable, disable }
  if (state.glossaryStemRatio !== null) out.glossaryStemRatio = state.glossaryStemRatio
  if (state.formality !== '') out.formality = state.formality
  const audit = state.register.audit.trim()
  const translate = state.register.translate.trim()
  if (audit !== '' && audit === translate) out.register = audit
  else if (audit !== '' || translate !== '') {
    out.register = { ...(audit === '' ? {} : { audit }), ...(translate === '' ? {} : { translate }) }
  }
  const always = list(state.properNouns.always)
  const dateOnly = list(state.properNouns.dateOnly)
  if (always.length > 0 || dateOnly.length > 0) {
    out.properNouns = { ...(always.length === 0 ? {} : { always }), ...(dateOnly.length === 0 ? {} : { dateOnly }) }
  }
  // Kept as typed apart from a final newline, which the app adds anyway:
  // leading spaces can be part of the person's own list layout.
  if (filled(state.capitalization)) out.capitalization = `${state.capitalization.replace(/\s+$/, '')}\n`
  if (filled(state.guidance)) out.guidance = state.guidance.trim()
  // Whatever the app matches as text is written as typed, edge spaces and
  // all. It matches a literal as a substring with no word boundaries, so the
  // spaces are the rule: ' :' is a space before a colon, and trimmed to ':'
  // it would hint at every colon in every translation while rules check
  // passes the file. A row of spaces alone still counts as blank, since a
  // stray space left in an empty row would otherwise match every space.
  const mistakes = state.mistakes
    .filter((m) => filled(m.wrong))
    .map((m) => ({
      wrong: m.wrong,
      ...(filled(m.right) ? { right: m.right.trim() } : {}),
      ...(filled(m.note) ? { note: m.note.trim() } : {}),
    }))
  if (mistakes.length > 0) out.mistakes = mistakes
  const patterns = state.patterns
    .filter((p) => (p.mode === 'find' ? p.value !== '' : filled(p.value)))
    .map((p) => ({
      ...(p.mode === 'find' ? { find: p.value } : { text: p.value }),
      ...(p.replace !== '' || p.level === 'fix' ? { replace: p.replace } : {}),
      level: p.level,
      ...(p.mode === 'find' && p.ignoreCase ? { ignoreCase: true } : {}),
      ...(filled(p.whenSource) || filled(p.whenNotSource)
        ? {
            when: {
              ...(filled(p.whenSource) ? { source: p.whenSource } : {}),
              ...(filled(p.whenNotSource) ? { notSource: p.whenNotSource } : {}),
            },
          }
        : {}),
      ...(filled(p.note) ? { note: p.note.trim() } : {}),
    }))
  if (patterns.length > 0) out.patterns = patterns
  const answers = state.sentenceEnd.answers
    .filter((a) => a.text !== '')
    .map((a) => ({ text: a.text, ...(a.source === '' ? {} : { source: a.source }) }))
  const sentenceEnd = {
    ...(answers.length === 0 ? {} : { answers }),
    ...(state.sentenceEnd.unmarked ? { unmarked: true } : {}),
    ...(state.sentenceEnd.notEnding === '' ? {} : { notEnding: state.sentenceEnd.notEnding }),
  }
  if (Object.keys(sentenceEnd).length > 0) out.sentenceEnd = sentenceEnd
  if (Object.keys(dateTime).length > 0) out.dateTime = dateTime
  if (state.names.order !== '') out.names = { order: state.names.order }
  return out
}

// Regex sources in single quotes, where a backslash is just a backslash: the
// form the docs and polyglots-data use, and the one a person can read.
const REGEX_KEYS = new Set(['find', 'replace', 'notEnding'])
// Short word lists on one line, as the docs write them.
const FLOW_KEYS = new Set(['enable', 'disable', 'dateOnly', 'when'])

function style(node: Node | null | undefined, key?: string, insideAnswers = false): void {
  if (isMap(node)) {
    if (key !== undefined && FLOW_KEYS.has(key)) node.flow = true
    // A date format on both sides, quoted as polyglots-data writes them: a
    // bare "g:i a: H:i" is valid YAML that nobody can read with confidence.
    if (key === 'formats') {
      for (const pair of node.items as Pair<Scalar, Scalar>[]) {
        pair.key.type = 'QUOTE_SINGLE'
        pair.value!.type = 'QUOTE_SINGLE'
      }
      return
    }
    for (const pair of node.items as Pair<Scalar, Node>[]) style(pair.value, String(pair.key.value), insideAnswers || key === 'answers')
  } else if (isSeq(node)) {
    if (key !== undefined && FLOW_KEYS.has(key)) node.flow = true
    for (const item of node.items as Node[]) style(item, undefined, insideAnswers || key === 'answers')
  } else if (isScalar(node) && typeof node.value === 'string') {
    if (node.value.includes('\n')) node.type = 'BLOCK_LITERAL'
    else if (key !== undefined && (REGEX_KEYS.has(key) || insideAnswers)) node.type = 'QUOTE_SINGLE'
  }
}

/** The rules file for a builder state: the schema it needs, a comment per section, nothing the person left blank. */
export function emitRulesYaml(state: BuilderState): string {
  const doc = new Document(contents(state))
  const locale = state.locale.trim()
  doc.commentBefore = [
    ` polyglots rules${locale === '' ? '' : ` for ${locale}`}, written with the rules builder:`,
    ` ${RULES_BUILDER_URL}`,
    '',
    ' Check it with: polyglots rules check --file <this file>',
    ' Every value here is read by the app; comments are not.',
  ].join('\n')
  if (isMap(doc.contents)) {
    for (const pair of doc.contents.items as Pair<Scalar, Node>[]) {
      const key = String(pair.key.value)
      style(pair.value, key)
      const comment = SECTION_COMMENTS[key]
      if (comment !== undefined) {
        pair.key.commentBefore = comment
        pair.key.spaceBefore = true
      }
    }
  }
  // No folding: a long note or regex stays on its line, as a person writes
  // one, and a folded regex is unreadable even when it is still correct.
  // Single quotes wherever quotes are needed, as a register line starting
  // with "- " does: the style polyglots-data and the docs use.
  return doc.toString({ lineWidth: 0, singleQuote: true, flowCollectionPadding: false })
}
