import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import type { AgentStatus } from '../../agent/discover.js'
import type { ModelServer } from '../../draft/discover.js'
import { agentModel, codexHint } from '../../agent/providers.js'
import { configuredLocale, DEFAULT_CONFIG } from '../../config.js'
import { TOKENS } from '../../ui/tokens.js'
import { errorMessage, useCommands, useConfig } from '../commands.js'
import { LocaleSearch } from '../components/LocaleSearch.js'
import { useKeys } from '../hooks/useKeys.js'
import { useTmListing } from '../hooks/useTmListing.js'
import { DRAFT_ENGINES, REVIEW_PROVIDERS, type DraftEngineOption, type ProviderOption } from '../providers.js'
import { STEP_LABELS, type SetupStatus } from '../setup.js'
import { markAsked, pushRecent, recordStep, SETUP_STEPS, type SetupStep, type TuiState } from '../state.js'
import { useGlyphs } from '../theme.js'
import { ConfigureKeys } from './ConfigureKeys.js'
import { TmFetch } from './ImportTm.js'
import { LocaleRules } from './LocaleRules.js'
import { LocalModels } from './LocalModels.js'
import { SyncGlossary } from './SyncGlossary.js'

// The setup wizard: six steps, each skippable, resumable because where it
// stands is derived from the same facts as the header's x/6 rather than from
// a page number. Four steps are the existing screens, embedded: their own
// "back" is the wizard's "next", so a glossary sync, a memory fetch or a
// rules edit behaves here exactly as it does from the menu.

// The wizard's own steps: the six setup steps, then one question that is not
// part of setup. Kept out of SETUP_STEPS on purpose. Those are counted in the
// header's x/6 and reopen the wizard while missing; counting the usage
// question there would make "no answer yet" read as unfinished setup and
// press the person to answer, which is the opposite of asking neutrally.
type WizardStep = SetupStep | 'usage'

// Worded as issue #19 agreed, and answered No by default: No is listed first,
// so enter alone, the key that moves a wizard on, keeps it off.
export const USAGE_QUESTION =
  'Share anonymous totals (strings reviewed, number of projects) to show on the website? You can change this any time.'

const USAGE_ANSWERS = [
  { id: 'no', label: 'No', cost: 'Nothing is sent.' },
  {
    id: 'yes',
    label: 'Yes',
    cost: 'Counts only, at most once a week; never locale, project names, files, strings or your username. polyglots usage-stats show prints it.',
  },
] as const

const TITLES: Record<WizardStep, string> = {
  locale: 'Locale',
  provider: 'Review provider',
  keys: 'Draft engine and API keys',
  glossary: 'Glossary sync',
  memory: 'Translation memory',
  rules: 'Locale rules',
  usage: 'Usage statistics',
}

export interface WizardProps {
  start: SetupStep
  // The steps to walk, in order. All of setup by default; a change of locale
  // passes the locale's own, and that walk is a detour rather than setup, so
  // its end neither asks the usage question nor marks the wizard dismissed.
  steps?: readonly SetupStep[]
  status: SetupStatus
  agents?: AgentStatus[]
  // Records a step as chosen or skipped in tui.json. The app owns the file.
  onRecord: (patch: (state: TuiState) => TuiState) => void
  // After each step, so the header's count catches up with a glossary
  // synced or a key saved inside the wizard.
  onAdvance?: () => void
  onDone: () => void
}

