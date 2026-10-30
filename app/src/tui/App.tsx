import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp } from 'ink'
import { CommandsProvider, defaultCommands, errorMessage, useCommands, type TuiCommands } from './commands.js'
import type { AgentStatus } from '../agent/discover.js'
import { DEFAULT_CONFIG, configuredLocale } from '../config.js'
import { DEFAULT_PROVIDER } from '../agent/providers.js'
import type { Locale, PolyglotsConfig, ReviewChoice, Secrets } from '../types.js'
import { TOKENS } from '../ui/tokens.js'
import { Footer, Header } from './components/Chrome.js'
import { LocalePicker } from './components/LocalePicker.js'
import { LocaleSetupPrompt } from './components/LocaleSetupPrompt.js'
import { HelpOverlay, Palette, QuitPrompt } from './components/Overlays.js'
import { Viewport, type PageBy } from './components/Viewport.js'
import { FooterStageProvider } from './footer-stage.js'
import { ActivityProvider, createActivity, useBusy, type Activity } from './hooks/activity.js'
import { useGlobalKeys } from './hooks/useKeys.js'
import { InputGate, TypingProvider, useTyping, type Key } from './input.js'
import { footerKeys } from './keys.js'
import { CONFIGURATION, HOME, parentOf, TOOLS, type ScreenId } from './menu.js'
import { providerLabel } from './local.js'
import { createProviderCheckCache, providerCheckKey, providerNote, ProviderCheckProvider, withSignIn } from './provider-check.js'
import { hasProviderCheck, providerOf, type CheckedProvider, type ProviderCheck } from '../agent/agy-check.js'
import { createServices, ServicesProvider, useServices, useStatsError, useStatsUrl, type Services } from './services.js'
import { memoryState, missingLocaleSteps, setupStatus, tmListed, type SetupStatus } from './setup.js'
import { frameLayout, frameSize, MIN_SIZE, SizeProvider, useSize } from './size.js'
import { LOCALE_STEPS, localeWizard, markAsked, migrateTuiState, pushRecent, SETUP_STEPS, type SetupStep, type TuiState } from './state.js'
import { UnsavedContext } from './unsaved.js'
import { Agents } from './screens/Agents.js'
import { ConfigureKeys } from './screens/ConfigureKeys.js'
import { Fetch } from './screens/Fetch.js'
import { ExportTm } from './screens/ExportTm.js'
import { Home, Submenu } from './screens/Home.js'
import { ImportTm } from './screens/ImportTm.js'
import { About, Help, Interface } from './screens/Info.js'
import { LocaleRules } from './screens/LocaleRules.js'
import { ReplyTemplates } from './screens/ReplyTemplates.js'
import { LocalModels } from './screens/LocalModels.js'
import { Review } from './screens/Review.js'
import { Split } from './screens/Split.js'
import { Stats } from './screens/Stats.js'
import { SyncGlossary } from './screens/SyncGlossary.js'
import { EditGlossary } from './screens/EditGlossary.js'
import { Translate } from './screens/Translate.js'
import { UsageStats } from './screens/UsageStats.js'
import { Wizard } from './screens/Wizard.js'
import { laterVersion, WHATS_NEW, whatsNewFor } from './whats-new.js'
import { VERSION } from '../version.js'

export interface AppProps {
  commands?: TuiCommands
  cwd?: string
  activity?: Activity
  services?: Services
  onExit?: () => void
  // The update check main() started; the header names a newer version once
  // it answers.
  update?: Promise<string | undefined>
  // The running version and its "What's new" lines; tests pass their own.
  version?: string
  whatsNew?: Readonly<Record<string, readonly string[]>>
}

type Overlay = 'help' | 'palette' | 'quit' | 'locale' | 'locale-setup'

// Why the locale picker refuses a pick. Nothing past the refusal is promised:
// the job may be stopped or finish, and either frees the picker. "Job", not
// "run": a glossary sync, a memory import or a rules fetch holds it too.
const LOCALE_BUSY = 'The locale changes after the current job ends.'
const LOCALE_UNSAVED = 'Save or discard the changes first.'

