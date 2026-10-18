import type { DraftEngineName, LocalServerKind, LocalServerSettings, PolyglotsConfig } from '../types.js'
import { excerpt } from '../logs/excerpt.js'

/**
 * Talking to a model on a local server: Ollama's own API, or the
 * OpenAI-compatible one that LM Studio, llama.cpp's server and vLLM speak.
 *
 * One request shape for both, so the draft engine and the local reviewer say
 * what they want (a system prompt, a user prompt, a JSON schema for the reply)
 * and never which server is listening. What differs between the two is wire
 * format only, and that lives here.
 *
 * Both transports always stream. Node's fetch abandons a request after 300s
 * without response headers, and a local server sends none until the whole
 * generation is finished, so a non-streamed call dies at exactly five minutes
 * on any batch worth sending. That cost a benchmark run to learn. Streaming
 * makes the headers arrive at once; the deltas themselves are incidental.
 */

export interface LocalTarget {
  kind: LocalServerKind
  baseUrl: string
  model: string
  contextLength?: number
}

export interface LocalChatRequest {
  // Optional: the review prompts are one block, written for an agent's stdin,
  // and splitting them would be a second copy of where the line falls.
  system?: string
  user: string
  // Sent as the server's structured-output format. Steers the reply; the
  // caller still validates it, because a schema is a request and not a promise.
  schema: unknown
  // OpenAI's json_schema format requires a name. Ollama ignores it.
  schemaName: string
}

/** Returns the assistant's whole reply, accumulated from the stream. */
export type LocalChat = (request: LocalChatRequest) => Promise<string>

/**
 * The server stopped because it ran out of room, not because it finished.
 *
 * Its own class so the message can say what to do. Without it the half-written
 * reply fails to parse as JSON, and the error names a syntax problem in text
 * nobody can see rather than a batch too big for the context.
 */
// Names no model: every caller already prefixes the one it asked, and saying
// it here too printed it twice.
export class LocalReplyTruncatedError extends Error {
  override readonly name = 'LocalReplyTruncatedError'
  constructor(detail = 'the reply was cut off before it finished') {
    super(`${detail}; use a smaller batch or a larger context`)
  }
}

// The stream closed without the server saying it had finished: a dropped
// connection or a crashed runner, whose partial reply must not be parsed as if
// it were the whole one.
const ENDED_EARLY = 'the stream ended before the server said it was done'

/** What a server put in an error frame, as one line. */
function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : JSON.stringify(error)
}

// --- Ollama ---------------------------------------------------------------

export interface QwenChatMessage {
  role: 'system' | 'user'
  content: string
}

export interface QwenChatBody {
  model: string
  // Always true; see the note at the top of this file.
  stream: true
  think: false
  format: unknown
  messages: QwenChatMessage[]
  // Only when a context length is configured. Ollama's own default is small,
  // and a prompt longer than it is truncated without a word, so the setting is
  // what makes a configured context true rather than advisory.
  options?: { num_ctx: number }
}

/** The Ollama transport. Named for the engine it first served; see qwen.ts. */
export interface QwenClientLike {
  chat(body: QwenChatBody): Promise<string>
}

// --- OpenAI-compatible ----------------------------------------------------

export interface OpenAICompatibleChatBody {
  model: string
  stream: true
  response_format: { type: 'json_schema'; json_schema: { name: string; schema: unknown } }
  messages: QwenChatMessage[]
}

export interface OpenAICompatibleClientLike {
  chat(body: OpenAICompatibleChatBody): Promise<string>
}

interface Transport {
  fetch?: typeof fetch
  // How long the server may say nothing, before headers or between chunks,
  // before the reply is abandoned. Unset means no limit.
  idleTimeoutMs?: number
}

