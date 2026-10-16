import { describe, expect, it } from 'vitest'
import { buildAuditPrompt } from '../../src/audit/prompt.js'
import { buildReviewPrompt } from '../../src/review/prompt.js'

// test/setup/isolate-home.ts gives every test an empty POLYGLOTS_HOME, so no
// rules file is found and the neutral line is what the prompts carry.
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
