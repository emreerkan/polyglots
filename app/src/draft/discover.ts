import { z } from 'zod'
import { loadConfig } from '../config.js'
import type { LocalServerKind, PolyglotsConfig } from '../types.js'
import { DEFAULT_QWEN_BASE_URL } from './qwen.js'
import { normalizeBaseUrl, serverBaseUrl } from './local-chat.js'
import { excerpt } from '../logs/excerpt.js'

export { normalizeBaseUrl, serverBaseUrl }

/**
 * Which local model servers are listening, and what they hold.
 *
 * Read-only by design, and only ever a model listing: `GET /api/tags` for
 * Ollama, `GET /v1/models` for anything OpenAI-compatible. Nothing here sends
 * a chat or a completion, so nothing loads a model into memory, and listing is
 * free and instant. That is why there is no `--live` counterpart to doctor.
 *
 * Nothing here is passed into a translate or a review either. The model a run
 * uses is still read from config inside the run, so discovery cannot move a
 * draft engine id or a cache key.
 */

export type ServerKind = LocalServerKind

export interface LocalModel {
  // Ollama's `name`, or the OpenAI `id`.
  name: string
  // Ollama's `model`, which can differ from `name` for an alias. Kept because
  // the configured model may have been written as either.
  model?: string
  // Bytes on disk. Ollama only.
  size?: number
  parameterSize?: string
  quantization?: string
  family?: string
  // The context the server was started with, in tokens, when it says. Only
  // vLLM's listing does (max_model_len); nothing is guessed for the rest.
  contextLength?: number
}

export interface ServerTarget {
  baseUrl: string
  // Known from the port for a default target. Unset for a configured server,
  // whose kind is found by asking it.
  kind?: ServerKind
  label: string
  source: 'default' | 'config'
}

export interface ModelServer {
  target: ServerTarget
  state: 'up' | 'down' | 'not-a-model-server'
  kind?: ServerKind
  models: LocalModel[]
  // One line, e.g. "not running", "timed out after 1.5s", "HTTP 404".
  error?: string
  // Whether a model listed here can be chosen. Every server that is up
  // qualifies since #5: a choice is saved with its kind and server, so the run
  // asks the server that listed it, in that server's own protocol.
  selectable: boolean
}

export interface ModelCheck {
  state: 'installed' | 'missing' | 'unreachable'
  // Set by checkLocalModel. checkOllamaModel predates the second kind.
  kind?: ServerKind
  model: string
  baseUrl: string
  // From the server's listing, when it reports one; see LocalModel.
  contextLength?: number
  // Set unless installed. Names the pull command or `ollama serve`.
  message?: string
}

