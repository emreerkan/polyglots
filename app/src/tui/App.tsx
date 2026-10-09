import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp } from 'ink'
import { CommandsProvider, defaultCommands, errorMessage, useCommands, type TuiCommands } from './commands.js'
import type { AgentStatus } from '../agent/discover.js'
import { DEFAULT_CONFIG } from '../config.js'
import { DEFAULT_PROVIDER } from '../agent/providers.js'
import type { PolyglotsConfig, ReviewChoice, Secrets } from '../types.js'
import { TOKENS } from '../ui/tokens.js'
import { Footer, Header } from './components/Chrome.js'
import { HelpOverlay, Palette, QuitPrompt } from './components/Overlays.js'
import { Viewport, type PageBy } from './components/Viewport.js'
import { FooterStageProvider } from './footer-stage.js'
import { ActivityProvider, createActivity, useBusy, type Activity } from './hooks/activity.js'
import { useGlobalKeys } from './hooks/useKeys.js'
import { InputGate, TypingProvider, useTyping, type Key } from './input.js'
import { footerKeys } from './keys.js'
import { CONFIGURATION, HOME, parentOf, TOOLS, type ScreenId } from './menu.js'
import { providerLabel } from './local.js'
import { createServices, ServicesProvider, useServices, useStatsError, useStatsUrl, type Services } from './services.js'
import { setupStatus, type SetupStatus } from './setup.js'
import { frameLayout, frameSize, MIN_SIZE, SizeProvider, useSize } from './size.js'
import { SETUP_STEPS, type SetupStep, type TuiState } from './state.js'
import { Agents } from './screens/Agents.js'
import { ConfigureKeys } from './screens/ConfigureKeys.js'
import { Fetch } from './screens/Fetch.js'
import { ExportTm } from './screens/ExportTm.js'
import { Home, Submenu } from './screens/Home.js'
import { ImportTm } from './screens/ImportTm.js'
import { About, Help, Interface } from './screens/Info.js'
import { LocaleRules } from './screens/LocaleRules.js'
import { LocalModels } from './screens/LocalModels.js'
import { Review } from './screens/Review.js'
import { Split } from './screens/Split.js'
import { Stats } from './screens/Stats.js'
import { SyncGlossary } from './screens/SyncGlossary.js'
import { Translate } from './screens/Translate.js'
import { UsageStats } from './screens/UsageStats.js'
import { Wizard } from './screens/Wizard.js'

export interface AppProps {
  commands?: TuiCommands
  cwd?: string
  activity?: Activity
  services?: Services
  onExit?: () => void
  // The update check main() started; the header names a newer version once
  // it answers.
  update?: Promise<string | undefined>
}

type Overlay = 'help' | 'palette' | 'quit'

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

function Shell({ cwd = process.cwd(), onExit, update }: AppProps) {
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

  const [tuiState, setTuiState] = useState<TuiState>(() => commands.loadTuiState())
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
  const [agents, setAgents] = useState<AgentStatus[] | undefined>(undefined)
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

  // Counted at launch and after the screens that can change it, not on
  // every navigation like the cheaper facts below: it opens polyglots.db.
  // With no locale there is no glossary to count, and the step reads as missing.
  const countGlossary = () => {
    const locale = tryOr(() => commands.loadConfig(), DEFAULT_CONFIG).defaultLocale
    return locale === undefined ? undefined : tryOr(() => commands.glossaryCount(locale), undefined)
  }
  const [glossary, setGlossary] = useState<number | undefined>(countGlossary)
  const refreshGlossary = () => setGlossary(countGlossary())

  const status: SetupStatus = useMemo(() => {
    const config: PolyglotsConfig = tryOr(() => commands.loadConfig(), DEFAULT_CONFIG)
    const locale = config.defaultLocale
    return setupStatus({
      config,
      secrets: tryOr<Secrets>(() => commands.loadSecrets(), {}),
      state: tuiState,
      ...(agents === undefined ? {} : { agents }),
      localeConfigured: tryOr(() => commands.localeConfigured(), false),
      ...(glossary === undefined ? {} : { glossaryCount: glossary }),
      hasLocaleRules: locale === undefined ? false : tryOr(() => commands.hasLocaleRules(locale), false),
    })
  }, [commands, tuiState, agents, setupEpoch, provider, glossary])

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
  const [wizardStart, setWizardStart] = useState<SetupStep>(() => SETUP_STEPS.find((s) => status.steps[s] === 'missing') ?? 'locale')
  const [wizardReturn, setWizardReturn] = useState<ScreenId>('home')
  const [statusFocus, setStatusFocus] = useState<SetupStep | undefined>(undefined)
  const [overlay, setOverlay] = useState<Overlay | undefined>(undefined)

  const [paletteBlocked, setPaletteBlocked] = useState(false)
  // The warning is about the run, so it goes when the run does, whether or
  // not the palette was closed in between.
  useEffect(() => {
    if (!busy) setPaletteBlocked(false)
  }, [busy])

  const go = (next: ScreenId) => {
    setSetupEpoch((e) => e + 1)
    if (screen === 'sync-glossary' || screen === 'setup') refreshGlossary()
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
    const next = patch(tryOr(() => commands.loadTuiState(), tuiState))
    try {
      commands.saveTuiState(next)
    } catch {
      // Losing where the wizard stands costs one more look at it next
      // launch; failing the step the person just took over it would cost
      // more. The in-memory state still moves on.
    }
    setTuiState(next)
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
      // Stops the stats server from anywhere, since it keeps serving after its
      // screen is left. The stats screen binds x itself, to show that it stopped.
      stopStats: framed && statsUrl !== undefined && screen !== 'stats' ? unlessTyping(() => void services.stopStats()) : undefined,
      // The Help page pages through its own text with the same keys.
      scroll: framed && screen !== 'help' ? (_input, key) => pageBody.current?.(key.pageUp ? -1 : 1) : undefined,
    },
  })

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
            onOpenStep={(step) => {
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
      case 'locale-rules':
        return <LocaleRules onBack={back} />
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
            key={wizardStart}
            start={wizardStart}
            status={status}
            {...(agents === undefined ? {} : { agents })}
            onRecord={record}
            onAdvance={() => {
              setSetupEpoch((e) => e + 1)
              refreshGlossary()
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
          provider={providerLabel(provider)}
          {...(model === undefined ? {} : { model })}
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
            {/* Keyed by screen, so the next screen starts at its top. */}
            <FooterStageProvider value={setFooterStage}>
              <Viewport key={screen} pageRef={pageBody}>
                {view}
              </Viewport>
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
            onPick={(id) => {
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
        {overlay === 'quit' && <QuitPrompt onQuit={quit} onCancel={() => setOverlay(undefined)} />}
      </Box>
      {layout.fits ? (
        <Footer keys={footerKeys(screen, statsUrl !== undefined, footerStage)} busy={busy} />
      ) : null}
    </Box>
    </Box>
  )
}