function tryOr<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/**
 * Wraps the commands whose result is a file worth naming after the app has
 * closed. Done here rather than in each screen because the screens already
 * show the result; all this adds is a note of it, and every way into a run
 * goes through these four.
 */
function recordOutputs(commands: TuiCommands, services: Services): TuiCommands {
  return {
    ...commands,
    translateFile: async (opts) => {
      const summary = await commands.translateFile(opts)
      services.lastOutput = summary.file
      return summary
    },
    reviewFile: async (opts) => {
      const summary = await commands.reviewFile(opts)
      services.lastOutput = summary.problemsFile ?? summary.file
      return summary
    },
    fetchProjects: async (ready, opts) => {
      const fetched = await commands.fetchProjects(ready, opts)
      if (fetched.some((f) => f.state === 'fetched')) services.lastOutput = opts.outDir
      return fetched
    },
    writeStats: async (opts) => {
      const summary = await commands.writeStats(opts)
      services.lastOutput = summary.file
      return summary
    },
  }
}

// No error boundary of our own: Ink 7 wraps the tree in one that exits with
// the error, which unmounts and leaves the alternate screen, and runTui
// rethrows once the normal screen is back, where the trace can be read.
export function App(props: AppProps) {
  const [ownActivity] = useState(createActivity)
  const [ownServices] = useState(createServices)
  const activity = props.activity ?? ownActivity
  const services = props.services ?? ownServices
  const base = props.commands ?? defaultCommands
  const commands = useMemo(() => recordOutputs(base, services), [base, services])
  return (
    <SizeProvider>
      <TypingProvider>
        <ActivityProvider value={activity}>
          <ServicesProvider value={services}>
            <CommandsProvider value={commands}>
              <Shell {...props} />
            </CommandsProvider>
          </ServicesProvider>
        </ActivityProvider>
      </TypingProvider>
    </SizeProvider>
  )
}

