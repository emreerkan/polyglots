import { Box, Text } from 'ink'
import { useState } from 'react'
import { estimateRemainingMs, formatDuration, formatFinishTime, renderBar as bar, type BatchPhase } from '../../cli/progress.js'
import { skippedRuleText } from '../../cli/summaries.js'
import { fuzzyTotal } from '../../commands/translate-counts.js'
import { useElapsed } from '../hooks/useElapsed.js'
import { openInDefaultApp } from '../open-file.js'
import type {
  TranslateEntry,
  TranslateEntryOutcome,
  TranslateEvent,
  TranslateSummary,
} from '../../commands/translate.js'
import type { Token } from '../../ui/tokens.js'
import { RecentEntries, recentEntries, RECENT_LIMIT, type PanelRow } from './RecentEntries.js'
import { useKeys } from '../hooks/useKeys.js'

export interface ProgressState {
  started: boolean
  file?: string
  total: number
  pending: number
  fromTm: number
  translated: number
  fuzzy: number
  skipped: number
  done: number
  batch?: { index: number; of: number }
  // Which of the batch's two long calls is running, and since when. The bar
  // cannot move inside a batch, so this is what the clock hangs off.
  phase?: { name: BatchPhase; since: number }
  // The bar counts entries, but time is spent in batches, so the estimate is
  // built from those.
  batchDurations: number[]
  batchesDone: number
  // A batch has started and not yet finished. `phase` is not a substitute: it
  // is set by the event between the batch's two long calls, so it is undefined
  // for the whole first call of every batch.
  inFlight: boolean
  remainingMs?: number
  /**
   * What the operator has asked for and the run has not reached yet.
   *
   * See the review reducer, which carries the same field for the same reason:
   * a keypress is acted on at the next batch boundary, and the minutes in
   * between used to look exactly like a run that had ignored it. This screen
   * had it worse, since it emitted paused and resumed from the day it had a
   * pause key and the switch below has never had a case for either.
   */
  intent?: 'pause' | 'stop'
  paused: boolean
  warnings: string[]
  summary?: TranslateSummary
}

export function reduceProgress(events: TranslateEvent[]): ProgressState {
  const state: ProgressState = {
    started: false,
    total: 0,
    pending: 0,
    fromTm: 0,
    translated: 0,
    fuzzy: 0,
    skipped: 0,
    done: 0,
    batchDurations: [],
    batchesDone: 0,
    inFlight: false,
    paused: false,
    warnings: [],
  }

  // Only set while a batch is open, so one duration is recorded per batch and an
  // event with no timestamp records none rather than NaN.
  let openedAt: number | undefined
  let batchSize = 0

  const close = (at: unknown) => {
    state.batchesDone += 1
    if (typeof openedAt === 'number' && typeof at === 'number') state.batchDurations.push(at - openedAt)
    openedAt = undefined
    state.phase = undefined
    state.inFlight = false
  }

  for (const e of events) {
    switch (e.type) {
      case 'start':
        state.started = true
        state.file = e.file
        state.total = e.total
        state.pending = e.pending
        break
      case 'tm-hit':
        state.fromTm += e.count
        break
      case 'batch-start':
        state.batch = { index: e.index, of: e.of }
        state.phase = undefined
        state.inFlight = true
        openedAt = typeof e.at === 'number' ? e.at : undefined
        batchSize = e.size
        break
      case 'batch-phase':
        state.phase = { name: e.phase, since: e.at }
        break
      case 'batch-done':
        state.translated += e.translated
        state.fuzzy += e.fuzzy
        close(e.at)
        break
      // A skipped batch still cost whatever it spent failing, so it is timed like
      // any other.
      case 'batch-skipped':
        state.skipped += e.size
        state.warnings.push(`Batch ${e.index} skipped (${e.size} entries): ${e.reason}`)
        close(e.at)
        break
      case 'warning':
        state.warnings.push(e.message)
        break
      case 'saved':
        break
      // Only the intent. The run acts on it at the next batch boundary, and
      // the batch in flight goes on costing what it costs until then.
      case 'paused':
        state.intent = 'pause'
        break
      case 'stopping':
        state.intent = 'stop'
        break
      case 'resumed':
        state.intent = undefined
        break
      case 'done':
        state.summary = e.summary
        break
    }
  }
  state.remainingMs = estimateRemainingMs(
    state.batchDurations,
    (state.batch?.of ?? 0) - state.batchesDone,
    batchSize,
  )

  // Parked is the intent having arrived, which it has not while the batch it
  // waits for is still open. A stop never reads as parked: that run is leaving.
  state.paused = state.intent === 'pause' && !state.inFlight
  if (state.intent) state.remainingMs = undefined

  if (state.summary) {
    state.phase = undefined
    state.remainingMs = undefined
    state.fromTm = state.summary.fromTm
    state.translated = state.summary.translated
    state.fuzzy = fuzzyTotal(state.summary)
    state.skipped = state.summary.skipped
  }
  state.done = state.fromTm + state.translated + state.skipped
  return state
}

