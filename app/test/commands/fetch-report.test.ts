import { describe, expect, it } from 'vitest'
import { endOfJob } from '../../src/commands/fetch-report.js'
import type { TranslateSummary } from '../../src/commands/translate.js'

const translated = (patch: Partial<TranslateSummary> = {}): TranslateSummary => ({
  file: 'a.po',
  total: 10,
  pending: 0,
  fromTm: 2,
  translated: 5,
  fuzzy: 1,
  skipped: 0,
  ...patch,
})

describe('endOfJob: a translate line', () => {
  // The single-file summaries count drafts a locale rule changed; a batch line
  // that left them out read as a run the rules never touched.
  it('counts the drafts locale rules fixed, as the single-file summary does', () => {
    const end = endOfJob({ file: 'a.po', state: 'done', summary: translated({ fixedByRules: 3 }) }, 'me')
    expect(end).toEqual({ tally: 'done', detail: '5 translated, 1 fuzzy, 2 from TM, 3 fixed by locale rules' })
  })

  it('says nothing about locale rules when none fixed anything', () => {
    const end = endOfJob({ file: 'a.po', state: 'done', summary: translated() }, 'me')
    expect(end.detail).toBe('5 translated, 1 fuzzy, 2 from TM')
  })
})
