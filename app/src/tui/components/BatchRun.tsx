import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Box, Text } from 'ink'
import { agentBinOverride, isReviewProvider, providerSpec } from '../../agent/providers.js'
import { debugEnabled } from '../../logs/debug.js'
import { MAX_PARALLEL, runFileBatch, type BatchItem } from '../../commands/batch.js'
import { tallyLine, tallyOf, type ProjectEnd } from '../../commands/fetch-report.js'
import { resolveFileLocale } from '../../cli/locale.js'
import { fillBatchReply, listTemplateLocales, listTemplates, loadTemplates, normaliseRequester, replyCaution, type Template } from '../../reply/templates.js'
import { createRunControl, type RunControl } from '../../run-control.js'
import type { TranslateEvent } from '../../commands/translate.js'
import { countEntries } from '../../po/count.js'
import { normalizeLocale } from '../../tmx/parse.js'
import type { DraftEngineChoice, Locale, ReviewEvent } from '../../types.js'
import { resolveLocale } from '../../wporg/locales.js'
import { batchSizeChoices } from '../batch-size.js'
import { copyToClipboard } from '../clipboard.js'
import { useCommands, useConfig } from '../commands.js'
import { preflightFor, useProviderCheck } from '../provider-check.js'
import { createEventStore, fileLine, overall, overallLines, type FileTrack } from '../batch-progress.js'
import { useElapsed } from '../hooks/useElapsed.js'
import { useKeys } from '../hooks/useKeys.js'
import { useTask } from '../hooks/useTask.js'
import { TextInput } from '../input.js'
import { initialBatchSize, screenBatchAdvice } from '../local.js'
import { reportModel } from '../../report/offer.js'
import { BACK_HINT, DONE_HINT, Hint } from './Hint.js'
import { useProblemReport } from './ProblemReport.js'
import { Progress } from './Progress.js'
import { ReviewProgress } from './ReviewProgress.js'
import { ScrollTarget } from './Viewport.js'

const ENGINES: DraftEngineChoice[] = ['deepl', 'openai', 'local']

