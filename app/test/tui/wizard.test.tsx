import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config.js'
import { App } from '../../src/tui/App.js'
import { CommandsProvider } from '../../src/tui/commands.js'
import { matchLocales, offeredProviders, USAGE_QUESTION, Wizard } from '../../src/tui/screens/Wizard.js'
import type { SetupStatus } from '../../src/tui/setup.js'
import { DEFAULT_TUI_STATE, LOCALE_STEPS, type TuiState } from '../../src/tui/state.js'
import type { PolyglotsConfig } from '../../src/types.js'
import {
  agentStatus,
  cleanup,
  ESC_DELAY,
  fakeCommands,
  flat,
  keys,
  makeHome,
  manifestWith,
  memoryTuiState,
  modelServer,
  render,
  tick,
  tmEntry,
  unusableAgent,
  waitForText,
  type Home,
} from './helpers.js'

let home: Home
beforeEach(async () => {
  home = await makeHome()
})
afterEach(async () => {
  cleanup()
  await home.cleanup()
})

const fresh = (): TuiState => structuredClone(DEFAULT_TUI_STATE)

function configStore(initial: Partial<PolyglotsConfig> = {}) {
  let current: PolyglotsConfig = { ...DEFAULT_CONFIG, ...initial }
  const saved: Partial<PolyglotsConfig>[] = []
  return {
    saved,
    loadConfig: () => current,
    saveConfig: (patch: Partial<PolyglotsConfig>) => {
      saved.push(patch)
      current = { ...current, ...patch }
      return current
    },
  }
}

async function type(stdin: { write(s: string): void }, text: string) {
  for (const ch of text) {
    stdin.write(ch)
    await tick()
  }
}

describe('opening at launch', () => {
  it('opens on the first missing step when setup is incomplete and the wizard was never finished', async () => {
    const { lastFrame } = render(<App commands={fakeCommands({ ...memoryTuiState(fresh()) })} />)
    await waitForText(lastFrame, 'Step 1 of 6')
    expect(flat(lastFrame())).toContain('Locale')
  })

  it('stays on home once the wizard has been walked to the end', async () => {
    const { lastFrame } = render(<App commands={fakeCommands()} />)
    await waitForText(lastFrame, 'Translate a .po file')
    expect(lastFrame()).not.toContain('Step 1 of 6')
  })

  // The provider is unknown until discovery answers. Counting that as
  // missing would flash the wizard at every launch of a finished setup.
  it('does not open for a provider that is merely not checked yet', async () => {
    const commands = fakeCommands({
      ...memoryTuiState(fresh()),
      discoverAgents: () => new Promise(() => {}),
      // The glossary and rules steps are counted for the configured locale.
      loadConfig: () => ({ ...DEFAULT_CONFIG, defaultLocale: 'tr' }),
      localeConfigured: () => true,
      loadSecrets: () => ({ DEEPL_API_KEY: 'k' }),
      glossaryCount: () => 10,
      hasLocaleRules: () => true,
    })
    const { lastFrame } = render(<App commands={commands} />)
    await waitForText(lastFrame, 'Translate a .po file')
    expect(lastFrame()).not.toContain('Step 1 of 6')
  })
})

