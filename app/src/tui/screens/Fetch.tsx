import { useState } from 'react'
import { Box, Text } from 'ink'
import { providerLabel } from '../local.js'
import { defaultOutDir, type Ready, type Resolution } from '../../commands/fetch.js'
import { describeResolution, endOfResolution, waitNotice, type ProjectEnd } from '../../commands/fetch-report.js'
import type { Locale } from '../../types.js'
import { parseProjectLines, type FetchStatus } from '../../wporg/projects.js'
import { useCommands, useConfig } from '../commands.js'
import { BatchRun, type BatchStage } from '../components/BatchRun.js'
import { NeedsLocale } from '../components/NeedsLocale.js'
import { DONE_HINT, Hint } from '../components/Hint.js'
import { useKeys } from '../hooks/useKeys.js'
import { useTypingWhile } from '../input.js'
import { useFooterStage } from '../footer-stage.js'

export interface FetchProps {
  // Opens setup at the locale step; see NeedsLocale.
  onSetup?: () => void
  onBack: () => void
}

// After resolved, the batch's own stages (options, running, summary) belong
// to BatchRun, which local files marked in the review and translate pickers
// share.
type Stage = 'list' | 'get' | 'resolving' | 'resolved' | 'batch'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Fetch a list of projects from translate.wordpress.org and review or translate
 * every one, from the menu.
 *
 * The steps follow the CLI's: the list, what to get, how each project resolved,
 * the action's options, the run, and a table of how each ended. What to get is
 * asked before the list is checked rather than after, because the check depends
 * on it: a plugin's branch is the one with more strings in that status, and a
 * project with nothing in it is skipped.
 */
export function Fetch(props: FetchProps) {
  const { config } = useConfig()
  if (config.defaultLocale === undefined) {
    return (
      <NeedsLocale
        title="Fetch from translate.wordpress.org"
        needs="Fetching"
        onBack={props.onBack}
        {...(props.onSetup === undefined ? {} : { onSetup: props.onSetup })}
      />
    )
  }
  return <FetchInLocale {...props} locale={config.defaultLocale} />
}

