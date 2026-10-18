import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { useState } from 'react'
import { Box, Text } from 'ink'
import type { ExportTmResult, TmExportFormat } from '../../commands/tm-export.js'
import { configuredLocale } from '../../config.js'
import { useCommands, useConfig } from '../commands.js'
import { NeedsLocale } from '../components/NeedsLocale.js'
import { FilePicker } from '../components/FilePicker.js'
import { DONE_HINT, Hint } from '../components/Hint.js'
import { useBackKeys } from '../hooks/useBackKeys.js'
import { useKeys } from '../hooks/useKeys.js'
import { useTask } from '../hooks/useTask.js'
import { TextInput } from '../input.js'
import type { Locale } from '../../types.js'

export interface ExportTmProps {
  // Opens setup at the locale step; see NeedsLocale.
  onSetup?: () => void
  onBack: () => void
}

const FORMATS: TmExportFormat[] = ['tmx', 'po']

const pad = (n: number) => String(n).padStart(2, '0')

// Dated by the local day, so two exports a week apart sit side by side in
// Downloads instead of the later one silently replacing the earlier.
export function defaultTmName(format: TmExportFormat, now: Date = new Date()): string {
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  return `polyglots-tm-${day}.${format}`
}

function target(dir: string, name: string, format: TmExportFormat): string {
  const typed = name.trim()
  if (typed.length === 0) return join(dir, defaultTmName(format))
  return isAbsolute(typed) || typed.includes('/') ? resolve(dir, typed) : join(dir, typed)
}

/**
 * Writes the translation memory out as TMX or .po, the menu's half of
 * `tm export`.
 *
 * The format is asked first because it decides the file's extension and what
 * the file can hold. TMX carries every approved wording of a source; a .po
 * keys entries by source and context, so alternatives are collapsed to the
 * most recent, and the count left behind is reported rather than lost quietly.
 *
 * The file lands in Downloads, where everything else this tool hands the
 * person goes. Only the format the person picked decides the format: a typed
 * name with the other extension does not switch it behind their back.
 */
export function ExportTm(props: ExportTmProps) {
  const { config } = useConfig()
  const locale = configuredLocale(config)
  if (locale === undefined) {
    return (
      <NeedsLocale
        title="Export Translation Memory"
        needs="Exporting the memory"
        onBack={props.onBack}
        {...(props.onSetup === undefined ? {} : { onSetup: props.onSetup })}
      />
    )
  }
  return <ExportTmInLocale {...props} locale={locale} />
}

function ExportTmInLocale({ onBack, locale }: ExportTmProps & { locale: Locale }) {
  const commands = useCommands()
  const { error: configError } = useConfig()
  const [stage, setStage] = useState<'format' | 'target'>('format')
  const [format, setFormat] = useState<TmExportFormat>('tmx')
  const [dir, setDir] = useState(join(homedir(), 'Downloads'))
  const [name, setName] = useState('')
  const [picking, setPicking] = useState(false)
  const task = useTask<ExportTmResult>()

  const editing = stage === 'target' && task.state.status === 'idle' && !picking
  const running = task.state.status === 'running'
  const failed = task.state.status === 'error'
  const done = task.state.status === 'done' ? task.state : undefined

  useBackKeys(picking ? () => setPicking(false) : onBack, {
    enabled: !running,
    allowQ: !editing,
  })
  useKeys({ retry: { again: failed ? task.reset : undefined }, finished: { close: done ? onBack : undefined } })

  useKeys(
    {
      exportFormat: {
        format: () => setFormat((f) => (f === 'tmx' ? 'po' : 'tmx')),
        next: () => {
          setName(defaultTmName(format))
          setStage('target')
        },
      },
    },
    { isActive: stage === 'format' },
  )

  // Tab, as on the statistics screen: the name field types any printable key.
  useKeys({ target: { folder: () => setPicking(true) } }, { isActive: editing })

  const submit = () => {
    const file = target(dir, name, format)
    setDir(dirname(file))
    setName(basename(file))
    task.run(() => commands.exportTm({ locale: locale, file, format }))
  }

  if (picking) {
    return (
      <Box flexDirection="column">
        <Text bold>Export Translation Memory · where should the file go?</Text>
        <FilePicker
          dir={dir}
          extensions={[]}
          chooseDir
          onPick={(path) => {
            setDir(path)
            setPicking(false)
          }}
        />
        <Hint>enter to use the highlighted folder · esc to go back</Hint>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold>Export Translation Memory</Text>
      {configError && <Text color="yellow">Config error, using defaults: {configError}</Text>}

      {stage === 'format' && (
        <>
          <Text>{format === 'tmx' ? '❯ ' : '  '}TMX, every approved wording (Poedit, OmegaT and other CAT tools)</Text>
          <Text>{format === 'po' ? '❯ ' : '  '}.po, one wording per source (the most recent)</Text>
          <Hint>↑↓ choose · enter continue · esc back to menu</Hint>
        </>
      )}

      {stage === 'target' && (
        <>
          <Box>
            <Text>
              Write to: <Text dimColor>{dir}/</Text>
            </Text>
            {editing ? <TextInput value={name} onChange={setName} onSubmit={submit} /> : <Text>{name}</Text>}
          </Box>
          {editing && <Hint>enter to write the file · tab choose folder · esc back to menu</Hint>}
          {running && <Text>Reading the memory…</Text>}
          {done && (
            <Box flexDirection="column">
              <Text bold>
                Exported {done.result.entries} {done.result.entries === 1 ? 'entry' : 'entries'}.
              </Text>
              {done.result.file && <Text>Wrote {done.result.file}</Text>}
              {done.result.dropped > 0 && (
                <Text color="yellow">
                  {done.result.dropped} alternative {done.result.dropped === 1 ? 'wording was' : 'wordings were'} not
                  carried: a .po holds one per source and context. TMX keeps them all.
                </Text>
              )}
            </Box>
          )}
          {failed && (
            <Text color="red">Could not export: {task.state.status === 'error' ? task.state.message : ''}</Text>
          )}
          {failed ? <Hint>enter to try again · q/esc back to menu</Hint> : done && <Hint>{DONE_HINT}</Hint>}
        </>
      )}
    </Box>
  )
}
