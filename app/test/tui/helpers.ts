import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReactElement } from 'react'
import { render as inkRender, type Instance } from 'ink'
import { vi } from 'vitest'
import { loadConfig, saveConfig, loadSecrets, saveSecret } from '../../src/config.js'
import type { Fetched, Ready, Resolution } from '../../src/commands/fetch.js'
import type { SplitOptions } from '../../src/commands/split.js'
import type { StatsOptions } from '../../src/commands/stats.js'
import type { ExportTmOptions } from '../../src/commands/tm-export.js'
import type { TmImportOptions } from '../../src/commands/tm-import.js'
import type { TranslateEvent, TranslateOptions, TranslateSummary } from '../../src/commands/translate.js'
import type { ReviewFileOptions, TuiCommands } from '../../src/tui/commands.js'
import { walk, type ScreenId } from '../../src/tui/menu.js'
import { DEFAULT_TUI_STATE, type TuiState } from '../../src/tui/state.js'
import type { AgentStatus } from '../../src/agent/discover.js'
import type { ModelCheck, ModelServer } from '../../src/draft/discover.js'
import type { ReviewProvider, ReviewSummary } from '../../src/types.js'
import type { FetchStatus, ProjectRef } from '../../src/wporg/projects.js'
import { DEFAULT_QWEN_MODEL } from '../../src/draft/qwen.js'

const ANSI = /\x1b\[[0-9;]*m/g
const strip = (s: string | undefined): string => (s ?? '').replace(ANSI, '')
const CSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const stripAll = (s: string | undefined): string => (s ?? '').replace(CSI, '')

// The size every App test renders at unless it says otherwise. Fixed rather
// than read from the terminal running the tests: Ink falls back to the real
// terminal's rows when a stream has none, and a layout test that passes in a
// tall window and fails in CI has proved nothing.
export const DEFAULT_SIZE = { columns: 120, rows: 40 }

const mounted: Instance[] = []

// ink-testing-library's renderer, rebuilt on these fakes because its stdout is
// fixed at 100 columns with no rows, which cannot test a breakpoint or the
// minimum size.
export function render(tree: ReactElement, size: { columns: number; rows: number } = DEFAULT_SIZE) {
  const stdout = new FakeStdout(size.columns, size.rows)
  const stderr = new FakeStdout(size.columns, size.rows)
  const stdin = new FakeStdin()
  const instance = inkRender(tree, {
    stdout: stdout.asStream(),
    stderr: stderr.asStream(),
    stdin: stdin.asStream(),
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  mounted.push(instance)
  return {
    stdin,
    unmount: instance.unmount,
    rerender: instance.rerender,
    resize: (columns: number, rows: number) => stdout.resize(columns, rows),
    lastFrame: (): string => strip(stdout.rawLast()),
    get frames(): string[] {
      return stdout.frames.map(strip)
    },
  }
}

export function cleanup(): void {
  for (const instance of mounted.splice(0)) {
    instance.unmount()
    instance.cleanup()
  }
}

// Minimal stand-ins for process.stdin/stdout, modelled on ink-testing-library's, for driving runTui().
export class FakeStdout extends EventEmitter {
  isTTY = true
  readonly frames: string[] = []
  private last: string | undefined
  private raw: string | undefined
  constructor(
    public columns = 100,
    public rows = 30,
  ) {
    super()
  }
  resize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.emit('resize')
  }
  rawLast = (): string | undefined => this.raw
  // Ink writes cursor and synchronized-output markers as separate chunks around each frame;
  // only chunks with visible text count as frames.
  // How long a write takes to be flushed, as a pipe to a slow reader can.
  // The callback fires then, and `flushed` records which chunks had.
  flushDelayMs = 0
  readonly flushed: string[] = []
  write = (chunk: string, encodingOrCallback?: unknown, callback?: unknown): boolean => {
    this.frames.push(chunk)
    this.raw = chunk
    if (stripAll(chunk).trim().length > 0) this.last = stripAll(chunk)
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    setTimeout(() => {
      this.flushed.push(chunk)
      if (typeof done === 'function') (done as () => void)()
    }, this.flushDelayMs)
    return true
  }
  lastFrame = (): string | undefined => this.last
  asStream(): NodeJS.WriteStream {
    return this as unknown as NodeJS.WriteStream
  }
}

export class FakeStdin extends EventEmitter {
  isTTY = true
  private data: string | null = null
  write = (data: string): void => {
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
  asStream(): NodeJS.ReadStream {
    return this as unknown as NodeJS.ReadStream
  }
}

export const keys = {
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  enter: '\r',
  backspace: '\x7f',
  esc: '\x1b',
  tab: '\t',
  pageUp: '\u001b[5~',
  pageDown: '\u001b[6~',
}

// Opens a screen the way a person would: by its hotkey, and its submenu's
// first. Derived from the menu tree, so moving an item between submenus moves
// every test that reaches it.
export async function openFromHome(stdin: { write(data: string): void }, id: ScreenId): Promise<void> {
  const entry = walk().find((e) => e.node.id === id)
  if (!entry) throw new Error(`no menu entry for ${id}`)
  await tick()
  for (const key of entry.keys) {
    stdin.write(key)
    await tick()
  }
}

export const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Ink holds a bare ESC for 20ms to disambiguate it from escape sequences.
export const ESC_DELAY = 40

export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await tick(5)
  }
}

export async function waitForText(frame: () => string | undefined, text: string | RegExp): Promise<void> {
  const matches = (): boolean => {
    const f = frame() ?? ''
    return typeof text === 'string' ? f.includes(text) : text.test(f)
  }
  try {
    await waitFor(matches)
  } catch {
    throw new Error(`waitForText: ${String(text)} not found in frame:\n${frame()}`)
  }
  // Ink re-attaches its stdin listener in a passive effect after the frame is painted;
  // input written before that effect flushes would be dropped.
  await tick()
}

// Whitespace collapsed, and terminal hyperlinks reduced to their text, so a
// label that is also a link still reads as the label.
export const flat = (frame: string | undefined): string =>
  (frame ?? '').replace(/\u001b\]8;;[^\u0007]*\u0007/g, '').replace(/\s+/g, ' ')