export interface DiscoverModelsDeps {
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface DiscoverModelsOptions extends DiscoverModelsDeps {
  config?: Pick<PolyglotsConfig, 'ollama' | 'localModelServers'>
  refresh?: boolean
}

const DEFAULT_TIMEOUT_MS = 1_500
const LM_STUDIO_BASE_URL = 'http://localhost:1234'
const LLAMA_CPP_BASE_URL = 'http://localhost:8080'

const OllamaTagsSchema = z.object({
  models: z.array(
    z.looseObject({
      name: z.string(),
      model: z.string().optional(),
      size: z.number().optional(),
      details: z
        .looseObject({
          parameter_size: z.string().optional(),
          quantization_level: z.string().optional(),
          family: z.string().optional(),
        })
        .nullish(),
    }),
  ),
})

const OpenAiModelsSchema = z.object({
  data: z.array(z.looseObject({ id: z.string(), max_model_len: z.number().int().positive().optional().catch(undefined) })),
})

export function defaultTargets(config: Pick<PolyglotsConfig, 'ollama' | 'localModelServers'>): ServerTarget[] {
  const candidates: ServerTarget[] = [
    { baseUrl: config.ollama.baseUrl, kind: 'ollama', label: 'Ollama', source: 'default' },
    // Also the stock address when the configured one is elsewhere: someone who
    // pointed polyglots at a LAN box may still have a local Ollama, and the
    // listing is where they would find that out.
    { baseUrl: DEFAULT_QWEN_BASE_URL, kind: 'ollama', label: 'Ollama', source: 'default' },
    { baseUrl: LM_STUDIO_BASE_URL, kind: 'openai-compatible', label: 'LM Studio', source: 'default' },
    // 8080 is a common dev-server port too. A GET on /v1/models there is
    // harmless, and an answer that is not a model list reads as "not a model
    // server", never as an error.
    { baseUrl: LLAMA_CPP_BASE_URL, kind: 'openai-compatible', label: 'llama.cpp server', source: 'default' },
    ...config.localModelServers.map((baseUrl): ServerTarget => ({ baseUrl, label: 'Configured server', source: 'config' })),
  ]
  const seen = new Set<string>()
  const targets: ServerTarget[] = []
  for (const candidate of candidates) {
    const baseUrl = normalizeBaseUrl(candidate.baseUrl)
    if (seen.has(baseUrl)) continue
    seen.add(baseUrl)
    targets.push({ ...candidate, baseUrl })
  }
  return targets
}

interface Probe {
  fetch: typeof fetch
  timeoutMs: number
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

// Reads undici's cause code rather than the message, which is only ever
// "fetch failed" and says nothing about why.
function describeFailure(err: unknown, timeoutMs: number): string {
  if (isTimeout(err)) return `timed out after ${timeoutMs / 1000}s`
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause
  if (cause?.code === 'ECONNREFUSED') return 'not running'
  if (typeof cause?.code === 'string') return cause.code
  return firstLine(err instanceof Error ? err.message : String(err))
}

function firstLine(text: string): string {
  return excerpt(text.split(/\r?\n/)[0]!, 200)
}

type Listing =
  | { state: 'up'; kind: ServerKind; models: LocalModel[] }
  | { state: 'down' | 'not-a-model-server'; error: string }

async function list(baseUrl: string, kind: ServerKind, probe: Probe): Promise<Listing> {
  const url = `${baseUrl}${kind === 'ollama' ? '/api/tags' : '/v1/models'}`
  let body: unknown
  try {
    const response = await probe.fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(probe.timeoutMs),
    })
    if (!response.ok) {
      // Drained so the socket is released rather than held until GC.
      await response.body?.cancel().catch(() => {})
      return { state: 'not-a-model-server', error: `HTTP ${response.status}` }
    }
    try {
      body = await response.json()
    } catch (err) {
      // The timeout signal covers the body too, so a listener that sends
      // headers and then stalls is down, not malformed.
      if (isTimeout(err)) return { state: 'down', error: describeFailure(err, probe.timeoutMs) }
      return { state: 'not-a-model-server', error: 'answer is not JSON' }
    }
  } catch (err) {
    return { state: 'down', error: describeFailure(err, probe.timeoutMs) }
  }
  if (kind === 'ollama') {
    const parsed = OllamaTagsSchema.safeParse(body)
    if (!parsed.success) return { state: 'not-a-model-server', error: 'not a model listing' }
    return {
      state: 'up',
      kind,
      models: parsed.data.models.map((m) => ({
        name: m.name,
        ...(m.model === undefined ? {} : { model: m.model }),
        ...(m.size === undefined ? {} : { size: m.size }),
        ...(m.details?.parameter_size === undefined ? {} : { parameterSize: m.details.parameter_size }),
        ...(m.details?.quantization_level === undefined ? {} : { quantization: m.details.quantization_level }),
        ...(m.details?.family === undefined ? {} : { family: m.details.family }),
      })),
    }
  }
  const parsed = OpenAiModelsSchema.safeParse(body)
  if (!parsed.success) return { state: 'not-a-model-server', error: 'not a model listing' }
  return {
    state: 'up',
    kind,
    models: parsed.data.data.map((m) => ({ name: m.id, ...(m.max_model_len === undefined ? {} : { contextLength: m.max_model_len }) })),
  }
}

async function probeTarget(target: ServerTarget, probe: Probe): Promise<ModelServer> {
  let listing: Listing
  if (target.kind) {
    listing = await list(target.baseUrl, target.kind, probe)
  } else {
    // /api/tags first, because it is the only listing that carries size,
    // parameter size and quantisation, and Ollama answers /v1/models as well.
    // A server that did not answer at all is not asked twice: the second
    // request would be refused or time out the same way, and doubles the wait.
    listing = await list(target.baseUrl, 'ollama', probe)
    if (listing.state === 'not-a-model-server') listing = await list(target.baseUrl, 'openai-compatible', probe)
  }
  if (listing.state === 'up') {
    return { target, state: 'up', kind: listing.kind, models: listing.models, selectable: true }
  }
  return { target, state: listing.state, models: [], error: listing.error, selectable: false }
}

interface Cached {
  key: string
  fetch: typeof fetch
  run: Promise<ModelServer[]>
}

let cached: Cached | undefined

