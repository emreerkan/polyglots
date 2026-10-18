import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logsDir, runLogStem } from './paths.js'

export interface RunLog {
  readonly path: string
  readonly debugDir: string | undefined
  write(kind: string, fields?: Record<string, unknown>): void
  // The batch the run is in, from the last batch-start event written, and the
  // next agent call's 1-based attempt within it. The agent lines and the debug
  // file names both carry the pair, so a retry is told from the first try.
  nextCall(): { batch: number; attempt: number }
  noteBatch(index: number): void
  // Appends to debugDir/name; does nothing when debug is off. A function is
  // called only when debug is on, so a caller can hand over the work of
  // rendering a large line without paying for it on every run.
  debugWrite(name: string, line: string | (() => string)): void
}

// The run a piece of async work belongs to. spawnAgent reads it rather than
// taking a new option: runBatch assembles agent options field by field, and an
// option missing from that list is dropped without a word, which is how every
// antigravity review once spawned claude. Two files reviewed in parallel each
// run inside their own context, so neither writes into the other's log.
const current = new AsyncLocalStorage<RunLog>()

export function currentRunLog(): RunLog | undefined {
  return current.getStore()
}

// The log is required: an optional one ran fn in whatever context the caller
// was already in, so a run without a log of its own would write into the log
// of the run around it, which is the cross-talk the context exists to stop.
export function withRunLog<T>(log: RunLog, fn: () => Promise<T>): Promise<T> {
  return current.run(log, fn)
}

export function openRunLog(opts: { runId: number; startedAt: number; debug: boolean; warn?: (line: string) => void }): RunLog {
  const stem = runLogStem(opts.startedAt, opts.runId)
  const path = join(logsDir(), `${stem}.jsonl`)
  // Created on the first debug write, not here: a run that never writes one
  // leaves no empty folder behind to wonder about.
  const debugDir = opts.debug ? join(logsDir(), stem) : undefined
  // One flag for the run log and one for the debug folder. A single flag let
  // a debug file that could not be written silence the run log for the rest
  // of the run, under a warning that named the wrong file; the run log is the
  // one every report reads, and the debug files are extras beside it.
  const broken = { main: false, debug: false }
  let unrenderable = false
  let batch = 0
  let attempt = 0
  const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
  // Synchronous on purpose. A line appended before the process dies is the one
  // that explains the death; a buffered stream would lose exactly that line.
  //
  // The line is rendered here, inside a try, rather than by the caller: a
  // field JSON cannot hold (a BigInt, a cycle) throws from JSON.stringify, and
  // "a log never fails a run" should not rest on no event ever carrying one.
  // Such a line is dropped with a warning, once, and the lines after it are
  // still written: one odd event says nothing about the folder.
  const append = (which: 'main' | 'debug', file: string, render: () => string) => {
    if (broken[which]) return
    let text: string
    try {
      text = render()
    } catch (err) {
      if (!unrenderable) {
        unrenderable = true
        opts.warn?.(`polyglots: could not write a line to ${file} (${message(err)}); the run goes on`)
      }
      return
    }
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, text)
    } catch (err) {
      // A log is never worth a run. Said once, then silent for the rest of it.
      broken[which] = true
      opts.warn?.(
        which === 'main'
          ? `polyglots: could not write the run log ${file} (${message(err)}); the run goes on without it`
          : `polyglots: could not write the debug file ${file} (${message(err)}); the run goes on without debug files`,
      )
    }
  }
  // The file exists from the moment the run opens it, empty or not. A folder
  // that cannot be written is then said before the first batch rather than at
  // the first event, and a debug run whose only lines so far went to the debug
  // folder still has a run log for the report to find.
  append('main', path, () => '')
  return {
    path,
    debugDir,
    write(kind, fields = {}) {
      append('main', path, () => JSON.stringify({ t: Date.now(), kind, ...fields }) + '\n')
    },
    nextCall() {
      attempt += 1
      return { batch, attempt }
    },
    noteBatch(index) {
      batch = index
      attempt = 0
    },
    debugWrite(name, line) {
      if (debugDir) append('debug', join(debugDir, name), () => (typeof line === 'function' ? line() : line) + '\n')
    },
  }
}

export function logRunEvent(log: RunLog, event: { type: string }): void {
  if (event.type === 'batch-start') log.noteBatch((event as { type: string; index: number }).index)
  if (event.type === 'entries') {
    // Catalogue text: only a debug run keeps it, and never in the main log.
    // Rendered only when debug is on: a 100-entry batch is not small, and a
    // run with debug off would serialize every one of them to throw it away.
    log.debugWrite('entries.jsonl', () => JSON.stringify({ t: Date.now(), ...event }))
    return
  }
  if (event.type === 'warning') {
    // Free text from the draft engines, and the placeholder warning quotes the
    // msgid it is about. Stripping just that quote would mean parsing every
    // engine's wording and trusting the next warning to follow it; the main log
    // keeps that a warning happened and how long it was, and a debug run, which
    // may hold catalogue text, keeps the words.
    const { message } = event as { type: string; message: string }
    log.write('warning', { chars: message.length })
    log.debugWrite('warnings.jsonl', () => JSON.stringify({ t: Date.now(), message }))
    return
  }
  const { type, ...rest } = event as { type: string } & Record<string, unknown>
  log.write(type, rest)
}
