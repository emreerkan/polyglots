import { describe, expect, it } from 'vitest'
import { buildAuditPrompt, type AuditCandidate } from '../../src/audit/prompt.js'
import { buildReviewPrompt } from '../../src/review/prompt.js'
import type { ReviewInput } from '../../src/types.js'
import { useLocaleFixture } from '../locale-fixture.js'

// Swedish is the only locale besides Turkish whose pack changed what a prompt
// says: its own capitalization paragraph and a register that asks for "du".
// These fixtures were captured from the code while the sv pack still existed,
// with the rules file in place but not yet read for either, and they now get
// both texts from test/fixtures/locale/sv_SE.yaml. A pass proves the file says
// what the pack did; a diff re-reviews every Swedish file in the cache.

useLocaleFixture('sv_SE.yaml')

const fixture = (name: string) => `../fixtures/locale/${name}`

const candidates: AuditCandidate[] = [
  {
    id: 1,
    key: 'Save All Changes',
    msgid: 'Save All Changes',
    msgstr: ['Spara Alla Ändringar'],
    comments: ['Button label'],
    references: ['wp-admin/edit.php:12'],
    hints: [{ rule: 'title-case', severity: 'suspect', message: 'title case mirrors the English source (Alla, Ändringar)' }],
  },
  {
    id: 2,
    key: '%s post',
    msgid: '%s post',
    msgidPlural: '%s posts',
    msgstr: ['%s inlägg', '%s inlägg'],
    comments: [],
    references: ['wp-includes/post.php:40'],
    hints: [],
    memory: ['%s inlägg'],
  },
]

const reviewInputs: ReviewInput[] = [
  { key: 'Settings', msgid: 'Settings', comments: [], drafts: ['Inställningar'] },
  {
    key: 'Log in to your account',
    msgid: 'Log in to your account',
    comments: ['Login form heading'],
    drafts: ['Logga in på ert konto'],
  },
]

describe('Swedish prompts, byte for byte', () => {
  it('keeps the audit prompt', async () => {
    await expect(buildAuditPrompt(candidates, 'sv', 2)).toMatchFileSnapshot(fixture('sv-audit-prompt.txt'))
  })

  it('keeps the draft review prompt', async () => {
    await expect(buildReviewPrompt(reviewInputs, 'sv', 2)).toMatchFileSnapshot(fixture('sv-review-prompt.txt'))
  })
})