function FetchInLocale({ onBack, locale }: FetchProps & { locale: Locale }) {
  const commands = useCommands()
  const { config, error: configError } = useConfig()
  const [stage, setStage] = useState<Stage>('list')
  const [lines, setLines] = useState<string[]>([])
  const [current, setCurrent] = useState('')
  const [status, setStatus] = useState<FetchStatus>('waiting')
  const [resolutions, setResolutions] = useState<Resolution[]>([])
  const [resolveError, setResolveError] = useState<string | undefined>(undefined)
  // The latest backoff, shown under the checking line.
  const [waiting, setWaiting] = useState<string | undefined>(undefined)
  const [batchStage, setBatchStage] = useState<BatchStage>('options')

  const review = status === 'waiting'
  const ready = resolutions.filter((r): r is Ready => r.state === 'ready')
  const shown = stage
  useFooterStage(shown === 'batch' ? (batchStage === 'summary' ? 'done' : batchStage) : undefined)

  const resolve = (chosen: FetchStatus) => {
    setStage('resolving')
    setResolveError(undefined)
    commands
      .resolveProjects(parseProjectLines(lines.join('\n')), {
        locale,
        status: chosen,
        onWait: (ms) => setWaiting(waitNotice(ms)),
      })
      .then(setResolutions, (err: unknown) => setResolveError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        setWaiting(undefined)
        setStage('resolved')
      })
  }

  // The downloads are fetch's part of the batch; BatchRun runs what they
  // leave on disk, the same way it runs files marked in a picker.
  const prepare = async (onWait: (notice: string | undefined) => void) => {
    const ends = new Map<string, ProjectEnd>()
    for (const r of resolutions) {
      const end = endOfResolution(r, status)
      if (end) ends.set(r.input, end)
    }
    const fetched = await commands.fetchProjects(ready, {
      locale,
      status,
      outDir: defaultOutDir(),
      onWait: (ms) => onWait(waitNotice(ms)),
    })
    const items = fetched.flatMap((f) => {
      if (f.state === 'failed') {
        ends.set(f.input, { tally: 'failed', detail: `download failed: ${f.reason}` })
        return []
      }
      return [{ input: f.input, file: f.file }]
    })
    return { items, ends }
  }

  // A pasted list arrives as one chunk with its line breaks in it, so a chunk is
  // split rather than taken as one line.
  const type = (input: string) => {
    const parts = (current + input).split(/\r\n|\r|\n/)
    const complete = parts.slice(0, -1).map((l) => l.trim()).filter((l) => l !== '')
    if (complete.length > 0) setLines((prev) => [...prev, ...complete])
    setCurrent(parts[parts.length - 1]!)
  }

  useTypingWhile(shown === 'list')

  // Moves on from the list once it names at least one project.
  const endList = (all: string[]) => {
    if (parseProjectLines(all.join('\n')).length === 0) return
    setLines(all)
    setCurrent('')
    setStage('get')
  }
  const listing = shown === 'list'
  // The batch's stages bind their own keys, back included, in BatchRun.
  const batch = shown === 'batch'
  useKeys({
    // Only escape leaves the list: q is a letter that slugs contain.
    back: { esc: batch ? undefined : onBack, q: batch || listing ? undefined : onBack },
    fetchList: {
      add: listing
        ? () => {
            const line = current.trim()
            if (line === '') return endList(lines)
            setLines((prev) => [...prev, line])
            setCurrent('')
          }
        : undefined,
      done: listing
        ? () => {
            const line = current.trim()
            endList(line === '' ? lines : [...lines, line])
          }
        : undefined,
      erase: listing
        ? () => {
            if (current.length > 0) setCurrent((c) => c.slice(0, -1))
            else if (lines.length > 0) {
              setCurrent(lines[lines.length - 1]!)
              setLines((prev) => prev.slice(0, -1))
            }
          }
        : undefined,
      type: listing ? type : undefined,
    },
    fetchGet: {
      choose: shown === 'get' ? () => setStatus((s) => (s === 'waiting' ? 'untranslated' : 'waiting')) : undefined,
      check: shown === 'get' ? () => resolve(status) : undefined,
    },
    fetchResolved: {
      next:
        shown === 'resolved'
          ? () => {
              if (ready.length === 0) return onBack()
              setStage('batch')
            }
          : undefined,
    },
  })

  const width = Math.max(0, ...resolutions.map((r) => r.input.length))

  return (
    <Box flexDirection="column">
      <Text bold>Fetch from translate.wordpress.org</Text>
      {configError && <Text color="yellow">Config error, using defaults: {configError}</Text>}
      {shown !== 'list' && shown !== 'get' && <Text dimColor>Provider: {providerLabel(config.reviewProvider)} · locale {locale}</Text>}

      {shown === 'list' && (
        <>
          <Text>Projects, one per line: a slug or a translate.wordpress.org URL</Text>
          {lines.map((line, i) => (
            <Text key={i}>  {line}</Text>
          ))}
          <Text>
            ❯ {current}
            <Text inverse> </Text>
          </Text>
          <Hint>enter adds a line · enter on an empty line continues · esc back to menu</Hint>
        </>
      )}

      {shown === 'get' && (
        <>
          <Text>What to get for {plural(parseProjectLines(lines.join('\n')).length, 'project', 'projects')}:</Text>
          <Text>{status === 'waiting' ? '❯ ' : '  '}Waiting strings, to review</Text>
          <Text>{status === 'untranslated' ? '❯ ' : '  '}Untranslated strings, to translate</Text>
          <Hint>↑↓ choose · enter check the list · esc back to menu</Hint>
        </>
      )}

      {shown === 'resolving' && <Text>Checking {plural(lines.length, 'project', 'projects')}...</Text>}
      {shown === 'resolving' && waiting && <Text color="yellow">{waiting}</Text>}

      {shown === 'resolved' && (
        <>
          {resolveError && <Text color="red">Could not check the list: {resolveError}</Text>}
          {resolutions.map((r) => (
            <Text key={r.input} {...(r.state === 'ready' ? {} : { dimColor: true, strikethrough: r.state !== 'unreachable' })}>
              {'  '}
              {r.input.padEnd(width)}
              {'  '}
              {describeResolution(r, status)}
            </Text>
          ))}
          {ready.length === 0 ? (
            <>
              <Text color="yellow">Nothing to do: no project on the list has {status} strings.</Text>
              <Hint>{DONE_HINT}</Hint>
            </>
          ) : (
            <Hint>enter to continue · esc back to menu</Hint>
          )}
        </>
      )}

      {shown === 'batch' && (
        <BatchRun
          action={review ? 'review' : 'translate'}
          noun={{ one: 'project', many: 'projects' }}
          inputs={resolutions.map((r) => r.input)}
          prepare={prepare}
          preparing={`Downloading ${plural(ready.length, 'export', 'exports')}...`}
          locale={{ fixed: locale }}
          after={`Saves to ${defaultOutDir()}`}
          onLeave={onBack}
          leaveHint="esc back to menu"
          onBack={onBack}
          onStage={setBatchStage}
        />
      )}
    </Box>
  )
}
