import { basename } from 'node:path'
import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { dateFormatProblems, isDateFormat } from '../../audit/rules/date-format.js'
import { UNIVERSAL_RULES } from '../../audit/rules/profiles.js'
import { openRulesDraft, saveRulesDraft, type RulesDraft, type RulesValue } from '../../rules/edit.js'
import { BUILT_IN_RULES, findingLabel } from '../../rules/names.js'
import { CAPITALIZATION_LIMIT, GUIDANCE_LIMIT, REGISTER_LIMIT, SENTENCE_REGEX_LIMIT } from '../../rules/schema.js'
import { resolveLocale, wpCodeOf } from '../../wporg/locales.js'
import { rulesBuilderUrl } from '../../rules/builder-url.js'
import { RulesFileError } from '../../rules/parse.js'
import { RulesFileChangedError, type RulesFetchPlan } from '../../commands/rules-fetch.js'
import { useCommands, useConfig } from '../commands.js'
import { Hint } from '../components/Hint.js'
import { ListEditor } from '../components/ListEditor.js'
import { Form } from '../components/Form.js'
import { MultilineInput } from '../components/MultilineInput.js'
import { copyRules } from '../../cli/rules.js'
import { tryRules, type TryResult } from '../../rules/try.js'
import { glossaryRows, rulesMaintained } from '../setup.js'
import { configuredLocale } from '../../config.js'
import type { GlossaryEntry } from '../../types.js'
import { useKeys } from '../hooks/useKeys.js'
import { useTask, type TaskState } from '../hooks/useTask.js'
import { useSize } from '../size.js'
import { TextInput } from '../input.js'
import { useReportUnsaved } from '../unsaved.js'
import { ScrollTarget } from '../components/Viewport.js'

export interface LocaleRulesProps {
  onBack: () => void
}

type Stage =
  | 'pick'
  | 'overview'
  | 'rules'
  | 'formality'
  | 'register'
  | 'registerText'
  | 'capitalization'
  | 'ratio'
  | 'nouns'
  | 'nounList'
  | 'mistakes'
  | 'patterns'
  | 'guidance'
  | 'sentenceEnd'
  | 'notEnding'
  | 'answers'
  | 'dateTime'
  | 'formats'
  | 'names'
  | 'try'
  | 'copy'
  | 'fetch'
  | 'builder'
  | 'leave'

// In the rules builder's order, so a person who has used one finds each
// section where the other put it: basics, writing style, mistakes, then
// what most locales never touch.
const SECTION_STAGE: Stage[] = [
  'rules',
  'formality',
  'register',
  'capitalization',
  'guidance',
  'nouns',
  'mistakes',
  'patterns',
  'sentenceEnd',
  'dateTime',
  'names',
  'ratio',
  'try',
  'copy',
  'fetch',
  'builder',
]
// What the overview offers for a file that does not parse: the two ways to a
// valid one that do not start from its contents. Editing would start from a
// value the file does not hold, and saving it would write over whatever the
// person meant to keep, so neither is offered until the file reads.
const REPAIR_STAGE: Stage[] = ['fetch', 'builder']
// The rows of the screen around a fetch summary: the frame's header and
// footer, this screen's title, path and the lines above and below the
// summary. What is left is the summary's window; a smaller terminal still
// gets a few lines, and the frame scrolls whatever wraps past it.
const FETCH_CHROME_ROWS = 16
const MIN_FETCH_ROWS = 5
type NounList = 'always' | 'dateOnly'
const NOUN_LISTS: { key: NounList; label: string }[] = [
  { key: 'always', label: 'Always capitalized' },
  { key: 'dateOnly', label: 'Only in a specific date' },
]
type Mistake = RulesValue['mistakes'][number]

type Pattern = RulesValue['patterns'][number]

type Formality = 'formal' | 'informal' | undefined
const FORMALITIES: { value: Formality; label: string }[] = [
  { value: undefined, label: 'Not set' },
  { value: 'formal', label: 'Formal' },
  { value: 'informal', label: 'Informal' },
]

type RegisterPart = 'audit' | 'translate'
const REGISTER_PARTS: { key: RegisterPart; label: string }[] = [
  { key: 'audit', label: 'For the review prompt' },
  { key: 'translate', label: 'For the draft prompt' },
]
// A file may give one line for both prompts. Shown under both, and written
// back as two only once one of them is edited, so opening and saving the
// screen leaves a file's single line as it was.
const registerParts = (register: RulesValue['register']): Partial<Record<RegisterPart, string>> =>
  register === undefined ? {} : typeof register === 'string' ? { audit: register, translate: register } : register

type SentenceEnd = NonNullable<RulesValue['sentenceEnd']>
type Answer = NonNullable<SentenceEnd['answers']>[number]
const SENTENCE_END_ROWS = 3

const describeSentenceEnd = (end: SentenceEnd | undefined) => {
  const parts = [
    ...(end?.unmarked ? ['no final mark'] : []),
    ...(end?.notEnding !== undefined ? ['a mark that is not a stop'] : []),
    ...(end?.answers?.length ? [`${end.answers.length} final mark${end.answers.length === 1 ? '' : 's'}`] : []),
  ]
  return parts.length > 0 ? parts.join(' · ') : 'not set'
}

const describeRegister = (register: RulesValue['register']) => {
  const parts = registerParts(register)
  if (parts.audit === undefined && parts.translate === undefined) return 'not set'
  return `review ${parts.audit === undefined ? 'not set' : 'set'} · draft ${parts.translate === undefined ? 'not set' : 'set'}`
}

type DateTime = NonNullable<RulesValue['dateTime']>
type Clock = DateTime['clock']
type DateOrder = DateTime['order']
const CLOCKS: Clock[] = [undefined, '24h', '12h']
const DATE_ORDERS: DateOrder[] = [undefined, 'dmy', 'mdy', 'ymd']
const DATE_TIME_ROWS = 3
type Format = { source: string; target: string }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const describeDateTime = (d: DateTime | undefined) => {
  const formats = Object.keys(d?.formats ?? {}).length
  const parts = [...(d?.clock ? [d.clock] : []), ...(d?.order ? [d.order] : []), ...(formats > 0 ? [plural(formats, 'format')] : [])]
  return parts.length > 0 ? parts.join(' · ') : 'not set'
}
// The next value in a short list, wrapping round: three or four choices are
// quicker to step through than to pick from a menu.
const step = <T,>(list: readonly T[], current: T, by: number): T => list[(list.indexOf(current) + by + list.length) % list.length]!