// The fields differ by action, so each list is spelled out rather than one list
// with entries hidden: the cursor index then always names a field on screen.
// The locale leads where there is one to type, as on the single-file forms.
type Field = 'locale' | 'requester' | 'parallel' | 'batch' | 'fresh' | 'noAi' | 'engine' | 'start'
const REVIEW_FIELDS: Field[] = ['parallel', 'batch', 'fresh', 'noAi', 'start']
const TRANSLATE_FIELDS: Field[] = ['parallel', 'batch', 'engine', 'fresh', 'start']

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
  // Every file's event stream, kept for the life of the screen so the list,
  // the overall lines and an opened file's own screen are all reduced from
  // the same events by the single-file reducers. The store holds them; the
  // state is its last snapshot, which is what makes a new event re-render.
  const store = useRef<ReturnType<typeof createEventStore> | undefined>(undefined)
  const [tracks, setTracks] = useState<FileTrack[]>([])
  const [startedAt, setStartedAt] = useState(0)
  // The file the list's cursor is on, by input rather than by row, so it stays
  // on the same file from the running list to the summary, whose rows are the
  // inputs and can include lines that never ran.
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  // The file whose own progress screen is open in place of the list.
  const [inspecting, setInspecting] = useState<string | undefined>(undefined)
  // Every run's onWarn lines: the debug notice, one per file, or a run log
  // that could not be written. The last few are shown; each file's own folder
  // is in its run log either way, and fifty notices would push the files off
  // the screen.
  const [notices, setNotices] = useState<string[]>([])
  const [paused, setPaused] = useState<'running' | 'paused' | 'stopping'>('running')
  // The provider check's refusal, from the first file it stopped. It stops
  // the batch through the same control as q, so the stopping line would say
  // the person asked for it; the refusal, which says what to do, shows instead.
  const [refused, setRefused] = useState<string | undefined>(undefined)
  const control = useRef<RunControl | undefined>(undefined)
  const task = useTask<Finished>()

  const shown = stage === 'running' && task.state.status !== 'running' ? 'done' : stage
  useEffect(() => {
    onStage?.(shown === 'done' ? 'summary' : shown)
  }, [onStage, shown])
  // Whether the summary's cursor has been moved since the batch ended. Until
  // then a problem report offer is what the body follows, the question the
  // screen is asking; after, the cursor is where the reader is looking. Both
  // followed at once, the offer won as the last target drawn, and a row the
  // cursor moved to could go out of view above it.
  const [movedOnSummary, setMovedOnSummary] = useState(false)
  // One offer for the whole batch, over every file's run, once all have ended.
  const report = useProblemReport({
    ended: shown === 'done',
    batch: true,
    follow: !movedOnSummary,
    facts: () => ({
      provider: review && noAi ? 'rules' : config.reviewProvider,
      // No model took part in a No-AI review, so the report names none.
      ...(review && noAi ? {} : reportModel(config, undefined)),
      batchSize,
      parallel,
    }),
  })
  // The summary's own keys, off while the contact line takes every key.
  const done = shown === 'done' && !report.typing

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
  // Which template each line's reply uses, by input; the first when unset.
  const [templateOf, setTemplateOf] = useState<Map<string, number>>(new Map())
  const [copied, setCopied] = useState<'yes' | 'no' | undefined>(undefined)
  // The rows the cursor moves over: the files while the batch runs, every
  // input on the summary. Until it is moved, the summary's cursor starts on
  // the first line with a reply, which is where the old reply cursor started.
  const rows = shown === 'done' ? (finished?.inputs ?? []) : tracks.map((t) => t.input)
  const at = cursor !== undefined && rows.includes(cursor) ? cursor : shown === 'done' ? (responses[0]?.input ?? rows[0]) : rows[0]
  const atIndex = at === undefined ? -1 : rows.indexOf(at)
  const current = responses.find((r) => r.input === at)
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
  const replied = current !== undefined && currentText !== undefined
  // A copy confirmation belongs to the text it copied, so moving clears it.
  const move = (step: number) => {
    setCursor(rows[Math.min(rows.length - 1, Math.max(0, atIndex + step))])
    setCopied(undefined)
    if (shown === 'done') setMovedOnSummary(true)
  }
  const inspect = (input: string) => {
    // From here on the file keeps its entries events, so its entries list
    // fills from the next batch that closes; the earlier ones were dropped.
    store.current?.open(input)
    setCursor(input)
    setInspecting(input)
  }

  // The clock the overall line, each file's open batch and the near-limit
  // marker read. useElapsed only drives the once-a-second render here; the
  // times themselves are read off the clock against each event's own stamp.
  useElapsed(shown === 'running' && phase === 'running', startedAt)
  const now = Date.now()
  // The agent's own limit on one call, which a batch open a minute short of is
  // about to hit. Only the two agent CLIs have one; a local model, or a review
  // without AI, has no limit to be near.
  const reaches = review ? !noAi : engine !== 'none'
  const timeoutMs = reaches && isReviewProvider(config.reviewProvider) ? providerSpec(config.reviewProvider).defaultTimeoutMs : undefined

  const start = () => {
    const resolve = localeOf()
    if (resolve === undefined) return
    setStage('running')
    setPhase('preparing')
    setNotices([])
    setStartedAt(Date.now())
    setCursor(undefined)
    setInspecting(undefined)
    setMovedOnSummary(false)
    setRefused(undefined)
    setTracks([])
    // The last batch's store until this one's is made, after prepare: a pause
    // while preparing must not mark that batch's files.
    store.current = undefined
    report.reset()
    const run = createRunControl()
    control.current = run
    // A batch's runs never report the pause or the stop in their own events:
    // the batch holds the control and the runs only act on it at their next
    // boundary. Each running file is told here instead, so an opened file's
    // screen, reduced from its events, drops its estimate as a single run's
    // screen does, rather than counting it down under the "Paused." line.
    // In a try, as the other bookkeeping: the control's listeners are the
    // screen's, and a throw here would skip the ones after it.
    run.subscribe((state) => {
      setPaused(state)
      const events = store.current
      if (events === undefined) return
      try {
        const e = { type: state === 'paused' ? 'paused' : state === 'stopping' ? 'stopping' : 'resumed', at: Date.now() } as const
        for (const t of events.tracks()) if (t.state === 'running') events.push(t.input, e)
        setTracks(events.tracks())
      } catch {}
    })
    task.run(async () => {
      const { items, ends } = await props.prepare(setWaiting)
      setWaiting(undefined)
      const events = createEventStore(action)
      store.current = events
      // A queued file's entry count is all its estimate has to go on; one that
      // cannot be read counts as nothing rather than holding up the line.
      for (const item of items) events.queue(item.input, countEntries(item.file) ?? 0)
      const changed = () => setTracks(events.tracks())
      changed()
      setPhase('running')
      // runFileBatch reports progress by file, and the list is read by input.
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
          onRunStarted: report.noteRun,
          // One check for the whole batch, the app's own when it is fresh.
          ...(() => {
            const preflight = preflightFor(providerCheck, config, reaches)
            return preflight === undefined ? {} : { preflight }
          })(),
          onProgress: (file) => {
            const input = inputOf.get(file)!
            // This runs inside the file's own run, so a throw from it reaches
            // the run and fails a file whose batches are paid for and fine.
            // The store and the screen's state are the screen's own: a throw
            // from either costs the list a line, as on the command line, and
            // the run log still has the batch.
            return (e) => {
              try {
                events.push(input, e)
                changed()
              } catch {}
            }
          },
          // The end, not the file's done event, finishes a line: a file that
          // threw never sends one, and its clock must still stop.
          //
          // The store's bookkeeping gets a try, as the command line's lines
          // do: the pool now ends the whole batch on a throw from this
          // handler, and a bug in the screen's clock must cost a line, not
          // every file still to run. The table is built from the outcomes,
          // so it stays whole either way.
          onEvent: (e) => {
            try {
              if (e.type === 'start') events.start(e.item.input, Date.now())
              else events.finish(e.item.input, Date.now(), e.outcome.state)
            } catch {}
            if (e.type === 'end') {
              const reason = e.outcome.state === 'stopped' ? e.outcome.reason : undefined
              if (reason !== undefined) setRefused((was) => was ?? reason)
            }
            changed()
          },
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
  const inspected = inspecting !== undefined
  // The list is on screen, with a cursor to move and a file to open.
  const listing = !inspected && ((shown === 'running' && phase === 'running') || done) && rows.length > 0
  // The summary's reply keys, off while one file's screen is open: that
  // screen binds c and t for its own reply, and both would answer.
  const summary = done && !inspected
  const close = () => setInspecting(undefined)
  useKeys({
    // Before back, so q stops the whole batch from an opened file too: the
    // run keys act on the batch in both views, and the hint there says so.
    run: {
      pause: shown === 'running' ? () => control.current?.pause() : undefined,
      resume: shown === 'running' ? () => control.current?.resume() : undefined,
      stop: shown === 'running' ? () => control.current?.stop() : undefined,
    },
    back: {
      esc: options ? props.onLeave : inspected ? close : shown === 'done' && !report.holdsEsc ? props.onBack : undefined,
      q: options && !typing ? props.onLeave : done && inspected ? close : done ? props.onBack : undefined,
    },
    finished: { close: done && rows.length === 0 ? props.onBack : undefined },
    batchFiles: {
      move: listing && rows.length > 1 ? (_input, key) => move(key.upArrow ? -1 : 1) : undefined,
      inspect: listing && at !== undefined ? () => inspect(at) : undefined,
    },
    batchResult: {
      copy: summary && currentText !== undefined ? () => setCopied(copyToClipboard(currentText) ? 'yes' : 'no') : undefined,
      template:
        summary && current !== undefined && current.templates.length > 1
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

  const trackOf = (input: string) => tracks.find((t) => t.input === input)
  // One file's line after its name, coloured as its state is.
  const lineOf = (track: FileTrack) => {
    const { text, near } = fileLine(track, now, action, timeoutMs)
    return <Text {...(near ? { color: 'yellow' } : track.state === 'queued' ? { dimColor: true } : {})}>{text}</Text>
  }
  const runNotes = (
    <>
      {notices.map((line, i) => (
        <Text key={i} color="yellow">
          {line}
        </Text>
      ))}
      {paused === 'paused' && <Text color="yellow">Paused. Running {noun.many} stop after their current batch.</Text>}
      {paused === 'stopping' &&
        (refused !== undefined ? (
          <Text color="yellow">Stopped: {refused}</Text>
        ) : (
          <Text color="yellow">Stopping after the current batches. Queued {noun.many} will not start.</Text>
        ))}
    </>
  )

  if (shown === 'running' && inspecting !== undefined) {
    const track = trackOf(inspecting)
    return (
      <Box flexDirection="column">
        <Inspected input={inspecting} track={track} action={action} line={track && lineOf(track)} wporgUsername={config.wporgUsername ?? ''} requester={requesterName ?? ''} />
        {runNotes}
        <Hint>esc back to all files · p pause · r resume · q stop the whole batch</Hint>
      </Box>
    )
  }

  if (shown === 'running') {
    // The control's state as well as the events the listener above pushes:
    // those reach only files running when the key was pressed. A pause that
    // parks the pool between files leaves none running and the queued ones
    // with an estimate at the run's pace, which is not an answer while paused.
    const held = paused === 'paused' ? 'pause' : paused === 'stopping' ? 'stop' : undefined
    const [first, second] = overallLines(overall(tracks, { parallel, now, startedAt, action, ...(held === undefined ? {} : { held }) }), now)
    // The failed count is the line's last clause when there is one, and the
    // only part in yellow: the estimate beside it is not a warning.
    const failedAt = /(?:^| · )(\d+ batch(?:es)? failed)$/.exec(second)
    return (
      <Box flexDirection="column">
        {phase === 'preparing' ? (
          props.preparing && <Text>{props.preparing}</Text>
        ) : (
          <>
            <Text>{first}</Text>
            {second !== '' && (
              <Text>
                {failedAt ? second.slice(0, failedAt.index) : second}
                {failedAt && <Text color="yellow">{failedAt[0]}</Text>}
              </Text>
            )}
            <Box flexDirection="column" marginTop={1}>
              {tracks.map((track, i) => (
                <ScrollTarget key={track.input} active={i === atIndex}>
                  <Text>
                    {tracks.length > 1 && i === atIndex ? '❯ ' : '  '}
                    {track.input.padEnd(width)}
                    {'  '}
                    {lineOf(track)}
                  </Text>
                </ScrollTarget>
              ))}
            </Box>
          </>
        )}
        {phase === 'preparing' && waiting && <Text color="yellow">{waiting}</Text>}
        {runNotes}
        <Hint>{`${phase === 'running' ? `${tracks.length > 1 ? '↑↓ move · ' : ''}enter open a file · ` : ''}p pause · r resume · q stop and keep what is done`}</Hint>
      </Box>
    )
  }

  if (inspecting !== undefined) {
    const track = trackOf(inspecting)
    const i = finished?.inputs.indexOf(inspecting) ?? -1
    const end = i < 0 ? undefined : finished?.ends[i]
    return (
      <Box flexDirection="column">
        <Inspected
          input={inspecting}
          track={track}
          action={action}
          line={track ? lineOf(track) : end && <Text>{`${end.tally} ${end.detail}`}</Text>}
          wporgUsername={config.wporgUsername ?? ''}
          requester={requesterName ?? ''}
        />
        <Hint>esc back to the summary</Hint>
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
              <ScrollTarget key={input} active={input === at && !replied}>
                <Text>
                  {rows.length > 1 && input === at ? '❯ ' : '  '}
                  {input.padEnd(width)}
                  {'  '}
                  <Text {...(color ? { color } : {})}>{end.tally}</Text> {end.detail}
                </Text>
              </ScrollTarget>
            )
          })}
          <Text bold>{tallyLine(tallyOf(task.state.result.ends))}</Text>
          {/* The reply, not the cursor row, is what the body follows when
              there is one. It is drawn under the whole list, so following
              the row kept a reply on a short terminal below the window, and
              a followed row turns the page keys off. Its first line names
              the file, so the row it belongs to may scroll away above it.
              A reply taller than the body starts at its top, and the page
              keys read the rest (Viewport says how); keyed by file, so the
              next file's reply is a new target and starts at its top too. */}
          {current !== undefined && currentText !== undefined && (
            <ScrollTarget key={current.input} active>
              <Box flexDirection="column" marginTop={1}>
                <Text dimColor>
                  {currentTemplate ? 'Reply' : 'Message'} {responses.indexOf(current) + 1} of {responses.length} ·{' '}
                  {current.input}
                  {currentTemplate ? ` · ${currentTemplate.name} template` : ''} · c to copy
                  {rows.length > 1 ? ' · ↑↓ move' : ''}
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
            </ScrollTarget>
          )}
        </>
      )}
      {report.element}
      {/* Enter opens the file under the cursor once there is a list, so the
          way back is esc or q alone. A batch that failed before any line has
          nothing to open, and enter still goes back there. */}
      <Hint>{rows.length > 0 ? `enter open a file · ${BACK_HINT}` : DONE_HINT}</Hint>
    </Box>
  )
}

