// Records the TUI scenarios in tui-demos.ts: renders the real App from
// app/src/tui into a fake terminal of a fixed size, presses the keys the
// scenario names, and keeps the screens it asks for. Imported by snapshot.ts
// after its sandbox is in place, so POLYGLOTS_HOME and HOME already point at
// throwaway folders when the first app module loads.
//
// Ink is rendered in debug mode, where every render writes the whole screen
// rather than the cursor moves a real terminal gets. Each write is then one
// complete frame, and the converter in ansi.ts needs to know nothing about
// cursor addressing.

import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { App } from '../../app/src/tui/App.js'
import type { TuiCommands } from '../../app/src/tui/commands.js'
import { loadConfig, saveConfig } from '../../app/src/config.js'
import { DEFAULT_TUI_STATE, parseTuiState, type TuiState } from '../../app/src/tui/state.js'
import { ansiToHtml, ansiToText } from './ansi.js'
import type { TuiClock, TuiDriver, TuiScenario } from './tui-demos.js'

// Ink and React are the app's dependencies, not the site's, and a bare
// import here would be resolved from website/, where neither is installed.
// They are loaded from where the app's own modules load them, so App and
// this renderer share one React: two copies would fail on the first hook.
const fromApp = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'package.json'))
const load = async <T>(name: string): Promise<T> => (await import(pathToFileURL(fromApp.resolve(name)).href)) as T
type Ink = typeof import('../../app/node_modules/ink/build/index.js')
const { render } = await load<Ink>('ink')
const { createElement } = await load<{ createElement(type: unknown, props: unknown): Parameters<Ink['render']>[0] }>('react')

export interface TuiFrame {
  hold: number
  html: string[]
}

export interface TuiDemo {
  columns: number
  rows: number
  frames: TuiFrame[]
  /** Plain text of the first frame, the panel's still, for the copy beside it and for agents reading the page. */
  text: string
}

// Every command the app can be handed. Listed so that each one a scenario
// does not fake is a stub that throws, as in snapshot.ts: a screen that grows
// a new call must not run the real thing during a build. The `satisfies`
// makes a member added to TuiCommands fail this typecheck until it is listed.
// The config readers are the real ones, over the sandbox's config.json.
// Secrets are not: the real reader also takes keys from the environment, and
// snapshot.ts sets a dummy DeepL key there for the translate demo, which would
// show every TUI panel's keys step as done.
const COMMANDS = {
  translateFile: true,
  importTmx: true,
  exportTm: true,
  syncGlossary: true,
  reviewFile: true,
  splitPo: true,
  writeStats: true,
  resolveProjects: true,
  fetchProjects: true,
  loadConfig: true,
  saveConfig: true,
  loadSecrets: true,
  saveSecret: true,
  discoverAgents: true,
  discoverModels: true,
  checkLocalModel: true,
  loadTuiState: true,
  saveTuiState: true,
  glossaryCount: true,
  hasLocaleRules: true,
  localeConfigured: true,
  memoryCount: true,
  dataClient: true,
  planRulesFetch: true,
  writeRulesFetch: true,
  planTmFetch: true,
  runTmFetch: true,
  startStatsServer: true,
  openInBrowser: true,
  stopOwnRuns: true,
  checkProvider: true,
  sendReport: true,
} satisfies Record<keyof TuiCommands, true>

function refuseUnfaked(name: string): TuiCommands {
  const stubs: Record<string, unknown> = {}
  const refuse = (command: string) => () => {
    throw new Error(`The ${name} TUI demo called ${command}, which it does not fake. Fake it in scripts/tui-demos.ts, or the build would run the real thing.`)
  }
  for (const command of Object.keys(COMMANDS)) stubs[command] = refuse(command)
  // An object, not a function: a function stub would fail as "manifest is
  // not a function", which names nothing worth fixing.
  stubs.dataClient = { manifest: refuse('dataClient.manifest'), download: refuse('dataClient.download') }
  return stubs as unknown as TuiCommands
}

// tui.json, held in memory: the scenario says where the wizard stands. The
// scenario's state goes through the same parse the real file does, so a field
// added to TuiState later reads as its default here, as it would in an old
// file, rather than as undefined that the app's first read throws on.
function memoryState(initial: TuiState): Pick<TuiCommands, 'loadTuiState' | 'saveTuiState'> {
  let state = parseTuiState(JSON.stringify(initial))
  return {
    loadTuiState: () => state,
    saveTuiState: (next) => {
      state = next
    },
  }
}