describe('the steps', () => {
  it('saves the chosen locale and marks it confirmed', async () => {
    const config = configStore()
    const state = memoryTuiState(fresh())
    const { lastFrame, stdin } = render(<App commands={fakeCommands({ ...config, ...state })} />)
    await waitForText(lastFrame, 'Search:')
    // Nothing configured, so the field starts empty (no-locale.test.tsx).
    await type(stdin, 'de_DE')
    await waitForText(lastFrame, 'de_DE')
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'Step 2 of 6')
    expect(config.saved).toContainEqual({ defaultLocale: 'de' })
    const last = state.saveTuiState.mock.calls.at(-1)![0]
    expect(last.wizard.confirmed).toContain('locale')
  })

  it('skips a step with esc and remembers that it was skipped', async () => {
    const state = memoryTuiState(fresh())
    const { lastFrame, stdin } = render(<App commands={fakeCommands({ ...state })} />)
    await waitForText(lastFrame, 'Step 1 of 6')
    stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(lastFrame, 'Step 2 of 6')
    expect(state.saveTuiState.mock.calls.at(-1)![0].wizard.skipped).toEqual(['locale'])
  })

  it('records a skipped memory step under the configured locale, not globally', async () => {
    const config = configStore({ defaultLocale: 'nl' })
    const state = memoryTuiState(fresh())
    const commands = fakeCommands({
      ...config,
      ...state,
      dataClient: {
        manifest: async () => manifestWith({ tm: [tmEntry({ locale: 'nl_NL', slug: 'nl' })] }),
        download: async () => {
          throw new Error('not here')
        },
      },
    })
    const { lastFrame, stdin } = render(<App commands={commands} />)
    for (const step of [1, 2, 3, 4]) {
      await waitForText(lastFrame, `Step ${step} of 6`)
      stdin.write(keys.esc)
      await tick(ESC_DELAY)
    }
    await waitForText(lastFrame, 'Step 5 of 6')
    stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(lastFrame, 'Step 6 of 6')
    const last = state.saveTuiState.mock.calls.at(-1)![0]
    expect(last.wizard.locales.nl?.skipped).toEqual(['memory'])
    expect(last.wizard.skipped).not.toContain('memory')
  })

  it('moves a global memory skip into the configured locale at launch and saves it', () => {
    const state = memoryTuiState({ ...fresh(), wizard: { ...fresh().wizard, dismissed: true, skipped: ['memory', 'keys'] } })
    render(<App commands={fakeCommands({ ...configStore({ defaultLocale: 'tr' }), ...state })} />)
    const saved = state.saveTuiState.mock.calls[0]![0]
    expect(saved.wizard.skipped).toEqual(['keys'])
    expect(saved.wizard.locales.tr).toEqual({ skipped: ['memory'], confirmed: [], asked: true })
  })

  it('offers only providers that are ready, with what each costs, and saves the pick', async () => {
    const config = configStore()
    const commands = fakeCommands({
      ...config,
      ...memoryTuiState(fresh()),
      discoverAgents: async () => [agentStatus('claude'), unusableAgent('antigravity', 'agy not on PATH')],
      discoverModels: async () => [],
    })
    const { lastFrame, stdin } = render(<App commands={commands} />)
    await waitForText(lastFrame, 'Step 1 of 6')
    stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(lastFrame, 'Claude Code')
    const frame = flat(lastFrame())
    expect(frame).toContain('Claude subscription or API credits')
    expect(frame).not.toContain('Antigravity')
    expect(frame).not.toContain('Local model')
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'Step 3 of 6')
    expect(config.saved).toContainEqual({ reviewProvider: 'claude' })
  })

  it('offers Codex after Antigravity, with its cost, and says what it will use once chosen', async () => {
    const config = configStore()
    const commands = fakeCommands({
      ...config,
      ...memoryTuiState(fresh()),
      discoverAgents: async () => [
        unusableAgent('claude', 'not on PATH'),
        agentStatus('antigravity'),
        agentStatus('codex', { bin: 'codex', path: '/opt/bin/codex' }),
      ],
      discoverModels: async () => [],
    })
    const { lastFrame, stdin } = render(<App commands={commands} />)
    await waitForText(lastFrame, 'Step 1 of 6')
    stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(lastFrame, 'Codex')
    const frame = flat(lastFrame())
    expect(frame).toContain("Uses your ChatGPT plan's Codex limits.")
    expect(frame.indexOf('Antigravity')).toBeLessThan(frame.indexOf('Codex'))
    expect(frame.indexOf('Codex')).toBeLessThan(frame.indexOf('No AI'))
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'Step 3 of 6')
    expect(config.saved).toContainEqual({ reviewProvider: 'codex' })
    expect(flat(lastFrame())).toContain(
      "codex will use codex's default model, effort codex's default effort. To choose another model: polyglots config set codex.model <name>",
    )
  })

  // Someone who wants no AI has no agent to find. The choice is always on the
  // list, last so enter on the first row still picks an agent, and it is the
  // whole list when nothing is installed.
  it('offers No AI even when no agent is ready, and saves it as none', async () => {
    const config = configStore()
    const commands = fakeCommands({
      ...config,
      ...memoryTuiState(fresh()),
      discoverAgents: async () => [unusableAgent('claude', 'not on PATH'), unusableAgent('antigravity', 'agy not on PATH')],
      discoverModels: async () => [],
    })
    const { lastFrame, stdin } = render(<App commands={commands} />)
    await waitForText(lastFrame, 'Step 1 of 6')
    stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(lastFrame, 'No AI')
    expect(flat(lastFrame())).not.toContain('No review agent is ready')
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'Step 3 of 6')
    expect(config.saved).toContainEqual({ reviewProvider: 'none' })
  })

  it('lists No AI after the agents', async () => {
    const { lastFrame, stdin } = render(<App commands={fakeCommands({ ...memoryTuiState(fresh()) })} />)
    await waitForText(lastFrame, 'Step 1 of 6')
    stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(lastFrame, 'No AI')
    const frame = flat(lastFrame())
    expect(frame.indexOf('Claude Code')).toBeLessThan(frame.indexOf('No AI'))
  })

  it('offers no draft engine, and moves straight on without a key screen', async () => {
    const config = configStore()
    const { lastFrame, stdin } = render(<App commands={fakeCommands({ ...config, ...memoryTuiState(fresh()) })} />)
    await waitForText(lastFrame, 'Step 1 of 6')
    for (let i = 0; i < 2; i++) {
      stdin.write(keys.esc)
      await tick(ESC_DELAY)
    }
    await waitForText(lastFrame, 'Translation memory only')
    for (let i = 0; i < 5; i++) {
      stdin.write(keys.down)
      await tick()
    }
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'Step 4 of 6')
    expect(config.saved).toContainEqual({ defaultDraftEngine: 'none' })
  })

  it('offers the local draft engine only when a local server answers', async () => {
    const withServer = render(<App commands={fakeCommands({ ...memoryTuiState(fresh()), discoverModels: async () => [modelServer()] })} />)
    await waitForText(withServer.lastFrame, 'Step 1 of 6')
    for (let i = 0; i < 2; i++) {
      withServer.stdin.write(keys.esc)
      await tick(ESC_DELAY)
    }
    await waitForText(withServer.lastFrame, 'Step 3 of 6')
    await waitForText(withServer.lastFrame, 'Local model')
    expect(flat(withServer.lastFrame())).toContain('DeepL')
    cleanup()

    const without = render(<App commands={fakeCommands({ ...memoryTuiState(fresh()), discoverModels: async () => [modelServer({ state: 'down', models: [] })] })} />)
    await waitForText(without.lastFrame, 'Step 1 of 6')
    for (let i = 0; i < 2; i++) {
      without.stdin.write(keys.esc)
      await tick(ESC_DELAY)
    }
    await waitForText(without.lastFrame, 'OpenAI')
    expect(flat(without.lastFrame())).not.toContain('Local model')
  })

  it('goes on to the key screen after choosing DeepL', async () => {
    const config = configStore()
    const { lastFrame, stdin } = render(<App commands={fakeCommands({ ...config, ...memoryTuiState(fresh()) })} />)
    await waitForText(lastFrame, 'Step 1 of 6')
    for (let i = 0; i < 2; i++) {
      stdin.write(keys.esc)
      await tick(ESC_DELAY)
    }
    await waitForText(lastFrame, 'DeepL')
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'DEEPL_API_KEY')
    expect(config.saved).toContainEqual({ defaultDraftEngine: 'deepl' })
  })

  it('is dismissed and lands on home after the last step', async () => {
    const state = memoryTuiState(fresh())
    const { lastFrame, stdin } = render(<App commands={fakeCommands({ ...state, ...configStore({ usageStats: false }) })} />)
    await waitForText(lastFrame, 'Step 1 of 6')
    for (const step of [1, 2, 3, 4, 6]) {
      await waitForText(lastFrame, `Step ${step} of 6`)
      stdin.write(keys.esc)
      await tick(ESC_DELAY)
    }
    await waitForText(lastFrame, 'Translate a .po file')
    expect(state.saveTuiState.mock.calls.at(-1)![0].wizard.dismissed).toBe(true)
  })

  it('is reachable from Configuration', async () => {
    const { lastFrame, stdin } = render(<App commands={fakeCommands()} />)
    await tick()
    stdin.write('c')
    await waitForText(lastFrame, 'Setup wizard')
    stdin.write('w')
    await waitForText(lastFrame, 'Step 1 of 6')
  })
})