/**
 * Every target, probed in parallel, so the worst case is one timeout (two for
 * a configured server whose first answer was not a listing), not the sum.
 *
 * Memoised per process like discoverAgents, and cleared with `refresh`. The
 * memo is keyed by the target list and the fetch it was made with, so a
 * changed server list is never served the old answer, and two callers with
 * different fetches (two tests, in practice) never see each other's. Never
 * rejects for a probe: every target becomes a ModelServer.
 *
 * It does reject when no config was passed and the saved one will not load,
 * and that has to be a rejection rather than a throw. The function is not
 * async, because the memo hands back the very promise it kept, so a throw from
 * loadConfig would leave before any promise existed and skip every .then a
 * caller had chained. The Local models screen calls it from an effect, and a
 * throw there takes Ink down, on a config the rest of the TUI had already
 * survived by falling back to the defaults.
 */
export function discoverModels(opts: DiscoverModelsOptions = {}): Promise<ModelServer[]> {
  const fetchImpl = opts.fetch ?? globalThis.fetch
  let config: Pick<PolyglotsConfig, 'ollama' | 'localModelServers'>
  try {
    config = opts.config ?? loadConfig()
  } catch (err) {
    return Promise.reject(err)
  }
  const targets = defaultTargets(config)
  const key = JSON.stringify(targets)
  if (!opts.refresh && cached && cached.key === key && cached.fetch === fetchImpl) return cached.run
  const probe = { fetch: fetchImpl, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS }
  const run = Promise.all(targets.map((t) => probeTarget(t, probe)))
  const entry = { key, fetch: fetchImpl, run }
  cached = entry
  // Unreachable while every probe settles to a ModelServer, which is the
  // contract above. Kept so that a probe which one day throws costs a single
  // failed check, rather than a rejection served from the memo until the
  // person thinks to press r.
  run.catch(() => {
    if (cached === entry) cached = undefined
  })
  return run
}

/**
 * Whether the configured Ollama answers and holds the configured model.
 *
 * Reuses the memoised discovery only when it found that server up. A cached
 * "down" is asked again, because the person may well have started Ollama
 * since, and a warning built on a stale failure is the worse mistake.
 */
export async function checkOllamaModel(ollama: { baseUrl: string; model: string }, deps: DiscoverModelsDeps = {}): Promise<ModelCheck> {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const baseUrl = normalizeBaseUrl(ollama.baseUrl)
  let server: ModelServer | undefined
  if (cached && cached.fetch === fetchImpl) {
    const servers = await cached.run.catch(() => undefined)
    server = servers?.find((s) => s.target.baseUrl === baseUrl && s.state === 'up' && s.kind === 'ollama')
  }
  server ??= await probeTarget(
    { baseUrl, kind: 'ollama', label: 'Ollama', source: 'default' },
    { fetch: fetchImpl, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  )
  const base = { model: ollama.model, baseUrl }
  if (server.state !== 'up' || server.kind !== 'ollama') {
    const reason = server.error ?? 'not an Ollama server'
    return { ...base, state: 'unreachable', message: `Ollama is not reachable at ${baseUrl} (${reason}). Start it with: ollama serve` }
  }
  if (server.models.some((m) => matchesModel(ollama.model, m))) return { ...base, state: 'installed' }
  const family = stripTag(ollama.model)
  const siblings = server.models
    .map((m) => m.name)
    .filter((name) => stripTag(name) === family)
    .map(sanitizeDisplay)
  // The pull command goes last, so it is the thing at the end of the line to
  // copy, with no full stop welded onto it.
  const installed = siblings.length > 0 ? ` Installed: ${siblings.join(', ')}.` : ''
  return {
    ...base,
    state: 'missing',
    message: `${ollama.model} is not installed in Ollama at ${baseUrl}.${installed} Pull it with: ${pullCommand(ollama.model, baseUrl)}`,
  }
}

/**
 * Whether the local target a run will use answers and holds its model, for
 * either kind of server. Warns and never refuses, like checkOllamaModel, whose
 * answer it returns for an Ollama target. A target with no kind is Ollama,
 * which is what a caller from before the second kind means.
 *
 * An OpenAI-compatible model id is matched exactly. There is no implicit tag
 * to apply, and a near miss is the server's naming, not ours to second-guess.
 */
export async function checkLocalModel(
  target: { kind?: ServerKind; baseUrl: string; model: string },
  deps: DiscoverModelsDeps = {},
): Promise<ModelCheck> {
  const kind = target.kind ?? 'ollama'
  if (kind === 'ollama') {
    const check = await checkOllamaModel(target, deps)
    return { ...check, kind }
  }
  const fetchImpl = deps.fetch ?? globalThis.fetch
  // Probed without the API version: list() adds /v1/models itself, and LM
  // Studio's documentation has people type the base URL with /v1 on it.
  const baseUrl = serverBaseUrl(target.baseUrl)
  let server: ModelServer | undefined
  if (cached && cached.fetch === fetchImpl) {
    const servers = await cached.run.catch(() => undefined)
    server = servers?.find((s) => s.target.baseUrl === baseUrl && s.state === 'up' && s.kind === kind)
  }
  server ??= await probeTarget(
    { baseUrl, kind, label: 'OpenAI-compatible server', source: 'config' },
    { fetch: fetchImpl, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  )
  const base = { kind, model: target.model, baseUrl }
  if (server.state !== 'up') {
    return {
      ...base,
      state: 'unreachable',
      message: `No OpenAI-compatible server answers at ${baseUrl} (${server.error ?? 'not a model server'}). Start LM Studio's server, llama-server or vllm serve there.`,
    }
  }
  const found = server.models.find((m) => m.name === target.model)
  if (found) return { ...base, state: 'installed', ...(found.contextLength === undefined ? {} : { contextLength: found.contextLength }) }
  const served = server.models.map((m) => sanitizeDisplay(m.name))
  return {
    ...base,
    state: 'missing',
    message: `${target.model} is not served at ${baseUrl}.${served.length > 0 ? ` Served: ${served.join(', ')}.` : ' It serves no models.'}`,
  }
}

// A tag is a colon after the last slash: `registry:5000/name` has a port, not
// a tag, and still means `:latest`.
const TAGGED = /:[^/]*$/

function withTag(name: string): string {
  return TAGGED.test(name) ? name : `${name}:latest`
}

function stripTag(name: string): string {
  return name.replace(TAGGED, '')
}

/**
 * Ollama's own reading of a name: no tag means `:latest`, and otherwise the
 * match is exact and case-sensitive, as Ollama stores names. Compared against
 * `model` as well as `name`, since either may be what was configured.
 */
export function matchesModel(configured: string, listed: LocalModel): boolean {
  const want = withTag(configured)
  return [listed.name, listed.model].some((n) => n !== undefined && withTag(n) === want)
}

function isDefaultOllamaHost(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    // Both spellings of loopback, because the ollama CLI's own default is
    // 127.0.0.1 and polyglots' is localhost: either way a bare pull lands on
    // the server the run will ask.
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
      url.port === '11434' &&
      url.pathname.replace(/\/+$/, '') === ''
    )
  } catch {
    return false
  }
}