function Choice<T extends { id: string; label: string; cost: string }>({ options, at }: { options: readonly T[]; at: number }) {
  const glyphs = useGlyphs()
  return (
    <Box flexDirection="column">
      {options.map((o, i) => (
        <Box key={o.id} flexDirection="column">
          <Text>
            <Text {...TOKENS.accent.ink}>{i === at ? glyphs.next : ' '}</Text> <Text bold={i === at}>{o.label}</Text>
          </Text>
          <Text {...TOKENS.muted.ink}>
            {'    '}
            {o.cost}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

// Moved to the shared search, which the locale picker uses too; re-exported so
// what imported it from here keeps working.
export { matchLocales } from '../components/LocaleSearch.js'

function LocaleStep({ onChosen, onSkip }: { onChosen: (id: string, previous: string | undefined) => void; onSkip: () => void }) {
  const commands = useCommands()
  // The configured locale when there is one, so re-running setup starts from
  // it. Otherwise empty: this used to open on tr, and enter, the key that
  // moves a wizard on, quietly made a stranger a Turkish translator.
  const [initial] = useState(() => {
    try {
      return commands.loadConfig().defaultLocale ?? ''
    } catch {
      return ''
    }
  })
  const [error, setError] = useState<string>()
  // The arrows are the search list's own; enter is its field's submit.
  useKeys({ wizard: { skip: onSkip, move: undefined, choose: undefined } })
  const pick = (id: string) => {
    // Read before the save below replaces it, so the walk can keep it in the
    // recent list as the picker does.
    let previous: string | undefined
    try {
      previous = configuredLocale(commands.loadConfig())
    } catch {
      previous = undefined
    }
    try {
      commands.saveConfig({ defaultLocale: id })
      onChosen(id, previous)
    } catch (err) {
      setError(errorMessage(err))
    }
  }
  return (
    <Box flexDirection="column">
      <Text>The locale you translate into, as translate.wordpress.org names it.</Text>
      <LocaleSearch initial={initial} onPick={pick} {...(error === undefined ? {} : { error })} />
    </Box>
  )
}

/** The providers worth offering: agents discovery found usable, the local reviewer when a server answers, and no AI once both have been asked. */
export function offeredProviders(agents: AgentStatus[] | undefined, servers: ModelServer[] | undefined): ProviderOption[] {
  return REVIEW_PROVIDERS.filter((p) =>
    // Only once discovery has answered both questions. Offered earlier, it
    // would be the only row on screen while discovery runs, and an impatient
    // enter would turn a person with a working agent into a rules-only one.
    p.needs === 'nothing'
      ? agents !== undefined && servers !== undefined
      : p.needs === 'agent'
        ? (agents ?? []).some((a) => a.provider === p.id && a.usable)
        : (servers ?? []).some((s) => s.state === 'up'),
  )
}

function useServers(): ModelServer[] | undefined {
  const commands = useCommands()
  const [servers, setServers] = useState<ModelServer[] | undefined>(undefined)
  useEffect(() => {
    let wanted = true
    commands.discoverModels().then(
      (s) => wanted && setServers(s),
      () => wanted && setServers([]),
    )
    return () => {
      wanted = false
    }
  }, [commands])
  return servers
}

function PickStep<T extends { id: string; label: string; cost: string }>({
  intro,
  options,
  waiting,
  empty,
  onPick,
  onSkip,
}: {
  intro: string
  options: readonly T[]
  waiting: boolean
  empty: string
  onPick: (option: T) => void
  onSkip: () => void
}) {
  const [at, setAt] = useState(0)
  useKeys({
    wizard: {
      skip: onSkip,
      move: (_input, key) => (key.upArrow ? setAt((a) => Math.max(0, a - 1)) : setAt((a) => Math.min(options.length - 1, a + 1))),
      choose: () => options[at] && onPick(options[at]),
    },
  })
  return (
    <Box flexDirection="column">
      <Text>{intro}</Text>
      <Text> </Text>
      {options.length > 0 ? <Choice options={options} at={Math.min(at, options.length - 1)} /> : null}
      {waiting && <Text {...TOKENS.muted.ink}>Looking for what is installed…</Text>}
      {!waiting && options.length === 0 && <Text {...TOKENS.warn.ink}>{empty}</Text>}
    </Box>
  )
}

export const OFFLINE_NOTE = 'Could not reach polyglots-data; skipped.'

// The memory step reads the manifest itself, in the background: the step is
// drawn at once with a line saying so, and esc skips it while it waits. A
// locale the vault does not have, or no locale at all, has nothing to offer
// and moves straight on; offline, the step is skipped with a note, since
// there is nothing to offer then either and the person should not have to
// press a key to learn that.
function MemoryStep({
  onSkip,
  onUnlisted,
  onOffline,
  onDone,
}: {
  onSkip: () => void
  onUnlisted: () => void
  onOffline: () => void
  onDone: (outcome: 'imported' | 'failed') => void
}) {
  const { config } = useConfig()
  const locale = configuredLocale(config)
  const listing = useTmListing(locale)
  useEffect(() => {
    if (listing.status === 'unlisted') onUnlisted()
    else if (listing.status === 'offline') onOffline()
  }, [listing.status])
  if (listing.status === 'listed' && locale !== undefined) {
    return (
      <Box flexDirection="column">
        <Text>The locale's published memory from polyglots-data, so drafts and reviews have its wordings from the start.</Text>
        <Text> </Text>
        <TmFetch locale={locale} client={listing.client} onBack={onSkip} onDone={onDone} doneHint="enter next step" />
      </Box>
    )
  }
  return <MemoryWait onSkip={onSkip} />
}

function MemoryWait({ onSkip }: { onSkip: () => void }) {
  useKeys({ wizard: { skip: onSkip, move: undefined, choose: undefined } })
  return <Text {...TOKENS.muted.ink}>Checking polyglots-data…</Text>
}

export function Wizard({ start, steps, status, agents, onRecord, onAdvance, onDone }: WizardProps) {
  const commands = useCommands()
  const [step, setStep] = useState<WizardStep>(start)
  // Inside the keys step: once an engine is picked, its own screen follows.
  const [engine, setEngine] = useState<DraftEngineOption['id'] | undefined>(undefined)
  const [error, setError] = useState<string>()
  // A line about the step just left, shown on the next one: the memory step
  // skips itself offline, and moving on without a word would look like a
  // step that was never there.
  const [note, setNote] = useState<string>()
  const servers = useServers()
  const walk = steps ?? SETUP_STEPS
  const index = step === 'usage' ? walk.length : walk.indexOf(step)
  // Asked once: an answer either way, from here or from the CLI, means the
  // question is not put again. Configuration › Usage statistics changes it.
  const unanswered = () => {
    try {
      return commands.loadConfig().usageStats === undefined
    } catch {
      return false
    }
  }

  const advance = () => {
    onAdvance?.()
    setEngine(undefined)
    setError(undefined)
    setNote(undefined)
    const next = step === 'usage' ? undefined : (walk[index + 1] ?? (steps === undefined && unanswered() ? 'usage' : undefined))
    if (next) setStep(next)
    else {
      // Reaching the end, by finishing or by skipping, is what stops the
      // wizard opening at launch. It stays one key away in Configuration.
      if (steps === undefined) onRecord((s) => ({ ...s, wizard: { ...s.wizard, dismissed: true } }))
      onDone()
    }
  }
  const record = (kind: 'confirmed' | 'skipped') => {
    // The answer to the usage question lives in config.json, not in tui.json.
    if (step === 'usage') return
    // Read now, not from the render: the locale step saves the locale just
    // before it records, and a stale one would file the answer under none.
    let locale: string | undefined
    try {
      locale = configuredLocale(commands.loadConfig())
    } catch {
      locale = undefined
    }
    onRecord((s) => recordStep(s, locale, kind, step))
  }
  const skip = () => {
    record('skipped')
    advance()
  }
  const save = (patch: Parameters<typeof commands.saveConfig>[0]): boolean => {
    try {
      commands.saveConfig(patch)
      return true
    } catch (err) {
      setError(errorMessage(err))
      return false
    }
  }

  let body
  if (step === 'locale') {
    body = (
      <LocaleStep
        onChosen={(id, previous) => {
          // Asked as well: the locale chosen here is being set up right now,
          // and offering its setup again on a later switch back to it would
          // ask what this walk is already answering. The locale replaced goes
          // in under it, as the picker puts it, so the way back is one key.
          onRecord((s) => {
            const left = previous === undefined || previous === id ? s.recentLocales : pushRecent(s.recentLocales, previous)
            return markAsked({ ...s, recentLocales: pushRecent(left, id) }, id)
          })
          record('confirmed')
          advance()
        }}
        onSkip={skip}
      />
    )
  } else if (step === 'provider') {
    body = (
      <PickStep
        intro="Who reviews submissions. Only what is installed and signed in is listed."
        options={offeredProviders(agents, servers)}
        waiting={agents === undefined || servers === undefined}
        empty="No review agent is ready. Check AI agents in Configuration says what each one is missing."
        onPick={(p) => {
          if (!save({ reviewProvider: p.id })) return
          record('confirmed')
          advance()
          // After advance, which clears the note: the hint is about the
          // choice just made and belongs on the step that follows it.
          if (p.id === 'codex') {
            let config = DEFAULT_CONFIG
            try {
              config = commands.loadConfig()
            } catch {
              // An unreadable config still gets the hint, from codex's own settings.
            }
            setNote(codexHint(agentModel('codex', config)))
          }
        }}
        onSkip={skip}
      />
    )
  } else if (step === 'keys') {
    if (engine === 'deepl' || engine === 'openai') body = <ConfigureKeys onBack={advance} />
    else if (engine === 'local') body = <LocalModels onBack={advance} />
    else {
      const up = (servers ?? []).some((s) => s.state === 'up')
      body = (
        <PickStep
          intro="Which engine writes machine drafts when the memory has no match. Optional: esc skips it."
          options={DRAFT_ENGINES.filter((e) => e.id !== 'local' || up)}
          waiting={servers === undefined}
          empty=""
          onPick={(e) => {
            if (!save({ defaultDraftEngine: e.id })) return
            record('confirmed')
            // Nothing to configure for no engine: no key, no server.
            if (e.id === 'none') advance()
            else setEngine(e.id)
          }}
          onSkip={skip}
        />
      )
    }
  } else if (step === 'glossary') {
    body = <SyncGlossary onBack={advance} />
  } else if (step === 'memory') {
    body = (
      <MemoryStep
        onSkip={skip}
        onUnlisted={advance}
        onOffline={() => {
          // In the full wizard an offline step is skipped as esc would skip
          // it. The walk a change of locale offers passes this step whether
          // or not the memory was missing, and a lasting skip there would
          // stop the memory ever being offered for the locale over one
          // dropped connection; it moves on and records nothing, as a failed
          // fetch does.
          if (steps === undefined) skip()
          else advance()
          setNote(OFFLINE_NOTE)
        }}
        onDone={(outcome) => {
          // A failed fetch moves on but records nothing: the step stays open,
          // so the header still shows the memory missing and the next launch
          // offers it again, where a skip would have said not to.
          if (outcome === 'imported') record('confirmed')
          advance()
        }}
      />
    )
  } else if (step === 'usage') {
    // esc is the default answer, said out loud: leaving the question
    // unanswered would ask it again at the next walk through the wizard.
    body = (
      <PickStep
        intro={USAGE_QUESTION}
        options={USAGE_ANSWERS}
        waiting={false}
        empty=""
        onPick={(a) => {
          if (!save({ usageStats: a.id === 'yes' })) return
          advance()
        }}
        onSkip={() => {
          if (!save({ usageStats: false })) return
          advance()
        }}
      />
    )
  } else {
    body = <LocaleRules onBack={advance} />
  }

  return (
    <Box flexDirection="column">
      {step === 'usage' ? (
        <Text>
          <Text {...TOKENS.heading.ink}>Setup</Text> <Text {...TOKENS.muted.ink}>·</Text> One last question{' '}
          <Text {...TOKENS.muted.ink}>·</Text> <Text bold>{TITLES[step]}</Text>
        </Text>
      ) : (
        <Text>
          <Text {...TOKENS.heading.ink}>Setup</Text> <Text {...TOKENS.muted.ink}>·</Text> Step {index + 1} of {walk.length}{' '}
          <Text {...TOKENS.muted.ink}>·</Text> <Text bold>{TITLES[step]}</Text>
          {'  '}
          <Text {...TOKENS.muted.ink}>
            ({STEP_LABELS[step]} {status.steps[step] === 'done' ? 'is done' : 'needs doing'})
          </Text>
        </Text>
      )}
      <Text {...TOKENS.muted.ink}>esc skips a step · the wizard stays under Configuration › Setup wizard</Text>
      {note && <Text {...TOKENS.warn.ink}>{note}</Text>}
      <Text> </Text>
      {body}
      {error && <Text {...TOKENS.error.ink}>Could not save that: {error}</Text>}
    </Box>
  )
}
