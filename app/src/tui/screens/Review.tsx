import { basename, dirname } from 'node:path'
import { useMemo, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import { normalizeLocale } from '../../tmx/parse.js'
import { resolveLocale } from '../../wporg/locales.js'
import type { ReviewEvent, ReviewSummary } from '../../types.js'
import { agentBinOverride } from '../../agent/providers.js'
import { initialBatchSize, providerLabel, screenBatchAdvice } from '../local.js'
import { headerLocaleOf } from '../../cli/locale.js'
import { useCommands, useConfig } from '../commands.js'
import { poEntryCount } from '../../po/count.js'
import { FilePicker } from '../components/FilePicker.js'
import { BACK_HINT, Hint, RUN_DONE_HINT } from '../components/Hint.js'
import { ReviewProgress } from '../components/ReviewProgress.js'
import { appendEvent } from '../components/RecentEntries.js'
import { ScrollTarget } from '../components/Viewport.js'
import { useTask } from '../hooks/useTask.js'
import { createRunControl, type RunControl } from '../../run-control.js'
import { batchSizeChoices } from '../batch-size.js'
import { useKeys } from '../hooks/useKeys.js'
import { TextInput } from '../input.js'
import { useFooterStage } from '../footer-stage.js'
import { listTemplates, loadTemplates, normaliseRequester, type Template } from '../../reply/templates.js'
import type { Locale } from '../../types.js'

export interface ReviewProps {
  cwd: string
  onBack: () => void
}

type Phase = 'pick' | 'options' | 'running'

const PO_EXTENSIONS = ['.po']
// The form's fields in order. Requester is only there when the locale has a
// reply template, since {username} is the only thing it fills: a field that
// does nothing for most people would be one more stop on the way to Start.
type Field = 'locale' | 'requester' | 'batch' | 'noAi' | 'fresh' | 'start'

// The locale as typed, read the way Start reads it, for a template lookup
// that must never throw while the person is still typing.
function templatesFor(typed: string): readonly string[] {
  try {
    const locale: Locale = resolveLocale(typed)?.id ?? normalizeLocale(typed)
    return locale === '' ? [] : listTemplates(locale)
  } catch {
    return []
  }
}

// Read when the run ends, so a template edited while it ran is the one used.
// A file that cannot be read loses the reply, not the results screen.
function loadTemplatesSafely(locale: Locale): Template[] {
  try {
    return loadTemplates(locale)
  } catch {
    return []
  }
}

function step(values: number[], current: number, by: number): number {
  const i = values.indexOf(current)
  return values[(i + by + values.length) % values.length] ?? current
}

// The form the run is started with, so the field and the header are compared
// as the run would see them: pt_BR typed and pt-br read are the same locale.
const resolvedLocale = (typed: string): string => resolveLocale(typed)?.id ?? normalizeLocale(typed)

export function Review({ cwd, onBack }: ReviewProps) {
  const commands = useCommands()
  const { config, error: configError } = useConfig()
  const [phase, setPhase] = useState<Phase>('pick')
  const [file, setFile] = useState('')
  // Empty with no locale configured, and then filled from the picked file's
  // Language header when that names one locale for certain (headerLocaleOf).
  const [locale, setLocale] = useState(config.defaultLocale ?? '')
  // The locale read from the picked file, kept to say so beside the field.
  const [headerLocale, setHeaderLocale] = useState<string | undefined>(undefined)
  // Whether the person typed into the locale field, as against it holding
  // what config or the file's header put there. Only a typed locale is carried
  // to another file: one that came from a header belongs to that file, and
  // carrying it would review a de_DE catalogue as tr_TR because the last one
  // was.
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
  // With no review provider there is no AI to choose, so rules-only is fixed
  // on rather than offered: a toggle that could be turned off would start a
  // run that reaches for an agent nobody set up.
  const noReviewer = config.reviewProvider === 'none'
  const [skipAi, setNoAi] = useState(false)
  const noAi = noReviewer || skipAi
  const [fresh, setFresh] = useState(false)
  const [batchSize, setBatchSize] = useState(initialBatchSize(config))
  const [requester, setRequester] = useState('')
  const hasTemplates = useMemo(() => templatesFor(locale).length > 0, [locale])
  const fields: Field[] = ['locale', ...(hasTemplates ? (['requester'] as const) : []), 'batch', 'noAi', 'fresh', 'start']
  const [focus, setFocus] = useState(0)
  const field = fields[Math.min(focus, fields.length - 1)]!
  const [events, setEvents] = useState<ReviewEvent[]>([])
  // Held in a ref so a keypress reaches the run in flight without re-rendering
  // the whole screen on every state change.
  const control = useRef<RunControl | undefined>(undefined)
  const task = useTask<ReviewSummary>()

  const finished = phase === 'running' && task.state.status !== 'running'
  const stage = finished ? 'done' : phase
  const typing = stage === 'options' && (field === 'locale' || field === 'requester')
  const templates = useMemo(() => (finished ? loadTemplatesSafely(locale) : []), [finished, locale])
  const requesterName = normaliseRequester(requester)
  useFooterStage(stage)

  const start = (chosenLocale: string) => {
    setEvents([])
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
      commands.reviewFile({
        control: run,
        file,
        locale: chosenLocale,
        noAi,
        fresh,
        batchSize,
        ...(bin === undefined ? {} : { bin }),
        // Bounded: a long run's per-entry events would otherwise all stay in memory.
        onProgress: (e) => setEvents((prev) => appendEvent(prev, e)),
      }).finally(unsubscribe),
    )
  }

  // The next file with the choices just made, from the folder this one came
  // from. Batch size and Skip AI are the person's preferences and stay as they
  // are. Start over does not: it was a decision about this file's saved
  // progress, and carried to the next one it would throw that file's cache
  // away for nothing. The cursor waits on Start, so it is one enter rather than
  // none: the options screen is where a wrong carry-over gets caught.
  const anotherFile = () => {
    setPickDir(dirname(file))
    setFresh(false)
    setHeaderLocale(undefined)
    if (!localeTyped) setLocale(config.defaultLocale ?? '')
    // The requester goes too: the next file in a folder of submissions is
    // usually someone else's, and a reply carried over would greet the last
    // contributor by name. The field stays in view on the options screen.
    setRequester('')
    setFocus(fields.indexOf('start'))
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
    back: { esc: running ? undefined : onBack, q: running || typing ? undefined : onBack },
    finished: { close: stage === 'done' ? onBack : undefined },
    another: { file: stage === 'done' ? anotherFile : undefined },
    runForm: {
      move: options
        ? (_input, key) =>
            key.upArrow || (key.tab && key.shift) ? setFocus((f) => Math.max(0, f - 1)) : setFocus((f) => Math.min(fields.length - 1, f + 1))
        : undefined,
      change: options
        ? (input, key) => {
            if (input === ' ' && typing) return false
            if (field === 'noAi') {
              if (!noReviewer) setNoAi((v) => !v)
            }
            else if (field === 'fresh') setFresh((v) => !v)
            else if (field === 'batch') {
              setBatchSize((n) => step(batchSizeChoices(initialBatchSize(config)), n, key.leftArrow ? -1 : 1))
            }
          }
        : undefined,
      select:
        options && !typing
          ? () => {
              if (field === 'start') {
                const normalized = resolvedLocale(locale)
                if (normalized.length > 0) {
                  setLocale(normalized)
                  start(normalized)
                }
              } else setFocus((f) => f + 1)
            }
          : undefined,
    },
  })

  const marker = (at: Field) => (field === at ? '❯ ' : '  ')

  return (
    <Box flexDirection="column">
      <Text bold>Review {stage === 'pick' ? 'a submitted .po file' : basename(file)}</Text>
      {configError && <Text color="yellow">Config error, using defaults: {configError}</Text>}
      {/* Named on every screen that runs or reports a job, so which
          subscription is being spent is never a guess. Not switchable here:
          the choice belongs to the menu, and changing it mid-file would split
          one submission's verdicts across two agents. */}
      {stage !== 'pick' && <Text dimColor>Provider: {providerLabel(config.reviewProvider)}</Text>}

      {stage === 'pick' && (
        <>
          <FilePicker
            dir={pickDir}
            extensions={PO_EXTENSIONS}
            annotate={poEntryCount}
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

      {stage === 'options' && (
        <>
          <Box>
            <Text>{marker('locale')}Locale:          </Text>
            {typing && field === 'locale' ? (
              <TextInput value={locale} onChange={typeLocale} onSubmit={() => setFocus(1)} />
            ) : (
              <Text>{locale}</Text>
            )}
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
          {hasTemplates && (
            <Box>
              <Text>{marker('requester')}Requester:       </Text>
              {field === 'requester' ? (
                <TextInput value={requester} onChange={setRequester} onSubmit={() => setFocus((f) => f + 1)} />
              ) : (
                <Text dimColor={requester === ''}>{requester === '' ? 'optional, fills {username} in the reply' : requester}</Text>
              )}
            </Box>
          )}
          {/* Dimmed under "skip AI checks", where there are no batches to size.
              It still steps, so the choice survives toggling the AI back on. */}
          <Text dimColor={noAi}>
            {marker('batch')}Batch size:      {batchSize} entries per AI call
          </Text>
          {/* Where the size is chosen, because shrinking the batch is the
              obvious response to a timeout and the wrong one on this agent. */}
          {screenBatchAdvice(config, batchSize, locale) && (
            <Text color="yellow">{screenBatchAdvice(config, batchSize, locale)}</Text>
          )}
          <Text>
            {marker('noAi')}Skip AI checks:  {noAi ? 'yes (rules only, fast)' : 'no (rules, then AI review)'}
          </Text>
          {noReviewer && (
            <Text dimColor>  No AI is set up as the review provider, so this runs the rules only. Setup changes it.</Text>
          )}
          {/* A review that was interrupted picks up from the marker in its
              problems file. This is the way to make it forget that and start
              from the first batch again. */}
          <Text>
            {marker('fresh')}Start over:      {fresh ? 'yes (ignore saved progress)' : 'no (resume if interrupted)'}
          </Text>
          <Text>{marker('start')}Start review</Text>
          <Hint>↑↓ move · ←→ change · enter select · esc back to menu</Hint>
        </>
      )}

      {(stage === 'running' || stage === 'done') && (
        <>
          <ReviewProgress
            events={events}
            wporgUsername={config.wporgUsername}
            templates={templates}
            {...(requesterName === undefined ? {} : { requester: requesterName })}
          />
          {/* Kept in view when failed batches make the screen taller than the
              body: these keys are how the run is stopped. */}
          {stage === 'running' && (
            <ScrollTarget active>
              <Hint>p pause · r resume · q stop and keep what is done</Hint>
            </ScrollTarget>
          )}
          {task.state.status === 'error' && <Text color="red">Review failed: {task.state.message}</Text>}
          {stage === 'done' && <Hint>{RUN_DONE_HINT}</Hint>}
        </>
      )}
    </Box>
  )
}