describe('the usage statistics question', () => {
  // Walks the six setup steps with esc, to the question after them. The
  // memory step passes by itself: the fake manifest lists no memory.
  async function toQuestion(initial: Partial<PolyglotsConfig> = {}) {
    const config = configStore(initial)
    const state = memoryTuiState(fresh())
    const r = render(<App commands={fakeCommands({ ...config, ...state })} />)
    await waitForText(r.lastFrame, 'Step 1 of 6')
    for (const step of [1, 2, 3, 4, 6]) {
      await waitForText(r.lastFrame, `Step ${step} of 6`)
      r.stdin.write(keys.esc)
      await tick(ESC_DELAY)
    }
    return { ...r, config, state }
  }

  it('is asked once, neutrally, after the setup steps, with No as the default answer', async () => {
    const { lastFrame, stdin, config, state } = await toQuestion()
    await waitForText(lastFrame, 'Share anonymous totals (strings reviewed, number of projects) to show on the website?')
    expect(flat(lastFrame())).toContain('You can change this any time.')
    expect(flat(lastFrame())).not.toContain('Step 7')
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'Translate a .po file')
    expect(config.saved).toContainEqual({ usageStats: false })
    expect(state.saveTuiState.mock.calls.at(-1)![0].wizard.dismissed).toBe(true)
  })

  it('saves yes only when yes is chosen', async () => {
    const { lastFrame, stdin, config } = await toQuestion()
    await waitForText(lastFrame, 'Share anonymous totals')
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'Translate a .po file')
    expect(config.saved).toContainEqual({ usageStats: true })
  })

  it('takes esc as the default answer, no', async () => {
    const { lastFrame, stdin, config } = await toQuestion()
    await waitForText(lastFrame, 'Share anonymous totals')
    stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(lastFrame, 'Translate a .po file')
    expect(config.saved).toContainEqual({ usageStats: false })
  })

  it('is not asked again once answered', async () => {
    const { lastFrame, config } = await toQuestion({ usageStats: true })
    await waitForText(lastFrame, 'Translate a .po file')
    expect(flat(lastFrame())).not.toContain('Share anonymous totals')
    expect(config.saved.some((p) => 'usageStats' in p)).toBe(false)
  })
})