/**
 * How long a local server may be silent, from config, where it is seconds.
 *
 * Silence, not total time. A local model on modest hardware can take many
 * minutes over a batch, and a cap on the whole reply would cut off a slow
 * model that is working. What has to be caught is a server that stops: a
 * runner wedged after a model swap, or a stream left open by a crashed
 * worker, which hung the run with no error until someone noticed. Three
 * minutes by default because the first chunk is the slow one: the model may
 * have to load and the whole prompt is evaluated before any token comes back,
 * which on a CPU-only machine with a full context takes minutes.
 */
export const DEFAULT_LOCAL_IDLE_TIMEOUT_SECONDS = 180

export function localIdleTimeoutMs(config: { localIdleTimeout?: number }): number {
  return (config.localIdleTimeout ?? DEFAULT_LOCAL_IDLE_TIMEOUT_SECONDS) * 1000
}

interface IdleWatch {
  signal: AbortSignal
  // Restarts the silence clock: called on headers and on every chunk.
  arm(): void
  stop(): void
  // Settles with p, or rejects with the timeout if the server goes quiet first.
  race<T>(p: Promise<T>): Promise<T>
  error(): Error | undefined
}

/**
 * Raced against every await on the server rather than left to the abort
 * signal alone. A fetch honours the signal, but nothing obliges every body
 * stream or proxy to, and the failure this exists for is a promise that
 * never settles.
 */
function idleWatch(ms: number | undefined): IdleWatch {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let fired: Error | undefined
  let fail: (error: Error) => void = () => undefined
  const expired = new Promise<never>((_resolve, reject) => {
    fail = reject
  })
  // Nobody may be racing at the moment it fires; that is not unhandled.
  expired.catch(() => undefined)
  const arm = () => {
    if (ms === undefined) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      fired = new LocalReplyTruncatedError(
        `the server sent nothing for ${ms / 1000}s, so the reply was abandoned (polyglots config set localIdleTimeout <seconds> if the model is only slow)`,
      )
      // Rejected before the abort, so a race sees the timeout rather than the
      // AbortError the abort sets off in the fetch.
      fail(fired)
      controller.abort(fired)
    }, ms)
  }
  arm()
  return {
    signal: controller.signal,
    arm,
    stop: () => clearTimeout(timer),
    race: (p) => Promise.race([p, expired]),
    error: () => fired,
  }
}

