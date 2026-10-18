import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Box, Text } from 'ink'
import { agentBinOverride } from '../../agent/providers.js'
import { debugEnabled } from '../../logs/debug.js'
import { MAX_PARALLEL, runFileBatch, type BatchItem } from '../../commands/batch.js'
import { tallyLine, tallyOf, type ProjectEnd } from '../../commands/fetch-report.js'
import { resolveFileLocale } from '../../cli/locale.js'
import { fillBatchReply, listTemplateLocales, listTemplates, loadTemplates, normaliseRequester, replyCaution, type Template } from '../../reply/templates.js'
import { createRunControl, type RunControl } from '../../run-control.js'
import { normalizeLocale } from '../../tmx/parse.js'
import type { DraftEngineChoice, Locale } from '../../types.js'
import { resolveLocale } from '../../wporg/locales.js'
import { batchSizeChoices } from '../batch-size.js'
import { copyToClipboard } from '../clipboard.js'
import { useCommands, useConfig } from '../commands.js'
import { useProviderCheck } from '../provider-check.js'
import { useKeys } from '../hooks/useKeys.js'
import { useTask } from '../hooks/useTask.js'
import { TextInput } from '../input.js'
import { initialBatchSize, screenBatchAdvice } from '../local.js'
import { DONE_HINT, Hint } from './Hint.js'

const ENGINES: DraftEngineChoice[] = ['deepl', 'openai', 'local']

// The fields differ by action, so each list is spelled out rather than one list
// with entries hidden: the cursor index then always names a field on screen.
// The locale leads where there is one to type, as on the single-file forms.
type Field = 'locale' | 'requester' | 'parallel' | 'batch' | 'fresh' | 'noAi' | 'engine' | 'start'
const REVIEW_FIELDS: Field[] = ['parallel', 'batch', 'fresh', 'noAi', 'start']
const TRANSLATE_FIELDS: Field[] = ['parallel', 'batch', 'engine', 'fresh', 'start']

// An item's line while the batch runs.
interface Live {
  state: 'queued' | 'running' | 'finished'
  batch?: string
}

interface Finished {
  inputs: string[]
  ends: ProjectEnd[]
}

/** What the batch's own stages are, reported up for the frame's footer. */
export type BatchStage = 'options' | 'running' | 'summary'

/** What a batch has to run, once Start is pressed. */
export interface Prepared {
  items: BatchItem[]
  // Lines that ended before any job, such as a failed download, by input.
  ends: Map<string, ProjectEnd>
}

export interface BatchRunProps {
  action: 'review' | 'translate'
  // What one line is: a project for fetch, a file for marked local files.
  noun: { one: string; many: string }
  // Every line, in the order the tables list them.
  inputs: string[]
  /**
   * Everything between Start and the jobs: fetch's downloads, or nothing for
   * files already on disk. Its waiting notices go under the preparing line.
   */
  prepare: (onWait: (notice: string | undefined) => void) => Promise<Prepared>
  // What the screen says while prepare runs: "Downloading 3 exports...".
  preparing?: string
  /**
   * Fetch has one locale for the list. Local files have a field: what was
   * typed runs every file, and an empty field runs each file in the locale
   * its own header names, as a single file is.
   */
  locale: { fixed: Locale } | { field: string }
  // Shown above the fields, such as the marked files.
  before?: ReactNode
  // A dimmed line under Start, such as where the exports are saved.
  after?: string
  // Escape on the options; the hint names where it goes.
  onLeave: () => void
  leaveHint: string
  // Enter or q once the batch has ended.
  onBack: () => void
  onStage?: (stage: BatchStage) => void
}

// A template folder that cannot be read leaves the batch without replies
// rather than failing a run already paid for.
function safely<T>(read: () => T[]): T[] {
  try {
    return read()
  } catch {
    return []
  }
}

// One thing to post back, for one line of the batch.
interface Response {
  input: string
  end: ProjectEnd
  // The line's locale's templates, approved first; empty means the message.
  templates: Template[]
}

function next<T>(values: T[], current: T, step: number): T {
  const i = values.indexOf(current)
  return values[(i + step + values.length) % values.length] as T
}

