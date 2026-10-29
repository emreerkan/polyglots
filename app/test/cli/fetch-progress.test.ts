import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFetchProgressReporter } from '../../src/cli/fetch-progress.js'

function fakeStream(isTTY: boolean) {
  const chunks: string[] = []
  return { isTTY, chunks, write: (c: string) => (chunks.push(c), true) }
}

// What a terminal shows once every carriage return and erase has been applied.
function screen(chunks: string[]): string[] {
  const lines = ['']
  for (const chunk of chunks) {
    for (const part of chunk.split(/(\r\x1b\[2K|\n)/)) {
      if (part === '\r\x1b[2K') lines[lines.length - 1] = ''
      else if (part === '\n') lines.push('')
      else lines[lines.length - 1] += part
    }
  }
  return lines
}

afterEach(() => vi.useRealTimers())

describe('the fetch progress line', () => {
  it('prints a line as each project ends when stderr is not a terminal', () => {
    const stream = fakeStream(false)
    const report = createFetchProgressReporter(stream, { title: 'Checking projects', verb: 'checked', total: 2 })
    report.working('koji')
    report.ended('koji', 'theme, 5 waiting')
    report.working('acme')
    report.ended('acme', 'not found')
    report.finish()
    expect(stream.chunks.join('')).toBe('checked 1/2 koji\nchecked 2/2 acme\n')
  })

  it('redraws one line on a terminal, naming the project in progress, and clears it at the end', () => {
    const stream = fakeStream(true)
    const report = createFetchProgressReporter(stream, { title: 'Checking projects', verb: 'checked', total: 3 })
    report.working('koji')
    report.ended('koji', 'theme, 5 waiting')
    report.working('acme')
    expect(screen(stream.chunks).at(-1)).toMatch(/^Checking projects 1\/3 ⠋ acme$/)
    report.finish()
    expect(screen(stream.chunks)).toEqual([''])
  })

  it('moves the spinner while a project takes its time', () => {
    vi.useFakeTimers()
    const stream = fakeStream(true)
    const report = createFetchProgressReporter(stream, { title: 'Downloading exports', verb: 'downloaded', total: 1 })
    report.working('woocommerce')
    vi.advanceTimersByTime(100)
    expect(screen(stream.chunks).at(-1)).toMatch(/^Downloading exports 0\/1 ⠙ woocommerce$/)
    report.finish()
  })

  // Nothing else lists the downloads before the batch's own table, so each
  // one that ends stays on screen above the live line.
  it('keeps a line for each project that ends when asked to', () => {
    const stream = fakeStream(true)
    const report = createFetchProgressReporter(stream, { title: 'Downloading exports', verb: 'downloaded', total: 2, keep: true })
    report.working('koji')
    report.ended('koji', 'saved')
    report.working('acme')
    expect(screen(stream.chunks)).toEqual(['  koji  saved', 'Downloading exports 1/2 ⠋ acme'])
    report.finish()
    expect(screen(stream.chunks)).toEqual(['  koji  saved', ''])
  })

  it('prints a notice above the live line and draws the line again', () => {
    const stream = fakeStream(true)
    const report = createFetchProgressReporter(stream, { title: 'Checking projects', verb: 'checked', total: 2 })
    report.working('koji')
    report.note('translate.wordpress.org asked to slow down; trying again in 45s')
    expect(screen(stream.chunks)).toEqual(['translate.wordpress.org asked to slow down; trying again in 45s', 'Checking projects 0/2 ⠋ koji'])
    report.finish()
  })

  it('says how a project ended on a pipe when asked to keep it', () => {
    const stream = fakeStream(false)
    const report = createFetchProgressReporter(stream, { title: 'Downloading exports', verb: 'downloaded', total: 1, keep: true })
    report.working('koji')
    report.ended('koji', 'failed: export answered 500')
    expect(stream.chunks.join('')).toBe('downloaded 1/1 koji: failed: export answered 500\n')
  })
})