export interface Home {
  path: string
  cleanup(): Promise<void>
}

const savedEnv = { ...process.env }

export async function makeHome(): Promise<Home> {
  const path = await mkdtemp(join(tmpdir(), 'polyglots-tui-'))
  process.env.POLYGLOTS_HOME = path
  delete process.env.DEEPL_API_KEY
  delete process.env.OPENAI_API_KEY
  return {
    path,
    cleanup: async () => {
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
      Object.assign(process.env, savedEnv)
      delete process.env.POLYGLOTS_HOME
      await rm(path, { recursive: true, force: true })
    },
  }
}

export function summaryOf(file: string, patch: Partial<TranslateSummary> = {}): TranslateSummary {
  return { file, total: 10, pending: 4, fromTm: 1, translated: 3, fuzzy: 1, skipped: 0, ...patch }
}

export function scriptedTranslate(events: (file: string) => TranslateEvent[]): TuiCommands['translateFile'] {
  return async (opts: TranslateOptions) => {
    let summary: TranslateSummary = summaryOf(opts.file)
    for (const e of events(opts.file)) {
      if (e.type === 'done') summary = e.summary
      opts.onProgress?.(e)
      await tick()
    }
    return summary
  }
}

export function reviewSummaryOf(file: string, patch: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    file,
    locale: 'tr',
    total: 10,
    skipped: 2,
    reviewed: 8,
    problems: 3,
    needsReview: 0,
    approvable: 5,
    unreviewed: 0,
    repaired: 1,
    written: 3,
    pending: 0,
    byRule: { 'title-case': 2, glossary: 1 },
    byGroup: { 'title-case': 1 },
    problemsFile: `${file.replace(/\.po$/, '')}-problems.po`,
    ...patch,
  }
}

// A ready agent unless the patch says otherwise. The default fake discovery
// reports both providers usable, so every test that does not care about
// discovery sees the menu behave as it did before discovery existed.
export function agentStatus(provider: ReviewProvider, patch: Partial<AgentStatus> = {}): AgentStatus {
  const bin = provider === 'claude' ? 'claude' : 'agy'
  return {
    provider,
    bin,
    binSource: 'default',
    path: `/opt/bin/${bin}`,
    version: `${bin} 1.0.0`,
    auth: { state: 'signed-in' },
    setup: { state: 'ok' },
    usable: true,
    notes: [],
    ...patch,
  }
}

export function unusableAgent(provider: ReviewProvider, reason: string): AgentStatus {
  const status = agentStatus(provider, { usable: false, reason, auth: { state: 'unknown', detail: 'not checked' } })
  delete status.path
  delete status.version
  return status
}

// An Ollama server holding the default draft model unless the patch says
// otherwise, so a test that does not care about local models sees the
// configured one installed.
export function modelServer(patch: Partial<ModelServer> = {}): ModelServer {
  return {
    target: { baseUrl: 'http://localhost:11434', kind: 'ollama', label: 'Ollama', source: 'default' },
    state: 'up',
    kind: 'ollama',
    selectable: true,
    models: [{ name: `${DEFAULT_QWEN_MODEL}`, model: `${DEFAULT_QWEN_MODEL}`, size: 17_200_000_000, parameterSize: '27B', quantization: 'Q4_K_M' }],
    ...patch,
  }
}

