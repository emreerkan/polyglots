import { useState } from 'react'
import { Box, Text } from 'ink'
import { createTemplate, deleteTemplate, fillTemplate, loadTemplates, saveTemplate, type Template } from '../../reply/templates.js'
import { TOKENS } from '../../ui/tokens.js'
import { wpCodeOf } from '../../wporg/locales.js'
import type { Locale } from '../../types.js'
import { configuredLocale } from '../../config.js'
import { errorMessage, useConfig } from '../commands.js'
import { Hint } from '../components/Hint.js'
import { NeedsLocale } from '../components/NeedsLocale.js'
import { useBackKeys } from '../hooks/useBackKeys.js'
import { useKeys } from '../hooks/useKeys.js'
import { TextArea, TextInput } from '../input.js'
import { useReportUnsaved } from '../unsaved.js'

// The TUI's half of `polyglots template`. The app owns these files: a person
// creates, edits, previews and deletes them here and never needs to know the
// folder, which is why the screen shows no path.
//
// Editing happens in place rather than in $EDITOR. The people who use this
// screen are locale managers, and most of them have never set $EDITOR, so
// handing the terminal to vi would strand them in it.
//
// The locale is the configured one, with no way to type another. A reply
// template is the locale manager's own comment for their own team, and a
// screen that offered every locale would mostly offer ways to edit the wrong
// one. Someone who manages two switches the locale with l.

export interface ReplyTemplatesProps {
  onBack: () => void
  onSetup?: () => void
}

type Stage = 'list' | 'name' | 'delete' | 'edit' | 'unsaved'

// What the preview fills a template with. A made-up requester and a made-up
// message for the requester in the shape buildReport writes, so the preview
// shows where each placeholder lands without a review having been run.
const SAMPLE_REQUESTER = 'requester'
const SAMPLE_RESULTS = 'I fixed 3 entries, which you can see <a href="">here</a>. They included ~2 glossary issues.'

function read(locale: Locale): { templates: Template[]; error?: string } {
  try {
    return { templates: loadTemplates(locale) }
  } catch (err) {
    return { templates: [], error: errorMessage(err) }
  }
}

export function ReplyTemplates({ onBack, onSetup }: ReplyTemplatesProps) {
  const { config } = useConfig()
  const locale = configuredLocale(config)
  if (locale === undefined) {
    return <NeedsLocale title="Reply templates" needs="A reply template" onBack={onBack} {...(onSetup ? { onSetup } : {})} />
  }
  return <TemplateList locale={locale} onBack={onBack} />
}

