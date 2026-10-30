import { useEffect, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import { configuredLocale } from '../../config.js'
import type { GlossaryEditorServer } from '../../glossary/editor/server.js'
import type { Locale } from '../../types.js'
import { TOKENS } from '../../ui/tokens.js'
import { errorMessage, useCommands, useConfig } from '../commands.js'
import { Hint } from '../components/Hint.js'
import { NeedsLocale } from '../components/NeedsLocale.js'
import { useBackKeys } from '../hooks/useBackKeys.js'
import { useKeys } from '../hooks/useKeys.js'

export interface EditGlossaryProps {
  onBack: () => void
  // Opens setup at the locale step; see NeedsLocale.
  onSetup?: () => void
}

export function EditGlossary(props: EditGlossaryProps) {
  const { config } = useConfig()
  const locale = configuredLocale(config)
  if (locale === undefined) {
    return (
      <NeedsLocale
        title="Edit glossary"
        needs="Editing the glossary"
        onBack={props.onBack}
        {...(props.onSetup === undefined ? {} : { onSetup: props.onSetup })}
      />
    )
  }
  return <EditGlossaryInLocale onBack={props.onBack} locale={locale} />
}

type Serving =
  | { state: 'starting' }
  | { state: 'up'; url: string }
  | { state: 'stopped' }
  | { state: 'closed' }
  | { state: 'failed'; message: string }

/**
 * The TUI's `glossary edit`: the polyglots glossary of the configured locale,
 * served while this screen is open.
 *
 * Unlike the stats server, this one does not outlive its screen. Stats is a
 * read-only page that may as well stay up while the person does other work;
 * this page writes polyglots.db, and a server left running behind every other
 * screen would be a write path nobody remembers is open. Leaving the screen
 * closes it, as Ctrl+C does for the CLI, and the screen says so up front.
 *
 * The server can also end itself, when the page sends close or sits idle;
 * the screen then says so, and s starts a fresh one with a new address.
 */
function EditGlossaryInLocale({ onBack, locale }: { onBack: () => void; locale: Locale }) {
  const commands = useCommands()
  const [serving, setServing] = useState<Serving>({ state: 'starting' })
  const [opened, setOpened] = useState<boolean | undefined>(undefined)
  const [serverError, setServerError] = useState<string | undefined>(undefined)
  // The server this screen holds, if any. A ref rather than state, because
  // the unmount cleanup must see the current one, not the first render's.
  const current = useRef<GlossaryEditorServer | undefined>(undefined)
  const mounted = useRef(true)

  // Takes the server out of the screen's hands before closing it, so its done
  // (which close resolves) is not then read as the page having closed it.
  const release = (): void => {
    const server = current.current
    current.current = undefined
    void server?.close()
  }

  const start = (): void => {
    setServing({ state: 'starting' })
    setOpened(undefined)
    setServerError(undefined)
    commands
      .startGlossaryEditor({
        source: { kind: 'db', locale },
        onError: (err) => mounted.current && setServerError(err.message),
      })
      .then(
        (server) => {
          // Left while it was starting: nobody would close it later.
          if (!mounted.current) {
            void server.close()
            return
          }
          current.current = server
          setServing({ state: 'up', url: server.url })
          void commands.openInBrowser(server.url).then((o) => mounted.current && setOpened(o))
          void server.done.then(() => {
            if (current.current !== server) return
            release()
            if (mounted.current) setServing({ state: 'closed' })
          })
        },
        (err: unknown) => mounted.current && setServing({ state: 'failed', message: errorMessage(err) }),
      )
  }

  useEffect(() => {
    mounted.current = true
    start()
    return () => {
      mounted.current = false
      release()
    }
  }, [])

  const url = serving.state === 'up' ? serving.url : undefined
  useBackKeys(onBack)
  useKeys({
    editGlossary: {
      open: url ? () => void commands.openInBrowser(url).then(setOpened) : undefined,
      stop: url
        ? () => {
            release()
            setServing({ state: 'stopped' })
          }
        : undefined,
      serve: serving.state === 'stopped' || serving.state === 'closed' || serving.state === 'failed' ? start : undefined,
    },
  })

  return (
    <Box flexDirection="column">
      <Text bold>Edit glossary</Text>
      {serving.state === 'starting' && <Text>Starting the glossary editor…</Text>}
      {url && (
        <>
          <Text>
            Glossary editor at <Text {...TOKENS.path.ink}>{url}</Text> (polyglots, {locale})
          </Text>
          <Text {...TOKENS.muted.ink}>Only this machine can reach it. Leaving this screen stops it; save in the page first.</Text>
          {opened === true && <Text {...TOKENS.success.ink}>Opening it in the browser.</Text>}
          {opened === false && <Text {...TOKENS.warn.ink}>No browser to open here; copy the address above.</Text>}
        </>
      )}
      {serving.state === 'stopped' && <Text>Stopped. s to start it again.</Text>}
      {serving.state === 'closed' && <Text>The editor closed: the page was closed, or left idle. s to start it again.</Text>}
      {serving.state === 'failed' && <Text {...TOKENS.error.ink}>Could not start the glossary editor: {serving.message} · s to try again</Text>}
      {serverError && <Text {...TOKENS.warn.ink}>The server reported: {serverError}</Text>}
      <Hint>{url ? 'o open in browser · x stop · esc back' : serving.state === 'starting' ? 'esc back' : 's start again · esc back'}</Hint>
    </Box>
  )
}