function shellWord(word: string): string {
  return /^[\w.:/@+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/**
 * The command that pulls `model` onto the server the run will ask. Without
 * OLLAMA_HOST for a non-default server, the pull would land on whatever
 * machine it was typed on, and the run would go on not finding it.
 */
export function pullCommand(model: string, baseUrl: string): string {
  const pull = `ollama pull ${shellWord(model)}`
  return isDefaultOllamaHost(baseUrl) ? pull : `OLLAMA_HOST=${shellWord(normalizeBaseUrl(baseUrl))} ${pull}`
}

/**
 * Text from whatever is listening on a port, made safe to print. Escape
 * sequences go whole, so a hostile or broken listener cannot recolour or move
 * the terminal; any C0 or C1 control left after that goes too.
 */
export function sanitizeDisplay(text: string): string {
  return text.replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-_]?/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, '')
}

/** Decimal units, as Ollama's own CLI shows them, so the numbers agree. */
export function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`
  return `${bytes} B`
}

/**
 * What to call a server once it has answered. A configured URL has no name
 * until then, and afterwards is named by what it turned out to be.
 */
export function serverLabel(server: ModelServer): string {
  if (server.target.source === 'default' || server.kind === undefined) return server.target.label
  return server.kind === 'ollama' ? 'Ollama' : 'OpenAI-compatible server'
}

/** The one line the CLI and the menu both print for a server that is not up. */
export function unavailableLine(server: ModelServer): string {
  const where = `${server.target.label} (${server.target.baseUrl})`
  const reason = sanitizeDisplay(server.error ?? '')
  if (server.state === 'not-a-model-server') return `Not a model server: ${where}${reason ? `: ${reason}` : ''}`
  if (reason === 'not running') return `Not running: ${where}`
  return `Not reachable: ${where}${reason ? `: ${reason}` : ''}`
}

/** Size, parameter size and quantisation, sanitised, blank where unknown. */
export function modelFacts(model: LocalModel): [string, string, string] {
  return [
    model.size === undefined ? '' : formatSize(model.size),
    sanitizeDisplay(model.parameterSize ?? ''),
    sanitizeDisplay(model.quantization ?? ''),
  ]
}

/** The kind's name, as the CLI and the menu print it beside a model. */
export function kindLabel(kind: ServerKind): string {
  return kind === 'ollama' ? 'Ollama' : 'OpenAI-compatible'
}