function TemplateList({ locale, onBack }: { locale: Locale; onBack: () => void }) {
  const [loaded, setLoaded] = useState(() => read(locale))
  const [cursor, setCursor] = useState(0)
  const [stage, setStage] = useState<Stage>('list')
  const [name, setName] = useState('')
  // The editor's text, and the text it opened with, to tell whether esc
  // would throw anything away.
  const [draft, setDraft] = useState('')
  // Clean shows the first branch of every choice; with problems, the second
  // and the sample message. The two a reviewer posts most.
  const [withProblems, setWithProblems] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()

  const { templates } = loaded
  const current = templates[Math.min(cursor, templates.length - 1)]
  const label = wpCodeOf(locale) ?? locale
  const listing = stage === 'list'

  const reload = (select?: string) => {
    const next = read(locale)
    setLoaded(next)
    const at = select === undefined ? -1 : next.templates.findIndex((t) => t.name === select)
    setCursor(at >= 0 ? at : Math.max(0, Math.min(cursor, next.templates.length - 1)))
    return at >= 0 ? next.templates[at] : undefined
  }

  const create = (raw: string) => {
    const wanted = raw.trim()
    if (wanted === '') {
      setStage('list')
      return
    }
    try {
      createTemplate(locale, wanted)
      const created = reload(wanted)
      setError(undefined)
      setName('')
      // Straight into the editor: a template is created to be rewritten, and
      // the starter is only somewhere to begin. Esc leaves it as the starter.
      if (created) {
        setDraft(created.text)
        setNotice(`Created ${wanted} from a starter.`)
        setStage('edit')
      } else {
        setNotice(`Created ${wanted}.`)
        setStage('list')
      }
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const startEdit = () => {
    if (!current) return
    setDraft(current.text)
    setNotice(undefined)
    setError(undefined)
    setStage('edit')
  }

  const save = () => {
    if (!current) return
    try {
      saveTemplate(locale, current.name, draft)
      reload(current.name)
      setNotice(`Saved ${current.name}.`)
      setError(undefined)
      setStage('list')
    } catch (err) {
      // Stay in the editor: leaving would lose the text that failed to save.
      setError(errorMessage(err))
      setStage('edit')
    }
  }

  const changed = current !== undefined && draft !== current.text
  // The draft keeps the last text edited after the editor closes, so it counts
  // only while the editor holds it, or while the save question is up.
  useReportUnsaved((stage === 'edit' && changed) || stage === 'unsaved')

  const remove = () => {
    if (!current) return
    try {
      deleteTemplate(locale, current.name)
      setNotice(`Deleted ${current.name}.`)
      setError(undefined)
    } catch (err) {
      setError(errorMessage(err))
    }
    reload()
    setStage('list')
  }

  // q leaves only from the list: while a name is typed it is a letter.
  useBackKeys(
    stage === 'name'
      ? () => {
          setName('')
          setError(undefined)
          setStage('list')
        }
      : onBack,
    { enabled: stage === 'list' || stage === 'name', allowQ: listing },
  )
  useKeys({
    replyTemplates: {
      move: listing && templates.length > 1 ? (_input, key) => setCursor((c) => (key.upArrow ? Math.max(0, c - 1) : Math.min(templates.length - 1, c + 1))) : undefined,
      edit: listing && current ? startEdit : undefined,
      create: listing
        ? () => {
            setNotice(undefined)
            setError(undefined)
            setStage('name')
          }
        : undefined,
      remove: listing && current ? () => setStage('delete') : undefined,
      preview: listing && current ? () => setWithProblems((v) => !v) : undefined,
    },
    templateEditor: {
      save: stage === 'edit' ? save : undefined,
      close: stage === 'edit' ? () => (changed ? setStage('unsaved') : setStage('list')) : undefined,
    },
    templateUnsaved: {
      save: stage === 'unsaved' ? save : undefined,
      discard: stage === 'unsaved' ? () => setStage('list') : undefined,
      keep: stage === 'unsaved' ? () => setStage('edit') : undefined,
    },
    templateDelete: {
      yes: stage === 'delete' ? remove : undefined,
      no: stage === 'delete' ? () => setStage('list') : undefined,
    },
  })

  if ((stage === 'edit' || stage === 'unsaved') && current) {
    return (
      <Box flexDirection="column">
        <Text {...TOKENS.heading.ink}>
          Editing {current.name} · {label}
        </Text>
        <Text {...TOKENS.muted.ink} wrap="wrap">
          {'{username}'} is the requester, {'{results}'} the message for them, and {'{no problems|some problems}'} takes
          its first text when the review found nothing.
        </Text>
        <Text> </Text>
        <Box borderStyle="round" paddingX={1}>
          {/* Unfocused while the question is up, so its y and n are not typed. */}
          <TextArea
            value={draft}
            onChange={(text) => {
              setDraft(text)
              setNotice(undefined)
            }}
            onClear={() => setNotice('Cleared. Nothing is saved until ctrl+s; esc then n brings the saved text back.')}
            focus={stage === 'edit'}
            viewportLines={12}
          />
        </Box>
        {notice && <Text {...TOKENS.muted.ink}>{notice}</Text>}
        {stage === 'unsaved' && <Text {...TOKENS.warn.ink}>Save the changes to {current.name}? y save · n discard · esc keep editing</Text>}
        {error && <Text {...TOKENS.error.ink}>{error}</Text>}
        <Hint>{stage === 'edit' ? 'enter new line · ctrl+x clear · ctrl+s save · ctrl+z undo · esc close' : 'y save · n discard · esc keep editing'}</Hint>
      </Box>
    )
  }

  const preview =
    current === undefined
      ? undefined
      : fillTemplate(current.text, {
          username: SAMPLE_REQUESTER,
          repaired: withProblems ? 3 : 0,
          flagged: 0,
          results: withProblems ? SAMPLE_RESULTS : '',
        })

  return (
    <Box flexDirection="column">
      <Text {...TOKENS.heading.ink}>Reply templates · {label}</Text>
      <Text {...TOKENS.muted.ink} wrap="wrap">
        The comment you post back on a PTE request, filled in after every review. Each choice like{' '}
        {'{no problems|some problems}'} takes its first text when the review found nothing.
      </Text>
      <Text> </Text>
      {loaded.error && <Text {...TOKENS.error.ink}>Could not read the templates: {loaded.error}</Text>}
      {templates.length === 0 ? (
        <Text>No reply templates for {label} yet. Press n to create one from a starter.</Text>
      ) : (
        templates.map((t, i) => (
          <Text key={t.name}>
            {t === current ? '❯ ' : '  '}
            {t.name}
          </Text>
        ))
      )}
      {stage === 'name' && (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text>New template name: </Text>
            <TextInput value={name} onChange={setName} onSubmit={create} />
          </Box>
          <Text {...TOKENS.muted.ink}>approved and declined have their own starters; any other name starts from the approved text.</Text>
        </Box>
      )}
      {stage === 'delete' && current && (
        <Box marginTop={1}>
          <Text {...TOKENS.warn.ink}>Delete the {current.name} reply template? y delete · n keep</Text>
        </Box>
      )}
      {notice && <Text {...TOKENS.success.ink}>{notice}</Text>}
      {error && <Text {...TOKENS.error.ink}>{error}</Text>}
      {preview !== undefined && current && (
        <Box flexDirection="column" marginTop={1}>
          <Text {...TOKENS.muted.ink}>
            Preview · {current.name} · {withProblems ? 'with problems' : 'clean'} · v for {withProblems ? 'clean' : 'with problems'}
          </Text>
          {/* Unwrapped by us and unstyled, as the reply is on the results
              screen: what shows here is what the review will produce. */}
          <Text>{preview}</Text>
        </Box>
      )}
      <Hint>{listing ? 'e edit · n new · d delete · v preview · esc back to menu' : stage === 'name' ? 'enter to create · esc cancel' : 'y delete · n keep'}</Hint>
    </Box>
  )
}
