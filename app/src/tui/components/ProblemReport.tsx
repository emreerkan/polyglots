import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Box, Text } from 'ink'
import { PROVIDERS } from '../../agent/providers.js'
import { formatBytes } from '../../commands/tm-fetch.js'
import { openJobsDb } from '../../jobs/db.js'
import { summarize } from '../../report/build.js'
import {
  boundedVersion,
  buildFor,
  contactLine,
  cutLine,
  deliverReport,
  deliveryLine,
  findProblems,
  problemHeadline,
  type Delivery,
  type Problems,
  type ReportFacts,
} from '../../report/offer.js'
import { markOfferHintShown, offerHintDue, shouldOffer } from '../../report/send.js'
import { errorMessage, useCommands, useConfig } from '../commands.js'
import { useKeys } from '../hooks/useKeys.js'
import { TextInput } from '../input.js'
import { Hint } from './Hint.js'
import { ScrollTarget } from './Viewport.js'

// The app's half of the problem report offer (spec: run logging, section 3).
// On the finished screen of a run that had a problem, under the summary:
// a line that says what went wrong and asks, `v` for what would be sent, `s`
// for one optional contact line and then the send. The CLI asks the same
// question with y/N/v; both word the outcome through deliveryLine.
//
// A hook rather than a component alone, because the screen around it has to
// know two things about it: while the offer shows, esc is the offer's, not the
// screen's way back; and while the contact line has focus, every printable
// key is text, so the finished screen's a, c, t and q must hear none of them.
// Ink hands every key to every listener, so the screen switches its own
// bindings off rather than this one trying to swallow them.

export const OFFER_QUESTION = 'Send a problem report to the polyglots maintainer?'
export const OFFER_KEYS = 's send · v see what is sent · esc no'
// Where the setting lives in the app. The CLI's hint names config set instead.
const OFF_HINT = 'Turn these offers off in Configuration › Usage statistics.'

type Mode =
  | { kind: 'none' }
  | { kind: 'offer'; problems: Problems }
  | { kind: 'list'; problems: Problems; items: Array<{ name: string; bytes: number }> | { error: string } }
  | { kind: 'contact'; problems: Problems; text: string }
  | { kind: 'sending' }
  | { kind: 'done'; delivery: Delivery | { error: string } }

export interface ProblemReportOptions {
  // The run, or every run of a batch, has ended: finished, failed or stopped.
  ended: boolean
  // What the report says about the command beside the runs. A function, read
  // only when a report is built: the model is looked up from the agent's own
  // settings file, which is not worth reading on every render.
  facts: () => ReportFacts
  // A batch of files, whose one offer names how many of them had a problem.
  batch?: boolean
  // Whether the body follows the offer into view; on unless the screen has a
  // cursor of its own that the reader has moved, which it then follows.
  follow?: boolean
}

export interface ProblemReport {
  // Handed to reviewFile, translateFile or runFileBatch as onRunStarted.
  noteRun: (runId: number) => void
  // At Start: the runs of the last run are no longer this screen's.
  reset: () => void
  // The offer, its list or its contact line is on screen, and esc is its.
  holdsEsc: boolean
  // The contact line has focus: every key is text.
  typing: boolean
  // Drawn under the summary; nothing when there is nothing to offer or say.
  element: ReactElement
}

