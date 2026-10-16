import { basename } from 'node:path'
import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import type { TmFetchPlan, TmFetchProgress, TmFetchResult } from '../../commands/tm-fetch.js'
import type { TmImportProgress, TmImportResult } from '../../commands/tm-import.js'
import type { DataClient } from '../../data/download.js'
import { TOKENS } from '../../ui/tokens.js'
import { useCommands, useConfig } from '../commands.js'
import { NeedsLocale } from '../components/NeedsLocale.js'
import { FilePicker } from '../components/FilePicker.js'
import { BACK_HINT, DONE_HINT, Hint } from '../components/Hint.js'
import { useBackKeys } from '../hooks/useBackKeys.js'
import { useKeys } from '../hooks/useKeys.js'
import { useTask } from '../hooks/useTask.js'
import { useTmListing } from '../hooks/useTmListing.js'
import { useGlyphs } from '../theme.js'
import type { Locale } from '../../types.js'

export interface ImportTmProps {
  // Opens setup at the locale step; see NeedsLocale.
  onSetup?: () => void
  cwd: string
  onBack: () => void
}

// The .po exports translate.wordpress.org hands out import as well as TMX, so
// the picker offers both; leaving .po out made the menu import less than the CLI.
const TM_EXTENSIONS = ['.tmx', '.po']
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const n = (v: number) => v.toLocaleString('en-US')

export function ImportTm(props: ImportTmProps) {
  const { config } = useConfig()
  if (config.defaultLocale === undefined) {
    return (
      <NeedsLocale
        title="Import Translation Memory"
        needs="Importing a memory"
        onBack={props.onBack}
        {...(props.onSetup === undefined ? {} : { onSetup: props.onSetup })}
      />
    )
  }
  return <ImportTmInLocale {...props} locale={config.defaultLocale} />
}

type Choice = 'fetch' | 'file'

// Two ways in: the locale's published memory from polyglots-data, or a file
// of one's own. The fetch is offered only once the manifest says the vault has
// the locale, and is listed first then, since a verified memory of the
// locale's own projects is the better start for someone who has none. Until
// the manifest answers, or when it cannot, the file is the only way in and
// nothing waits on the network.
function ImportTmInLocale({ cwd, onBack, locale }: ImportTmProps & { locale: Locale }) {
  const { error: configError } = useConfig()
  const glyphs = useGlyphs()
  const listing = useTmListing(locale)
  const [chosen, setChosen] = useState<Choice>()
  const [at, setAt] = useState(0)
  const options: { id: Choice; label: string; detail: string }[] = [
    ...(listing.status === 'listed'
      ? [{ id: 'fetch' as const, label: 'Fetch from polyglots-data', detail: "the locale's published memory, checked against its sha512" }]
      : []),
    { id: 'file', label: 'Import a file…', detail: '.tmx or .po, from PoEdit or translate.wordpress.org' },
  ]
  const cursor = Math.min(at, options.length - 1)
  const choosing = chosen === undefined

  useBackKeys(onBack, { enabled: choosing })
  useKeys({
    importChoice: {
      move: choosing ? (_input, key) => setAt(key.upArrow ? Math.max(0, cursor - 1) : Math.min(options.length - 1, cursor + 1)) : undefined,
      choose: choosing ? () => setChosen(options[cursor]!.id) : undefined,
    },
  })

  return (
    <Box flexDirection="column">
      <Text bold>Import Translation Memory · locale {locale}</Text>
      {configError && <Text color="yellow">Config error, using defaults: {configError}</Text>}
      {choosing && (
        <>
          {options.map((o, i) => (
            <Text key={o.id}>
              <Text {...TOKENS.accent.ink}>{i === cursor ? glyphs.next : ' '}</Text> <Text bold={i === cursor}>{o.label}</Text>{' '}
              <Text {...TOKENS.muted.ink}>{o.detail}</Text>
            </Text>
          ))}
          {listing.status === 'loading' && <Text {...TOKENS.muted.ink}>Checking polyglots-data…</Text>}
          {listing.status === 'offline' && <Text {...TOKENS.muted.ink}>Could not reach polyglots-data: {listing.message}</Text>}
          <Hint>{`↑↓ move · enter choose · ${BACK_HINT}`}</Hint>
        </>
      )}
      {chosen === 'fetch' && listing.status === 'listed' && <TmFetch locale={locale} client={listing.client} onBack={onBack} onDone={onBack} />}
      {chosen === 'file' && <ImportFile cwd={cwd} locale={locale} onBack={onBack} />}
    </Box>
  )
}