class FakeStdout extends EventEmitter {
  isTTY = true
  last = ''
  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    super()
  }
  write = (chunk: string, encodingOrCallback?: unknown, callback?: unknown): boolean => {
    // Ink also writes bare cursor and synchronized-output markers; only a
    // chunk with something visible in it is a frame.
    if (ansiToText(chunk).trim().length > 0) this.last = chunk
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    if (typeof done === 'function') queueMicrotask(done as () => void)
    return true
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true
  private data: string | null = null
  write(data: string): void {
    this.data = data
    this.emit('readable')
    this.emit('data', data)
  }
  read = (): string | null => {
    const { data } = this
    this.data = null
    return data
  }
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// Long enough for React to commit and Ink to write, and for Ink to put its
// stdin listener back after a render: a key written before that is dropped.
const settle = async () => {
  for (let i = 0; i < 4; i++) await tick()
}

const START = Date.UTC(2026, 8, 14, 9, 30)

export async function recordTui(scenario: TuiScenario): Promise<TuiDemo> {
  // The folder the app is started in, which the file picker names on its
  // "Browsing" line. Shown on the page as ~/Downloads/polyglots, where fetch
  // saves, rather than as the temporary path of whatever machine ran the
  // build. The swap happens on the drawn screen, after Ink has laid it out,
  // so the real path has to be no longer than the line: under /tmp it is,
  // where the snapshot's sandbox under macOS's per-user temporary folder
  // wrapped the line at 80 columns.
  const root = mkdtempSync('/tmp/polyglots-tui-')
  try {
    return await recordIn(scenario, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function recordIn(scenario: TuiScenario, root: string): Promise<TuiDemo> {
  const configDir = join(process.env.POLYGLOTS_HOME!, 'config')
  rmSync(configDir, { recursive: true, force: true })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.json'), JSON.stringify(scenario.config))

  const cwd = join(root, 'Downloads', 'polyglots')
  mkdirSync(cwd, { recursive: true })
  for (const file of scenario.files ?? []) {
    const path = join(cwd, file.name)
    const body = ['msgid ""', 'msgstr ""', '"Content-Type: text/plain; charset=UTF-8\\n"', '']
    for (let i = 1; i <= file.entries; i++) body.push(`msgid "String ${i}"`, 'msgstr ""', '')
    writeFileSync(path, body.join('\n'))
    const when = new Date(START - file.age * 60_000)
    utimesSync(path, when, when)
  }

  // Demo time, as in snapshot.ts: the elapsed clock, the "done by" hour and
  // anything else that reads the time read this one. The elapsed clock ticks
  // on an interval, so intervals are held here and fired as demo time passes
  // instead of by the wall clock, which would make every build differ.
  let now = START
  const intervals = new Map<number, { every: number; next: number; run: () => void }>()
  let nextId = 1
  const realNow = Date.now
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const realLocaleTime = Date.prototype.toLocaleTimeString
  Date.now = () => now
  Date.prototype.toLocaleTimeString = function (this: Date, _locales?: unknown, options?: Intl.DateTimeFormatOptions) {
    return realLocaleTime.call(this, 'en-GB', options)
  }
  globalThis.setInterval = ((run: () => void, every = 0) => {
    const id = nextId++
    intervals.set(id, { every, next: now + every, run })
    return id
  }) as unknown as typeof setInterval
  globalThis.clearInterval = ((id: unknown) => {
    if (typeof id === 'number') intervals.delete(id)
    else realClearInterval(id as NodeJS.Timeout)
  }) as typeof clearInterval

  const clock: TuiClock = {
    advance(ms) {
      now += ms
      for (const timer of intervals.values()) {
        if (timer.next > now) continue
        timer.next = now + timer.every
        timer.run()
      }
    },
  }

  const stdout = new FakeStdout(scenario.columns, scenario.rows)
  const stdin = new FakeStdin()
  const frames: TuiFrame[] = []
  let still: string[] | undefined
  // The sandbox's own path never reaches the page; see cwd above.
  const tidy = (line: string) => line.split(root).join('~')
  const screen = (): string[] => {
    const lines = stdout.last.replace(/\n+$/, '').split('\n').map(tidy)
    if (lines.length > scenario.rows) throw new Error(`The ${scenario.name} TUI demo drew ${lines.length} rows into a ${scenario.rows}-row terminal.`)
    while (lines.length < scenario.rows) lines.push('')
    return lines
  }

  // Thrown from a render, an error ends the app and Ink draws its trace in
  // place of the screen. Kept, so the snapshot fails with the error itself
  // rather than with a wait that timed out on a screen of stack frames.
  let crashed: unknown
  const drive: TuiDriver = {
    settle,
    async press(...keys) {
      for (const key of keys) {
        stdin.write(key)
        await settle()
      }
    },
    async shot(hold) {
      await settle()
      const lines = screen()
      still ??= lines
      const html = lines.map(ansiToHtml)
      const last = frames.at(-1)
      if (last && last.html.join('\n') === html.join('\n')) last.hold += hold
      else frames.push({ hold, html })
    },
    async waitFor(text) {
      for (let waited = 0; !ansiToText(stdout.last).includes(text); waited += 5) {
        if (crashed) throw crashed
        if (waited > 3_000) throw new Error(`The ${scenario.name} TUI demo never showed "${text}". The screen was:\n${ansiToText(stdout.last)}`)
        await tick(5)
      }
      await settle()
    },
  }

  const commands: TuiCommands = {
    ...refuseUnfaked(scenario.name),
    loadConfig,
    saveConfig,
    loadSecrets: () => ({}),
    ...memoryState(scenario.tuiState ?? DEFAULT_TUI_STATE),
    ...scenario.commands(clock, drive),
  }

  const instance = render(createElement(App, { commands, cwd }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new FakeStdout(scenario.columns, scenario.rows) as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  instance.waitUntilExit().catch((err: unknown) => (crashed = err))
  try {
    await settle()
    await scenario.play(drive)
    if (crashed) throw crashed
  } finally {
    instance.unmount()
    instance.cleanup()
    Date.now = realNow
    Date.prototype.toLocaleTimeString = realLocaleTime
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }

  if (frames.length === 0) throw new Error(`The ${scenario.name} TUI demo recorded no frames.`)
  const text = still!.map((l) => ansiToText(l).trimEnd()).join('\n')
  // As with the CLI demos: a field the TUI reads and the scenario did not
  // set shows as undefined or NaN instead of failing, which on a public page
  // is worse than a failed build.
  for (const frame of frames) {
    const plain = frame.html.join('\n').replace(/<[^>]+>/g, '')
    if (/\bundefined\b|\bNaN\b/.test(plain)) throw new Error(`The ${scenario.name} TUI demo showed undefined or NaN:\n${plain}`)
  }
  return { columns: scenario.columns, rows: scenario.rows, frames, text }
}