export function useProblemReport({ ended, facts, batch = false, follow = true }: ProblemReportOptions): ProblemReport {
  const commands = useCommands()
  const { config } = useConfig()
  const runIds = useRef<number[]>([])
  const [mode, setMode] = useState<Mode>({ kind: 'none' })
  // Shown under the first offer ever, once, whichever front end makes it.
  const [offHint, setOffHint] = useState(false)
  // Which finished screen the offer belongs to. A send takes seconds, and
  // the person can leave for another file meanwhile: the send carries on,
  // but its answer is about a run no longer on screen, and "Sent. Report"
  // under the next run's summary would say that run had been reported.
  // Moved on whenever the screen leaves (`ended` false); every caller of
  // reset drives `ended` false too, so reset need not move it as well.
  const generation = useRef(0)
  // A send dropped that way which did not go: the line naming where it was
  // saved, held for the next finished screen. Spec section 3 has the message
  // name the saved file, and nothing retries, so a path never shown is a
  // report nobody sends.
  const missed = useRef<string | undefined>(undefined)
  const [earlier, setEarlier] = useState<string | undefined>(undefined)
  const endedNow = useRef(ended)
  endedNow.current = ended

  // Looked at once the run is over, when every run id is in. Nothing is
  // opened for a run that started no run row (a fake in a test, a file that
  // could not be read), nor for a person who said never.
  useEffect(() => {
    // Gone with the finished screen it was under: `a` for another file leaves
    // with the offer showing, and an offer still held would keep the picker's
    // esc for itself, drawn nowhere.
    if (!ended) {
      generation.current++
      setMode({ kind: 'none' })
      setEarlier(undefined)
      return
    }
    if (missed.current !== undefined) {
      setEarlier(missed.current)
      missed.current = undefined
    }
    if (runIds.current.length === 0 || config.problemReports === 'never') return
    let problems: Problems
    try {
      const jobs = openJobsDb()
      try {
        problems = findProblems(jobs, runIds.current)
      } finally {
        jobs.close()
      }
    } catch {
      // A job store that cannot be read loses the offer, never the summary
      // of a run already paid for.
      return
    }
    if (!shouldOffer(config, problems.runIds)) return
    setMode({ kind: 'offer', problems })
    if (offerHintDue()) {
      setOffHint(true)
      markOfferHintShown()
    }
  }, [ended])

  const send = (problems: Problems, typed: string) => {
    setMode({ kind: 'sending' })
    const mine = generation.current
    const settle = (next: Extract<Mode, { kind: 'done' }>) => {
      if (generation.current === mine) return setMode(next)
      const line = earlierLine(next.delivery)
      if (line === undefined) return
      // Shown at once when a later run has already finished, else held for
      // the next one that does.
      if (endedNow.current) setEarlier(line)
      else missed.current = line
    }
    void (async () => {
      try {
        const known = facts()
        // The version discovery read at launch, held per process, so this is
        // almost always an answer already in hand rather than a spawn. Held
        // to the same short wait as the command line's, and a discovery that
        // fails or is still probing sends the report without a version.
        // A local model or no reviewer has no binary, and discovery, skipped
        // at launch for No AI, is not started for it here.
        const version = (PROVIDERS as readonly string[]).includes(known.provider)
          ? await boundedVersion(
              Promise.resolve().then(async () => (await commands.discoverAgents()).find((s) => s.provider === known.provider)?.version),
            )
          : undefined
        const jobs = openJobsDb()
        let report
        try {
          report = buildFor(jobs, problems.runIds, { ...known, ...(version === undefined ? {} : { version }) }, contactLine(typed))
        } finally {
          jobs.close()
        }
        settle({ kind: 'done', delivery: await deliverReport(report, commands.sendReport) })
      } catch (error) {
        settle({ kind: 'done', delivery: { error: errorMessage(error) } })
      }
    })()
  }

  // Built without the contact line, so the list is what leaves the machine
  // before anything does; the line typed after it is added on top.
  const see = (problems: Problems) => {
    try {
      const jobs = openJobsDb()
      try {
        setMode({ kind: 'list', problems, items: summarize(buildFor(jobs, problems.runIds, facts())) })
      } finally {
        jobs.close()
      }
    } catch (error) {
      setMode({ kind: 'list', problems, items: { error: errorMessage(error) } })
    }
  }

  return {
    noteRun: (runId) => void runIds.current.push(runId),
    reset: () => {
      runIds.current = []
      setMode({ kind: 'none' })
      setOffHint(false)
    },
    holdsEsc: mode.kind === 'offer' || mode.kind === 'list' || mode.kind === 'contact',
    typing: mode.kind === 'contact',
    element: (
      <>
        {earlier !== undefined && <Text color="yellow">{earlier}</Text>}
        <ProblemReportOffer
        mode={mode}
        batch={batch}
        follow={follow}
        offHint={offHint}
        onSend={(problems) => setMode({ kind: 'contact', problems, text: config.wporgUsername })}
        onSee={see}
        onType={(text) => setMode((m) => (m.kind === 'contact' ? { ...m, text } : m))}
        onSubmit={send}
        onDismiss={() => setMode((m) => (m.kind === 'offer' ? { kind: 'none' } : m.kind === 'list' || m.kind === 'contact' ? { kind: 'offer', problems: m.problems } : m))}
        />
      </>
    ),
  }
}

