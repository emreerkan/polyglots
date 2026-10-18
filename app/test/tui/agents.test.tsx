import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { App } from '../../src/tui/App.js'
import type { AgentStatus } from '../../src/agent/discover.js'
import { DEFAULT_CONFIG } from '../../src/config.js'
import type { PolyglotsConfig } from '../../src/types.js'
import {
  agentStatus,
  ESC_DELAY,
  fakeCommands,
  flat,
  openFromHome,
  keys,
  makeHome,
  tick,
  unusableAgent,
  waitForText,
  render,
  cleanup,
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

async function openAgents(stdin: { write(data: string): void }, lastFrame: () => string) {
  await tick()
  await openFromHome(stdin, 'agents')
  await waitForText(lastFrame, 'r re-check')
}

describe('Check AI agents', () => {
  it('shows what was found for each provider', async () => {
    const statuses: AgentStatus[] = [
      agentStatus('claude', { auth: { state: 'signed-in', detail: 'claude.ai' }, version: '2.1.292 (Claude Code)' }),
      agentStatus('antigravity', {
        binSource: 'POLYGLOTS_AGENT_BIN',
        auth: { state: 'unknown', detail: 'no token file' },
        model: 'Gemini 3.8 Flash (Medium)',
        notes: ['binary from POLYGLOTS_AGENT_BIN', 'sign-in unknown: no token file'],
      }),
    ]
    const { lastFrame, stdin } = render(<App commands={fakeCommands({ discoverAgents: async () => statuses })} />)
    await openAgents(stdin, lastFrame)
    const frame = flat(lastFrame())
    expect(frame).toContain('claude ready')
    expect(frame).toContain('/opt/bin/claude')
    expect(frame).toContain('2.1.292 (Claude Code)')
    expect(frame).toContain('signed in (claude.ai)')
    expect(frame).toContain('antigravity ready')
    expect(frame).toContain('POLYGLOTS_AGENT_BIN')
    expect(frame).toContain('Gemini 3.8 Flash (Medium)')
    expect(frame).toContain('sign-in unknown: no token file')
  })

  it('names the reason an agent is unavailable', async () => {
    const statuses = [agentStatus('claude'), unusableAgent('antigravity', 'agy not on PATH')]
    const { lastFrame, stdin } = render(<App commands={fakeCommands({ discoverAgents: async () => statuses })} />)
    await openAgents(stdin, lastFrame)
    const frame = flat(lastFrame())
    expect(frame).toContain('antigravity unavailable')
    expect(frame).toContain('agy not on PATH')
  })

  // The menu reads the same state, so a re-check here is what it shows after.
  it('re-checks with r, and the menu agrees after esc', async () => {
    let installed = false
    const discoverAgents = vi.fn(async () => [
      agentStatus('claude'),
      installed ? agentStatus('antigravity') : unusableAgent('antigravity', 'agy not on PATH'),
    ])
    const { lastFrame, stdin } = render(<App commands={fakeCommands({ discoverAgents })} />)
    await openAgents(stdin, lastFrame)
    expect(flat(lastFrame())).toContain('agy not on PATH')

    installed = true
    stdin.write('r')
    await waitForText(() => flat(lastFrame()), 'antigravity ready')
    expect(discoverAgents).toHaveBeenLastCalledWith({ refresh: true })

    stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(lastFrame, 'Configure API keys')
    expect(lastFrame()).not.toContain('Unavailable')
  })

  it('shows a failed check with a way to retry', async () => {
    let fail = true
    const discoverAgents = vi.fn(async () => {
      if (fail) throw new Error('spawn EPERM')
      return [agentStatus('claude'), agentStatus('antigravity')]
    })
    const { lastFrame, stdin } = render(<App commands={fakeCommands({ discoverAgents })} />)
    await openAgents(stdin, lastFrame)
    expect(flat(lastFrame())).toContain('Could not check agents: spawn EPERM')

    fail = false
    stdin.write('r')
    await waitForText(() => flat(lastFrame()), 'claude ready')
    expect(lastFrame()).not.toContain('Could not check agents')
  })

  // The CLI reads the same key, so the setting lives in config rather than in
  // Interface settings, which hold what only the app reads.
  it('turns debug mode on and off with d, saving it to config', async () => {
    let current: PolyglotsConfig = { ...DEFAULT_CONFIG, defaultLocale: 'tr' }
    const saved: Partial<PolyglotsConfig>[] = []
    const saveConfig = (patch: Partial<PolyglotsConfig>) => {
      saved.push(patch)
      current = { ...current, ...patch }
      return current
    }
    const { lastFrame, stdin } = render(
      <App commands={fakeCommands({ discoverAgents: async () => [agentStatus('claude')], loadConfig: () => current, saveConfig })} />,
    )
    await openAgents(stdin, lastFrame)
    expect(flat(lastFrame())).toContain('Debug mode: off')
    // The off hint says what turning it on would do, as a condition, rather
    // than starting "On," as if it were already on.
    expect(flat(lastFrame())).toContain(
      "When on, each batch's prompt and agent output are saved beside the run log, to find out why a batch failed.",
    )
    stdin.write('d')
    await waitForText(() => flat(lastFrame()), 'Debug mode: on')
    expect(saved).toEqual([{ debug: true }])
    expect(flat(lastFrame())).toContain('saved beside each run log')
    stdin.write('d')
    await waitForText(() => flat(lastFrame()), 'Debug mode: off')
    expect(saved).toEqual([{ debug: true }, { debug: false }])
  })
  describe('codex', () => {
    function codexConfig(initial: Partial<PolyglotsConfig> = {}) {
      let current: PolyglotsConfig = { ...DEFAULT_CONFIG, defaultLocale: 'tr', ...initial }
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

    it("shows the model and effort codex will use, each with where it came from", async () => {
      mkdirSync(process.env.CODEX_HOME!, { recursive: true })
      writeFileSync(join(process.env.CODEX_HOME!, 'config.toml'), 'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"\n')
      const store = codexConfig()
      const { lastFrame, stdin } = render(
        <App commands={fakeCommands({ ...store, discoverAgents: async () => [agentStatus('claude'), agentStatus('codex')] })} />,
      )
      await openAgents(stdin, lastFrame)
      const frame = flat(lastFrame())
      expect(frame).toContain('Codex: gpt-5.6-luna (codex config), effort low (codex config)')
      expect(frame).toContain('r re-check · d debug mode · e codex effort · esc/q back to menu')
    })

    it('cycles codex.effort with e through the eight values, then removes it', async () => {
      const store = codexConfig({ codex: { model: 'gpt-5.6-luna' } })
      const { lastFrame, stdin } = render(
        <App commands={fakeCommands({ ...store, discoverAgents: async () => [agentStatus('codex')] })} />,
      )
      await openAgents(stdin, lastFrame)
      for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
        stdin.write('e')
        await waitForText(() => flat(lastFrame()), `effort ${effort} (polyglots config)`)
      }
      stdin.write('e')
      await waitForText(() => flat(lastFrame()), "effort codex's default effort")
      expect(store.saved.map((p) => p.codex)).toEqual([
        { model: 'gpt-5.6-luna', effort: 'none' },
        { model: 'gpt-5.6-luna', effort: 'minimal' },
        { model: 'gpt-5.6-luna', effort: 'low' },
        { model: 'gpt-5.6-luna', effort: 'medium' },
        { model: 'gpt-5.6-luna', effort: 'high' },
        { model: 'gpt-5.6-luna', effort: 'xhigh' },
        { model: 'gpt-5.6-luna', effort: 'max' },
        { model: 'gpt-5.6-luna', effort: 'ultra' },
        { model: 'gpt-5.6-luna' },
      ])
    })
  })
})
