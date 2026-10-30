import { describe, expect, it } from 'vitest'
import { describeChecked, describeDownload, endOfJob } from '../../src/commands/fetch-report.js'
import type { TranslateSummary } from '../../src/commands/translate.js'
import type { ReviewSummary } from '../../src/types.js'

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

  it('counts the fuzzy entries the memory filled', () => {
    const end = endOfJob({ file: 'a.po', state: 'done', summary: translated({ fromTmFuzzy: 2 }) }, 'me')
    expect(end.detail).toBe('5 translated, 3 fuzzy, 2 from TM')
  })

  it('says nothing about locale rules when none fixed anything', () => {
    const end = endOfJob({ file: 'a.po', state: 'done', summary: translated() }, 'me')
    expect(end.detail).toBe('5 translated, 1 fuzzy, 2 from TM')
  })
})

// A file with a batch given up still ends done, since the rest of it was
// worked. The detail is the only place on the table line that can say part
// of it was not, which the problem report offer below the table already
// counts as a failed batch.
describe('endOfJob: a file with a batch given up', () => {
  it('names the entries a translate skipped', () => {
    const end = endOfJob({ file: 'a.po', state: 'done', summary: translated({ skipped: 4 }) }, 'me')
    expect(end.tally).toBe('done')
    expect(end.detail).toBe('5 translated, 1 fuzzy, 2 from TM, 4 in failed batches')
  })

  const reviewed = (patch: Partial<ReviewSummary> = {}): ReviewSummary => ({
    file: 'a.po', locale: 'tr', total: 10, skipped: 0, reviewed: 10, problems: 0, needsReview: 1,
    approvable: 6, unreviewed: 3, repaired: 0, written: 0, pending: 0, byRule: {}, byGroup: {},
    ...patch,
  })

  it('names the entries a review could not review', () => {
    const summary = reviewed()
    const end = endOfJob({ file: 'a.po', state: 'done', summary }, 'me')
    expect(end.tally).toBe('done')
    expect(end.detail).toBe('10 reviewed, 1 flagged, 0 repaired, 3 in failed batches')
  })

  // A stopped review also has entries it never reached. The two counts are
  // different sets, so they must not read as near synonyms of each other.
  it('keeps the failed batches apart from the entries a stopped review never reached', () => {
    const end = endOfJob({ file: 'a.po', state: 'done', summary: reviewed({ reviewed: 5, pending: 5 }) }, 'me')
    expect(end).toEqual({ tally: 'stopped', detail: '5 reviewed, 1 flagged, 0 repaired, 3 in failed batches, 5 not reviewed yet' })
  })

  it('names the failed batches on a stopped translate line', () => {
    const end = endOfJob({ file: 'a.po', state: 'done', summary: translated({ skipped: 4, stopped: 'stopped by the operator' }) }, 'me')
    expect(end).toEqual({ tally: 'stopped', detail: '5 translated, 1 fuzzy, 2 from TM, 4 in failed batches, stopped: stopped by the operator' })
  })
})

describe('describeDownload', () => {
  it('says what became of each export', () => {
    expect(describeDownload({ input: 'koji', file: '/x/a.po', state: 'fetched' })).toBe('saved')
    expect(describeDownload({ input: 'koji', file: '/x/a.po', state: 'kept' })).toBe('kept, already on disk')
    expect(describeDownload({ input: 'koji', state: 'failed', reason: 'export answered 500' })).toBe('failed: export answered 500')
  })
})

describe('describeChecked', () => {
  it("names a plugin's readme beside its code", () => {
    const code = { input: 'acme', state: 'ready' as const, type: 'wp-plugins' as const, slug: 'acme', branch: 'dev', count: 4 }
    const readme = { ...code, input: 'wp-plugins/acme/stable-readme', branch: 'stable-readme', count: 2 }
    expect(describeChecked([code], 'waiting')).toBe('plugin dev, 4 waiting')
    expect(describeChecked([code, readme], 'waiting')).toBe('plugin dev, 4 waiting + readme, 2 waiting')
  })
})