type NameOrder = NonNullable<RulesValue['names']>['order'] | undefined
const NAME_ORDERS: { value: NameOrder; label: string }[] = [
  { value: undefined, label: 'Not set' },
  { value: 'given-first', label: 'Given name first' },
  { value: 'family-first', label: 'Family name first' },
]

const sentenceRegex = (v: string) =>
  v === '' ? undefined : v.length > SENTENCE_REGEX_LIMIT ? `longer than ${SENTENCE_REGEX_LIMIT} characters` : !compiles(v) ? 'not a valid regular expression' : undefined

const ANSWER_FIELDS = [
  { key: 'text', label: 'Final mark (regex)', required: true, validate: sentenceRegex },
  { key: 'source', label: 'Answers this source mark (regex, optional)', validate: sentenceRegex },
]
const describeAnswer = (a: Answer) => `/${a.text}/${a.source !== undefined ? `  answers /${a.source}/` : ''}`

const compiles = (source: string) => {
  try {
    new RegExp(source, 'u')
    return true
  } catch {
    return false
  }
}

const describePattern = (p: Pattern) =>
  `${p.text !== undefined ? `"${p.text}"` : `/${p.find}/`}  ${p.level ?? 'hint'}` +
  `${p.replace !== undefined ? ` → ${p.replace}` : ''}` +
  `${p.when?.source !== undefined ? `  when the source has "${p.when.source}"` : ''}` +
  `${p.when?.notSource !== undefined ? `  when the source lacks "${p.when.notSource}"` : ''}${p.note ? `  (${p.note})` : ''}`

const PATTERN_FIELDS = [
  {
    key: 'text',
    label: 'Text',
    validate: (v: string, all: Record<string, string>) =>
      v.trim() === '' && (all.find ?? '').trim() === ''
        ? 'needs Text or Regex'
        : v.trim() !== '' && (all.find ?? '').trim() !== ''
          ? 'Text or Regex, not both'
          : undefined,
  },
  { key: 'find', label: 'Regex', validate: (v: string) => (v !== '' && !compiles(v) ? 'not a valid regular expression' : undefined) },
  { key: 'ignoreCase', label: 'Ignore case (y/n)', validate: (v: string) => (/^[yn]?$/i.test(v.trim()) ? undefined : 'y or n') },
  { key: 'replace', label: 'Replace' },
  {
    key: 'level',
    label: 'Level',
    validate: (v: string, all: Record<string, string>) =>
      !['', 'hint', 'error', 'fix'].includes(v.trim())
        ? 'hint, error or fix'
        : v.trim() === 'fix' && (all.replace ?? '') === ''
          ? 'fix needs a replacement'
          : undefined,
  },
  { key: 'when', label: 'When source contains' },
  { key: 'notSource', label: 'When source lacks' },
  { key: 'note', label: 'Note' },
]

const patternToForm = (p: Pattern): Record<string, string> => ({
  text: p.text ?? '',
  find: p.find ?? '',
  ignoreCase: p.ignoreCase ? 'y' : '',
  replace: p.replace ?? '',
  level: p.level ?? '',
  when: p.when?.source ?? '',
  notSource: p.when?.notSource ?? '',
  note: p.note ?? '',
})

const patternFromForm = (v: Record<string, string>): Pattern => {
  const has = (k: string) => (v[k] ?? '').trim() !== ''
  return {
    ...(has('text') ? { text: v.text!.trim() } : {}),
    ...(has('find') ? { find: v.find! } : {}),
    ...(/^y$/i.test((v.ignoreCase ?? '').trim()) ? { ignoreCase: true } : {}),
    ...((v.replace ?? '') !== '' ? { replace: v.replace! } : {}),
    ...(has('level') ? { level: v.level!.trim() as 'hint' | 'error' | 'fix' } : {}),
    ...(has('when') || has('notSource')
      ? {
          when: {
            ...(has('when') ? { source: v.when!.trim() } : {}),
            ...(has('notSource') ? { notSource: v.notSource!.trim() } : {}),
          },
        }
      : {}),
    ...(has('note') ? { note: v.note!.trim() } : {}),
  }
}

const describeMistake = (m: Mistake) => `${m.wrong}${m.right ? ` → ${m.right}` : ''}${m.note ? `  (${m.note})` : ''}`
const RATIO_STEP = 0.05

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))
const round = (n: number) => Math.round(n * 100) / 100

/**
 * The menu's editor for a locale's rules file.
 *
 * Edits are held on the screen and written only on `s`, through the same
 * save `rules edit` would leave you with: comments a person wrote stay, only
 * changed sections are touched, and nothing invalid reaches the disk. Leaving
 * with unsaved edits asks first. Saving says what it costs: the rules feed
 * configHash, so the next review of every file in the locale starts over.
 */