// The line for a send whose own screen had gone by the time it came back;
// nothing for one that was sent, since nothing is left for the person to do.
function earlierLine(delivery: Delivery | { error: string }): string | undefined {
  const lead = 'The earlier problem report was not sent'
  if ('error' in delivery) return `${lead}: ${delivery.error}`
  switch (delivery.state) {
    case 'sent':
      return undefined
    case 'kept':
      return `${lead}. Saved as ${delivery.path}.`
    case 'lost':
      return `${lead}, and could not be saved: ${delivery.saveError}`
    case 'too-large':
      return `${lead}: ${delivery.message}`
  }
}

interface OfferProps {
  mode: Mode
  batch: boolean
  follow: boolean
  offHint: boolean
  onSend: (problems: Problems) => void
  onSee: (problems: Problems) => void
  onType: (text: string) => void
  onSubmit: (problems: Problems, typed: string) => void
  // esc: no report from the offer; back to the offer from its list or contact line.
  onDismiss: () => void
}

function ProblemReportOffer({ mode, batch, follow, offHint, onSend, onSee, onType, onSubmit, onDismiss }: OfferProps) {
  const offer = mode.kind === 'offer' ? mode : undefined
  useKeys({
    problemReport: {
      send: offer ? () => onSend(offer.problems) : undefined,
      see: offer ? () => onSee(offer.problems) : undefined,
      dismiss: mode.kind === 'offer' || mode.kind === 'list' || mode.kind === 'contact' ? onDismiss : undefined,
    },
  })

  if (mode.kind === 'none') return <></>
  if (mode.kind === 'done') {
    const { delivery } = mode
    if ('error' in delivery) return <Text color="yellow">Not sent: {delivery.error}</Text>
    const cut = cutLine(delivery)
    return (
      <Box flexDirection="column">
        {cut && <Text dimColor>{cut}</Text>}
        <Text color={delivery.state === 'sent' ? 'green' : 'yellow'}>{deliveryLine(delivery)}</Text>
      </Box>
    )
  }
  if (mode.kind === 'sending') return <Text dimColor>Sending the problem report...</Text>
  // Followed into view: on a long summary the offer is the last thing drawn,
  // and a question below the window is a question nobody answers.
  return (
    <ScrollTarget active={follow}>
      <Box flexDirection="column" marginTop={1}>
        <Text color="yellow">
          {problemHeadline(mode.problems, batch)} {OFFER_QUESTION}
        </Text>
        {mode.kind === 'offer' && (
          <>
            <Hint>{OFFER_KEYS}</Hint>
            {offHint && <Hint>{OFF_HINT}</Hint>}
          </>
        )}
        {mode.kind === 'list' &&
          ('error' in mode.items ? (
            <Text color="yellow">Could not put the report together: {mode.items.error}</Text>
          ) : (
            <>
              <Text>The report holds, before anything is sent:</Text>
              {mode.items.map((item) => (
                <Text key={item.name}>
                  {'  '}
                  {item.name}
                  {'  '}
                  <Text dimColor>{formatBytes(item.bytes)}</Text>
                </Text>
              ))}
            </>
          ))}
        {mode.kind === 'list' && <Hint>esc back to the offer</Hint>}
        {mode.kind === 'contact' && (
          <>
            <Box gap={1}>
              <Text>How can the maintainer reach you?</Text>
              <TextInput value={mode.text} onChange={onType} onSubmit={() => onSubmit(mode.problems, mode.text)} />
            </Box>
            <Hint>optional · enter send · esc back to the offer</Hint>
          </>
        )}
      </Box>
    </ScrollTarget>
  )
}