function ImportFile({ cwd, locale, onBack }: { cwd: string; locale: Locale; onBack: () => void }) {
  const commands = useCommands()
  const [file, setFile] = useState<string>()
  const [progress, setProgress] = useState<TmImportProgress[]>([])
  const task = useTask<TmImportResult>()

  const running = task.state.status === 'running'
  const finished = task.state.status === 'done' || task.state.status === 'error'

  useBackKeys(onBack, { enabled: !running })
  useKeys({ finished: { close: finished ? onBack : undefined } })

  const pick = (path: string) => {
    setFile(path)
    setProgress([])
    task.run(() =>
      commands.importTmx([path], {
        locale: locale,
        onProgress: (e) => setProgress((prev) => [...prev, e]),
      }),
    )
  }

  if (file === undefined) {
    return (
      <>
        <FilePicker dir={cwd} extensions={TM_EXTENSIONS} onPick={pick} />
        <Hint>{BACK_HINT}</Hint>
      </>
    )
  }
  return (
    <>
      {running && <Text>Importing {basename(file)}…</Text>}
      {progress.map((p) => (
        <Text key={p.file}>
          {basename(p.file)}: {count(p.entries, 'entry', 'entries')}, {p.upserted} new or updated
        </Text>
      ))}
      {task.state.status === 'done' && (
        <Text bold>
          Imported {count(task.state.result.entries, 'entry', 'entries')} ({task.state.result.upserted} new or updated) from{' '}
          {count(task.state.result.files, 'file', 'files')}.
        </Text>
      )}
      {task.state.status === 'error' && <Text color="red">Import failed: {task.state.message}</Text>}
      {finished && <Hint>{DONE_HINT}</Hint>}
    </>
  )
}

export interface TmFetchProps {
  locale: Locale
  // A client whose manifest is the one already read to decide the fetch was
  // worth offering (useTmListing), so the plan does not ask again.
  client: DataClient
  // Esc before or instead of importing.
  onBack: () => void
  // Enter, or esc, once the import has finished or failed.
  onDone: () => void
  doneHint?: string
}

/**
 * tm fetch on a screen: the same plan and summary the CLI prints, one key to
 * go ahead, progress while the file downloads and imports, and the CLI's
 * result line. The setup wizard embeds it as its memory step, the way it
 * embeds the glossary sync, so the step and the menu cannot drift apart.
 */
export function TmFetch({ locale, client, onBack, onDone, doneHint = DONE_HINT }: TmFetchProps) {
  const commands = useCommands()
  const plan = useTask<TmFetchPlan>()
  const run = useTask<TmFetchResult>()
  const [progress, setProgress] = useState<TmFetchProgress>()

  useEffect(() => {
    plan.run(() => commands.planTmFetch(locale, client))
  }, [])

  const ready = plan.state.status === 'done' ? plan.state.result : undefined
  const importing = run.state.status === 'running'
  const finished = run.state.status === 'done' || run.state.status === 'error'

  // Not while importing: the rows are going in, and leaving would only hide
  // the result. Once it has finished, every way out is the way on.
  useBackKeys(finished ? onDone : onBack, { enabled: !importing })
  useKeys({
    tmFetch: {
      start:
        ready !== undefined && run.state.status === 'idle'
          ? () => run.run(() => commands.runTmFetch(ready, client, { onProgress: setProgress }))
          : undefined,
    },
    finished: { close: finished ? onDone : undefined },
  })

  if (plan.state.status === 'idle' || plan.state.status === 'running') return <Text>Checking polyglots-data…</Text>
  if (plan.state.status === 'error') {
    return (
      <>
        <Text color="red">{plan.state.message}</Text>
        <Hint>{BACK_HINT}</Hint>
      </>
    )
  }
  const summary = plan.state.result.summary
  return (
    <>
      {summary.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
      {run.state.status === 'idle' && <Hint>{`y download and import · ${BACK_HINT}`}</Hint>}
      {importing && (
        <Text>
          {progress?.phase === 'importing' ? `Importing ${n(progress.done)} of ${n(progress.total)}…` : 'Downloading…'}
        </Text>
      )}
      {run.state.status === 'done' && (
        <Text bold>
          Imported {n(run.state.result.added)} new strings ({n(run.state.result.present)} already present) from {n(run.state.result.projects)} projects in{' '}
          {(run.state.result.ms / 1000).toFixed(1)}s.
        </Text>
      )}
      {run.state.status === 'error' && <Text color="red">Fetch failed: {run.state.message}</Text>}
      {finished && <Hint>{doneHint}</Hint>}
    </>
  )
}