/** Runs one exchange under an idle watch, reporting a stall as itself. */
async function watched(ms: number | undefined, exchange: (watch: IdleWatch) => Promise<string>): Promise<string> {
  const watch = idleWatch(ms)
  try {
    return await exchange(watch)
  } catch (err) {
    throw watch.error() ?? err
  } finally {
    watch.stop()
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * A base URL in the one spelling targets are compared by: scheme and host
 * lowercased (the URL parser does both), trailing slashes gone, query and
 * fragment dropped. `localhost` and `127.0.0.1` stay distinct on purpose,
 * because they can be two different listeners.
 */
export function normalizeBaseUrl(raw: string): string {
  try {
    const url = new URL(raw.trim())
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return trimSlash(raw.trim())
  }
}

/**
 * The server's root, without the API version an OpenAI-compatible URL may be
 * typed with. LM Studio documents `http://localhost:1234/v1`, llama.cpp
 * `http://localhost:8080`, and both are a server root to a person typing one.
 * The one place that decides it, for the request URL, the engine id,
 * discovery's comparisons and the CLI and menu markers.
 */
export function serverBaseUrl(raw: string): string {
  return normalizeBaseUrl(raw).replace(/\/v1$/, '')
}

async function failure(res: Response): Promise<Error> {
  // A short excerpt of what the server said, because a 400 from LM Studio
  // ("no model loaded") or vLLM (a schema it cannot compile) explains itself
  // only in the body.
  const said = excerpt((await res.text().catch(() => '')).trim(), 200)
  const status = [`HTTP ${res.status}`, res.statusText].filter(Boolean).join(' ')
  return new Error(said ? `${status}: ${said}` : status)
}

/**
 * Lines from a streamed body, split however the socket delivered them. A
 * partial line is held until the next chunk completes it.
 */
async function* lines(res: Response, watch: IdleWatch): AsyncGenerator<string> {
  if (!res.body) throw new Error('response had no body')
  // One decoder for the whole stream, in streaming mode: a multibyte character
  // ("ı", "ş") cut between two reads is held until its last byte arrives.
  // Decoding each chunk on its own turned both halves into U+FFFD.
  const decoder = new TextDecoder('utf-8')
  let buffered = ''
  // Read by hand rather than with for await, so each read can be raced
  // against the idle watch.
  const reader = res.body.getReader()
  try {
    for (;;) {
      const read = await watch.race(reader.read())
      if (read.done) break
      watch.arm()
      buffered += decoder.decode(read.value, { stream: true })
      const parts = buffered.split('\n')
      buffered = parts.pop() ?? ''
      for (const line of parts) if (line.trim() !== '') yield line
    }
    buffered += decoder.decode()
    if (buffered.trim() !== '') yield buffered
  } finally {
    // Released however the reading ended: a stall, an error frame, or the
    // caller returning on done. for await used to do this on its own, and a
    // stalled socket must not stay open behind an error already reported.
    reader.cancel().catch(() => undefined)
  }
}

export function ollamaTransport(baseUrl: string, deps: Transport = {}): QwenClientLike {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  return {
    chat: (body) =>
      watched(deps.idleTimeoutMs, async (watch) => {
        const res = await watch.race(
          fetchImpl(`${trimSlash(baseUrl)}/api/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: watch.signal,
          }),
        )
        if (!res.ok) throw await watch.race(failure(res))
        watch.arm()

        let text = ''
        for await (const line of lines(res, watch)) {
          let event: { message?: { content?: string }; done?: boolean; done_reason?: string; error?: unknown }
          try {
            event = JSON.parse(line) as typeof event
          } catch {
            continue
          }
          // Ollama reports a failure mid-generation as a line of its own, after
          // a 200 and possibly after content. Swallowing it returned the partial
          // reply as if it were whole.
          if (event.error !== undefined) throw new Error(errorText(event.error))
          text += event.message?.content ?? ''
          if (event.done) {
            if (event.done_reason === 'length') throw new LocalReplyTruncatedError()
            return text
          }
        }
        throw new LocalReplyTruncatedError(ENDED_EARLY)
      }),
  }
}

/**
 * The OpenAI-compatible endpoint, under whichever spelling the base URL was
 * given in. LM Studio documents `http://localhost:1234/v1`, llama.cpp
 * `http://localhost:8080`, and both are the same server to a person typing one.
 */
function chatCompletionsUrl(baseUrl: string): string {
  return `${serverBaseUrl(baseUrl)}/v1/chat/completions`
}

export function openaiCompatibleTransport(baseUrl: string, deps: Transport = {}): OpenAICompatibleClientLike {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  return {
    chat: (body) =>
      watched(deps.idleTimeoutMs, async (watch) => {
        const res = await watch.race(
          fetchImpl(chatCompletionsUrl(baseUrl), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
            body: JSON.stringify(body),
            signal: watch.signal,
          }),
        )
        if (!res.ok) throw await watch.race(failure(res))
        watch.arm()

        let text = ''
        for await (const line of lines(res, watch)) {
          // Server-sent events: only `data:` lines carry anything, and the
          // stream ends on a literal [DONE] rather than on a field. Whatever
          // follows it is not part of this reply.
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') return text
          let event: {
            choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>
            error?: unknown
          }
          try {
            event = JSON.parse(data) as typeof event
          } catch {
            continue
          }
          // llama.cpp and vLLM send a failure after the 200 as an error frame.
          if (event.error !== undefined) throw new Error(errorText(event.error))
          const choice = event.choices?.[0]
          text += choice?.delta?.content ?? ''
          if (choice?.finish_reason === 'length') throw new LocalReplyTruncatedError()
        }
        throw new LocalReplyTruncatedError(ENDED_EARLY)
      }),
  }
}

// --- One request shape for both -------------------------------------------

function messagesOf(request: LocalChatRequest): QwenChatMessage[] {
  return [
    ...(request.system === undefined ? [] : [{ role: 'system' as const, content: request.system }]),
    { role: 'user', content: request.user },
  ]
}

export function chatFromOllama(client: QwenClientLike, model: string, contextLength?: number): LocalChat {
  return (request) =>
    client.chat({
      model,
      stream: true,
      think: false,
      format: request.schema,
      messages: messagesOf(request),
      ...(contextLength === undefined ? {} : { options: { num_ctx: contextLength } }),
    })
}

export function chatFromOpenAICompatible(client: OpenAICompatibleClientLike, model: string): LocalChat {
  return (request) =>
    client.chat({
      model,
      stream: true,
      response_format: { type: 'json_schema', json_schema: { name: request.schemaName, schema: request.schema } },
      messages: messagesOf(request),
    })
}

export function createLocalChat(target: LocalTarget, deps: Transport = {}): LocalChat {
  return target.kind === 'ollama'
    ? chatFromOllama(ollamaTransport(target.baseUrl, deps), target.model, target.contextLength)
    : chatFromOpenAICompatible(openaiCompatibleTransport(target.baseUrl, deps), target.model)
}

// --- Which target, and what it is called ----------------------------------

export type LocalTargetConfig = Pick<PolyglotsConfig, 'localServerKind' | 'ollama' | 'openaiCompatible'>

/**
 * The local server and model a run uses, read once from config.
 *
 * `model` overrides the configured one for this run only. An OpenAI-compatible
 * target with no model is refused here, before a run row or an engine id
 * exists: there is no default an arbitrary server can be assumed to hold, and
 * the alternative is an id ending in a slash and a 404 on batch one.
 */
export function resolveLocalTarget(config: LocalTargetConfig, model?: string): LocalTarget {
  const kind = config.localServerKind ?? 'ollama'
  const settings: LocalServerSettings = kind === 'ollama' ? config.ollama : config.openaiCompatible
  const chosen = (model ?? settings.model).trim()
  if (chosen === '') {
    // Worded by kind: the schema refuses an empty ollama.model, but a per-run
    // override can still be blank, and naming the other key sends the reader
    // to the wrong setting.
    const key = kind === 'ollama' ? 'ollama.model' : 'openaiCompatible.model'
    throw new Error(
      `${key} is not set; pick one with polyglots models, the Local models screen, or polyglots config set ${key} <id>`,
    )
  }
  return {
    kind,
    baseUrl: settings.baseUrl,
    model: chosen,
    ...(settings.contextLength === undefined ? {} : { contextLength: settings.contextLength }),
  }
}

/**
 * The server part of an OpenAI-compatible id: host and port, lowercased by the
 * URL parser, plus any path that is not the API version. The scheme is left
 * out, since http and https on one host and port are one server.
 */
function serverPart(baseUrl: string): string {
  return serverBaseUrl(baseUrl).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
}

/**
 * What a local model is called in the draft cache, and, behind `local:`, in
 * the review caches.
 *
 * Ollama keeps `ollama:<model>` exactly as it was before there was a second
 * kind, because the draft cache is keyed by it and every cached draft must
 * survive the upgrade. Its host was never part of it, and an Ollama name is a
 * registry name and tag that pins the weights, so it does not need one.
 *
 * An OpenAI-compatible model id is whatever that server calls it: llama.cpp
 * reports a file path or an alias, and two servers can serve different
 * quantisations under one name. So the server is part of the id, which errs
 * towards a miss the way the cache always does. Nothing produced an
 * `openai-compatible:` id before, so it cannot collide with one.
 */
export function localModelId(target: Pick<LocalTarget, 'kind' | 'baseUrl' | 'model'>): DraftEngineName {
  return target.kind === 'ollama'
    ? `ollama:${target.model}`
    : `openai-compatible:${serverPart(target.baseUrl)}/${target.model}`
}
