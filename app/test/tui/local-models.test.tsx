import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { App } from '../../src/tui/App.js'
import { loadConfig } from '../../src/config.js'
import type { ModelServer } from '../../src/draft/discover.js'
import { fakeCommands, flat, openFromHome, keys, makeHome, modelServer, render, tick, waitFor, waitForText, cleanup, type Home } from './helpers.js'
import { DEFAULT_QWEN_MODEL } from '../../src/draft/qwen.js'

let home: Home

beforeEach(async () => {
  home = await makeHome()
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

const ollama = modelServer({
  models: [
    { name: `${DEFAULT_QWEN_MODEL}`, model: `${DEFAULT_QWEN_MODEL}`, size: 17_200_000_000, parameterSize: '27B', quantization: 'Q4_K_M' },
    { name: 'llama3.2:latest', model: 'llama3.2:latest', size: 2_019_393_189, parameterSize: '3.2B', quantization: 'Q4_K_M' },
  ],
})

const lmStudio: ModelServer = {
  target: { baseUrl: 'http://localhost:1234', kind: 'openai-compatible', label: 'LM Studio', source: 'default' },
  state: 'up',
  kind: 'openai-compatible',
  selectable: true,
  models: [{ name: 'qwen2.5-7b-instruct' }],
}

const llamaCppDown: ModelServer = {
  target: { baseUrl: 'http://localhost:8080', kind: 'openai-compatible', label: 'llama.cpp server', source: 'default' },
  state: 'down',
  error: 'not running',
  selectable: false,
  models: [],
}

async function openLocalModels(stdin: { write(data: string): void }, lastFrame: () => string) {
  await tick()
  await openFromHome(stdin, 'local-models')
  await waitForText(lastFrame, 'r re-check')
}

// The row the given model is on, so a marker can be pinned to one model
// rather than found anywhere in the frame. The last match, because the
// header naming the draft model comes first.
function lineOf(frame: string, name: string): string {
  return frame.split('\n').filter((l) => l.includes(name)).at(-1) ?? ''
}

describe('Local models', () => {
  it('lists Ollama models with size and quantisation, and marks the current one', async () => {
    const commands = fakeCommands({ discoverModels: vi.fn(async () => [ollama, lmStudio, llamaCppDown]) })
    const { lastFrame, stdin } = render(<App commands={commands} />)
    await openLocalModels(stdin, lastFrame)
    await waitForText(lastFrame, 'llama3.2:latest')
    const frame = lastFrame()
    expect(lineOf(frame, `${DEFAULT_QWEN_MODEL}`)).toMatch(/17\.2 GB\s+27B\s+Q4_K_M\s+\(current\)/)
    expect(lineOf(frame, 'llama3.2:latest')).toMatch(/2\.0 GB\s+3\.2B\s+Q4_K_M/)
    expect(lineOf(frame, 'llama3.2:latest')).not.toContain('(current)')
    expect(flat(frame)).toContain('Not running: llama.cpp server (http://localhost:8080)')
  })

  // Selectable since #5: the model is saved with its kind and server, so a run
  // asks LM Studio for it in LM Studio's own protocol.
  it('saves an LM Studio model with its kind and server, and moves the marker to it', async () => {
    const saveConfig = vi.fn(fakeCommands().saveConfig)
    const commands = fakeCommands({ discoverModels: vi.fn(async () => [ollama, lmStudio]), saveConfig })
    const { lastFrame, stdin } = render(<App commands={commands} />)
    await openLocalModels(stdin, lastFrame)
    await waitForText(lastFrame, 'qwen2.5-7b-instruct')
    expect(flat(lastFrame())).not.toContain('listing only')
    for (let i = 0; i < 2; i++) {
      stdin.write(keys.down)
      await tick()
    }
    expect(lineOf(lastFrame(), 'qwen2.5-7b-instruct')).toContain('❯')
    stdin.write(keys.enter)
    await waitForText(lastFrame, /qwen2\.5-7b-instruct.*\(current\)/)
    expect(saveConfig).toHaveBeenCalledWith({
      localServerKind: 'openai-compatible',
      openaiCompatible: { baseUrl: 'http://localhost:1234', model: 'qwen2.5-7b-instruct' },
    })
    expect(loadConfig().localServerKind).toBe('openai-compatible')
    expect(lineOf(lastFrame(), `${DEFAULT_QWEN_MODEL}`)).not.toContain('(current)')
  })

  it('switches back to Ollama when an Ollama model is chosen', async () => {
    const commands = fakeCommands({ discoverModels: vi.fn(async () => [ollama, lmStudio]) })
    const { lastFrame, stdin } = render(<App commands={commands} />)
    await openLocalModels(stdin, lastFrame)
    await waitForText(lastFrame, 'qwen2.5-7b-instruct')
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.enter)
    await waitForText(lastFrame, /qwen2\.5-7b-instruct.*\(current\)/)
    stdin.write(keys.up)
    await tick()
    stdin.write(keys.enter)
    await waitForText(lastFrame, /llama3\.2:latest.*\(current\)/)
    expect(loadConfig().localServerKind).toBe('ollama')
    expect(loadConfig().ollama.model).toBe('llama3.2:latest')
  })

  it('saves the model on enter and moves the marker', async () => {
    const saveConfig = vi.fn(fakeCommands().saveConfig)
    const commands = fakeCommands({ discoverModels: vi.fn(async () => [ollama]), saveConfig })
    const { lastFrame, stdin } = render(<App commands={commands} />)
    await openLocalModels(stdin, lastFrame)
    await waitForText(lastFrame, 'llama3.2:latest')
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.enter)
    await waitForText(lastFrame, /llama3\.2:latest.*\(current\)/)
    expect(saveConfig).toHaveBeenCalledWith({
      localServerKind: 'ollama',
      ollama: { baseUrl: 'http://localhost:11434', model: 'llama3.2:latest' },
    })
    expect(lineOf(lastFrame(), `${DEFAULT_QWEN_MODEL}`)).not.toContain('(current)')
  })

  // A context length belongs to the model and server it was set for; carried
  // to another, it would be sent as num_ctx to a model it was never meant for.
  it('drops the context length when the model changes', async () => {
    fakeCommands().saveConfig({ ollama: { baseUrl: 'http://localhost:11434', model: `${DEFAULT_QWEN_MODEL}`, contextLength: 16384 } })
    const saveConfig = vi.fn(fakeCommands().saveConfig)
    const commands = fakeCommands({ discoverModels: vi.fn(async () => [ollama]), saveConfig })
    const { lastFrame, stdin } = render(<App commands={commands} />)
    await openLocalModels(stdin, lastFrame)
    await waitForText(lastFrame, 'llama3.2:latest')
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.enter)
    await waitForText(lastFrame, /llama3\.2:latest.*\(current\)/)
    expect(loadConfig().ollama).toEqual({ baseUrl: 'http://localhost:11434', model: 'llama3.2:latest' })
  })

  it('keeps the context length when the current model is chosen again', async () => {
    fakeCommands().saveConfig({ ollama: { baseUrl: 'http://localhost:11434', model: `${DEFAULT_QWEN_MODEL}`, contextLength: 16384 } })
    const commands = fakeCommands({ discoverModels: vi.fn(async () => [ollama]) })
    const { lastFrame, stdin } = render(<App commands={commands} />)
    await openLocalModels(stdin, lastFrame)
    await waitForText(lastFrame, 'llama3.2:latest')
    stdin.write(keys.enter)
    await tick(10)
    expect(loadConfig().ollama.contextLength).toBe(16384)
  })

  it('keeps the marker where it was when saving fails', async () => {
    const commands = fakeCommands({
      discoverModels: vi.fn(async () => [ollama]),
      saveConfig: vi.fn(() => {
        throw new Error('EACCES: permission denied')
      }),
    })
    const { lastFrame, stdin } = render(<App commands={commands} />)
    await openLocalModels(stdin, lastFrame)
    await waitForText(lastFrame, 'llama3.2:latest')
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.enter)
    await waitForText(() => flat(lastFrame()), 'Could not save that: EACCES: permission denied')
    expect(lineOf(lastFrame(), `${DEFAULT_QWEN_MODEL}`)).toContain('(current)')
    expect(lineOf(lastFrame(), 'llama3.2:latest')).not.toContain('(current)')
  })

  it('says how to start Ollama when nothing is up', async () => {
    const down = { ...ollama, state: 'down' as const, error: 'not running', models: [], selectable: false }
    const commands = fakeCommands({ discoverModels: vi.fn(async () => [down, llamaCppDown]) })
    const { lastFrame, stdin } = render(<App commands={commands} />)
    await openLocalModels(stdin, lastFrame)
    await waitForText(() => flat(lastFrame()), 'No local model server found')
    expect(flat(lastFrame())).toContain('ollama serve')
    expect(flat(lastFrame())).toContain('polyglots config set localModelServers')
  })

  it('re-checks with r', async () => {
    const discoverModels = vi.fn(async () => [ollama])
    const { lastFrame, stdin } = render(<App commands={fakeCommands({ discoverModels })} />)
    await openLocalModels(stdin, lastFrame)
    await waitForText(lastFrame, 'llama3.2:latest')
    stdin.write('r')
    await waitFor(() => discoverModels.mock.calls.length === 2)
    expect(discoverModels).toHaveBeenLastCalledWith({ refresh: true })
  })

  it('shows a failed check with a way to retry', async () => {
    let fail = true
    const discoverModels = vi.fn(async () => {
      if (fail) throw new Error('config is broken')
      return [ollama]
    })
    const { lastFrame, stdin } = render(<App commands={fakeCommands({ discoverModels })} />)
    await openLocalModels(stdin, lastFrame)
    await waitForText(() => flat(lastFrame()), 'Could not check local models: config is broken')
    fail = false
    stdin.write('r')
    await waitForText(lastFrame, 'llama3.2:latest')
    expect(lastFrame()).not.toContain('Could not check local models')
  })

  // A real discoverModels that cannot load the config used to throw before it
  // had a promise to reject, which escaped the effect and took Ink down. The
  // screen must survive any implementation that throws, not only one that
  // rejects.
  it('shows a check that throws synchronously, and recovers on r', async () => {
    let fail = true
    const discoverModels = vi.fn((): Promise<ModelServer[]> => {
      if (fail) throw new Error('Invalid config in config.json')
      return Promise.resolve([ollama])
    })
    const { lastFrame, stdin } = render(<App commands={fakeCommands({ discoverModels })} />)
    await openLocalModels(stdin, lastFrame)
    await waitForText(() => flat(lastFrame()), 'Could not check local models: Invalid config in config.json')
    fail = false
    stdin.write('r')
    await waitForText(lastFrame, 'llama3.2:latest')
    expect(lastFrame()).not.toContain('Could not check local models')
  })

  it('shows a name carrying control characters but never selects it', async () => {
    const hostile = modelServer({ models: [{ name: 'bad\x1b[2Jname' }, { name: 'llama3.2:latest' }] })
    const commands = fakeCommands({ discoverModels: vi.fn(async () => [hostile]) })
    const { lastFrame, stdin } = render(<App commands={commands} />)
    await openLocalModels(stdin, lastFrame)
    await waitForText(lastFrame, 'badname')
    expect(lineOf(lastFrame(), 'llama3.2:latest')).toContain('❯')
    stdin.write(keys.up)
    await tick()
    expect(lineOf(lastFrame(), 'badname')).not.toContain('❯')
  })
})