export function LocaleRules({ onBack }: LocaleRulesProps) {
  const commands = useCommands()
  const size = useSize()
  const { config } = useConfig()
  const [stage, setStage] = useState<Stage>('pick')
  // Empty when no locale is configured: prefilling one would open someone
  // else's rules on enter.
  const [input, setInput] = useState(config.defaultLocale ?? '')
  const [draft, setDraft] = useState<RulesDraft>()
  // Set instead of draft when the locale's file exists but is not a valid
  // rules file: the overview then shows the error and offers only the repairs.
  const [broken, setBroken] = useState<{ locale: string; path: string }>()
  const [value, setValue] = useState<RulesValue>({ mistakes: [], patterns: [] })
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  // The highlighted section, not its index: the fetch row can move to the
  // front after the screen is drawn, and an index would then slide the
  // highlight onto a neighbour the person never chose. Undefined until they
  // move, which keeps it on whatever row is first.
  const [section, setSection] = useState<Stage>()
  const [maintained, setMaintained] = useState(false)
  const [ruleCursor, setRuleCursor] = useState(0)
  const [nounCursor, setNounCursor] = useState(0)
  const [registerCursor, setRegisterCursor] = useState(0)
  const [endCursor, setEndCursor] = useState(0)
  const [dateCursor, setDateCursor] = useState(0)
  const [trial, setTrial] = useState<TryResult | string>()
  const [glossary, setGlossary] = useState<GlossaryEntry[]>()
  const [copyResult, setCopyResult] = useState<{ ok: boolean; lines: string[] }>()
  const fetchTask = useTask<RulesFetchPlan>()
  const [fetchTop, setFetchTop] = useState(0)
  const [writing, setWriting] = useState(false)
  const [writeError, setWriteError] = useState<string>()
  // Undefined while the opener is still trying; then whether a browser opened.
  const [builderOpened, setBuilderOpened] = useState<boolean>()

  const dirty = draft !== undefined && JSON.stringify(value) !== JSON.stringify(draft.value)
  useReportUnsaved(dirty)
  // A locale with no file can be saved as it stands: that is how someone
  // content with the built-in rules says so, and what the setup step counts.
  // The defaults are written commented out, so nothing is re-reviewed.
  const savable = dirty || (draft !== undefined && !draft.exists)
  const id = draft?.locale ?? broken?.locale ?? ''
  const rulesPath = draft?.path ?? broken?.path
  // Fetching leads when polyglots-data holds maintained rules for the locale:
  // for someone whose file is missing or stale it is the step they want, and
  // buried among a dozen editors it was easy to miss. The other rows keep
  // their order so a person who knows the screen finds them where they were.
  const rows = broken ? REPAIR_STAGE : maintained ? ['fetch' as Stage, ...SECTION_STAGE.filter((s) => s !== 'fetch')] : SECTION_STAGE
  const current = section !== undefined && rows.includes(section) ? section : rows[0]!
  const cursor = rows.indexOf(current)
  // Derived inside the updater: two arrow presses can arrive before a render,
  // and an index read from the render would drop the second.
  const moveCursor = (by: number) =>
    setSection((s) => {
      const from = s !== undefined && rows.includes(s) ? rows.indexOf(s) : 0
      return rows[Math.min(Math.max(0, from + by), rows.length - 1)]
    })

  const activeRules = (): Set<string> =>
    value.rules
      ? new Set([...UNIVERSAL_RULES, ...value.rules.enable].filter((r) => !value.rules!.disable.includes(r)))
      : new Set(draft?.builtIn.rules ?? [])
  const ratio = value.glossaryStemRatio ?? draft?.builtIn.glossaryStemRatio ?? 0.7
  // Counted as the limit counts it: the final newline a | block keeps is not
  // part of the text.
  const capitalizationLength = value.capitalization?.trimEnd().length ?? 0

  const open = (raw: string) => {
    const resolved = resolveLocale(raw)
    if (!resolved) {
      setError(`Locale "${raw.trim()}" is not listed on translate.wordpress.org`)
      return
    }
    try {
      const opened = openRulesDraft(resolved.id)
      setDraft(opened)
      setValue(opened.value)
      setError(undefined)
      // Pinned, not left to default to the first row: the first row changes
      // when the manifest says the rules are maintained, and an enter pressed
      // while reading must open what was highlighted, not what moved under it.
      setSection(SECTION_STAGE[0])
      setStage('overview')
    } catch (err) {
      setError(errorText(err))
      // A file that does not parse still opens, to the repairs: stopping at
      // the prompt left fetching the published file, the natural mend, to
      // the CLI alone. Anything else (an unreadable file) stays here.
      if (err instanceof RulesFileError) {
        setBroken({ locale: resolved.id, path: err.path })
        setSection(undefined)
        setStage('overview')
      }
    }
  }

  // A configured locale opens at once: asking for the locale the header
  // already shows was a step with one answer. The manifest is read once for
  // that locale, in the background, so the overview is drawn first and
  // reorders if the answer is yes. A failed read leaves the order alone.
  const startLocale = configuredLocale(config)
  useEffect(() => {
    if (startLocale === undefined) return
    open(startLocale)
    let wanted = true
    commands.dataClient.manifest().then(
      (manifest) => wanted && setMaintained(rulesMaintained(manifest, startLocale)),
      () => undefined,
    )
    return () => {
      wanted = false
    }
    // Once per mounted locale: App remounts the screen when the locale changes.
  }, [])

  const save = async () => {
    if (!draft) return
    try {
      const next = await saveRulesDraft(draft, value)
      setDraft(next)
      setValue(next.value)
      setError(undefined)
      setNotice(`Saved ${basename(next.path)}.`)
    } catch (err) {
      setNotice(undefined)
      setError(errorText(err))
    }
  }

  const toggle = (rule: string) => {
    const rules = activeRules()
    if (rules.has(rule)) rules.delete(rule)
    else rules.add(rule)
    setValue({
      ...value,
      rules: {
        enable: [...rules].filter((r) => !UNIVERSAL_RULES.includes(r)),
        disable: UNIVERSAL_RULES.filter((r) => !rules.has(r)),
      },
    })
    setNotice(undefined)
  }

  const nouns = (list: NounList): readonly string[] => value.properNouns?.[list] ?? draft?.builtIn.properNouns[list] ?? []
  // A list edited for the first time is written out whole, built-in names
  // included, since a list in the file replaces the built-in one. The other
  // list stays out of the file and so stays built-in.
  const setNouns = (list: NounList, names: string[]) => {
    setValue({ ...value, properNouns: { ...(value.properNouns ?? {}), [list]: names } })
    setNotice(undefined)
  }

  // A text emptied in its editor takes the key out of the file, as guidance
  // does, so the built-in wording comes back rather than a blank one.
  const setText = (key: 'capitalization', text: string) => {
    const { [key]: _, ...rest } = value
    setValue(text === '' ? rest : { ...value, [key]: text })
    setNotice(undefined)
  }
  const setFormality = (formality: Formality) => {
    const { formality: _, ...rest } = value
    setValue(formality === undefined ? rest : { ...value, formality })
    setNotice(undefined)
  }
  const register = registerParts(value.register)
  const setRegister = (part: RegisterPart, text: string) => {
    const { [part]: _, ...others } = register
    const parts = text === '' ? others : { ...others, [part]: text }
    const { register: _r, ...rest } = value
    setValue(Object.keys(parts).length === 0 ? rest : { ...value, register: parts })
    setNotice(undefined)
  }
  const end: SentenceEnd = value.sentenceEnd ?? {}
  // Only what is set reaches the file: unmarked is true or absent, and an
  // empty list or an empty section is left out rather than written empty.
  const setEnd = (next: SentenceEnd) => {
    const kept: SentenceEnd = {
      ...(next.answers?.length ? { answers: next.answers } : {}),
      ...(next.unmarked ? { unmarked: true as const } : {}),
      ...(next.notEnding !== undefined && next.notEnding !== '' ? { notEnding: next.notEnding } : {}),
    }
    const { sentenceEnd: _, ...rest } = value
    setValue(Object.keys(kept).length === 0 ? rest : { ...value, sentenceEnd: kept })
    setNotice(undefined)
  }
  const openEndRow = () => {
    if (endCursor === 0) {
      const { unmarked: _, ...rest } = end
      setEnd(end.unmarked ? rest : { ...end, unmarked: true })
    } else setStage(endCursor === 1 ? 'notEnding' : 'answers')
  }
  const formalityIndex = Math.max(0, FORMALITIES.findIndex((f) => f.value === value.formality))

  const dates: DateTime = value.dateTime ?? {}
  // As setEnd: only what is set reaches the file, and a section left with
  // nothing in it is taken out rather than written empty.
  const setDateTime = (next: DateTime) => {
    const kept: DateTime = {
      ...(next.clock ? { clock: next.clock } : {}),
      ...(next.order ? { order: next.order } : {}),
      ...(next.formats && Object.keys(next.formats).length > 0 ? { formats: next.formats } : {}),
    }
    const { dateTime: _, ...rest } = value
    setValue(Object.keys(kept).length === 0 ? rest : { ...value, dateTime: kept })
    setNotice(undefined)
  }
  const changeDateRow = (by: number) => {
    if (dateCursor === 0) setDateTime({ ...dates, clock: step(CLOCKS, dates.clock, by) })
    if (dateCursor === 1) setDateTime({ ...dates, order: step(DATE_ORDERS, dates.order, by) })
  }
  const formats: Format[] = Object.entries(dates.formats ?? {}).map(([source, target]) => ({ source, target }))
  // Checked as the schema checks them, as they are typed: a suggestion the
  // date-format check reports would teach contributors the wrong answer, and
  // the file would be refused at save with the form long closed.
  const formatFields = [
    {
      key: 'source',
      label: 'English format',
      required: true,
      validate: (v: string) => (v.trim() !== '' && !isDateFormat(v.trim(), 'date format') ? 'not a PHP date format' : undefined),
    },
    {
      key: 'target',
      label: 'Your format',
      required: true,
      validate: (v: string, all: Record<string, string>) => {
        const source = (all.source ?? '').trim()
        if (v.trim() === '' || !isDateFormat(source, 'date format')) return undefined
        const rules = { ...(dates.clock ? { clock: dates.clock } : {}), ...(dates.order ? { order: dates.order } : {}) }
        const problem = dateFormatProblems(source, v.trim(), rules)[0]
        return problem ? `the date-format check reports: ${problem.message}` : undefined
      },
    },
  ]
  const nameOrderIndex = Math.max(0, NAME_ORDERS.findIndex((n) => n.value === value.names?.order))
  const setNameOrder = (order: NameOrder) => {
    const { names: _, ...rest } = value
    setValue(order === undefined ? rest : { ...value, names: { order } })
    setNotice(undefined)
  }

  // One listener, every stage: what a key does depends on the stage, and only
  // the live stage's handlers are set. The list editors, the forms and the
  // guidance editor own their keys, so none are set here while one is open.
  // Copy shows a form only when there is a saved file and nothing unsaved;
  // otherwise it is a notice, and esc has to come from here.
  const on = (...stages: Stage[]) => stages.includes(stage)
  const copyNotice = stage === 'copy' && (dirty || !draft?.exists)
  const toOverview = () => setStage('overview')
  const leave = () => (dirty ? setStage('leave') : onBack())
  // Fetching never starts over unsaved edits: the fetched file replaces the
  // one on disk, the edits were made against that one, and writing it would
  // drop them without a word. Save or discard first, as copy asks.
  const openFetch = () => {
    setFetchTop(0)
    setWriteError(undefined)
    if (dirty) fetchTask.reset()
    else fetchTask.run(() => commands.planRulesFetch(id, commands.dataClient))
  }
  const fetchPlan = fetchTask.state.status === 'done' ? fetchTask.state.result : undefined
  const fetchRows = Math.max(MIN_FETCH_ROWS, size.rows - FETCH_CHROME_ROWS)
  const fetchMaxTop = Math.max(0, (fetchPlan?.summary.length ?? 0) - fetchRows)
  // Written exactly as downloaded, then read back through the same open the
  // screen started with, so what is on screen is the file now on disk, with
  // nothing left over from the old one to save on top of it.
  const writeFetched = async (plan: RulesFetchPlan) => {
    setWriting(true)
    try {
      await commands.writeRulesFetch(plan)
      const opened = openRulesDraft(plan.locale)
      setDraft(opened)
      setValue(opened.value)
      setBroken(undefined)
      // From the repairs the cursor was on their first row; in the full
      // overview it stays on the fetch it came from.
      setSection('fetch')
      setError(undefined)
      setNotice(`Wrote ${basename(plan.path)}.`)
      setStage('overview')
    } catch (err) {
      // The file changed while the summary was on screen. The summary is
      // about a file that is gone, and y left bound to it refused again on
      // every press with the CLI's "run rules fetch again". The screen can do
      // that itself: plan against the file as it is now and say why the
      // summary changed under the person's eyes.
      if (err instanceof RulesFileChangedError) {
        setFetchTop(0)
        setWriteError(`${basename(plan.path)} changed since the summary; nothing was written. Below is what writing does now.`)
        fetchTask.run(() => commands.planRulesFetch(id, commands.dataClient))
      } else setWriteError(errorText(err))
    } finally {
      setWriting(false)
    }
  }
  const builderUrl = rulesBuilderUrl(wpCodeOf(id) ?? id)
  const openSection = () => {
    const next = rows[cursor]!
    if (next === 'fetch') openFetch()
    if (next === 'builder') {
      // The address is shown either way: over SSH no browser opens, and the
      // person copies it to the machine they are sitting at.
      setBuilderOpened(undefined)
      void commands.openInBrowser(builderUrl).then(setBuilderOpened)
    }
    if (next === 'copy') setCopyResult(undefined)
    if (next === 'try') {
      setTrial(undefined)
      // The locale's glossary, read once, so the glossary rule fires in a trial too.
      if (glossary === undefined) setGlossary(glossaryRows(id))
    }
    setStage(next)
  }
  useKeys({
    back: {
      esc:
        copyNotice ||
        on('nouns', 'rules', 'ratio', 'leave', 'builder', 'formality', 'register', 'sentenceEnd', 'dateTime', 'names') ||
        (on('fetch') && !writing)
          ? toOverview
          : on('pick')
            ? onBack
            : on('overview')
              ? leave
              : undefined,
      q: on('overview') ? leave : undefined,
    },
    localeRules: {
      move: on('overview')
        ? (_ch, key) => moveCursor(key.upArrow ? -1 : 1)
        : undefined,
      open: on('overview') ? openSection : undefined,
      save: on('overview') && savable ? () => void save() : undefined,
    },
    rulesFetch: {
      scroll:
        on('fetch') && fetchMaxTop > 0
          ? (_ch, key) => setFetchTop((t) => Math.min(fetchMaxTop, Math.max(0, Math.min(t, fetchMaxTop) + (key.upArrow ? -1 : 1))))
          : undefined,
      write: on('fetch') && !dirty && !writing && fetchPlan !== undefined && fetchPlan.state !== 'same' ? () => void writeFetched(fetchPlan) : undefined,
    },
    leave: {
      save: on('leave') ? () => void save().then(toOverview) : undefined,
      discard: on('leave') ? onBack : undefined,
    },
    ruleList: {
      move: on('rules')
        ? (_ch, key) =>
            key.upArrow ? setRuleCursor((c) => Math.max(0, c - 1)) : setRuleCursor((c) => Math.min(BUILT_IN_RULES.length - 1, c + 1))
        : undefined,
      toggle: on('rules') ? () => toggle(BUILT_IN_RULES[ruleCursor]!) : undefined,
    },
    ratio: {
      change: on('ratio')
        ? (_ch, key) => {
            const next = round(Math.min(1, Math.max(RATIO_STEP, ratio + (key.leftArrow ? -RATIO_STEP : RATIO_STEP))))
            setValue({ ...value, glossaryStemRatio: next })
            setNotice(undefined)
          }
        : undefined,
      reset: on('ratio')
        ? () => {
            const { glossaryStemRatio: _, ...rest } = value
            setValue(rest)
          }
        : undefined,
    },
    nouns: {
      move: on('nouns') ? () => setNounCursor((c) => (c === 0 ? 1 : 0)) : undefined,
      open: on('nouns') ? () => setStage('nounList') : undefined,
    },
    formality: {
      choose: on('formality')
        ? (_ch, key) =>
            setFormality(FORMALITIES[key.upArrow ? Math.max(0, formalityIndex - 1) : Math.min(FORMALITIES.length - 1, formalityIndex + 1)]!.value)
        : undefined,
    },
    register: {
      move: on('register') ? () => setRegisterCursor((c) => (c === 0 ? 1 : 0)) : undefined,
      open: on('register') ? () => setStage('registerText') : undefined,
    },
    sentenceEnd: {
      move: on('sentenceEnd')
        ? (_ch, key) =>
            key.upArrow ? setEndCursor((c) => Math.max(0, c - 1)) : setEndCursor((c) => Math.min(SENTENCE_END_ROWS - 1, c + 1))
        : undefined,
      open: on('sentenceEnd') ? openEndRow : undefined,
    },
    dateTime: {
      move: on('dateTime')
        ? (_ch, key) =>
            key.upArrow ? setDateCursor((c) => Math.max(0, c - 1)) : setDateCursor((c) => Math.min(DATE_TIME_ROWS - 1, c + 1))
        : undefined,
      change: on('dateTime') && dateCursor < 2 ? (_ch, key) => changeDateRow(key.leftArrow ? -1 : 1) : undefined,
      open: on('dateTime') && dateCursor === 2 ? () => setStage('formats') : undefined,
    },
    names: {
      choose: on('names')
        ? (_ch, key) =>
            setNameOrder(NAME_ORDERS[key.upArrow ? Math.max(0, nameOrderIndex - 1) : Math.min(NAME_ORDERS.length - 1, nameOrderIndex + 1)]!.value)
        : undefined,
    },
  })

  const marker = (selected: boolean) => (selected ? '❯ ' : '  ')
  const sectionLabel = (section: Stage): string => {
    switch (section) {
      case 'rules':
        return `Built-in rules     ${activeRules().size} on`
      case 'formality':
        return `Formality          ${value.formality ?? 'not set'}`
      case 'register':
        return `Register           ${describeRegister(value.register)}`
      case 'capitalization':
        return `Capitalization     ${capitalizationLength} of ${CAPITALIZATION_LIMIT} characters`
      case 'guidance':
        return `Guidance           ${value.guidance?.length ?? 0} of ${GUIDANCE_LIMIT} characters`
      case 'nouns':
        return `Proper nouns       ${nouns('always').length} always · ${nouns('dateOnly').length} date-only`
      case 'mistakes':
        return `Common mistakes    ${value.mistakes.length}`
      case 'patterns':
        return `Patterns           ${value.patterns.length}`
      case 'sentenceEnd':
        return `Sentence ends      ${describeSentenceEnd(value.sentenceEnd)}`
      case 'dateTime':
        return `Dates and times    ${describeDateTime(value.dateTime)}`
      case 'names':
        return `Name order         ${value.names?.order ?? 'not set'}`
      case 'ratio':
        return `Glossary match     ${ratio.toFixed(2)}`
      case 'try':
        return 'Try the rules      check a sample against the rules as edited'
      case 'copy':
        return 'Copy to another locale'
      case 'fetch':
        return 'Fetch from polyglots-data'
      case 'builder':
        return 'Open the rules builder in your browser'
      default:
        return section
    }
  }
  const header = draft || broken ? `${wpCodeOf(id) ?? id} (${id})` : ''

  return (
    <Box flexDirection="column">
      <Text bold>
        Locale rules{header ? ` · ${header}` : ''}
        {dirty ? <Text color="yellow">  unsaved changes</Text> : null}
      </Text>

      {stage === 'pick' && (
        <>
          <Box>
            <Text>Locale: </Text>
            <TextInput value={input} onChange={setInput} onSubmit={open} />
          </Box>
          <Text dimColor>Any spelling: tr, tr_TR, nl_NL_formal, nl/formal.</Text>
          {error && <Text color="red">{error}</Text>}
          <Hint>enter to open · esc back to menu</Hint>
        </>
      )}

      {/* Worded as rules check words it: polyglots ships no locale data, so
          "built-in defaults" promised a locale more than it gets. */}
      {draft && stage !== 'pick' && (
        <Text dimColor>
          {draft.exists
            ? draft.path
            : `No file yet: only the universal checks run. s saves these rules as ${basename(draft.path)}, which completes this setup step.`}
        </Text>
      )}

      {broken && !draft && stage !== 'pick' && <Text dimColor>{broken.path}</Text>}

      {broken && !draft && stage === 'overview' && (
        <>
          {error && <Text color="red">{error}</Text>}
          <Text>Not a valid rules file, so it cannot be edited here. Mend it by hand, or replace it:</Text>
          <Text>{`${marker(cursor === 0)}Fetch from polyglots-data`}</Text>
          <Text>{`${marker(cursor === 1)}Open the rules builder in your browser`}</Text>
          <Hint>↑↓ move · enter open · esc back</Hint>
        </>
      )}

      {draft && (stage === 'overview' || stage === 'leave') && (
        <>
          {/* Followed, as the rule list is: with dateTime and names the list
              is taller than a 24-row terminal, and a body with no target to
              follow kept whatever offset the last screen left, hiding the
              title on the way back and the cursor on the way down. */}
          {rows.map((row, i) => (
            <ScrollTarget key={row} active={cursor === i}>
              <Text>{`${marker(cursor === i)}${sectionLabel(row)}`}</Text>
            </ScrollTarget>
          ))}
          {dirty && (
            <Text color="yellow">
              Saving changes the rules for {id}: the next review of every {id} file starts over.
            </Text>
          )}
          {notice && <Text color="green">{notice}</Text>}
          {error && <Text color="red">{error}</Text>}
          {stage === 'leave' ? (
            <Text color="yellow">Unsaved changes. s save · d discard and leave · esc keep editing</Text>
          ) : (
            <Hint>
              {dirty
                ? '↑↓ move · enter open · s save · esc back'
                : savable
                  ? '↑↓ move · enter open · s save these rules · esc back'
                  : '↑↓ move · enter open · esc back'}
            </Hint>
          )}
        </>
      )}

      {draft && stage === 'rules' && (
        <>
          {BUILT_IN_RULES.map((rule, i) => (
            <ScrollTarget key={rule} active={i === ruleCursor}>
              <Text>
                {marker(i === ruleCursor)}[{activeRules().has(rule) ? 'x' : ' '}] {rule.padEnd(14)}
                <Text dimColor>{UNIVERSAL_RULES.includes(rule) ? 'universal' : 'opt-in'}</Text>
              </Text>
            </ScrollTarget>
          ))}
          {/* The ids are what rules.json holds, so the list keeps them; the
              plain name and what the rule checks sit under it, for the one
              row in focus, where a sixty-column frame has room to wrap them. */}
          <RuleDetail rule={BUILT_IN_RULES[ruleCursor]} />
          <Hint>↑↓ move · space toggle · esc back to the overview</Hint>
        </>
      )}

      {draft && stage === 'nouns' && (
        <>
          {NOUN_LISTS.map((l, i) => (
            <Text key={l.key}>
              {marker(i === nounCursor)}
              {l.label.padEnd(26)}
              <Text dimColor>
                {nouns(l.key).length} names{value.properNouns?.[l.key] ? '' : ', built-in'}
              </Text>
            </Text>
          ))}
          <Hint>↑↓ move · enter open · esc back to the overview</Hint>
        </>
      )}

      {draft && stage === 'nounList' && (
        <ListEditor<string>
          title={NOUN_LISTS[nounCursor]!.label}
          items={[...nouns(NOUN_LISTS[nounCursor]!.key)]}
          empty="No names."
          describe={(n) => n}
          fields={[{ key: 'name', label: 'Name', required: true }]}
          toForm={(n) => ({ name: n })}
          fromForm={(v) => v.name!.trim()}
          onChange={(names) => setNouns(NOUN_LISTS[nounCursor]!.key, names)}
          onBack={() => setStage('nouns')}
        />
      )}

      {draft && stage === 'mistakes' && (
        <ListEditor<Mistake>
          title="Common mistakes"
          items={value.mistakes}
          empty="No mistakes yet. A match goes to the AI review with your note."
          describe={describeMistake}
          fields={[
            { key: 'wrong', label: 'Wrong', required: true },
            { key: 'right', label: 'Right' },
            { key: 'note', label: 'Note' },
          ]}
          toForm={(m) => ({ wrong: m.wrong, right: m.right ?? '', note: m.note ?? '' })}
          fromForm={(v) => ({
            wrong: v.wrong!.trim(),
            ...(v.right?.trim() ? { right: v.right.trim() } : {}),
            ...(v.note?.trim() ? { note: v.note.trim() } : {}),
          })}
          onChange={(mistakes) => {
            setValue({ ...value, mistakes })
            setNotice(undefined)
          }}
          onBack={() => setStage('overview')}
        />
      )}

      {draft && stage === 'patterns' && (
        <ListEditor<Pattern>
          title="Patterns"
          items={value.patterns}
          empty="No patterns yet. hint: the AI judges · error: always wrong · fix: replaced automatically."
          describe={describePattern}
          fields={PATTERN_FIELDS}
          toForm={patternToForm}
          fromForm={patternFromForm}
          onChange={(patterns) => {
            setValue({ ...value, patterns })
            setNotice(undefined)
          }}
          onBack={() => setStage('overview')}
        />
      )}

      {draft && stage === 'guidance' && (
        <>
          <Text>Guidance for the AI review prompts</Text>
          <MultilineInput
            value={value.guidance ?? ''}
            onChange={(text) => {
              const { guidance: _, ...rest } = value
              setValue(text === '' ? rest : { ...value, guidance: text })
              setNotice(undefined)
            }}
            onDone={() => setStage('overview')}
          />
          <Text color={(value.guidance?.length ?? 0) > GUIDANCE_LIMIT ? 'red' : undefined} dimColor={(value.guidance?.length ?? 0) <= GUIDANCE_LIMIT}>
            {`${value.guidance?.length ?? 0} of ${GUIDANCE_LIMIT} characters${(value.guidance?.length ?? 0) > GUIDANCE_LIMIT ? ': too long to save' : ''}`}
          </Text>
          <Hint>enter new line · ctrl+x clear · ctrl+z undo · esc back to the overview</Hint>
        </>
      )}

      {draft && stage === 'capitalization' && (
        <>
          <Text>Capitalization, for the prompts where title-case runs</Text>
          <Text dimColor>One "- " line per point; {'{language}'} becomes the language's name. Write in English; the model reads it.</Text>
          <MultilineInput value={value.capitalization ?? ''} onChange={(text) => setText('capitalization', text)} onDone={() => setStage('overview')} />
          <TextCount length={capitalizationLength} limit={CAPITALIZATION_LIMIT} />
          <Hint>enter new line · ctrl+x clear · ctrl+z undo · esc back to the overview</Hint>
        </>
      )}

      {draft && stage === 'formality' && (
        <>
          <Text>How a draft addresses the reader</Text>
          {FORMALITIES.map((f, i) => (
            <Text key={f.label}>{`${marker(i === formalityIndex)}${f.label}`}</Text>
          ))}
          <Hint>↑↓ choose · esc back to the overview</Hint>
        </>
      )}

      {draft && stage === 'register' && (
        <>
          <Text dimColor>
            The tone and form of address. Leave both empty for the register that is standard in WordPress for your language.
          </Text>
          {REGISTER_PARTS.map((part, i) => (
            <Text key={part.key}>
              {marker(i === registerCursor)}
              {part.label.padEnd(26)}
              <Text dimColor>{`${register[part.key]?.length ?? 0} of ${REGISTER_LIMIT}`}</Text>
            </Text>
          ))}
          <Hint>↑↓ move · enter edit · esc back to the overview</Hint>
        </>
      )}

      {draft && stage === 'registerText' && (
        <>
          <Text>{`Register ${REGISTER_PARTS[registerCursor]!.label.toLowerCase()}`}</Text>
          <Text dimColor>Write in English; the model reads it.</Text>
          <MultilineInput
            value={register[REGISTER_PARTS[registerCursor]!.key] ?? ''}
            onChange={(text) => setRegister(REGISTER_PARTS[registerCursor]!.key, text)}
            onDone={() => setStage('register')}
          />
          <TextCount length={register[REGISTER_PARTS[registerCursor]!.key]?.length ?? 0} limit={REGISTER_LIMIT} />
          <Hint>enter new line · ctrl+x clear · ctrl+z undo · esc back</Hint>
        </>
      )}

      {draft && stage === 'sentenceEnd' && (
        <>
          <Text dimColor>For scripts whose final mark is not a full stop. Each value is a regular expression.</Text>
          <Text>{`${marker(endCursor === 0)}[${end.unmarked ? 'x' : ' '}] The language writes no final mark`}</Text>
          <Text>{`${marker(endCursor === 1)}Not a stop         ${end.notEnding ?? 'not set'}`}</Text>
          <Text>{`${marker(endCursor === 2)}Final marks        ${end.answers?.length ?? 0}`}</Text>
          <Hint>↑↓ move · space or enter toggle or open · esc back to the overview</Hint>
        </>
      )}

      {draft && stage === 'notEnding' && (
        <>
          <Text>A mark that looks like a full stop and is not one</Text>
          <Form
            fields={[{ key: 'notEnding', label: 'Regex', validate: sentenceRegex }]}
            initial={{ notEnding: end.notEnding ?? '' }}
            onCancel={() => setStage('sentenceEnd')}
            onSubmit={(v) => {
              const { notEnding: _, ...rest } = end
              setEnd(v.notEnding ? { ...rest, notEnding: v.notEnding } : rest)
              setStage('sentenceEnd')
            }}
          />
        </>
      )}

      {draft && stage === 'answers' && (
        <ListEditor<Answer>
          title="Final marks"
          items={end.answers ?? []}
          empty="No final marks. Add the marks that answer a source's full stop, such as ։ or ።."
          describe={describeAnswer}
          fields={ANSWER_FIELDS}
          toForm={(a) => ({ text: a.text, source: a.source ?? '' })}
          fromForm={(v) => ({ text: v.text!, ...(v.source ? { source: v.source } : {}) })}
          onChange={(answers) => setEnd({ ...end, answers })}
          onBack={() => setStage('sentenceEnd')}
        />
      )}

      {draft && stage === 'dateTime' && (
        <>
          <Text dimColor>How the language writes dates and times, for the date-format check and the prompts.</Text>
          <Text>{`${marker(dateCursor === 0)}Clock              ${dates.clock ?? 'not set'}`}</Text>
          <Text>{`${marker(dateCursor === 1)}Date order         ${dates.order ?? 'not set'}`}</Text>
          <Text>{`${marker(dateCursor === 2)}Formats            ${formats.length}`}</Text>
          <Hint>{dateCursor === 2 ? '↑↓ move · enter open · esc back to the overview' : '↑↓ move · ←→ change · esc back to the overview'}</Hint>
        </>
      )}

      {draft && stage === 'formats' && (
        <ListEditor<Format>
          title="Usual formats"
          items={formats}
          empty={'No formats. Add what a common English format becomes, such as "F j, Y" → "j F Y".'}
          describe={(f) => `"${f.source}" → "${f.target}"`}
          fields={formatFields}
          toForm={(f) => ({ source: f.source, target: f.target })}
          fromForm={(v) => ({ source: v.source!.trim(), target: v.target!.trim() })}
          onChange={(list) => setDateTime({ ...dates, formats: Object.fromEntries(list.map((f) => [f.source, f.target])) })}
          onBack={() => setStage('dateTime')}
        />
      )}

      {draft && stage === 'names' && (
        <>
          <Text>Which name the language writes first, for the name-order check</Text>
          {NAME_ORDERS.map((n, i) => (
            <Text key={n.label}>{`${marker(i === nameOrderIndex)}${n.label}`}</Text>
          ))}
          <Text dimColor>Family name first adds a line to the prompts and checks full names such as "%1$s %2$s".</Text>
          <Hint>↑↓ choose · esc back to the overview</Hint>
        </>
      )}

      {draft && stage === 'copy' && (
        <>
          <Text>Copy the saved rules of {id} to another locale</Text>
          {dirty ? (
            <>
              <Text color="yellow">Save first: copy takes the file on disk, which is not what is on screen.</Text>
              <Hint>esc back to the overview</Hint>
            </>
          ) : !draft.exists ? (
            <>
              <Text color="yellow">{`There is no rules file for ${id} to copy yet.`}</Text>
              <Hint>esc back to the overview</Hint>
            </>
          ) : (
            <Form
              fields={[
                {
                  key: 'to',
                  label: 'To locale',
                  required: true,
                  validate: (v) => (v.trim() !== '' && !resolveLocale(v) ? 'not listed on translate.wordpress.org' : undefined),
                },
                { key: 'force', label: 'Replace if it exists (y/n)' },
              ]}
              onCancel={() => setStage('overview')}
              onSubmit={(v) => {
                const target = resolveLocale(v.to!)!.id
                copyRules(id, target, /^y$/i.test((v.force ?? '').trim()))
                  .then((lines) => setCopyResult({ ok: true, lines }))
                  .catch((err: unknown) => setCopyResult({ ok: false, lines: [errorText(err)] }))
              }}
            />
          )}
          {copyResult?.lines.map((line, i) => (
            <Text key={i} color={copyResult.ok ? (i === 0 ? 'green' : undefined) : 'red'}>
              {line}
            </Text>
          ))}
        </>
      )}

      {(draft || broken) && stage === 'fetch' && (
        <FetchPanel
          id={id}
          dirty={dirty}
          task={fetchTask.state}
          top={Math.min(fetchTop, fetchMaxTop)}
          rows={fetchRows}
          writing={writing}
          writeError={writeError}
        />
      )}

      {draft && stage === 'try' && (
        <>
          <Text>Try the rules as edited, saved or not</Text>
          <Form
            fields={[
              { key: 'source', label: 'Source', required: true },
              { key: 'translation', label: 'Translation', required: true },
            ]}
            onCancel={() => setStage('overview')}
            onSubmit={(v) => {
              try {
                setTrial(tryRules(draft, value, { source: v.source!, translation: v.translation! }, glossary ?? []))
              } catch (err) {
                setTrial(errorText(err))
              }
            }}
          />
          {typeof trial === 'string' && <Text color="red">{trial}</Text>}
          {trial && typeof trial !== 'string' && (
            <Box flexDirection="column">
              {trial.fixed !== undefined && <Text color="green">{`Fixed to: ${trial.fixed}`}</Text>}
              {trial.findings.length === 0 && <Text color="green">Nothing fires.</Text>}
              {trial.findings.map((f, i) => (
                <Text key={i} color={f.severity === 'error' ? 'red' : 'yellow'}>
                  {`${f.rule} (${f.severity}): ${f.message}`}
                </Text>
              ))}
            </Box>
          )}
        </>
      )}

      {(draft || broken) && stage === 'builder' && (
        <>
          <Text>
            {builderOpened === undefined
              ? 'Opening the rules builder…'
              : builderOpened
                ? 'Opened the rules builder in your browser:'
                : 'Open this address in your browser:'}
          </Text>
          <Text color="cyan">{builderUrl}</Text>
          <Text dimColor>It writes a rules file for {wpCodeOf(id) ?? id} step by step; save the download as {basename(rulesPath ?? '')}.</Text>
          <Hint>esc back to the overview</Hint>
        </>
      )}

      {draft && stage === 'ratio' && (
        <>
          <Text>
            Glossary match: {ratio.toFixed(2)}
            <Text dimColor>  built-in {draft.builtIn.glossaryStemRatio.toFixed(2)}</Text>
          </Text>
          <Text dimColor>How much of a glossary term an inflected form must keep to count as using it.</Text>
          <Hint>←→ change · r back to built-in · esc back to the overview</Hint>
        </>
      )}
    </Box>
  )
}