// The TUI has a whole line to itself, so it draws the same bar wider than the
// CLI does.
const BAR_WIDTH = 20

export function renderBar(done: number, total: number): string {
  return bar(done, total, BAR_WIDTH)
}

export function formatSummary(summary: TranslateSummary): string {
  // A memory-only run drafts nothing, so its line is about what the memory
  // filled and what it could not, rather than three zeros.
  if (summary.untranslated !== undefined) {
    return `Done. ${summary.fromTm} from TM, ${summary.untranslated} left untranslated (no memory match).`
  }
  return `Done. ${summary.translated} translated, ${fuzzyTotal(summary)} fuzzy, ${summary.fromTm} from TM, ${summary.skipped} skipped.`
}

const TRANSLATE_TONE: Record<TranslateEntryOutcome, Token> = {
  memory: 'success',
  drafted: 'accent',
  fuzzy: 'warn',
  skipped: 'error',
}

// A fuzzy entry says which side doubted it: two approved wordings in the memory
// is a choice to make, an engine draft the reviewer doubted is a check to do.
function translateRow(entry: TranslateEntry): PanelRow {
  return {
    key: entry.key,
    outcome: entry.outcome,
    tone: TRANSLATE_TONE[entry.outcome],
    msgid: entry.msgid,
    ...(entry.outcome === 'fuzzy' && entry.from ? { detail: entry.from === 'memory' ? 'memory' : 'MT' } : {}),
  }
}

export function Progress({ events }: { events: TranslateEvent[] }) {
  const state = reduceProgress(events)
  const elapsed = useElapsed(state.phase !== undefined, state.phase?.since ?? 0, state.phase?.since)
  const [opened, setOpened] = useState(false)
  // Translate writes in place, so the file to open is the one that was handed in.
  const translatedFile = state.summary?.file

  // Only once the run is over: during it the keys belong to pause, resume and
  // stop, and opening the file mid-run would show a catalogue still being
  // rewritten after every batch.
  useKeys({ translateResult: { open: translatedFile === undefined ? undefined : () => setOpened(openInDefaultApp(translatedFile)) } })

  if (!state.started) return <Text dimColor>Starting…</Text>

  const batch = state.batch ? `  batch ${state.batch.index}/${state.batch.of}` : ''
  return (
    <Box flexDirection="column">
      <Text>
        {renderBar(state.done, state.pending)} {state.done}/{state.pending}
        {batch}  fuzzy {state.fuzzy}
        {state.phase ? ` · ${state.phase.name} ${elapsed}s` : ''}
        {/* Takes the place of the remaining-time estimate, which the reducer
            drops once a stop is pending, so the line does not grow and wrap. */}
        {state.paused ? ` · paused after batch ${state.batchesDone}` : ''}
        {state.intent && state.inFlight
          ? state.intent === 'stop'
            ? ' · will stop after this batch'
            : ' · will pause after this batch'
          : ''}
        {state.remainingMs === undefined
          ? ''
          : ` · ~${formatDuration(state.remainingMs)} left, done by ${formatFinishTime(state.remainingMs)}`}
      </Text>
      <Text dimColor>
        {state.file} · {state.total} entries, {state.pending} selected, {state.fromTm} from TM
      </Text>
      {/* Until the summary, which is what the person reads at the end. */}
      {!state.summary && <RecentEntries rows={recentEntries<TranslateEntry>(events, RECENT_LIMIT).map(translateRow)} />}
      {state.warnings.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">Warnings:</Text>
          {state.warnings.map((w, i) => (
            <Text key={i} color="yellow">
              {'  - '}
              {w}
            </Text>
          ))}
        </Box>
      )}
      {state.summary && (
        <Box flexDirection="column" marginTop={1}>
          {state.summary.stopped && <Text color="red">Stopped: {state.summary.stopped}</Text>}
          <Text bold>{formatSummary(state.summary)}</Text>
          {state.summary.fixedByRules !== undefined && <Text>fixed by locale rules {state.summary.fixedByRules}</Text>}
          {(state.summary.skippedRules ?? []).map((label, i) => (
            <Text key={i} color="yellow">
              {skippedRuleText(label)}
            </Text>
          ))}
          <Text>Open {state.summary.file} in your .po editor to review.</Text>
          <Text dimColor>o to open it</Text>
          {opened && <Text color="green">Opening it now.</Text>}
        </Box>
      )}
    </Box>
  )
}
