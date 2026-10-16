import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import type { AgentStatus } from '../../agent/discover.js'
import type { ModelServer } from '../../draft/discover.js'
import { configuredLocale } from '../../config.js'
import { TOKENS } from '../../ui/tokens.js'
import { WPORG_LOCALES, localeId } from '../../wporg/locales.js'
import { errorMessage, useCommands, useConfig } from '../commands.js'
import { useKeys } from '../hooks/useKeys.js'
import { useTmListing } from '../hooks/useTmListing.js'
import { TextInput } from '../input.js'
import { DRAFT_ENGINES, REVIEW_PROVIDERS, type DraftEngineOption, type ProviderOption } from '../providers.js'
import { STEP_LABELS, type SetupStatus } from '../setup.js'
import { SETUP_STEPS, type SetupStep, type TuiState } from '../state.js'
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

/** The locales that match what has been typed: by WordPress code, slug, or slug/set. */
export function matchLocales(query: string, limit = 8): Array<{ id: string; wp: string }> {
  const q = query.trim().toLowerCase().replace(/-/g, '_')
  const all = WPORG_LOCALES.map((l) => ({ id: localeId(l.slug, l.set), wp: l.wp }))
  if (q === '') return all.slice(0, limit)
  const exact = all.filter((l) => l.id === query.trim().toLowerCase() || l.wp.toLowerCase() === q)
  const starts = all.filter((l) => !exact.includes(l) && (l.wp.toLowerCase().startsWith(q) || l.id.startsWith(query.trim().toLowerCase())))
  const contains = all.filter((l) => !exact.includes(l) && !starts.includes(l) && (l.wp.toLowerCase().includes(q) || l.id.includes(q)))
  return [...exact, ...starts, ...contains].slice(0, limit)
}

function LocaleStep({ onChosen, onSkip }: { onChosen: (id: string) => void; onSkip: () => void }) {
  const commands = useCommands()
  const glyphs = useGlyphs()
  // The configured locale when there is one, so re-running setup starts from
  // it. Otherwise empty: this used to open on tr, and enter, the key that
  // moves a wizard on, quietly made a stranger a Turkish translator.
  const [query, setQuery] = useState(() => {
    try {
      return commands.loadConfig().defaultLocale ?? ''
    } catch {
      return ''
    }
  })
  const [at, setAt] = useState(0)
  const [error, setError] = useState<string>()
  // Nothing listed, and so nothing to choose, until something is typed: an
  // unfiltered list would put a cursor on whichever locale sorts first.
  const matches = query.trim() === '' ? [] : matchLocales(query)
  const chosen = Math.min(at, Math.max(0, matches.length - 1))
  // Enter is the search field's own submit.
  useKeys({
    wizard: {
      skip: onSkip,
      move: (_input, key) => (key.upArrow ? setAt(Math.max(0, chosen - 1)) : setAt(Math.min(matches.length - 1, chosen + 1))),
      choose: undefined,
    },
  })
  const submit = () => {
    const pick = matches[chosen]
    if (!pick) return
    try {
      commands.saveConfig({ defaultLocale: pick.id })
      onChosen(pick.id)
    } catch (err) {
      setError(errorMessage(err))
    }
  }
  return (
    <Box flexDirection="column">
      <Text>The locale you translate into, as translate.wordpress.org names it.</Text>
      <Box>
        <Text>Search: </Text>
        <TextInput
          value={query}
          onChange={(v) => {
            setQuery(v)
            setAt(0)
          }}
          onSubmit={submit}
        />
      </Box>
      {matches.map((m, i) => (
        <Text key={m.id}>
          <Text {...TOKENS.accent.ink}>{i === chosen ? glyphs.next : ' '}</Text> <Text bold={i === chosen}>{m.id}</Text>{' '}
          <Text {...TOKENS.muted.ink}>{m.wp}</Text>
        </Text>
      ))}
      {query.trim() === '' ? (
        <Text {...TOKENS.muted.ink}>Type the locale's code: de, pt_BR, nl_NL_formal, es_ES…</Text>
      ) : (
        matches.length === 0 && <Text {...TOKENS.warn.ink}>translate.wordpress.org lists no locale like that.</Text>
      )}
      {error && <Text {...TOKENS.error.ink}>Could not save that: {error}</Text>}
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
function MemoryStep({ onSkip, onUnlisted, onOffline, onDone }: { onSkip: () => void; onUnlisted: () => void; onOffline: () => void; onDone: () => void }) {
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

export function Wizard({ start, status, agents, onRecord, onAdvance, onDone }: WizardProps) {
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
  const index = step === 'usage' ? SETUP_STEPS.length : SETUP_STEPS.indexOf(step)
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
    const next = step === 'usage' ? undefined : (SETUP_STEPS[index + 1] ?? (unanswered() ? 'usage' : undefined))
    if (next) setStep(next)
    else {
      // Reaching the end, by finishing or by skipping, is what stops the
      // wizard opening at launch. It stays one key away in Configuration.
      onRecord((s) => ({ ...s, wizard: { ...s.wizard, dismissed: true } }))
      onDone()
    }
  }
  const record = (kind: 'confirmed' | 'skipped') => {
    // The answer to the usage question lives in config.json, not in tui.json.
    if (step === 'usage') return
    onRecord((s) => ({
      ...s,
      wizard: {
        ...s.wizard,
        [kind]: [...s.wizard[kind].filter((x) => x !== step), step],
        // A step chosen after being skipped is no longer skipped, and the
        // other way round: the latest answer is the one that counts.
        [kind === 'confirmed' ? 'skipped' : 'confirmed']: s.wizard[kind === 'confirmed' ? 'skipped' : 'confirmed'].filter((x) => x !== step),
      },
    }))
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
        onChosen={() => {
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
          skip()
          setNote(OFFLINE_NOTE)
        }}
        onDone={() => {
          record('confirmed')
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
          <Text {...TOKENS.heading.ink}>Setup</Text> <Text {...TOKENS.muted.ink}>·</Text> Step {index + 1} of {SETUP_STEPS.length}{' '}
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
