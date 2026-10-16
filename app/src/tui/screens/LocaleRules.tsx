import { basename } from 'node:path'
import { useState } from 'react'
import { Box, Text } from 'ink'
import { UNIVERSAL_RULES } from '../../audit/rules/profiles.js'
import { openRulesDraft, saveRulesDraft, type RulesDraft, type RulesValue } from '../../rules/edit.js'
import { BUILT_IN_RULES, findingLabel } from '../../rules/names.js'
import { GUIDANCE_LIMIT } from '../../rules/schema.js'
import { resolveLocale, wpCodeOf } from '../../wporg/locales.js'
import { useConfig } from '../commands.js'
import { Hint } from '../components/Hint.js'
import { ListEditor } from '../components/ListEditor.js'
import { Form } from '../components/Form.js'
import { MultilineInput } from '../components/MultilineInput.js'
import { copyRules } from '../../cli/rules.js'
import { tryRules, type TryResult } from '../../rules/try.js'
import { glossaryRows } from '../setup.js'
import type { GlossaryEntry } from '../../types.js'
import { useKeys } from '../hooks/useKeys.js'
import { TextInput } from '../input.js'
import { ScrollTarget } from '../components/Viewport.js'

export interface LocaleRulesProps {
  onBack: () => void
}

type Stage = 'pick' | 'overview' | 'rules' | 'ratio' | 'nouns' | 'nounList' | 'mistakes' | 'patterns' | 'guidance' | 'try' | 'copy' | 'leave'

const SECTIONS = ['Built-in rules', 'Glossary match', 'Proper nouns', 'Common mistakes', 'Patterns', 'Guidance', 'Try the rules', 'Copy to another locale'] as const
const SECTION_STAGE: Stage[] = ['rules', 'ratio', 'nouns', 'mistakes', 'patterns', 'guidance', 'try', 'copy']
type NounList = 'always' | 'dateOnly'
const NOUN_LISTS: { key: NounList; label: string }[] = [
  { key: 'always', label: 'Always capitalized' },
  { key: 'dateOnly', label: 'Only in a specific date' },
]
type Mistake = RulesValue['mistakes'][number]

type Pattern = RulesValue['patterns'][number]

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
  `${p.when ? `  when the source has "${p.when.source}"` : ''}${p.note ? `  (${p.note})` : ''}`

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
  { key: 'note', label: 'Note' },
]

const patternToForm = (p: Pattern): Record<string, string> => ({
  text: p.text ?? '',
  find: p.find ?? '',
  ignoreCase: p.ignoreCase ? 'y' : '',
  replace: p.replace ?? '',
  level: p.level ?? '',
  when: p.when?.source ?? '',
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
    ...(has('when') ? { when: { source: v.when!.trim() } } : {}),
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
  const { config } = useConfig()
  const [stage, setStage] = useState<Stage>('pick')
  // Empty when no locale is configured: prefilling one would open someone
  // else's rules on enter.
  const [input, setInput] = useState(config.defaultLocale ?? '')
  const [draft, setDraft] = useState<RulesDraft>()
  const [value, setValue] = useState<RulesValue>({ mistakes: [], patterns: [] })
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [cursor, setCursor] = useState(0)
  const [ruleCursor, setRuleCursor] = useState(0)
  const [nounCursor, setNounCursor] = useState(0)
  const [trial, setTrial] = useState<TryResult | string>()
  const [glossary, setGlossary] = useState<GlossaryEntry[]>()
  const [copyResult, setCopyResult] = useState<{ ok: boolean; lines: string[] }>()

  const dirty = draft !== undefined && JSON.stringify(value) !== JSON.stringify(draft.value)
  // A locale with no file can be saved as it stands: that is how someone
  // content with the built-in rules says so, and what the setup step counts.
  // The defaults are written commented out, so nothing is re-reviewed.
  const savable = dirty || (draft !== undefined && !draft.exists)
  const id = draft?.locale ?? ''

  const activeRules = (): Set<string> =>
    value.rules
      ? new Set([...UNIVERSAL_RULES, ...value.rules.enable].filter((r) => !value.rules!.disable.includes(r)))
      : new Set(draft?.builtIn.rules ?? [])
  const ratio = value.glossaryStemRatio ?? draft?.builtIn.glossaryStemRatio ?? 0.7

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
      setStage('overview')
    } catch (err) {
      setError(errorText(err))
    }
  }

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

  // One listener, every stage: what a key does depends on the stage, and only
  // the live stage's handlers are set. The list editors, the forms and the
  // guidance editor own their keys, so none are set here while one is open.
  // Copy shows a form only when there is a saved file and nothing unsaved;
  // otherwise it is a notice, and esc has to come from here.
  const on = (...stages: Stage[]) => stages.includes(stage)
  const copyNotice = stage === 'copy' && (dirty || !draft?.exists)
  const toOverview = () => setStage('overview')
  const leave = () => (dirty ? setStage('leave') : onBack())
  const openSection = () => {
    const next = SECTION_STAGE[cursor]!
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
      esc: copyNotice || on('nouns', 'rules', 'ratio', 'leave') ? toOverview : on('pick') ? onBack : on('overview') ? leave : undefined,
      q: on('overview') ? leave : undefined,
    },
    localeRules: {
      move: on('overview')
        ? (_ch, key) => (key.upArrow ? setCursor((c) => Math.max(0, c - 1)) : setCursor((c) => Math.min(SECTIONS.length - 1, c + 1)))
        : undefined,
      open: on('overview') ? openSection : undefined,
      save: on('overview') && savable ? () => void save() : undefined,
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
  })

  const marker = (selected: boolean) => (selected ? '❯ ' : '  ')
  const header = draft ? `${wpCodeOf(id) ?? id} (${id})` : ''

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

      {draft && stage !== 'pick' && (
        <Text dimColor>{draft.exists ? draft.path : `No file yet: built-in defaults apply. s saves them as ${basename(draft.path)}, which completes this setup step.`}</Text>
      )}

      {draft && (stage === 'overview' || stage === 'leave') && (
        <>
          <Text>
            {marker(cursor === 0)}Built-in rules     {activeRules().size} on
          </Text>
          <Text>
            {marker(cursor === 1)}Glossary match     {ratio.toFixed(2)}
          </Text>
          <Text>
            {marker(cursor === 2)}Proper nouns       {nouns('always').length} always · {nouns('dateOnly').length} date-only
          </Text>
          <Text>{`${marker(cursor === 3)}Common mistakes    ${value.mistakes.length}`}</Text>
          <Text>{`${marker(cursor === 4)}Patterns           ${value.patterns.length}`}</Text>
          <Text>{`${marker(cursor === 5)}Guidance           ${value.guidance?.length ?? 0} of ${GUIDANCE_LIMIT} characters`}</Text>
          <Text>{`${marker(cursor === 6)}Try the rules      check a sample against the rules as edited`}</Text>
          <Text>{`${marker(cursor === 7)}Copy to another locale`}</Text>
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
