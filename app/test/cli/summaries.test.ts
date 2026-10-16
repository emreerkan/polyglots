import { describe, expect, it } from 'vitest'
import { stripVTControlCharacters } from 'node:util'
import { fetchTally, reviewSummary, statsServingSummary, statsSummary, translateSummary } from '../../src/cli/summaries.js'
import { reviewSummaryOf } from '../tui/helpers.js'
import type { ReviewSummary } from '../../src/types.js'
import { createPainter, plainPainter } from '../../src/ui/paint.js'
import type { TranslateSummary } from '../../src/commands/translate.js'

const base: TranslateSummary = { file: 'a.po', total: 412, pending: 412, fromTm: 24, translated: 380, fuzzy: 8, skipped: 0 }

describe('translateSummary', () => {
  it('frames the counts under a Done title and ends with where to look', () => {
    const lines = translateSummary(plainPainter, base, false)
    expect(lines[0]).toMatch(/^╭─ ✓ Done ─+╮$/)
    expect(lines).toContainEqual(expect.stringMatching(/│  translated\s+380\s+│/))
    expect(lines).toContainEqual(expect.stringMatching(/│  fuzzy\s+8  check before upload\s+│/))
    expect(lines.at(-1)).toBe('› Open a.po in your .po editor to review.')
  })

  it('titles a stopped run as stopped and says how to resume', () => {
    const lines = translateSummary(plainPainter, { ...base, stopped: 'stopped before batch 3' }, false)
    expect(lines[0]).toContain('! Stopped')
    expect(lines.at(-1)).toBe('› Re-run the same command to resume.')
  })

  it('says a dry run wrote nothing', () => {
    const lines = translateSummary(plainPainter, base, true)
    expect(lines[0]).toContain('Dry run')
    expect(lines.at(-1)).toBe('› Nothing was written.')
  })

  it('drops the fuzzy note when nothing is fuzzy', () => {
    expect(translateSummary(plainPainter, { ...base, fuzzy: 0 }, false).join('\n')).not.toContain('check before upload')
  })

  it('counts the entries a locale rule changed, and only when there are some', () => {
    expect(translateSummary(plainPainter, { ...base, fixedByRules: 3 }, false)).toContainEqual(
      expect.stringMatching(/│  fixed by locale rules\s+3\s+│/),
    )
    expect(translateSummary(plainPainter, base, false).join('\n')).not.toContain('locale rules')
  })

  it('reads the same with colour on, once the codes are stripped', () => {
    const painted = translateSummary(createPainter({ isTTY: true }, {}), base, false)
    expect(painted.join('\n')).toMatch(/\x1b\[/)
    expect(painted.map((l) => stripVTControlCharacters(l))).toEqual(translateSummary(plainPainter, base, false))
  })
})

// The factory names a problems file by default; a run that wrote none has the
// key absent, not undefined, under exactOptionalPropertyTypes.
function reviewed(patch: Partial<ReviewSummary>, problemsFile: string | undefined): ReviewSummary {
  const { problemsFile: _drop, ...rest } = reviewSummaryOf('a.po', patch)
  return problemsFile === undefined ? rest : { ...rest, problemsFile }
}

describe('reviewSummary', () => {
  it('frames reviewed, flagged and approvable, flagged highlighted', () => {
    const s = reviewed({ reviewed: 120, skipped: 3, problems: 9, needsReview: 2, approvable: 109, pending: 0 }, 'out/a-problems.po')
    const lines = reviewSummary(plainPainter, s, undefined)
    expect(lines[0]).toMatch(/✓ Reviewed/)
    expect(lines.join('\n')).toMatch(/flagged\s+11/)
    expect(lines.join('\n')).toMatch(/approvable\s+109/)
    expect(lines.at(-1)).toBe('› Wrote out/a-problems.po')
  })

  it('titles an early stop with a warning and never says approvable for the rest', () => {
    const s = reviewed({ reviewed: 40, pending: 80, problems: 1, needsReview: 0, approvable: 39 }, undefined)
    const lines = reviewSummary(plainPainter, s, undefined)
    expect(lines[0]).toContain('! Stopped early')
    expect(lines.join('\n')).toMatch(/not reached\s+80/)
    expect(lines.join('\n')).not.toContain('looks approvable')
    expect(lines.at(-1)).toBe('› Re-run the same command to carry on.')
  })

  it('says a clean finished run looks approvable', () => {
    const s = reviewed({ reviewed: 50, pending: 0, problems: 0, needsReview: 0, approvable: 50, repaired: 0, written: 0 }, undefined)
    expect(reviewSummary(plainPainter, s, undefined).at(-1)).toBe('› Nothing flagged; the whole submission looks approvable.')
  })

  it('prints the requester message verbatim under its heading, outside the box', () => {
    const s = reviewed({ reviewed: 10, pending: 0, problems: 1, needsReview: 0, approvable: 9 }, 'p.po')
    const lines = reviewSummary(plainPainter, s, 'Thanks! 1 entry needs a look.')
    const at = lines.indexOf('Message for the requester:')
    expect(at).toBeGreaterThan(0)
    expect(lines.slice(0, at).some((l) => l.startsWith('╰'))).toBe(true)
    expect(lines[at + 1]).toBe('Thanks! 1 entry needs a look.')
  })

  it('prints the reply instead of the requester message when a template was filled', () => {
    const s = reviewed({ reviewed: 10, pending: 0, problems: 1, needsReview: 0, approvable: 9, repaired: 1 }, 'p.po')
    const lines = reviewSummary(plainPainter, s, 'I fixed 1 entry.', { reply: { name: 'approved', text: 'Hello,\n\nI fixed 1 entry.' } })
    expect(lines).not.toContain('Message for the requester:')
    expect(lines).toContain('Reply (approved template):')
    expect(lines.filter((l) => l.includes('I fixed 1 entry.'))).toHaveLength(1)
  })

  it('paints the approvable count green only when there is something to approve', () => {
    const colour = createPainter({ isTTY: true }, {})
    const row = (approvable: number) =>
      reviewSummary(colour, reviewed({ reviewed: 5, problems: 5 - approvable, needsReview: 0, approvable, pending: 0 }, 'p.po'), undefined)
        .find((l) => l.includes('approvable'))!
    expect(row(0)).not.toContain('\x1b[32m')
    expect(row(3)).toContain('\x1b[32m')
  })

  it('reads the same with colour on, once the codes are stripped', () => {
    const s = reviewed({ problems: 2 }, 'p.po')
    const painted = reviewSummary(createPainter({ isTTY: true }, {}), s, 'msg')
    expect(painted.map((l) => stripVTControlCharacters(l))).toEqual(reviewSummary(plainPainter, s, 'msg'))
  })
})

describe('fetchTally', () => {
  it('frames the counts and titles by the worst outcome', () => {
    expect(fetchTally(plainPainter, { done: 3, failed: 0, skipped: 1, stopped: 0 })[0]).toContain('✓ Fetched')
    expect(fetchTally(plainPainter, { done: 2, failed: 1, skipped: 0, stopped: 0 })[0]).toContain('✗ Fetched with failures')
    const stopped = fetchTally(plainPainter, { done: 1, failed: 0, skipped: 0, stopped: 2 })
    expect(stopped[0]).toContain('! Stopped')
    expect(stopped.join('\n')).toMatch(/stopped\s+2/)
    expect(stopped.at(-1)).toBe('› Run the same list again to carry on.')
  })
})

describe('statsSummary', () => {
  const s = {
    file: '/tmp/stats.html', submissions: 12, entries: 4102, flagged: 410, incomplete: 1,
    translateRuns: 3, translateEntries: 900, weeks: [0, 2, 5, 9],
    topProjects: [{ project: 'akismet', runs: 4, entries: 2000, flagged: 200 }],
  }

  it('frames the headline numbers with a weekly sparkline', () => {
    const text = statsSummary(plainPainter, s).join('\n')
    expect(text).toMatch(/submissions\s+12/)
    expect(text).toMatch(/entries\s+4,102/)
    expect(text).toMatch(/weekly\s+▁\S{3}/)
  })

  // The sparkline is wider than any count, and as a cell of the counts column
  // it pushed every number far right of its label. It now starts where the
  // column starts and runs past it, so the numbers sit as close as before.
  it('keeps the counts beside their labels however long the sparkline is', () => {
    const long = { ...s, weeks: [0, 2, 5, 9, 3, 1, 0, 4, 8, 12, 6, 2] }
    const lines = statsSummary(plainPainter, long)
    const entries = lines.find((l) => l.includes('entries'))!
    const weekly = lines.find((l) => l.includes('weekly'))!
    expect(entries).toMatch(/entries {2,9}4,102/)
    expect(weekly.indexOf('▁')).toBe(entries.indexOf('4,102'))
    expect(weekly).toMatch(/█\S*  last 12 weeks/)
    expect(new Set(lines.filter((l) => /^[╭│╰]/.test(l)).map((l) => l.length)).size).toBe(1)
  })

  it('lists the top projects and points at the page', () => {
    const lines = statsSummary(plainPainter, s)
    expect(lines.join('\n')).toMatch(/akismet\s+2,000 entries\s+10% flagged/)
    expect(lines.join('\n')).toContain('1 unfinished review is left out of the totals.')
    expect(lines.at(-1)).toBe('› Wrote /tmp/stats.html')
  })

  it('says nothing is recorded yet when there is nothing', () => {
    const empty = { ...s, submissions: 0, entries: 0, flagged: 0, translateRuns: 0, translateEntries: 0, weeks: [], topProjects: [], incomplete: 0 }
    expect(statsSummary(plainPainter, empty)).toEqual([
      '› Nothing recorded yet. Wrote /tmp/stats.html anyway; it will fill in as you work.',
    ])
  })
})

describe('statsServingSummary', () => {
  const { file: _file, ...s } = {
    file: '/tmp/stats.html', submissions: 12, entries: 4102, flagged: 410, incomplete: 2,
    translateRuns: 0, translateEntries: 0, weeks: [1, 5],
    topProjects: [{ project: 'akismet', runs: 4, entries: 2000, flagged: 200 }],
  }
  const url = 'http://127.0.0.1:51234/tok/'

  it('frames the same numbers, then says where the page is served and how to stop it', () => {
    const lines = statsServingSummary(plainPainter, s, url, true)
    expect(lines[0]).toContain('• Statistics')
    expect(lines.join('\n')).toMatch(/akismet\s+2,000 entries/)
    expect(lines).toContain('  2 unfinished reviews are left out of the totals.')
    expect(lines.slice(-2)).toEqual([`› Serving ${url}`, '  Opened in your browser. Ctrl+C to stop.'])
    expect(lines.join('\n')).not.toContain('Wrote')
  })

  it('asks the reader to open the page when no browser was opened', () => {
    expect(statsServingSummary(plainPainter, s, url, false).at(-1)).toBe('  Open it in a browser. Ctrl+C to stop.')
  })

  it('says the page fills in as you work when nothing is recorded yet', () => {
    const empty = { ...s, submissions: 0, entries: 0, flagged: 0, incomplete: 0, weeks: [], topProjects: [] }
    expect(statsServingSummary(plainPainter, empty, url, true)).toEqual([
      '› Nothing recorded yet. The page fills in as you work.',
      `› Serving ${url}`,
      '  Opened in your browser. Ctrl+C to stop.',
    ])
  })
})
