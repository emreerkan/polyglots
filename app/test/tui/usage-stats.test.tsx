import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { DEFAULT_CONFIG } from '../../src/config.js'
import { App } from '../../src/tui/App.js'
import type { PolyglotsConfig } from '../../src/types.js'
import { readUsageState, usageStateFile } from '../../src/usage/index.js'
import { cleanup, fakeCommands, flat, keys, makeHome, render, tick, waitForText, type Home } from './helpers.js'

let home: Home
beforeEach(async () => {
  home = await makeHome()
  delete process.env.DO_NOT_TRACK
})
afterEach(async () => {
  cleanup()
  await home.cleanup()
})

function configStore(initial: Partial<PolyglotsConfig> = {}) {
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

async function open(initial: Partial<PolyglotsConfig> = {}) {
  const config = configStore(initial)
  const r = render(<App commands={fakeCommands({ ...config })} />)
  await waitForText(r.lastFrame, 'Translate a .po file')
  r.stdin.write('c')
  await waitForText(r.lastFrame, 'Usage statistics')
  r.stdin.write('u')
  await waitForText(r.lastFrame, 'Share anonymous totals with the website')
  return { ...r, config }
}

describe('Configuration › Usage statistics', () => {
  it('shows the setting off and previews what would be sent, without making an install id', async () => {
    const { lastFrame } = await open()
    const frame = flat(lastFrame())
    expect(frame).toContain('[ ] Share anonymous totals with the website')
    expect(frame).toContain('"reviewed": 0')
    expect(frame).toContain('(made when you turn this on)')
    expect(existsSync(usageStateFile())).toBe(false)
  })

  it('turns it on and off, and the preview then carries the real install id', async () => {
    const { lastFrame, stdin, config } = await open()
    stdin.write(' ')
    await waitForText(lastFrame, '[x] Share anonymous totals with the website')
    expect(config.saved).toContainEqual({ usageStats: true })
    const id = readUsageState()!.installId
    await waitForText(lastFrame, id)
    stdin.write(keys.enter)
    await waitForText(lastFrame, '[ ] Share anonymous totals with the website')
    expect(config.saved.at(-1)).toEqual({ usageStats: false })
  })

  // The other thing polyglots can send the maintainer, set beside it.
  it('turns the problem report offer to never and back to ask, below the sharing setting', async () => {
    const { lastFrame, stdin, config } = await open()
    expect(flat(lastFrame())).toContain('Offer problem reports: ask')
    stdin.write(keys.down)
    await tick()
    stdin.write(' ')
    await waitForText(lastFrame, 'Offer problem reports: never')
    expect(config.saved).toEqual([{ problemReports: 'never' }])
    // The sharing setting was not the one changed.
    expect(flat(lastFrame())).toContain('[ ] Share anonymous totals with the website')
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'Offer problem reports: ask')
    expect(config.saved.at(-1)).toEqual({ problemReports: 'ask' })
    stdin.write(keys.up)
    await tick()
    stdin.write(' ')
    await waitForText(lastFrame, '[x] Share anonymous totals with the website')
  })

  it('says when DO_NOT_TRACK overrides the setting', async () => {
    process.env.DO_NOT_TRACK = '1'
    const { lastFrame } = await open({ usageStats: true })
    expect(flat(lastFrame())).toContain('DO_NOT_TRACK')
    expect(existsSync(usageStateFile())).toBe(false)
  })

  it('forgets the install id with r', async () => {
    const { lastFrame, stdin } = await open({ usageStats: true })
    const first = readUsageState()!.installId
    await waitForText(lastFrame, first)
    stdin.write('r')
    await tick()
    await waitForText(lastFrame, 'Install id forgotten')
    // The setting is still on, so the preview has already made the next one.
    expect(readUsageState()!.installId).not.toBe(first)
    expect(flat(lastFrame())).not.toContain(first)
  })
})