interface InspectedProps {
  input: string
  // Undefined for a line that never ran, such as a failed download.
  track: FileTrack | undefined
  action: 'review' | 'translate'
  // The file's line from the list, with its time, drawn above its screen.
  line: ReactNode
  wporgUsername: string
  requester: string
}

/**
 * One file of a batch, opened from the list: the screen a single run of it
 * would show, fed from the events the batch kept for it, so it is the same
 * counts, bar, clock, estimate and failures rather than a second rendering of
 * them. Above it, the file's line from the list, which carries what the
 * single-run screen has no place for: how long the open batch has run, and
 * the file's total time once it has finished.
 *
 * Its reply templates are read when its done event arrives, from the locale
 * the run settled on, as a single review reads them when it ends; without
 * them a finished file would say it has no template when it has one.
 */
function Inspected({ input, track, action, line, wporgUsername, requester }: InspectedProps) {
  const events = track?.events ?? []
  const done = events.find((e): e is Extract<ReviewEvent, { type: 'done' }> => e.type === 'done')
  const locale = action === 'review' ? done?.summary.locale : undefined
  const templates = useMemo(() => (locale === undefined ? [] : safely(() => loadTemplates(locale))), [locale])
  return (
    <Box flexDirection="column">
      <Text>
        {input}
        {'  '}
        {line}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {track === undefined ? (
          <Text dimColor>Nothing ran for this line.</Text>
        ) : track.state === 'queued' ? (
          <Text dimColor>Queued: starts when a slot frees.</Text>
        ) : action === 'review' ? (
          // Keyed by file, so one file's chosen template or copy confirmation
          // never shows on the next file opened.
          <ReviewProgress key={input} events={events as ReviewEvent[]} wporgUsername={wporgUsername} templates={templates} requester={requester} />
        ) : (
          <Progress key={input} events={events as TranslateEvent[]} />
        )}
      </Box>
      {/* A file that threw sends no done event, so its screen never reaches
          a summary and would sit on its last batch as if still running. */}
      {track?.state === 'finished' && done === undefined && (
        <Text dimColor>This file ended without a summary; the batch summary says why.</Text>
      )}
    </Box>
  )
}