describe('a walk over some of the steps', () => {
  // The offer made on a change of locale walks only that locale's steps. It
  // is not the whole setup, so reaching its end says nothing about whether
  // the wizard should keep opening at launch, and the usage question, which
  // belongs to the first walk, has no place in it.
  it('walks only the given steps, without the usage question or a dismissal', async () => {
    const commands = fakeCommands({
      ...configStore({ defaultLocale: 'nl' }),
      // Never answers, so the memory step waits for esc rather than passing
      // by itself as an unlisted locale would.
      dataClient: { manifest: () => new Promise(() => {}), download: vi.fn(async () => {
        throw new Error('a TUI test does not download')
      }) },
    })
    const patches: ((s: TuiState) => TuiState)[] = []
    const onDone = vi.fn()
    const status: SetupStatus = {
      steps: { locale: 'done', provider: 'done', keys: 'done', glossary: 'missing', memory: 'missing', rules: 'missing' },
      done: 3,
      total: 6,
    }
    const { lastFrame, stdin } = render(
      <CommandsProvider value={commands}>
        <Wizard start="glossary" steps={LOCALE_STEPS} status={status} onRecord={(p) => patches.push(p)} onDone={onDone} />
      </CommandsProvider>,
    )
    for (const title of ['Glossary sync', 'Translation memory', 'Locale rules']) {
      await waitForText(lastFrame, title)
      stdin.write(keys.esc)
      await tick(ESC_DELAY)
    }
    await tick(20)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(flat(lastFrame())).not.toContain(USAGE_QUESTION.slice(0, 20))
    const final = patches.reduce((s, p) => p(s), fresh())
    expect(final.wizard.dismissed).toBe(false)
  })
})

describe('matchLocales', () => {
  it('puts an exact code first, then prefixes', () => {
    expect(matchLocales('tr_TR')[0]).toEqual({ id: 'tr', wp: 'tr_TR' })
    expect(matchLocales('nl').map((l) => l.id)).toContain('nl/formal')
  })
})

describe('offeredProviders', () => {
  it('lists usable agents and the local reviewer only with a live server', () => {
    expect(offeredProviders([agentStatus('claude'), agentStatus('antigravity')], []).map((p) => p.id)).toEqual([
      'claude',
      'antigravity',
      'none',
    ])
    expect(offeredProviders([], [modelServer()]).map((p) => p.id)).toEqual(['local', 'none'])
    expect(offeredProviders(undefined, undefined)).toEqual([])
    // Not while either question is still out: it would be the only row.
    expect(offeredProviders([], undefined)).toEqual([])
    expect(offeredProviders(undefined, [])).toEqual([])
  })
})
