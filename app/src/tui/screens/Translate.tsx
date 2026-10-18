import { basename, dirname } from 'node:path'
import { useEffect, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import type { TranslateEvent, TranslateSummary } from '../../commands/translate.js'
import { normalizeLocale } from '../../tmx/parse.js'
import { resolveLocale } from '../../wporg/locales.js'
import type { DraftEngineChoice } from '../../types.js'
import { kindLabel, type ModelCheck } from '../../draft/discover.js'
import { resolveLocalTarget, type LocalTarget } from '../../draft/local-chat.js'
import { headerLocaleOf } from '../../cli/locale.js'
import { useCommands, useConfig } from '../commands.js'
import { useProviderCheck } from '../provider-check.js'
import { ProviderRefusal } from '../../agent/agy-check.js'
import { poEntryCount } from '../../po/count.js'
import { BatchRun, type BatchStage } from '../components/BatchRun.js'
import { MarkedFiles, MarkingPicker, markedItems } from '../components/MarkingPicker.js'
import { BACK_HINT, Hint, RUN_DONE_HINT } from '../components/Hint.js'
import { Progress } from '../components/Progress.js'
import { appendEvent } from '../components/RecentEntries.js'
import { ScrollTarget } from '../components/Viewport.js'
import { useProblemReport } from '../components/ProblemReport.js'
import { reportModel } from '../../report/offer.js'
import { useTask } from '../hooks/useTask.js'
import { createRunControl, type RunControl } from '../../run-control.js'
import { agentBinOverride } from '../../agent/providers.js'
import { debugEnabled } from '../../logs/debug.js'
import { initialBatchSize, providerLabel, screenBatchAdvice } from '../local.js'
import { batchSizeChoices } from '../batch-size.js'
import { useKeys } from '../hooks/useKeys.js'
import { InputGate, TextInput } from '../input.js'
import { useFooterStage } from '../footer-stage.js'

export interface TranslateProps {
  cwd: string
  onBack: () => void
}

// batch: several marked files, whose options, run and summary are BatchRun's.
type Phase = 'pick' | 'options' | 'running' | 'batch'
type Mode = 'pending' | 'all'
type Engine = DraftEngineChoice

const PO_EXTENSIONS = ['.po']
const MODES: Mode[] = ['pending', 'all']
const ENGINES: Engine[] = ['deepl', 'openai', 'local', 'none']
const FIELD_MODE = 0
const FIELD_ENGINE = 1
const FIELD_LOCALE = 2
const FIELD_BATCH = 3
const FIELD_FRESH = 4
const FIELD_START = 5
const FIELD_COUNT = 6

function next<T>(values: T[], current: T, step: number): T {
  const i = values.indexOf(current)
  return values[(i + step + values.length) % values.length] as T
}

// The form the run is started with, so the field and the header are compared
// as the run would see them: pt_BR typed and pt-br read are the same locale.
const resolvedLocale = (typed: string): string => resolveLocale(typed)?.id ?? normalizeLocale(typed)

export function Translate({ cwd, onBack }: TranslateProps) {
  const commands = useCommands()
  const providerCheck = useProviderCheck()
  const { config, error: configError } = useConfig()
  const [phase, setPhase] = useState<Phase>('pick')
  const [file, setFile] = useState('')
  const [mode, setMode] = useState<Mode>('pending')
  const [engine, setEngine] = useState<Engine>(config.defaultDraftEngine)
  // Empty with no locale configured, and then filled from the picked file's
  // Language header when that names one locale for certain (headerLocaleOf).
  const [locale, setLocale] = useState(config.defaultLocale ?? '')
  // The locale read from the picked file, kept to say so beside the field.
  const [headerLocale, setHeaderLocale] = useState<string | undefined>(undefined)
  // Whether the person typed into the locale field, as against it holding
  // what config or the file's header put there. Only a typed locale is carried
  // to another file: one that came from a header belongs to that file, and
  // carrying it would translate a de_DE catalogue into Turkish because the
  // last one was.
  const [localeTyped, setLocaleTyped] = useState(false)
  const typeLocale = (value: string) => {
    setLocale(value)
    setLocaleTyped(true)
  }
  // Where the picker opens: the screen's cwd at first, then the folder of the
  // file just finished once `a` asks for another.
  const [pickDir, setPickDir] = useState(cwd)
  // Antigravity's lookup server takes its locale from config when it starts
  // and never hears one read from a file (resolveFileLocale says why), so the
  // header is not offered for it.
  const headerAllowed = config.defaultLocale === undefined && config.reviewProvider !== 'antigravity'
  const [batchSize, setBatchSize] = useState(initialBatchSize(config))
  // Draft keys hold only the source, so mode all on a file translated before
  // took every draft from the cache and changed nothing. This is the way to
  // ask again, as --fresh is on the command line.
  const [fresh, setFresh] = useState(false)
  const [focus, setFocus] = useState(FIELD_MODE)
  const [events, setEvents] = useState<TranslateEvent[]>([])
  // What translateFile says through onWarn: the debug notice, or that the run log
  // could not be written. Kept on the screen, since a line on stderr would be
  // drawn over by Ink's next frame and never read.
  const [notices, setNotices] = useState<string[]>([])
  // Held in a ref so a keypress reaches the run in flight without re-rendering
  // the whole screen on every state change.
  const control = useRef<RunControl | undefined>(undefined)
  const task = useTask<TranslateSummary>()
  const [modelCheck, setModelCheck] = useState<ModelCheck | undefined>(undefined)
  // The local target a run would draft with, or why there is none: an
  // OpenAI-compatible server with no model chosen, which the run refuses.
  const local = ((): { target: LocalTarget } | { error: string } => {
    try {
      return { target: resolveLocalTarget(config) }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })()

  // Asked while the options are being chosen rather than after Start, so a
  // model that was never pulled is seen before a run is spent finding out.
  // It warns and never blocks Start: a model mid-pull or a proxy in front of
  // Ollama would read as missing, and the first batch's error stays the
  // authoritative one. A rejected check shows nothing, for the same reason.
  useEffect(() => {
    setModelCheck(undefined)
    if (engine !== 'local' || !('target' in local)) return
    let wanted = true
    const { kind, baseUrl, model } = local.target
    commands.checkLocalModel({ kind, baseUrl, model }).then(
      (result) => wanted && setModelCheck(result),
      () => {},
    )
    return () => {
      wanted = false
    }
  }, [engine])

  // Files marked for one batch. Held here rather than in the picker so they
  // survive the picker's folder changes and a trip to the batch options and
  // back.
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set())
  const [batchStage, setBatchStage] = useState<BatchStage>('options')
  const batchItems = markedItems(cwd, marked)

  const finished = phase === 'running' && task.state.status !== 'running'
  const stage = finished ? 'done' : phase
  const typing = stage === 'options' && focus === FIELD_LOCALE
  useFooterStage(stage === 'batch' ? batchStage : stage)
  const report = useProblemReport({
    ended: finished,
    facts: () => ({ provider: config.reviewProvider, ...reportModel(config, undefined), batchSize }),
  })
  // The finished screen's own keys, off while the contact line takes every key.
  const done = stage === 'done' && !report.typing

  // Takes the locale rather than reading state, because the keypress that
  // starts a run normalises it in the same handler and would not see it yet.
  const start = (chosenLocale: string) => {
    setEvents([])
    setNotices([])
    report.reset()
    setPhase('running')
    // The binary the Check AI agents screen and the menu gate reported on, so a
    // run spawns what discovery checked rather than whatever is first on PATH.
    // Resolved at start rather than at mount, the moment the CLI resolves it.
    const bin = agentBinOverride(config.reviewProvider, process.env)
    const run = createRunControl()
    control.current = run
    const unsubscribe = run.subscribe((state) => {
      if (state === 'paused') setEvents((prev) => [...prev, { type: 'paused', at: Date.now() }])
      if (state === 'running') setEvents((prev) => [...prev, { type: 'resumed', at: Date.now() }])
      // Without this, q registered silently and the screen went on looking
      // exactly like a run that had not heard it, for however long the batch in
      // flight still had to run.
      if (state === 'stopping') setEvents((prev) => [...prev, { type: 'stopping', at: Date.now() }])
    })
    task.run(() =>
      commands.translateFile({
        control: run,
        file,
        locale: chosenLocale,
        mode,
        draftEngine: engine,
        batchSize,
        ...(fresh ? { fresh: true } : {}),
        ...(bin === undefined ? {} : { bin }),
        debug: debugEnabled({ config, env: process.env }),
        onWarn: (line) => setNotices((prev) => [...prev, line]),
        onRunStarted: report.noteRun,
        // Only the review pass reaches antigravity, and with no engine there
        // is nothing to review.
        ...(() => {
          const preflight = engine !== 'none' && config.reviewProvider === 'antigravity' ? providerCheck?.get() : undefined
          return preflight === undefined ? {} : { preflight }
        })(),
        // Bounded: a long run's per-entry events would otherwise all stay in memory.
        onProgress: (e) => setEvents((prev) => appendEvent(prev, e)),
      }).finally(unsubscribe),
    )
  }

  // The next file with the choices just made, from the folder this one came
  // from. The draft engine and batch size are the person's preferences and stay
  // as they are. The mode does not: `all` re-translates every entry in place,
  // the one choice on this screen that replaces work already in a file, and it
  // was made about the file just finished. Carried silently, it would overwrite
  // the next file's translations on a single enter, so it goes back to pending
  // and has to be chosen again. The cursor waits on Start, so it is one enter
  // rather than none: the options screen is where a wrong carry-over is caught.
  //
  // Start over goes back for the same reason: it spends a request on every
  // entry, and was chosen about the file just finished.
  const anotherFile = () => {
    setPickDir(dirname(file))
    setMode('pending')
    setFresh(false)
    setHeaderLocale(undefined)
    if (!localeTyped) setLocale(config.defaultLocale ?? '')
    setFocus(FIELD_START)
    setPhase('pick')
  }

  // Stays subscribed during the run: Ink only reads stdin (and so only sees Ctrl+C)
  // while some useInput is active.
  const running = stage === 'running'
  const options = stage === 'options'
  useKeys({
    // Pausing parks the run after the batch in flight, so the call already paid
    // for still finishes and saves.
    run: {
      pause: running ? () => control.current?.pause() : undefined,
      resume: running ? () => control.current?.resume() : undefined,
      stop: running ? () => control.current?.stop() : undefined,
    },
    // The batch's stages bind their own keys, back included, in BatchRun.
    back: {
      esc: running || stage === 'batch' || report.holdsEsc ? undefined : onBack,
      q: running || typing || stage === 'batch' || report.typing ? undefined : onBack,
    },
    finished: { close: done ? onBack : undefined },
    another: { file: done ? anotherFile : undefined },
    runForm: {
      move: options
        ? (_input, key) =>
            key.upArrow || (key.tab && key.shift) ? setFocus((f) => Math.max(0, f - 1)) : setFocus((f) => Math.min(FIELD_COUNT - 1, f + 1))
        : undefined,
      change: options
        ? (input, key) => {
            if (input === ' ' && typing) return false
            const step = key.leftArrow ? -1 : 1
            if (focus === FIELD_MODE) setMode((m) => next(MODES, m, step))
            if (focus === FIELD_ENGINE) setEngine((e) => next(ENGINES, e, step))
            if (focus === FIELD_BATCH) setBatchSize((n) => next(batchSizeChoices(initialBatchSize(config)), n, step))
            if (focus === FIELD_FRESH) setFresh((v) => !v)
          }
        : undefined,
      select:
        options && focus !== FIELD_LOCALE
          ? () => {
              if (focus === FIELD_START) {
                const normalized = resolvedLocale(locale)
                if (normalized.length > 0) {
                  setLocale(normalized)
                  // No second question, on either mode. Choosing `all` is the choice,
                  // and the screen where it is made says what it does; re-translating
                  // entries that already have a translation is the point of the mode
                  // rather than a mistake to catch on the way out. Review starts on the
                  // keypress too.
                  start(normalized)
                }
              } else setFocus((f) => f + 1)
            }
          : undefined,
    },
  })

  const name = basename(file)
  const marker = (field: number) => (focus === field ? '❯ ' : '  ')

  return (
    <Box flexDirection="column">
      <Text bold>Translate {stage === 'pick' ? 'a .po file' : stage === 'batch' ? `${marked.size} files` : name}</Text>
      {configError && <Text color="yellow">Config error, using defaults: {configError}</Text>}
      {/* Named on every screen that runs or reports a job, so which
          subscription is being spent is never a guess. Not switchable here:
          the choice belongs to the menu, and changing it mid-file would split
          one submission's verdicts across two agents. */}
      {stage !== 'pick' && <Text dimColor>Provider: {providerLabel(config.reviewProvider)}</Text>}

      {stage === 'pick' && (
        <>
          <MarkingPicker
            dir={pickDir}
            extensions={PO_EXTENSIONS}
            annotate={poEntryCount}
            marked={marked}
            onMarked={setMarked}
            verb="translate"
            onBatch={() => setPhase('batch')}
            onPick={(path) => {
              setFile(path)
              if (headerAllowed) {
                void headerLocaleOf(path).then((found) => {
                  if (!found) return
                  setHeaderLocale(found)
                  // Only into an empty field: the header is read after the
                  // form opens, and must not overwrite what was typed since.
                  setLocale((current) => (current.trim() === '' ? found : current))
                })
              }
              setPhase('options')
            }}
          />
          <Hint>{BACK_HINT}</Hint>
        </>
      )}

      {stage === 'batch' && (
        <BatchRun
          action="translate"
          noun={{ one: 'file', many: 'files' }}
          inputs={batchItems.map((i) => i.input)}
          prepare={async () => ({ items: batchItems, ends: new Map() })}
          // Empty with no locale configured, which runs each file in the
          // locale its own header names; see BatchRun.
          locale={{ field: config.defaultLocale ?? '' }}
          before={<MarkedFiles items={batchItems} />}
          // Back to the files rather than the menu: the marks are what an
          // escape from here most likely wants to change, and they are kept.
          onLeave={() => setPhase('pick')}
          leaveHint="esc back to the files"
          onBack={onBack}
          onStage={setBatchStage}
        />
      )}

      {stage === 'options' && (
        <>
          <Text>
            {marker(FIELD_MODE)}Mode:          {mode === 'pending' ? 'pending only (empty and fuzzy entries)' : 'all (re-translate every entry)'}
          </Text>
          {/* Said where the mode is chosen rather than in a prompt on the way
              out. translate saves the catalogue in place, so this is the one
              mode that replaces work already in the file. */}
          {mode === 'all' && (
            <Text color="yellow">   This will re-translate already-translated entries, in place.</Text>
          )}
          <Text>
            {marker(FIELD_ENGINE)}Draft engine:  {engine}
          </Text>
          {engine === 'local' && 'target' in local && (
            <Text dimColor>
              {'   '}Model: {local.target.model} at {local.target.baseUrl} ({kindLabel(local.target.kind)})
            </Text>
          )}
          {engine === 'local' && 'error' in local && <Text color="yellow">   {local.error}</Text>}
          {engine === 'none' && (
            <Text dimColor>   Fills from the translation memory only; the rest is left untranslated, and no AI is asked.</Text>
          )}
          {engine !== 'none' && config.reviewProvider === 'none' && (
            <Text color="yellow">   No review provider: drafts are written fuzzy for you to check.</Text>
          )}
          {engine === 'local' && modelCheck && modelCheck.state !== 'installed' && modelCheck.message && (
            <Text color="yellow">   {modelCheck.message}</Text>
          )}
          <Box>
            <Text>{marker(FIELD_LOCALE)}Locale:        </Text>
            {typing ? <TextInput value={locale} onChange={typeLocale} onSubmit={() => setFocus(FIELD_BATCH)} /> : <Text>{locale}</Text>}
          </Box>
          {headerLocale !== undefined && locale === headerLocale && <Text dimColor>  From the file's Language header.</Text>}
          {/* A typed locale is never overwritten by the header, and one carried
              from the last file by a arrives with the cursor already on Start.
              Without this line a carry that does not fit the new file goes
              through on a single enter with nothing on screen to say so. Held
              back while typing, where every partial keystroke would disagree. */}
          {!typing && headerLocale !== undefined && locale.trim() !== '' && resolvedLocale(locale) !== headerLocale && (
            <Text color="yellow">  The file's Language header says {headerLocale}.</Text>
          )}
          {locale.trim() === '' && config.reviewProvider === 'antigravity' && config.defaultLocale === undefined && (
            <Text color="yellow">  With Antigravity reviewing, type the locale: its lookup server never hears one read from the file.</Text>
          )}
          {locale.trim() === '' && !(config.reviewProvider === 'antigravity' && config.defaultLocale === undefined) && (
            <Text color="yellow">  No locale set: type the one you translate into, or choose it once in Setup.</Text>
          )}
          <Text>
            {marker(FIELD_BATCH)}Batch size:    {batchSize} entries per draft and review call
          </Text>
          {/* The drafts are reviewed by the same agent a review run uses, so
              the same advice about a batch too small to be worth it applies. */}
          {screenBatchAdvice(config, batchSize, locale) && (
            <Text color="yellow">{screenBatchAdvice(config, batchSize, locale)}</Text>
          )}
          <Text>
            {marker(FIELD_FRESH)}Start over:    {fresh ? 'yes, ignore what is cached' : 'no, reuse what is cached'}
          </Text>
          <Text>{marker(FIELD_START)}Start translation</Text>
          <Hint>↑↓ move · ←→ change · enter select · esc back to menu</Hint>
        </>
      )}

      {(stage === 'running' || stage === 'done') && (
        <>
          {notices.map((line, i) => (
            <Text key={i} color="yellow">
              {line}
            </Text>
          ))}
          {/* Closed while the report's contact line is typed into: o opens the file. */}
          <InputGate open={!report.typing}>
            <Progress events={events} />
          </InputGate>
          {/* Kept in view when failed batches make the screen taller than the
              body: these keys are how the run is stopped. */}
          {stage === 'running' && (
            <ScrollTarget active>
              <Hint>p pause · r resume · q stop and keep what is done</Hint>
            </ScrollTarget>
          )}
          {/* A provider refusal ends the run stopped, not failed: "failed" in
              red would blame polyglots for the person's own sign-in. */}
          {task.state.status === 'error' &&
            (task.state.error instanceof ProviderRefusal ? (
              <Text color="yellow">Stopped: {task.state.message}</Text>
            ) : (
              <Text color="red">Translation failed: {task.state.message}</Text>
            ))}
          {stage === 'done' && report.element}
          {stage === 'done' && <Hint>{RUN_DONE_HINT}</Hint>}
        </>
      )}
    </Box>
  )
}
