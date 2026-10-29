import { plainPainter, type Painter } from '../ui/paint.js'
import { CLEAR_LINE, redraw, type ProgressStream } from './progress.js'

// Fast enough to read as motion, slow enough to cost nothing on a remote shell.
const FRAME_MS = 100

export interface FetchProgressReporter {
  working(input: string): void
  ended(input: string, detail: string): void
  // A line of its own, such as a rate-limit wait, without breaking the live one.
  note(line: string): void
  finish(): void
}

/**
 * Fetch's lookups and downloads, a project at a time, on stderr.
 *
 * On a terminal it is one line, redrawn: how many have ended, and a spinner
 * beside the project in progress, since an export of a big plugin can take
 * minutes with nothing else changing. Down a pipe a redrawn line is noise in a
 * log, so each project that ends gets a line of its own instead. `keep` also
 * keeps a line per project on a terminal, for the downloads: the lookups are
 * followed by their table, but nothing lists the downloads until the batch
 * ends.
 */
export function createFetchProgressReporter(
  stream: ProgressStream,
  opts: { title: string; verb: string; total: number; keep?: boolean },
  p: Painter = plainPainter,
): FetchProgressReporter {
  const tty = stream.isTTY === true
  let done = 0
  let current: string | undefined
  let frame = 0
  let ticker: NodeJS.Timeout | undefined
  let live = false

  const draw = () => {
    const spin = current === undefined ? '' : ` ${p.glyphs.spinner[frame % p.glyphs.spinner.length]} ${current}`
    stream.write(redraw(`${opts.title} ${done}/${opts.total}${spin}`, p))
    live = true
  }
  const stopTicking = () => {
    if (ticker) clearInterval(ticker)
    ticker = undefined
  }

  return {
    working(input) {
      current = input
      if (!tty) return
      frame = 0
      draw()
      if (!ticker) {
        ticker = setInterval(() => {
          frame++
          draw()
        }, FRAME_MS)
        ticker.unref?.()
      }
    },
    ended(input, detail) {
      done++
      current = undefined
      if (!tty) {
        stream.write(`${opts.verb} ${done}/${opts.total} ${input}${opts.keep ? `: ${detail}` : ''}\n`)
        return
      }
      stopTicking()
      if (opts.keep) stream.write(`${CLEAR_LINE}  ${input}  ${detail}\n`)
      draw()
    },
    note(line) {
      if (!tty) {
        stream.write(`${line}\n`)
        return
      }
      stream.write(`${CLEAR_LINE}${line}\n`)
      draw()
    },
    finish() {
      stopTicking()
      if (live) stream.write(CLEAR_LINE)
      live = false
    },
  }
}
