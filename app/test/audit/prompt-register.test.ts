import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAuditPrompt } from '../../src/audit/prompt.js'
import { buildReviewPrompt } from '../../src/review/prompt.js'

let home: string
let saved: string | undefined

beforeEach(async () => {
  saved = process.env.POLYGLOTS_HOME
  home = await mkdtemp(join(tmpdir(), 'polyglots-register-'))
  process.env.POLYGLOTS_HOME = home
})

afterEach(async () => {
  if (saved === undefined) delete process.env.POLYGLOTS_HOME
  else process.env.POLYGLOTS_HOME = saved
  await rm(home, { recursive: true, force: true })
})

describe('register without a rules file', () => {
  it('uses the neutral line in both prompts', () => {
    const line = (language: string) => `- Use the register that is standard in WordPress ${language}. Keep the tone neutral and concise, with no slang.`
    expect(buildAuditPrompt([], 'de', 2)).toContain(line('German'))
    // The draft review prompt names a language by its label throughout, code
    // included, and the register line follows it.
    expect(buildReviewPrompt([], 'de', 2)).toContain(line('German (de)'))
    expect(buildAuditPrompt([], 'de', 2)).not.toContain('formal')
  })
  it('names the register above in the fix instruction', () => {
    expect(buildAuditPrompt([], 'de', 2)).toContain('and the register above')
  })
})
