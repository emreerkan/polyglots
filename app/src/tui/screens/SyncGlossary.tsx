import { useState } from 'react'
import { Box, Text } from 'ink'
import { removedEditLine, syncedLine, type SyncGlossaryResult } from '../../commands/glossary-sync.js'
import { configuredLocale } from '../../config.js'
import { normalizeLocale } from '../../tmx/parse.js'
import { resolveLocale } from '../../wporg/locales.js'
import { useCommands, useConfig } from '../commands.js'
import { DONE_HINT, Hint } from '../components/Hint.js'
import { useBackKeys } from '../hooks/useBackKeys.js'
import { useKeys } from '../hooks/useKeys.js'
import { useTask } from '../hooks/useTask.js'
import { TextInput } from '../input.js'

export interface SyncGlossaryProps {
  onBack: () => void
}

export function SyncGlossary({ onBack }: SyncGlossaryProps) {
  const commands = useCommands()
  const { config, error: configError } = useConfig()
  // With a locale configured there is nothing to type: the header names it
  // and l changes it. The field stays for a person with none, as the one way
  // to say which glossary to fetch.
  const configured = configuredLocale(config)
  const [locale, setLocale] = useState(configured ?? '')
  const task = useTask<SyncGlossaryResult>()

  const editing = task.state.status === 'idle'
  const running = task.state.status === 'running'
  const failed = task.state.status === 'error'
  const finished = !editing && !running

  useBackKeys(onBack, { enabled: !running, allowQ: !editing })
  useKeys({
    // A typed locale may be what failed, so a retry goes back to the field;
    // a configured one cannot be edited here, so a retry is the sync again.
    retry: { again: failed ? (configured === undefined ? task.reset : () => submit(configured)) : undefined },
    finished: { close: finished ? onBack : undefined },
    // The field's own enter submits it; with no field, enter starts the sync.
    syncGlossary: { start: editing && configured !== undefined ? () => submit(configured) : undefined },
  })

  const submit = (value: string) => {
    const normalized = resolveLocale(value)?.id ?? normalizeLocale(value)
    if (normalized.length === 0) return
    setLocale(normalized)
    task.run(() => commands.syncGlossary({ locale: normalized }))
  }

  return (
    <Box flexDirection="column">
      <Text bold>Sync glossary from translate.wordpress.org</Text>
      {configError && <Text color="yellow">Config error, using defaults: {configError}</Text>}
      {configured === undefined && (
        <Box>
          <Text>Locale: </Text>
          {editing ? <TextInput value={locale} onChange={setLocale} onSubmit={submit} /> : <Text>{locale}</Text>}
        </Box>
      )}
      {editing && <Hint>enter to sync · esc back to menu</Hint>}
      {running && <Text>Fetching glossary for {locale}…</Text>}
      {task.state.status === 'done' && (
        <Box flexDirection="column">
          <Text bold>{syncedLine(task.state.result, locale)}</Text>
          {task.state.result.removed.map((r, i) => (
            <Text key={i}>  {removedEditLine(r)}</Text>
          ))}
        </Box>
      )}
      {failed && <Text color="red">Sync failed: {task.state.status === 'error' ? task.state.message : ''}</Text>}
      {failed ? <Hint>{`${configured === undefined ? 'enter to edit the locale and retry' : 'enter to retry'} · q/esc back to menu`}</Hint> : finished && <Hint>{DONE_HINT}</Hint>}
    </Box>
  )
}