export function fakeCommands(overrides: Partial<TuiCommands> = {}): TuiCommands {
  return {
    writeStats: vi.fn(async (opts: StatsOptions = {}) => ({
      file: opts.out ?? 'polyglots-stats.html',
      submissions: 4,
      entries: 120,
      incomplete: 0,
      translateRuns: 2,
      translateEntries: 900,
      flagged: 12,
      weeks: [10, 30, 80],
      topProjects: [],
    })),
    translateFile: vi.fn(async (opts: TranslateOptions) => {
      const summary = summaryOf(opts.file)
      opts.onProgress?.({ type: 'start', file: opts.file, total: summary.total, pending: summary.pending })
      opts.onProgress?.({ type: 'done', summary })
      return summary
    }),
    importTmx: vi.fn(async (files: string[], opts: TmImportOptions) => {
      for (const file of files) opts.onProgress?.({ file, entries: 3, upserted: 2 })
      return { files: files.length, entries: 3 * files.length, upserted: 2 * files.length }
    }),
    syncGlossary: vi.fn(async () => ({ entries: 42 })),
    splitPo: vi.fn(async (opts: SplitOptions) => ({
      file: opts.file,
      dir: opts.file.replace(/\.po$/, '-split'),
      entries: 10,
      size: opts.size,
      parts: [{ file: 'part-01.po', entries: opts.size }],
      leftBehind: [],
    })),
    reviewFile: vi.fn(async (opts: ReviewFileOptions) => {
      const summary = reviewSummaryOf(opts.file)
      opts.onProgress?.({ type: 'start', file: opts.file, total: summary.total, reviewable: summary.reviewed })
      opts.onProgress?.({ type: 'done', summary })
      return summary
    }),
    // Every slug resolves as a theme with work, and every download succeeds.
    // The network is never touched: a test that wants another answer passes one.
    resolveProjects: vi.fn(async (refs: ProjectRef[], opts: { status: FetchStatus }) =>
      refs.map((r): Resolution => ({ input: r.slug, state: 'ready', type: 'wp-themes', slug: r.slug, count: opts.status === 'waiting' ? 5 : 3 })),
    ),
    fetchProjects: vi.fn(async (ready: Ready[], opts: { outDir: string }) =>
      ready.map((p): Fetched => ({ input: p.input, state: 'fetched', file: join(opts.outDir, `${p.type}-${p.slug}-tr.po`) })),
    ),
    // Never touches the memory: a test of the screen must not read polyglots.db.
    exportTm: vi.fn(async (opts: ExportTmOptions) => ({
      entries: 120,
      dropped: opts.format === 'po' ? 7 : 0,
      text: '',
      ...(opts.file === undefined ? {} : { file: opts.file }),
    })),
    // Never the real discovery: a TUI test must not spawn whatever agent CLI
    // happens to be installed.
    discoverAgents: vi.fn(async () => [agentStatus('claude'), agentStatus('antigravity')]),
    // Never the real probes either: a TUI test must not send a request to
    // whatever happens to be listening on 11434.
    discoverModels: vi.fn(async () => [modelServer()]),
    checkLocalModel: vi.fn(
      async (target: { kind?: 'ollama' | 'openai-compatible'; baseUrl: string; model: string }): Promise<ModelCheck> => ({
        state: 'installed',
        ...target,
      }),
    ),
    loadConfig,
    saveConfig,
    loadSecrets,
    saveSecret,
    ...memoryTuiState(),
    // Never polyglots.db: the status line is fed these, not the real memory.
    glossaryCount: vi.fn(() => 0),
    hasLocaleRules: vi.fn(() => false),
    localeConfigured: vi.fn(() => false),
    startStatsServer: vi.fn(async () => ({ url: 'http://127.0.0.1:4321/t0k3n/', port: 4321, close: vi.fn(async () => {}) })),
    stopOwnRuns: vi.fn(() => 0),
    openInBrowser: vi.fn(async () => true),
    ...overrides,
  }
}

// tui.json held in memory, with the wizard already dismissed: a test of a
// screen should land on home, not on setup. A wizard test passes its own.
export function memoryTuiState(initial: TuiState = { ...DEFAULT_TUI_STATE, wizard: { ...DEFAULT_TUI_STATE.wizard, dismissed: true } }) {
  let state = initial
  return {
    loadTuiState: vi.fn(() => state),
    saveTuiState: vi.fn((next: TuiState) => {
      state = next
    }),
  }
}