function Shell({ cwd = process.cwd(), onExit, update, version = VERSION, whatsNew = WHATS_NEW }: AppProps) {
  // The wrapped commands, so a run started from here is recorded for the
  // exit line: read through the context the App just provided, not the prop.
  const commands = useCommands()
  const { exit } = useApp()
  const terminal = useSize()
  const size = frameSize(terminal)
  const layout = frameLayout(size)
  const typing = useTyping()
  const busy = useBusy()
  const services = useServices()
  const [latest, setLatest] = useState<string | undefined>()
  useEffect(() => {
    let live = true
    update?.then((v) => live && setLatest(v), () => undefined)
    return () => {
      live = false
    }
  }, [update])
  const statsUrl = useStatsUrl()
  const statsError = useStatsError()

  const [tuiState, setTuiState] = useState<TuiState>(() => {
    const loaded = commands.loadTuiState()
    // A file written before the wizard kept answers per locale holds them in
    // the global lists. Moved once, at launch, into the locale configured now.
    const migrated = migrateTuiState(loaded, configuredLocale(tryOr(() => commands.loadConfig(), DEFAULT_CONFIG)))
    if (migrated !== loaded) {
      try {
        commands.saveTuiState(migrated)
      } catch {
        // As in record: the in-memory state still moves on.
      }
    }
    return migrated
  })
  // The locale the app works in, held here so the header, the screen's key and
  // the picker agree. Changed by the picker, and re-read after the wizard,
  // whose locale step is the other place that writes it.
  const [locale, setLocale] = useState<string | undefined>(() => configuredLocale(tryOr(() => commands.loadConfig(), DEFAULT_CONFIG)))
  const syncLocale = () => setLocale(configuredLocale(tryOr(() => commands.loadConfig(), DEFAULT_CONFIG)))
  // Set by a screen holding edits it has not written (src/tui/unsaved.ts).
  const unsaved = useRef(false)
  // Worked out once, from the state as launched: recording the version moves
  // tuiState on, and the block stays for the session rather than vanishing the
  // moment it is first drawn.
  const [news] = useState(() => whatsNewFor(tuiState.whatsNew.seen, version, whatsNew))
  const newsRecorded = useRef(false)
  // Re-read whenever a screen is left, since most of what setup counts is
  // changed by screens: a synced glossary, a saved key, a rules file.
  const [setupEpoch, setSetupEpoch] = useState(0)

  // Held here rather than read by home, so home stays a screen that can be
  // rendered without touching the user's config, and so the injected
  // commands are what a test drives.
  const [provider, setProvider] = useState<ReviewChoice>(() => tryOr(() => commands.loadConfig().reviewProvider, DEFAULT_PROVIDER))
  const [configured] = useState(provider)
  const [providerError, setProviderError] = useState<string | undefined>(undefined)
  // Discovery is held here, not in home or the agents screen, so a re-check
  // on one is what the other shows. It never blocks: home renders at once
  // and treats "not known yet" as "every provider is a candidate".
  const [discovered, setAgents] = useState<AgentStatus[] | undefined>(undefined)
  const [checking, setChecking] = useState(true)
  const [agentsError, setAgentsError] = useState<string | undefined>(undefined)
  const check = (refresh: boolean) => {
    setChecking(true)
    let wanted = true
    commands
      .discoverAgents(refresh ? { refresh: true } : undefined)
      .then(
        (result) => {
          if (!wanted) return
          setAgents(result)
          setAgentsError(undefined)
        },
        // A failed discovery falls back to home as it was before discovery
        // existed. Clearing the last answer would be wrong: it was true when
        // read, and a failed re-check does not make it less so.
        (err: unknown) => wanted && setAgentsError(errorMessage(err)),
      )
      .finally(() => wanted && setChecking(false))
    return () => {
      wanted = false
    }
  }
  // With No AI chosen nothing will run an agent, so launch does not spawn
  // each agent CLI to ask whether it is signed in (doctor skips it too).
  // Setup asks when opened, since that is where someone switches to one.
  const skippedDiscovery = useRef(false)
  useEffect(() => {
    if (tryOr(() => commands.loadConfig(), DEFAULT_CONFIG).reviewProvider === 'none') {
      skippedDiscovery.current = true
      setChecking(false)
      return
    }
    return check(false)
  }, [])

  // The provider check: in the background, never holding home, and only
  // while antigravity or codex is the provider, at launch or when switched
  // to. Held here so the header names the answer and the run screens reuse
  // it, and so a check a run started shows on the header too. The latest
  // answer is kept per provider, so a switch back and forth does not drop
  // what the other one said about its own sign-in.
  const [providerCheck] = useState(() => createProviderCheckCache(() => commands.checkProvider()))
  const [accountChecks, setAccountChecks] = useState<Partial<Record<CheckedProvider, ProviderCheck>>>(() => {
    const kept = providerCheck.latest()
    return kept === undefined ? {} : { [providerOf(kept)]: kept }
  })
  useEffect(() => providerCheck.subscribe((check) => setAccountChecks((prev) => ({ ...prev, [providerOf(check)]: check }))), [providerCheck])
  const askProvider = () => {
    if (!hasProviderCheck(provider)) return
    const key = providerCheckKey(tryOr(() => commands.loadConfig(), DEFAULT_CONFIG))
    if (key !== undefined) void providerCheck.get(key)
  }
  useEffect(askProvider, [provider])
  // Discovery read agy's token file; the check asked the agent, so its
  // sign-in wins.
  const agents = useMemo(
    () => withSignIn(withSignIn(discovered, accountChecks.antigravity), accountChecks.codex),
    [discovered, accountChecks],
  )

  // Counted at launch and after the screens that can change it, not on
  // every navigation like the cheaper facts below: it opens polyglots.db.
  // With no locale there is no glossary to count, and the step reads as missing.
  const countGlossary = () => {
    const locale = configuredLocale(tryOr(() => commands.loadConfig(), DEFAULT_CONFIG))
    return locale === undefined ? undefined : tryOr(() => commands.glossaryCount(locale), undefined)
  }
  const [glossary, setGlossary] = useState<number | undefined>(countGlossary)
  const refreshGlossary = () => setGlossary(countGlossary())

  // The memory step, counted the same way: rows for the slug, read when the
  // glossary is. Rows answer it outright. Without them, whether polyglots-data
  // has a memory for the locale decides between nothing to offer (done) and
  // one to fetch (missing), and that is a network question, asked once per
  // locale in the background and only when nothing else has answered it, so
  // a launch never waits on it and an install with a memory never asks.
  const memoryLocaleNow = () => configuredLocale(tryOr(() => commands.loadConfig(), DEFAULT_CONFIG))
  const countMemory = () => {
    const locale = memoryLocaleNow()
    return locale === undefined ? undefined : tryOr(() => commands.memoryCount(locale), undefined)
  }
  const [memoryRows, setMemoryRows] = useState<number | undefined>(countMemory)
  const refreshMemory = () => setMemoryRows(countMemory())
  const memoryLocale = useMemo(memoryLocaleNow, [commands, setupEpoch])
  const [listing, setListing] = useState<{ locale: Locale; listed?: boolean }>()
  const asksManifest =
    memoryLocale !== undefined && !(memoryRows !== undefined && memoryRows > 0) && !localeWizard(tuiState, memoryLocale).skipped.includes('memory')
  useEffect(() => {
    if (!asksManifest || memoryLocale === undefined || listing?.locale === memoryLocale) return
    setListing({ locale: memoryLocale })
    // Kept only while it is still the locale asked about. A failure leaves
    // the answer unknown, which counts neither way and reopens nothing.
    commands.dataClient.manifest().then(
      (manifest) => setListing((prev) => (prev?.locale === memoryLocale ? { locale: memoryLocale, listed: tmListed(manifest, memoryLocale) } : prev)),
      () => undefined,
    )
  }, [asksManifest, memoryLocale])

  const status: SetupStatus = useMemo(() => {
    const config: PolyglotsConfig = tryOr(() => commands.loadConfig(), DEFAULT_CONFIG)
    const locale = configuredLocale(config)
    return setupStatus({
      config,
      secrets: tryOr<Secrets>(() => commands.loadSecrets(), {}),
      state: tuiState,
      ...(agents === undefined ? {} : { agents }),
      localeConfigured: tryOr(() => commands.localeConfigured(), false),
      ...(glossary === undefined ? {} : { glossaryCount: glossary }),
      hasLocaleRules: locale === undefined ? false : tryOr(() => commands.hasLocaleRules(locale), false),
      memory: locale === undefined ? 'missing' : memoryState(memoryRows, listing?.locale === locale ? listing.listed : undefined),
    })
  }, [commands, tuiState, agents, setupEpoch, provider, glossary, memoryRows, listing])

  // The wizard opens at launch while setup has a step that is plainly
  // missing and it has not been walked to the end. "Unknown" does not count:
  // the provider is unknown until discovery answers, and a fully set-up
  // install must not see the wizard flash up for the second that takes.
  const [screen, setScreen] = useState<ScreenId>(() =>
    !tuiState.wizard.dismissed && SETUP_STEPS.some((s) => status.steps[s] === 'missing') ? 'setup' : 'home',
  )
  // Discovery skipped at launch (No AI) runs once setup is on screen.
  useEffect(() => {
    if (screen !== 'setup' || !skippedDiscovery.current) return
    skippedDiscovery.current = false
    return check(false)
  }, [screen])
  // Again each time home is shown, so the header's quota note does not keep
  // the launch answer for as long as the app stays open. get() hands back an
  // answer under five minutes old, so going back and forth spawns nothing.
  useEffect(() => {
    if (screen === 'home') askProvider()
  }, [screen])
  const [wizardStart, setWizardStart] = useState<SetupStep>(() => SETUP_STEPS.find((s) => status.steps[s] === 'missing') ?? 'locale')
  const [wizardReturn, setWizardReturn] = useState<ScreenId>('home')
  // Set only for the walk the locale offer starts, over that locale's steps;
  // every other way into setup walks all of it.
  const [wizardSteps, setWizardSteps] = useState<readonly SetupStep[] | undefined>()
  // What the offer names, worked out when the locale changed.
  const [localeMissing, setLocaleMissing] = useState<readonly SetupStep[]>([])
  const [statusFocus, setStatusFocus] = useState<SetupStep | undefined>(undefined)
  const [overlay, setOverlay] = useState<Overlay | undefined>(undefined)

  const [paletteBlocked, setPaletteBlocked] = useState(false)
  const [localeNote, setLocaleNote] = useState<{ blocked?: string; error?: string }>({})
  // The warning is about the run, so it goes when the run does, whether or
  // not the palette was closed in between.
  useEffect(() => {
    if (!busy) setPaletteBlocked(false)
    if (!busy) setLocaleNote((note) => (note.blocked === LOCALE_BUSY ? {} : note))
  }, [busy])

  const go = (next: ScreenId) => {
    if (screen === 'setup') syncLocale()
    // Left or entered again, setup is the whole of it from here on: a walk
    // over one locale's steps ends when it is left.
    if (screen === 'setup' || next === 'setup') setWizardSteps(undefined)
    setSetupEpoch((e) => e + 1)
    if (screen === 'sync-glossary' || screen === 'setup') refreshGlossary()
    if (screen === 'import-tm' || screen === 'setup') refreshMemory()
    setStatusFocus(undefined)
    if (next === 'setup') {
      setWizardReturn(screen === 'setup' ? wizardReturn : screen)
      setWizardStart(SETUP_STEPS.find((s) => status.steps[s] !== 'done') ?? 'locale')
    }
    setScreen(next)
  }
  const back = () => go(screen === 'setup' ? wizardReturn : parentOf(screen))
  // From a screen that stopped for want of a locale: the wizard at its locale
  // step, coming back to that screen once it is done or left.
  const openLocaleSetup = () => {
    setSetupEpoch((e) => e + 1)
    setWizardSteps(undefined)
    setWizardReturn(screen)
    setWizardStart('locale')
    setScreen('setup')
  }
  const quit = () => {
    onExit?.()
    exit()
  }
  // A run would keep going after the UI unmounted and keep writing files
  // with nobody watching, so quitting while one is in flight asks first,
  // whether by q on home or by Ctrl+C.
  const requestQuit = () => (busy ? setOverlay('quit') : quit())
  const record = (patch: (state: TuiState) => TuiState) => {
    // Patched onto the file as it is now, not onto the copy read at launch:
    // Interface settings writes the same file, and a stale copy here would
    // put back a setting it had just turned off.
    // Migrated again too: when the launch save failed, the file still holds
    // the old global lists, and patching it as read would write them back
    // over the migration the render already has.
    const next = patch(migrateTuiState(tryOr(() => commands.loadTuiState(), tuiState), locale))
    try {
      commands.saveTuiState(next)
    } catch {
      // Losing where the wizard stands costs one more look at it next
      // launch; failing the step the person just took over it would cost
      // more. The in-memory state still moves on.
    }
    setTuiState(next)
  }

  // Each opening starts clean: a note left from the last one, closed by
  // ctrl+c's prompt rather than esc, would speak about a pick not made yet.
  const openLocale = () => {
    setLocaleNote({})
    setOverlay('locale')
  }
  const closeLocale = () => {
    setLocaleNote({})
    setOverlay(undefined)
  }
  // The one way the locale changes outside setup. The screen on show is
  // mounted again under the new locale (the Viewport's key), because most of
  // them read the locale once, at mount, into a title, a prefilled field or a
  // memory count, and would otherwise go on showing the old one. That is why a
  // run refuses it, as leaving its screen would, and why unsaved edits do: the
  // remount would throw them away.
  const changeLocale = (id: string) => {
    if (id === locale) return closeLocale()
    if (busy) return setLocaleNote({ blocked: LOCALE_BUSY })
    if (unsaved.current) return setLocaleNote({ blocked: LOCALE_UNSAVED })
    try {
      commands.saveConfig({ defaultLocale: id })
    } catch (err) {
      // As the setup locale step does: the picker stays, with the reason, and
      // nothing else moves, since a run reads the saved config.
      return setLocaleNote({ error: errorMessage(err) })
    }
    // The locale left goes in too, under the new one: an install that has never
    // picked one has an empty list, and the way back would otherwise have to be
    // typed out after the first switch.
    record((s) => ({ ...s, recentLocales: pushRecent(locale === undefined ? s.recentLocales : pushRecent(s.recentLocales, locale), id) }))
    setLocale(id)
    setSetupEpoch((e) => e + 1)
    refreshGlossary()
    refreshMemory()
    closeLocale()
    offerSetup(id)
  }

  // Once per locale, on the first change to it: a locale without a glossary or
  // rules reviews without their checks, and nothing else on screen would say
  // so. Asked whatever the answer, and whether or not anything is missing, so
  // a switch back and forth never asks twice. The memory counts only in
  // principle, when the vault is already known to list it for this locale: no
  // fetch is started for the question, and the listing held here is for the
  // locale being left, so from the picker it never does. The walk the offer
  // starts still passes the memory step, which reads the vault itself.
  const offerSetup = (id: string) => {
    // Off the file, as record patches it: the render's copy predates the
    // recent-list write changeLocale has just made.
    const own = localeWizard(tryOr(() => commands.loadTuiState(), tuiState), id)
    if (own.asked) return
    const glossaryCount = tryOr(() => commands.glossaryCount(id), undefined)
    const memoryRows = tryOr(() => commands.memoryCount(id), undefined)
    const listed = listing?.locale === id ? listing.listed : undefined
    const missing = missingLocaleSteps({
      ...(glossaryCount === undefined ? {} : { glossaryCount }),
      ...(memoryRows === undefined ? {} : { memoryRows }),
      memorySkipped: own.skipped.includes('memory'),
      ...(listed === undefined ? {} : { listed }),
      hasRules: tryOr(() => commands.hasLocaleRules(id), false),
    })
    record((s) => markAsked(s, id))
    if (missing.length === 0) return
    setLocaleMissing(missing)
    setOverlay('locale-setup')
  }
  const startLocaleSetup = () => {
    setOverlay(undefined)
    setWizardReturn(screen)
    setWizardSteps(LOCALE_STEPS)
    setWizardStart(localeMissing[0] ?? 'glossary')
    setScreen('setup')
  }

  // A second Ctrl+C at the quit prompt answers yes: someone pressing it
  // twice means it. Everything else waits while an overlay is up, and while
  // the terminal is too small: there is nothing to draw an overlay on, and
  // one set now would pop up unbidden when the terminal is enlarged.
  const framed = overlay === undefined && layout.fits
  const pageBody = useRef<PageBy | undefined>(undefined)
  const [footerStage, setFooterStage] = useState<string | undefined>(undefined)
  // Printable, so they belong to a text field when one has focus. Ctrl+K is
  // not something a field types, so it opens the palette from inside one.
  const unlessTyping = (act: () => void) => (_input: string, key: Key) => {
    if (!key.ctrl && typing.current()) return
    act()
  }
  useGlobalKeys({
    global: {
      quit: () => (overlay === 'quit' ? quit() : requestQuit()),
      palette: framed ? unlessTyping(() => setOverlay('palette')) : undefined,
      help: framed ? unlessTyping(() => setOverlay('help')) : undefined,
      // Not on setup, whose first step is choosing the locale.
      locale: framed && screen !== 'setup' ? unlessTyping(openLocale) : undefined,
      // Stops the stats server from anywhere, since it keeps serving after its
      // screen is left. The stats screen binds x itself, to show that it
      // stopped, and the glossary editor's screen binds it for its own server.
      stopStats:
        framed && statsUrl !== undefined && screen !== 'stats' && screen !== 'edit-glossary'
          ? unlessTyping(() => void services.stopStats())
          : undefined,
      // The Help page pages through its own text with the same keys.
      scroll: framed && screen !== 'help' ? (_input, key) => pageBody.current?.(key.pageUp ? -1 : 1) : undefined,
    },
  })

  // Once a session, the first time home has drawn the block or had none to
  // draw. Written even when nothing changes, so a first-time user's tui.json
  // exists and the next update is news to them.
  const recordNewsSeen = () => {
    if (newsRecorded.current) return
    newsRecorded.current = true
    record((s) => ({ ...s, whatsNew: { seen: laterVersion(s.whatsNew.seen, version) } }))
  }

  const switchProvider = (next: ReviewChoice) => {
    // The display only moves once the setting is written. A run reads the
    // saved config, so showing a provider that failed to save would name an
    // agent no review is going to use.
    try {
      commands.saveConfig({ reviewProvider: next })
      setProvider(next)
      setProviderError(undefined)
    } catch (err) {
      setProviderError(errorMessage(err))
    }
  }

  const headerRows = layout.wordmark ? 4 : 2
  const bodyRows = Math.max(1, size.rows - headerRows - 2)
  const model = agents?.find((a) => a.provider === provider)?.model
  const note = provider === 'antigravity' ? providerNote(accountChecks.antigravity, model) : undefined

  const menu = { layout: layout.menu, width: size.columns, onOpen: go }
  const view = (() => {
    switch (screen) {
      case 'home':
        return (
          <Home
            {...menu}
            items={HOME}
            onLeave={requestQuit}
            provider={provider}
            onProvider={switchProvider}
            {...(providerError === undefined ? {} : { providerError })}
            {...(agents === undefined ? {} : { agents })}
            checking={checking}
            configured={configured}
            status={status}
            {...(statusFocus === undefined ? {} : { statusFocus })}
            onStatusFocus={setStatusFocus}
            rows={bodyRows}
            whatsNew={news}
            onWhatsNewSeen={recordNewsSeen}
            onOpenStep={(step) => {
              setWizardSteps(undefined)
              setWizardReturn('home')
              setWizardStart(step)
              setStatusFocus(undefined)
              setScreen('setup')
            }}
          />
        )
      case 'tools':
        return <Submenu {...menu} items={TOOLS} onLeave={back} />
      case 'config':
        return <Submenu {...menu} items={CONFIGURATION} onLeave={back} />
      case 'agents':
        return (
          <Agents
            {...(agents === undefined ? {} : { agents })}
            checking={checking}
            {...(agentsError === undefined ? {} : { error: agentsError })}
            onRecheck={() => check(true)}
            onBack={back}
          />
        )
      // Not hoisted like agents: nothing else needs the answer, and probing
      // three ports at launch would bother people who never draft locally.
      case 'local-models':
        return <LocalModels onBack={back} />
      case 'translate':
        return <Translate cwd={cwd} onBack={back} />
      case 'review':
        return <Review cwd={cwd} onBack={back} />
      case 'fetch':
        return <Fetch onBack={back} onSetup={openLocaleSetup} />
      case 'split':
        return <Split cwd={cwd} onBack={back} />
      case 'import-tm':
        return <ImportTm cwd={cwd} onBack={back} onSetup={openLocaleSetup} />
      case 'export-tm':
        return <ExportTm onBack={back} onSetup={openLocaleSetup} />
      case 'stats':
        return <Stats cwd={cwd} onBack={back} />
      case 'sync-glossary':
        return <SyncGlossary onBack={back} />
      case 'edit-glossary':
        return <EditGlossary onBack={back} onSetup={openLocaleSetup} />
      case 'locale-rules':
        return <LocaleRules onBack={back} />
      case 'reply-templates':
        return <ReplyTemplates onBack={back} onSetup={openLocaleSetup} />
      case 'configure-keys':
        return <ConfigureKeys onBack={back} />
      case 'help':
        return <Help height={bodyRows} onBack={back} />
      case 'about':
        return <About onBack={back} />
      case 'interface':
        return <Interface onBack={back} />
      case 'usage-stats':
        return <UsageStats onBack={back} />
      case 'setup':
        return (
          <Wizard
            key={`${wizardStart}:${wizardSteps?.join() ?? ''}`}
            start={wizardStart}
            {...(wizardSteps === undefined ? {} : { steps: wizardSteps })}
            status={status}
            {...(agents === undefined ? {} : { agents })}
            onRecord={record}
            onAdvance={() => {
              syncLocale()
              setSetupEpoch((e) => e + 1)
              refreshGlossary()
              refreshMemory()
            }}
            onDone={back}
          />
        )
    }
  })()

  // The screen stays mounted under an overlay and under the too-small
  // notice, hidden and behind a closed gate. Unmounting it would end a run in
  // it, and a resize that dips under the minimum must not cost a review.
  const hidden = overlay !== undefined || !layout.fits
  return (
    <Box width={terminal.columns} height={size.rows} justifyContent="center">
    <Box flexDirection="column" width={size.columns} height={size.rows}>
      {layout.fits ? (
        <Header
          wordmark={layout.wordmark}
          {...(locale === undefined ? {} : { locale })}
          provider={providerLabel(provider)}
          {...(model === undefined ? {} : { model })}
          {...(note === undefined ? {} : { providerNote: note })}
          status={status}
          {...(statusFocus === undefined ? {} : { focusedStep: statusFocus })}
          {...(statsUrl === undefined ? {} : { statsUrl })}
          {...(statsError === undefined ? {} : { statsError })}
          {...(latest === undefined ? {} : { update: latest })}
        />
      ) : null}
      <Box flexDirection="column" flexGrow={1} marginTop={layout.fits ? 1 : 0} overflow="hidden">
        <Box display={hidden ? 'none' : 'flex'} flexDirection="column" flexGrow={1}>
          <InputGate open={!hidden}>
            {/* Keyed by screen, so the next screen starts at its top, and by
                locale, so a change of locale mounts the screen again in it.
                Not setup's: its locale step writes the locale part way
                through a walk, and a remount would start the walk over. */}
            <FooterStageProvider value={setFooterStage}>
              <ProviderCheckProvider value={providerCheck}>
                <UnsavedContext.Provider value={unsaved}>
                  <Viewport key={screen === 'setup' ? screen : `${screen}:${locale ?? ''}`} pageRef={pageBody}>
                    {view}
                  </Viewport>
                </UnsavedContext.Provider>
              </ProviderCheckProvider>
            </FooterStageProvider>
          </InputGate>
        </Box>
        {!layout.fits && (
          <Box flexDirection="column">
            <Text {...TOKENS.warn.ink}>
              Enlarge the terminal to at least {MIN_SIZE.columns}×{MIN_SIZE.rows} (now {size.columns}×{size.rows}).
            </Text>
            <Text {...TOKENS.muted.ink}>ctrl+c quits</Text>
          </Box>
        )}
        {layout.fits && overlay === 'help' && <HelpOverlay screen={screen} rows={bodyRows} onClose={() => setOverlay(undefined)} />}
        {layout.fits && overlay === 'palette' && (
          <Palette
            blocked={paletteBlocked}
            withLocale={screen !== 'setup'}
            onPick={(id) => {
              // Not a screen: the picker opens over this one, which stays,
              // so a run here is no reason to refuse. The picker refuses the
              // pick itself.
              if (id === 'locale') {
                setPaletteBlocked(false)
                return openLocale()
              }
              // Leaving a screen with a run in it would unmount the run's
              // controls and progress while the run carried on, and leave a
              // second run on the same file one keypress away.
              if (busy && id !== screen) return setPaletteBlocked(true)
              setOverlay(undefined)
              go(id)
            }}
            onClose={() => {
              setPaletteBlocked(false)
              setOverlay(undefined)
            }}
          />
        )}
        {layout.fits && overlay === 'locale' && (
          <LocalePicker
            {...(locale === undefined ? {} : { current: locale })}
            recent={tuiState.recentLocales}
            {...(localeNote.blocked === undefined ? {} : { blocked: localeNote.blocked })}
            {...(localeNote.error === undefined ? {} : { error: localeNote.error })}
            onPick={changeLocale}
            onClose={closeLocale}
          />
        )}
        {layout.fits && overlay === 'locale-setup' && locale !== undefined && (
          <LocaleSetupPrompt locale={locale} missing={localeMissing} onYes={startLocaleSetup} onNo={() => setOverlay(undefined)} />
        )}
        {overlay === 'quit' && <QuitPrompt onQuit={quit} onCancel={() => setOverlay(undefined)} />}
      </Box>
      {layout.fits ? (
        <Footer keys={footerKeys(screen, statsUrl !== undefined, footerStage)} busy={busy} />
      ) : null}
    </Box>
    </Box>
  )
}