/**
 * What a fetch would write, before it is written: the same checks and the
 * same summary as rules fetch, read in a window the arrow keys move, since a
 * changed guidance or capitalization is printed in full and can run to pages.
 * The question sits above the summary so it stays in view however far the
 * summary is scrolled.
 */
function FetchPanel({
  id,
  dirty,
  task,
  top,
  rows,
  writing,
  writeError,
}: {
  id: string
  dirty: boolean
  task: TaskState<RulesFetchPlan>
  top: number
  rows: number
  writing: boolean
  writeError: string | undefined
}) {
  const back = <Hint>esc back to the overview</Hint>
  let body
  if (dirty) {
    body = (
      <>
        <Text color="yellow">Save or discard your changes first: the fetched file replaces the one on disk, and these edits would be lost.</Text>
        {back}
      </>
    )
  } else if (task.status === 'idle' || task.status === 'running') {
    body = <Text>Checking polyglots-data…</Text>
  } else if (task.status === 'error') {
    body = (
      <>
        <Text color="red">{task.message}</Text>
        {back}
      </>
    )
  } else if (task.result.state === 'same') {
    body = (
      <>
        <Text color="green">Already the published file.</Text>
        {back}
      </>
    )
  } else {
    const plan = task.result
    const below = Math.max(0, plan.summary.length - top - rows)
    body = (
      <>
        <Text color="yellow">{plan.state === 'changed' ? `This replaces ${plan.path}.` : `y writes ${plan.path}.`}</Text>
        <Text color="yellow">
          Writing changes the rules for {id}: the next review of every {id} file starts over.
        </Text>
        {writeError && <Text color="red">{writeError}</Text>}
        <Hint>{writing ? 'Writing…' : `${below > 0 || top > 0 ? '↑↓ scroll · ' : ''}y write · esc cancel`}</Hint>
        <Text> </Text>
        {top > 0 && <Text dimColor>{`… ${top} more above`}</Text>}
        {plan.summary.slice(top, top + rows).map((line, i) => (
          <Text key={top + i}>{line}</Text>
        ))}
        {below > 0 && <Text dimColor>{`… ${below} more below`}</Text>}
      </>
    )
  }
  return (
    <>
      <Text>Fetch the published rules of {id} from polyglots-data</Text>
      {body}
    </>
  )
}

function RuleDetail({ rule }: { rule: string | undefined }) {
  const label = rule === undefined ? undefined : findingLabel(rule)
  if (!label) return null
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{label.name}</Text>
      <Text dimColor>{label.description}</Text>
    </Box>
  )
}

function TextCount({ length, limit }: { length: number; limit: number }) {
  return (
    <Text color={length > limit ? 'red' : undefined} dimColor={length <= limit}>
      {`${length} of ${limit} characters${length > limit ? ': too long to save' : ''}`}
    </Text>
  )
}