/**
 * The options, the run and the summary of a batch: the stage Fetch runs after
 * its downloads, lifted out so a list of files marked in the review and
 * translate pickers runs through the same screens and the same runner.
 *
 * Fetch's look and wording are kept: its tests are the specification here,
 * and a local batch reads the same apart from the noun.
 */
export function BatchRun(props: BatchRunProps) {
  const { action, noun, inputs, onStage } = props
  const commands = useCommands()
  const providerCheck = useProviderCheck()
  const { config } = useConfig()
  const review = action === 'review'
  const localeField = 'field' in props.locale
  // The Requester field only when a reply could use it. With a fixed locale
  // that is its own templates; a typed or per-file locale is not settled
  // until the run, so any locale with a template is enough to offer it.
  const fixedLocale = 'fixed' in props.locale ? props.locale.fixed : undefined
  const offersRequester = useMemo(
    () =>
      review &&
      (fixedLocale === undefined ? safely(listTemplateLocales).length > 0 : safely(() => listTemplates(fixedLocale)).length > 0),
    [review, fixedLocale],
  )
  const fields: Field[] = [
    ...(localeField ? (['locale'] as Field[]) : []),
    ...(offersRequester ? (['requester'] as Field[]) : []),
    ...(review ? REVIEW_FIELDS : TRANSLATE_FIELDS),
  ]
  const [requester, setRequester] = useState('')
  const [stage, setStage] = useState<'options' | 'running'>('options')
  const [focus, setFocus] = useState(0)
  const [typed, setTyped] = useState('field' in props.locale ? props.locale.field : '')
  const [parallel, setParallel] = useState(1)
  const [batchSize, setBatchSize] = useState(initialBatchSize(config))
  const [fresh, setFresh] = useState(false)
  // With No AI chosen, review is rules-only whatever this field says
  // (reviewFile decides it), so the field is held on rather than offering a
  // "no" it cannot honour.
  const rulesOnly = config.reviewProvider === 'none'
  const [noAiChoice, setNoAi] = useState(false)
  const noAi = rulesOnly || noAiChoice
  const [engine, setEngine] = useState<DraftEngineChoice>(config.defaultDraftEngine)
  const [phase, setPhase] = useState<'preparing' | 'running'>('preparing')
  const [waiting, setWaiting] = useState<string | undefined>(undefined)
  const [live, setLive] = useState<Map<string, Live>>(new Map())
  // Every run's onWarn lines: the debug notice, one per file, or a run log
  // that could not be written. The last few are shown; each file's own folder
  // is in its run log either way, and fifty notices would push the files off
  // the screen.
  const [notices, setNotices] = useState<string[]>([])
  const [paused, setPaused] = useState<'running' | 'paused' | 'stopping'>('running')
  const control = useRef<RunControl | undefined>(undefined)
  const task = useTask<Finished>()

  const shown = stage === 'running' && task.state.status !== 'running' ? 'done' : stage
  useEffect(() => {
    onStage?.(shown === 'done' ? 'summary' : shown)
  }, [onStage, shown])

  const field = fields[focus]!
  const typing = shown === 'options' && (field === 'locale' || field === 'requester')
  // Antigravity's lookup server never hears a locale read from a file
  // (resolveFileLocale says why), so with it reviewing an empty field cannot
  // start: the per-file reading is exactly what it cannot follow.
  const antigravity = config.reviewProvider === 'antigravity'
  const perFile = localeField && typed.trim() === ''

  const localeOf = (): ((file: string) => Promise<Locale>) | undefined => {
    if ('fixed' in props.locale) {
      const fixed = props.locale.fixed
      return async () => fixed
    }
    if (!perFile) {
      const normalized = resolveLocale(typed)?.id ?? normalizeLocale(typed)
      return async () => normalized
    }
    if (antigravity) return undefined
    // The configured locale is set aside: an emptied field asks for each
    // file's own, and resolveFileLocale would otherwise answer with config.
    const headerOnly = { ...config, defaultLocale: undefined }
    return async (file) => (await resolveFileLocale(undefined, headerOnly, [file])).locale
  }

  // The summary's replies, or messages without a template, one per finished
  // review that has something to post, in the table's order. Templates are
  // read when the batch ends, as for one file, so an edit made while it ran
  // is the one used.
  const finished = task.state.status === 'done' ? task.state.result : undefined
  const responses = useMemo((): Response[] => {
    if (finished === undefined) return []
    const byLocale = new Map<string, Template[]>()
    const templatesOf = (locale: Locale) => {
      if (!byLocale.has(locale)) byLocale.set(locale, safely(() => loadTemplates(locale)))
      return byLocale.get(locale)!
    }
    return finished.inputs.flatMap((input, i) => {
      const end = finished.ends[i]!
      const templates = end.review === undefined ? [] : templatesOf(end.review.locale)
      return templates.length > 0 || end.message ? [{ input, end, templates }] : []
    })
  }, [finished])
  const [selected, setSelected] = useState(0)
  // Which template each line's reply uses, by input; the first when unset.
  const [templateOf, setTemplateOf] = useState<Map<string, number>>(new Map())
  const [copied, setCopied] = useState<'yes' | 'no' | undefined>(undefined)
  const current = responses[Math.min(selected, responses.length - 1)]
  const currentTemplate = current && current.templates.length > 0
    ? current.templates[(templateOf.get(current.input) ?? 0) % current.templates.length]!
    : undefined
  const requesterName = normaliseRequester(requester)
  const currentText =
    current === undefined
      ? undefined
      : currentTemplate !== undefined && current.end.review !== undefined
        ? fillBatchReply(currentTemplate.text, { review: current.end.review, ...(current.end.message ? { message: current.end.message } : {}) }, requesterName)
        : current.end.message
  // A copy confirmation belongs to the text it copied, so moving clears it.
  const pick = (index: number) => {
    setSelected(index)
    setCopied(undefined)
  }

  const start = () => {
    const resolve = localeOf()
    if (resolve === undefined) return
    setStage('running')
    setPhase('preparing')
    setNotices([])
    const run = createRunControl()
    control.current = run
    run.subscribe(setPaused)
    task.run(async () => {
      const { items, ends } = await props.prepare(setWaiting)
      setWaiting(undefined)
      setLive(new Map(items.map((item) => [item.input, { state: 'queued' }])))
      setPhase('running')
      const mark = (input: string, patch: Partial<Live>) =>
        setLive((prev) => new Map(prev).set(input, { ...(prev.get(input) ?? { state: 'queued' }), ...patch }))
      const inputOf = new Map(items.map((item) => [item.file, item.input]))
      const results = await runFileBatch(
        items,
        { reviewFile: commands.reviewFile, translateFile: commands.translateFile },
        {
          review,
          localeOf: resolve,
          parallel,
          batchSize,
          draftEngine: engine,
          control: run,
          // Translate's review pass and a review both run the configured
          // provider, so every job spawns the binary discovery checked, as
          // the CLI does, rather than whatever is first on PATH.
          ...(() => {
            const bin = agentBinOverride(config.reviewProvider, process.env)
            return bin === undefined ? {} : { bin }
          })(),
          ...(review && noAi ? { noAi: true } : {}),
          ...(fresh ? { fresh: true } : {}),
          wporgUsername: config.wporgUsername,
          debug: debugEnabled({ config, env: process.env }),
          onWarn: (line) => setNotices((prev) => [...prev, line].slice(-3)),
          // One check for the whole batch, the app's own when it is fresh.
          ...(() => {
            const reaches = review ? !noAi : engine !== 'none'
            const preflight = reaches && config.reviewProvider === 'antigravity' ? providerCheck?.get() : undefined
            return preflight === undefined ? {} : { preflight }
          })(),
          onProgress: (file) => (e) => {
            if (e.type === 'batch-start') mark(inputOf.get(file)!, { batch: `batch ${e.index}/${e.of}` })
          },
          onEvent: (e) => mark(e.item.input, { state: e.type === 'start' ? 'running' : 'finished' }),
        },
      )
      items.forEach((item, i) => ends.set(item.input, results[i]!))
      return {
        inputs,
        ends: inputs.map((i): ProjectEnd => ends.get(i) ?? { tally: 'failed', detail: 'never ran' }),
      }
    })
  }

  const options = shown === 'options'
  useKeys({
    run: {
      pause: shown === 'running' ? () => control.current?.pause() : undefined,
      resume: shown === 'running' ? () => control.current?.resume() : undefined,
      stop: shown === 'running' ? () => control.current?.stop() : undefined,
    },
    back: {
      esc: options ? props.onLeave : shown === 'done' ? props.onBack : undefined,
      q: options && !typing ? props.onLeave : shown === 'done' ? props.onBack : undefined,
    },
    finished: { close: shown === 'done' ? props.onBack : undefined },
    batchResult: {
      move:
        shown === 'done' && responses.length > 1
          ? (_input, key) => pick(key.upArrow ? Math.max(0, selected - 1) : Math.min(responses.length - 1, selected + 1))
          : undefined,
      copy: shown === 'done' && currentText !== undefined ? () => setCopied(copyToClipboard(currentText) ? 'yes' : 'no') : undefined,
      template:
        shown === 'done' && current !== undefined && current.templates.length > 1
          ? () => {
              setTemplateOf((prev) => new Map(prev).set(current.input, (prev.get(current.input) ?? 0) + 1))
              setCopied(undefined)
            }
          : undefined,
    },
    runForm: {
      move: options
        ? (_input, key) =>
            key.upArrow || (key.tab && key.shift) ? setFocus((f) => Math.max(0, f - 1)) : setFocus((f) => Math.min(fields.length - 1, f + 1))
        : undefined,
      change: options
        ? (input, key) => {
            if (input === ' ' && typing) return false
            const step = key.leftArrow ? -1 : 1
            // Parallel stops at its ends instead of wrapping: wrapping from eight to
            // one on a held key would quietly turn a fast batch into a slow one.
            if (field === 'parallel') setParallel((n) => Math.min(MAX_PARALLEL, Math.max(1, n + step)))
            if (field === 'batch') setBatchSize((n) => next(batchSizeChoices(initialBatchSize(config)), n, step))
            if (field === 'engine') setEngine((e) => next(ENGINES, e, step))
            if (field === 'fresh') setFresh((v) => !v)
            if (field === 'noAi' && !rulesOnly) setNoAi((v) => !v)
          }
        : undefined,
      // The locale field submits through its own input, which moves on.
      select: options && !typing ? () => (field === 'start' ? start() : setFocus((f) => f + 1)) : undefined,
    },
  })

  const marker = (f: Field) => (fields[focus] === f ? '❯ ' : '  ')
  const width = Math.max(0, ...inputs.map((i) => i.length))
  const count = (n: number) => `${n} ${n === 1 ? noun.one : noun.many}`
  const verb = review ? 'Review' : 'Translate'
  const adviceLocale = 'fixed' in props.locale ? props.locale.fixed : typed

  if (shown === 'options') {
    return (
      <Box flexDirection="column">
        {props.before}
        {localeField && (
          <>
            <Box>
              <Text>{marker('locale')}Locale:        </Text>
              {field === 'locale' ? (
                <TextInput value={typed} onChange={setTyped} placeholder="per file" onSubmit={() => setFocus((f) => f + 1)} />
              ) : (
                <Text>{perFile ? 'per file' : typed}</Text>
              )}
            </Box>
            {perFile && !antigravity && <Text dimColor>  Each file in the locale its Language header names. Type one to use it for every file.</Text>}
            {perFile && antigravity && (
              <Text color="yellow">  With Antigravity reviewing, type the locale: its lookup server never hears one read from a file.</Text>
            )}
          </>
        )}
        {offersRequester && (
          <Box>
            <Text>{marker('requester')}Requester:     </Text>
            {field === 'requester' ? (
              <TextInput value={requester} onChange={setRequester} onSubmit={() => setFocus((f) => f + 1)} />
            ) : (
              <Text dimColor={requester === ''}>{requester === '' ? 'optional, fills {username} in every reply' : requester}</Text>
            )}
          </Box>
        )}
        <Text>
          {marker('parallel')}Parallel:      {parallel} {parallel === 1 ? `${noun.one} at a time` : `${noun.many} at once`}
        </Text>
        <Text>
          {marker('batch')}Batch size:    {batchSize} entries per call
        </Text>
        {screenBatchAdvice(config, batchSize, adviceLocale) && (
          <Text color="yellow">{screenBatchAdvice(config, batchSize, adviceLocale)}</Text>
        )}
        {!review && (
          <Text>
            {marker('engine')}Draft engine:  {engine}
          </Text>
        )}
        <Text>
          {marker('fresh')}Start over:    {fresh ? 'yes, ignore what is cached' : 'no, reuse what is cached'}
        </Text>
        {review && (
          <Text>
            {marker('noAi')}Skip AI:       {noAi ? (rulesOnly ? 'yes, rules only (No AI is chosen in setup)' : 'yes, rules only') : 'no'}
          </Text>
        )}
        <Text>
          {marker('start')}
          {verb} {count(inputs.length)}
        </Text>
        {props.after && <Text dimColor>   {props.after}</Text>}
        <Hint>{`↑↓ move · ←→ change · enter select · ${props.leaveHint}`}</Hint>
      </Box>
    )
  }

  if (shown === 'running') {
    return (
      <Box flexDirection="column">
        {phase === 'preparing' ? (
          props.preparing && <Text>{props.preparing}</Text>
        ) : (
          [...live].map(([input, l]) => (
            <Text key={input} {...(l.state === 'queued' ? { dimColor: true } : {})}>
              {'  '}
              {input.padEnd(width)}
              {'  '}
              {l.state === 'running' ? `running${l.batch ? ` · ${l.batch}` : ''}` : l.state === 'queued' ? 'queued' : 'finished'}
            </Text>
          ))
        )}
        {phase === 'preparing' && waiting && <Text color="yellow">{waiting}</Text>}
        {notices.map((line, i) => (
          <Text key={i} color="yellow">
            {line}
          </Text>
        ))}
        {paused === 'paused' && <Text color="yellow">Paused. Running {noun.many} stop after their current batch.</Text>}
        {paused === 'stopping' && (
          <Text color="yellow">Stopping after the current batches. Queued {noun.many} will not start.</Text>
        )}
        <Hint>p pause · r resume · q stop and keep what is done</Hint>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {task.state.status === 'error' && <Text color="red">The batch failed: {task.state.message}</Text>}
      {task.state.status === 'done' && (
        <>
          {task.state.result.inputs.map((input, i) => {
            const end = task.state.status === 'done' ? task.state.result.ends[i]! : undefined
            if (!end) return null
            const color = end.tally === 'failed' ? 'red' : end.tally === 'done' ? 'green' : undefined
            return (
              <Text key={input}>
                {responses.length > 1 && current?.input === input ? '❯ ' : '  '}
                {input.padEnd(width)}
                {'  '}
                <Text {...(color ? { color } : {})}>{end.tally}</Text> {end.detail}
              </Text>
            )
          })}
          <Text bold>{tallyLine(tallyOf(task.state.result.ends))}</Text>
          {current !== undefined && currentText !== undefined && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>
                {currentTemplate ? 'Reply' : 'Message'} {Math.min(selected, responses.length - 1) + 1} of {responses.length} ·{' '}
                {current.input}
                {currentTemplate ? ` · ${currentTemplate.name} template` : ''} · c to copy
                {responses.length > 1 ? ' · ↑↓ another reply' : ''}
                {current.templates.length > 1 ? ' · t for the next template' : ''}
              </Text>
              {currentTemplate && current.end.review && replyCaution({ needsReview: current.end.review.flagged, unreviewed: 0 }) && (
                <Text color="yellow">{replyCaution({ needsReview: current.end.review.flagged, unreviewed: 0 })}</Text>
              )}
              {/* Unstyled, and copied exactly as filled, as for one file. */}
              <Text>{currentText}</Text>
              {copied === 'yes' && <Text color="green">{currentTemplate ? 'Reply' : 'Message'} copied to the clipboard.</Text>}
              {copied === 'no' && <Text color="yellow">Could not reach the clipboard; copy the text above by hand.</Text>}
            </Box>
          )}
        </>
      )}
      <Hint>{DONE_HINT}</Hint>
    </Box>
  )
}
