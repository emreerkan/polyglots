import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config.js'
import {
  checkLocalModel,
  checkOllamaModel,
  defaultTargets,
  discoverModels,
  formatSize,
  matchesModel,
  pullCommand,
  sanitizeDisplay,
  type ModelServer,
} from '../../src/draft/discover.js'
import { DEFAULT_QWEN_MODEL } from '../../src/draft/qwen.js'

// Every test here injects fetch. None of them opens a socket: whether the
// machine running the suite happens to have Ollama or LM Studio up must not
// decide whether it passes.

type Answer = { status?: number; body?: unknown; text?: string } | 'refused' | 'timeout'

interface Call {
  url: string
  init: RequestInit | undefined
}

// Errors shaped the way undici throws them, because that shape is what the
// classifier reads.
function refusedError(): Error {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
}

function timeoutError(): Error {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError')
}

// A fetch answering from a URL map. Anything not in the map is refused, which
// is what an empty port does.
function fakeFetch(answers: Record<string, Answer>): typeof fetch & { calls: Call[] } {
  const calls: Call[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const answer = answers[url] ?? 'refused'
    if (answer === 'refused') throw refusedError()
    if (answer === 'timeout') throw timeoutError()
    const text = answer.text ?? JSON.stringify(answer.body ?? {})
    return new Response(text, { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch & { calls: Call[] }
  fn.calls = calls
  return fn
}

const TAGS = {
  models: [
    {
      name: `${DEFAULT_QWEN_MODEL}`,
      model: `${DEFAULT_QWEN_MODEL}`,
      size: 17_200_000_000,
      details: { parameter_size: '27B', quantization_level: 'Q4_K_M', family: 'qwen3' },
      digest: 'abc',
    },
    { name: 'llama3.2:latest', model: 'llama3.2:latest', size: 2_019_393_189 },
  ],
}

const OPENAI_MODELS = { object: 'list', data: [{ id: 'qwen2.5-7b-instruct', object: 'model' }] }

const config = { ollama: DEFAULT_CONFIG.ollama, localModelServers: [] as string[] }

function server(servers: ModelServer[], baseUrl: string): ModelServer {
  const found = servers.find((s) => s.target.baseUrl === baseUrl)
  if (!found) throw new Error(`no server for ${baseUrl}`)
  return found
}

describe('defaultTargets', () => {
  it('lists the three loopback servers for the default config', () => {
    expect(defaultTargets(config)).toEqual([
      { baseUrl: 'http://localhost:11434', kind: 'ollama', label: 'Ollama', source: 'default' },
      { baseUrl: 'http://localhost:1234', kind: 'openai-compatible', label: 'LM Studio', source: 'default' },
      { baseUrl: 'http://localhost:8080', kind: 'openai-compatible', label: 'llama.cpp server', source: 'default' },
    ])
  })

  it('adds the default Ollama URL when the configured one is elsewhere', () => {
    const targets = defaultTargets({ ...config, ollama: { baseUrl: 'http://box:11434', model: 'x' } })
    expect(targets.map((t) => t.baseUrl)).toEqual([
      'http://box:11434',
      'http://localhost:11434',
      'http://localhost:1234',
      'http://localhost:8080',
    ])
    expect(targets[0]!.kind).toBe('ollama')
    expect(targets[1]!.kind).toBe('ollama')
  })

  it('appends configured servers with no kind', () => {
    const targets = defaultTargets({ ...config, localModelServers: ['http://lan-box:11434'] })
    expect(targets.at(-1)).toMatchObject({ baseUrl: 'http://lan-box:11434', source: 'config' })
    expect(targets.at(-1)!.kind).toBeUndefined()
  })

  it('collapses duplicates after normalising, but keeps localhost and 127.0.0.1 apart', () => {
    const targets = defaultTargets({
      ...config,
      ollama: { baseUrl: 'http://localhost:11434/', model: 'x' },
      localModelServers: ['HTTP://LOCALHOST:1234/', 'http://127.0.0.1:11434'],
    })
    expect(targets.map((t) => t.baseUrl)).toEqual([
      'http://localhost:11434',
      'http://localhost:1234',
      'http://localhost:8080',
      'http://127.0.0.1:11434',
    ])
  })
})

describe('discoverModels', () => {
  it('maps the Ollama listing to name, size, parameter size and quantisation', async () => {
    const fetch = fakeFetch({ 'http://localhost:11434/api/tags': { body: TAGS } })
    const servers = await discoverModels({ fetch, config, refresh: true })
    const ollama = server(servers, 'http://localhost:11434')
    expect(ollama).toMatchObject({ state: 'up', kind: 'ollama', selectable: true })
    expect(ollama.models[0]).toEqual({
      name: `${DEFAULT_QWEN_MODEL}`,
      model: `${DEFAULT_QWEN_MODEL}`,
      size: 17_200_000_000,
      parameterSize: '27B',
      quantization: 'Q4_K_M',
      family: 'qwen3',
    })
    // No details at all is an ordinary listing, not a broken one.
    expect(ollama.models[1]).toEqual({ name: 'llama3.2:latest', model: 'llama3.2:latest', size: 2_019_393_189 })
  })

  // Selectable since #5: an OpenAI-compatible model is saved with its kind and
  // server, so the run asks the server that listed it, in its own protocol.
  it('maps an OpenAI-compatible listing to names, and offers it for selection', async () => {
    const fetch = fakeFetch({ 'http://localhost:1234/v1/models': { body: OPENAI_MODELS } })
    const servers = await discoverModels({ fetch, config, refresh: true })
    const lmStudio = server(servers, 'http://localhost:1234')
    expect(lmStudio).toMatchObject({ state: 'up', kind: 'openai-compatible', selectable: true })
    expect(lmStudio.models).toEqual([{ name: 'qwen2.5-7b-instruct' }])
  })

  it('calls a 2xx answer of the wrong shape not a model server', async () => {
    const fetch = fakeFetch({ 'http://localhost:8080/v1/models': { body: { hello: 'vite' } } })
    const s = server(await discoverModels({ fetch, config, refresh: true }), 'http://localhost:8080')
    expect(s.state).toBe('not-a-model-server')
    expect(s.models).toEqual([])
    expect(s.selectable).toBe(false)
  })

  it('calls a non-JSON 2xx answer not a model server', async () => {
    const fetch = fakeFetch({ 'http://localhost:8080/v1/models': { text: '<!doctype html><p>dev server</p>' } })
    const s = server(await discoverModels({ fetch, config, refresh: true }), 'http://localhost:8080')
    expect(s.state).toBe('not-a-model-server')
  })

  it('calls a 404 not a model server, naming the status', async () => {
    const fetch = fakeFetch({ 'http://localhost:8080/v1/models': { status: 404, text: 'Not Found' } })
    const s = server(await discoverModels({ fetch, config, refresh: true }), 'http://localhost:8080')
    expect(s.state).toBe('not-a-model-server')
    expect(s.error).toBe('HTTP 404')
  })

  it('reports a refused connection as not running', async () => {
    const fetch = fakeFetch({})
    const s = server(await discoverModels({ fetch, config, refresh: true }), 'http://localhost:11434')
    expect(s).toMatchObject({ state: 'down', error: 'not running', selectable: false, models: [] })
  })

  it('reports a timeout with the limit it waited', async () => {
    const fetch = fakeFetch({ 'http://localhost:11434/api/tags': 'timeout' })
    const s = server(await discoverModels({ fetch, config, refresh: true }), 'http://localhost:11434')
    expect(s).toMatchObject({ state: 'down', error: 'timed out after 1.5s' })
  })

  it('finds an extra URL that answers /api/tags to be Ollama, and selectable', async () => {
    const fetch = fakeFetch({ 'http://lan-box:11434/api/tags': { body: TAGS } })
    const servers = await discoverModels({ fetch, config: { ...config, localModelServers: ['http://lan-box:11434'] }, refresh: true })
    expect(server(servers, 'http://lan-box:11434')).toMatchObject({ state: 'up', kind: 'ollama', selectable: true })
  })

  it('falls back to /v1/models for an extra URL that does not speak Ollama', async () => {
    const fetch = fakeFetch({
      'http://lan-box:9000/api/tags': { status: 404, text: 'nope' },
      'http://lan-box:9000/v1/models': { body: OPENAI_MODELS },
    })
    const servers = await discoverModels({ fetch, config: { ...config, localModelServers: ['http://lan-box:9000'] }, refresh: true })
    expect(server(servers, 'http://lan-box:9000')).toMatchObject({ state: 'up', kind: 'openai-compatible', selectable: true })
  })

  it('sends one request per default target, since the port already says what it is', async () => {
    const fetch = fakeFetch({})
    await discoverModels({ fetch, config, refresh: true })
    expect(fetch.calls.map((c) => c.url).sort()).toEqual([
      'http://localhost:11434/api/tags',
      'http://localhost:1234/v1/models',
      'http://localhost:8080/v1/models',
    ])
  })

  it('only ever sends a GET with a timeout signal, and never asks for a completion', async () => {
    const fetch = fakeFetch({
      'http://localhost:11434/api/tags': { body: TAGS },
      'http://lan-box:9000/api/tags': { status: 404 },
      'http://lan-box:9000/v1/models': { body: OPENAI_MODELS },
    })
    await discoverModels({ fetch, config: { ...config, localModelServers: ['http://lan-box:9000'] }, refresh: true })
    await checkOllamaModel(config.ollama, { fetch })
    expect(fetch.calls.length).toBeGreaterThan(0)
    for (const call of fetch.calls) {
      expect(call.init?.method ?? 'GET').toBe('GET')
      expect(call.init?.body).toBeUndefined()
      expect(call.init?.signal).toBeInstanceOf(AbortSignal)
      expect(call.url).not.toMatch(/\/api\/chat|\/api\/generate|\/v1\/chat|\/v1\/completions/)
    }
  })

  it('memoises per process, and probes again on refresh', async () => {
    const fetch = fakeFetch({ 'http://localhost:11434/api/tags': { body: TAGS } })
    const first = await discoverModels({ fetch, config, refresh: true })
    const second = await discoverModels({ fetch, config })
    expect(second).toBe(first)
    expect(fetch.calls).toHaveLength(3)
    await discoverModels({ fetch, config, refresh: true })
    expect(fetch.calls).toHaveLength(6)
  })
})

describe('matchesModel', () => {
  it('reads a bare name as the latest tag, the way Ollama does', () => {
    expect(matchesModel('llama3', { name: 'llama3:latest' })).toBe(true)
  })

  it('does not match a different tag', () => {
    expect(matchesModel('llama3:8b', { name: 'llama3:latest' })).toBe(false)
  })

  it('compares against model as well as name', () => {
    expect(matchesModel(`${DEFAULT_QWEN_MODEL}`, { name: 'my-alias', model: `${DEFAULT_QWEN_MODEL}` })).toBe(true)
  })

  it('is case-sensitive, as Ollama stores names', () => {
    expect(matchesModel('Llama3', { name: 'llama3:latest' })).toBe(false)
  })
})

describe('checkOllamaModel', () => {
  it('says installed when the listing holds the model', async () => {
    const fetch = fakeFetch({ 'http://localhost:11434/api/tags': { body: TAGS } })
    const check = await checkOllamaModel({ baseUrl: 'http://localhost:11434', model: `${DEFAULT_QWEN_MODEL}` }, { fetch })
    expect(check).toEqual({ state: 'installed', model: `${DEFAULT_QWEN_MODEL}`, baseUrl: 'http://localhost:11434' })
  })

  it('says missing with the pull command and the installed siblings', async () => {
    const fetch = fakeFetch({ 'http://localhost:11434/api/tags': { body: TAGS } })
    const check = await checkOllamaModel({ baseUrl: 'http://localhost:11434', model: 'qwen3.8:9b' }, { fetch })
    expect(check.state).toBe('missing')
    expect(check.message).toContain('qwen3.8:9b is not installed in Ollama at http://localhost:11434')
    expect(check.message).toContain(`Installed: ${DEFAULT_QWEN_MODEL}`)
    expect(check.message).not.toContain('llama3.2')
    expect(check.message).toMatch(/Pull it with: ollama pull qwen3\.8:9b$/)
  })

  it('says unreachable and how to start it', async () => {
    const fetch = fakeFetch({})
    const check = await checkOllamaModel({ baseUrl: 'http://localhost:11434', model: `${DEFAULT_QWEN_MODEL}` }, { fetch })
    expect(check.state).toBe('unreachable')
    expect(check.message).toBe('Ollama is not reachable at http://localhost:11434 (not running). Start it with: ollama serve')
  })

  it('probes only the configured URL', async () => {
    const fetch = fakeFetch({ 'http://box:11434/api/tags': { body: TAGS } })
    await checkOllamaModel({ baseUrl: 'http://box:11434/', model: 'llama3.2' }, { fetch })
    expect(fetch.calls.map((c) => c.url)).toEqual(['http://box:11434/api/tags'])
  })

  it('reuses a discovery that already found that server up', async () => {
    const fetch = fakeFetch({ 'http://localhost:11434/api/tags': { body: TAGS } })
    await discoverModels({ fetch, config, refresh: true })
    const before = fetch.calls.length
    const check = await checkOllamaModel(config.ollama, { fetch })
    expect(check.state).toBe('installed')
    expect(fetch.calls).toHaveLength(before)
  })
})

describe('pullCommand', () => {
  it('is bare for the default host', () => {
    expect(pullCommand(`${DEFAULT_QWEN_MODEL}`, 'http://localhost:11434')).toBe(`ollama pull ${DEFAULT_QWEN_MODEL}`)
    expect(pullCommand(`${DEFAULT_QWEN_MODEL}`, 'http://localhost:11434/')).toBe(`ollama pull ${DEFAULT_QWEN_MODEL}`)
  })

  it('names any other host, so the pull lands where the run will ask', () => {
    expect(pullCommand(`${DEFAULT_QWEN_MODEL}`, 'http://box:11434')).toBe(`OLLAMA_HOST=http://box:11434 ollama pull ${DEFAULT_QWEN_MODEL}`)
  })
})

describe('sanitizeDisplay', () => {
  it('strips escape sequences and C1 controls', () => {
    expect(sanitizeDisplay('\x1b[31mred\x1b[0m')).toBe('red')
    expect(sanitizeDisplay('a\x85b\x9fc\x07')).toBe('abc')
  })

  it('leaves Unicode letters alone', () => {
    expect(sanitizeDisplay('Türkçe-model:ğüşıöç')).toBe('Türkçe-model:ğüşıöç')
  })
})

describe('formatSize', () => {
  it('uses decimal units, as Ollama shows them', () => {
    expect(formatSize(17_200_000_000)).toBe('17.2 GB')
    expect(formatSize(2_019_393_189)).toBe('2.0 GB')
    expect(formatSize(950_000_000)).toBe('950 MB')
  })
})

describe('discoverModels with a config that will not load', () => {
  // Read from a temporary home, never the real one. The config is the one a
  // hand edit produces most often: a server without its scheme.
  it('rejects rather than throwing, so a caller chaining .then sees the failure', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { configDir, configFile } = await import('../../src/paths.js')
    const home = await mkdtemp(join(tmpdir(), 'polyglots-discover-'))
    const before = process.env.POLYGLOTS_HOME
    process.env.POLYGLOTS_HOME = home
    try {
      await mkdir(configDir(), { recursive: true })
      await writeFile(configFile(), JSON.stringify({ localModelServers: ['lan-box:11434'] }))
      const fetch = fakeFetch({})
      let result: Promise<ModelServer[]> | undefined
      expect(() => {
        result = discoverModels({ fetch, refresh: true })
      }).not.toThrow()
      await expect(result).rejects.toThrow(/config/i)
      expect(fetch.calls).toHaveLength(0)
    } finally {
      if (before === undefined) delete process.env.POLYGLOTS_HOME
      else process.env.POLYGLOTS_HOME = before
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('the context a server reports', () => {
  // vLLM says how long a context it was started with. Nothing else in the
  // standard listing does, and nothing is inferred for the servers that stay
  // silent.
  it('reads max_model_len from an OpenAI-compatible listing', async () => {
    const fetch = fakeFetch({
      'http://localhost:8080/v1/models': { body: { data: [{ id: 'Qwen/Qwen3-8B', max_model_len: 32768 }, { id: 'other' }] } },
    })
    const s = server(await discoverModels({ fetch, config, refresh: true }), 'http://localhost:8080')
    expect(s.models).toEqual([{ name: 'Qwen/Qwen3-8B', contextLength: 32768 }, { name: 'other' }])
  })
})

describe('checkLocalModel', () => {
  const lmStudio = { kind: 'openai-compatible' as const, baseUrl: 'http://localhost:1234', model: 'qwen2.5-7b-instruct' }

  it('asks Ollama the way checkOllamaModel does, and says which kind it checked', async () => {
    const fetch = fakeFetch({ 'http://localhost:11434/api/tags': { body: TAGS } })
    const check = await checkLocalModel({ kind: 'ollama', ...DEFAULT_CONFIG.ollama }, { fetch })
    expect(check).toEqual({ state: 'installed', kind: 'ollama', model: `${DEFAULT_QWEN_MODEL}`, baseUrl: 'http://localhost:11434' })
  })

  it('treats a target without a kind as Ollama, which is what such a caller means', async () => {
    const fetch = fakeFetch({ 'http://localhost:11434/api/tags': { body: TAGS } })
    expect((await checkLocalModel(DEFAULT_CONFIG.ollama, { fetch })).kind).toBe('ollama')
  })

  it('says installed when an OpenAI-compatible server serves the exact id', async () => {
    const fetch = fakeFetch({ 'http://localhost:1234/v1/models': { body: OPENAI_MODELS } })
    expect(await checkLocalModel(lmStudio, { fetch })).toEqual({ state: 'installed', ...lmStudio })
  })

  it('carries the context the server reports', async () => {
    const fetch = fakeFetch({ 'http://localhost:1234/v1/models': { body: { data: [{ id: lmStudio.model, max_model_len: 8192 }] } } })
    expect((await checkLocalModel(lmStudio, { fetch })).contextLength).toBe(8192)
  })

  it('says missing and lists what is served', async () => {
    const fetch = fakeFetch({ 'http://localhost:1234/v1/models': { body: OPENAI_MODELS } })
    const check = await checkLocalModel({ ...lmStudio, model: 'llama-3.2-3b' }, { fetch })
    expect(check.state).toBe('missing')
    expect(check.message).toBe('llama-3.2-3b is not served at http://localhost:1234. Served: qwen2.5-7b-instruct.')
  })

  it('says unreachable and how to start each kind of server', async () => {
    const check = await checkLocalModel(lmStudio, { fetch: fakeFetch({}) })
    expect(check.state).toBe('unreachable')
    expect(check.message).toMatch(/^No OpenAI-compatible server answers at http:\/\/localhost:1234 \(not running\)\./)
    expect(check.message).toMatch(/llama-server/)
    expect(check.message).toMatch(/vllm serve/)
  })

  it('accepts a base URL written with /v1', async () => {
    const fetch = fakeFetch({ 'http://localhost:1234/v1/models': { body: OPENAI_MODELS } })
    expect((await checkLocalModel({ ...lmStudio, baseUrl: 'http://localhost:1234/v1/' }, { fetch })).state).toBe('installed')
  })
})
