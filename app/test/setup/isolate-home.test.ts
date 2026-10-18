import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { configuredModel } from '../../src/agent/providers.js'

// The setup gives every test its own home folder as well as its own
// POLYGLOTS_HOME. Code that reads another tool's files, such as antigravity's
// settings, finds them through os.homedir(), and a test that reached the
// developer's own would pass or fail on what that machine has configured.
describe('the isolated home', () => {
  it('is what os.homedir() returns, a temporary folder', () => {
    expect(homedir()).toBe(process.env.POLYGLOTS_HOME)
    expect(homedir().startsWith(tmpdir())).toBe(true)
  })

  it('hides the real antigravity settings, so a test gets only the model it writes', () => {
    expect(configuredModel('antigravity')).toBeUndefined()
    const dir = join(homedir(), '.gemini', 'antigravity-cli')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ model: 'Test Model' }))
    expect(configuredModel('antigravity')).toBe('Test Model')
  })
})
