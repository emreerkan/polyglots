import { describe, expect, it } from 'vitest'
import { checkRows, downloadRows, progressCount, queuedRows } from '../../src/tui/fetch-progress.js'

describe('the fetch progress rows', () => {
  it('starts every line queued', () => {
    expect(queuedRows(['koji', 'acme'])).toEqual([
      { input: 'koji', state: 'queued' },
      { input: 'acme', state: 'queued' },
    ])
  })

  it('marks the line being checked, then how it ended', () => {
    let rows = queuedRows(['koji', 'nope'])
    rows = checkRows(rows, { input: 'koji', state: 'checking' }, 'waiting')
    expect(rows[0]).toEqual({ input: 'koji', state: 'working' })
    rows = checkRows(
      rows,
      { input: 'koji', state: 'checked', results: [{ input: 'koji', state: 'ready', type: 'wp-themes', slug: 'koji', count: 3 }] },
      'waiting',
    )
    expect(rows[0]).toEqual({ input: 'koji', state: 'done', detail: 'theme, 3 waiting' })
    rows = checkRows(rows, { input: 'nope', state: 'checked', results: [{ input: 'nope', state: 'not-found', reason: '' }] }, 'waiting')
    expect(rows[1]).toEqual({ input: 'nope', state: 'done', detail: 'not found', dim: true })
  })

  it('does not dim a plugin whose readme has work when its code has none', () => {
    const rows = checkRows(
      queuedRows(['acme']),
      {
        input: 'acme',
        state: 'checked',
        results: [
          { input: 'acme', state: 'empty', reason: 'nothing waiting' },
          { input: 'wp-plugins/acme/stable-readme', state: 'ready', type: 'wp-plugins', slug: 'acme', branch: 'stable-readme', count: 2 },
        ],
      },
      'waiting',
    )
    expect(rows[0]).toEqual({ input: 'acme', state: 'done', detail: 'nothing waiting + readme, 2 waiting' })
  })

  // The same line given twice is two rows; each event belongs to the first
  // of them that has not ended.
  it('keeps a line given twice as two rows', () => {
    let rows = queuedRows(['koji', 'koji'])
    rows = checkRows(rows, { input: 'koji', state: 'checking' }, 'waiting')
    rows = checkRows(rows, { input: 'koji', state: 'checked', results: [{ input: 'koji', state: 'empty', reason: 'nothing waiting' }] }, 'waiting')
    rows = checkRows(rows, { input: 'koji', state: 'checking' }, 'waiting')
    expect(rows.map((r) => r.state)).toEqual(['done', 'working'])
  })

  it('marks the export downloading, then how it ended', () => {
    let rows = queuedRows(['koji'])
    rows = downloadRows(rows, { input: 'koji', state: 'downloading' })
    expect(rows[0]).toEqual({ input: 'koji', state: 'working' })
    rows = downloadRows(rows, { input: 'koji', state: 'downloaded', result: { input: 'koji', state: 'failed', reason: 'export answered 500' } })
    expect(rows[0]).toEqual({ input: 'koji', state: 'done', detail: 'failed: export answered 500', warn: true })
  })

  it('counts the lines that have ended', () => {
    const rows = downloadRows(queuedRows(['a', 'b', 'c']), { input: 'a', state: 'downloaded', result: { input: 'a', file: '/a.po', state: 'fetched' } })
    expect(progressCount(rows)).toBe('1/3')
  })
})
