import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads'

/**
 * How long one regex may run over one text before it is given up on.
 *
 * A JavaScript regex cannot be interrupted in the thread that runs it, so a
 * pattern with nested repetition, ^(a+)+$ over thirty a's and a b, hangs the
 * whole review, and a rules file is now something people download. Every
 * regex a rules file carries therefore runs in a worker that the main thread
 * can terminate. A hundred milliseconds is three orders of magnitude above
 * what a sane pattern takes on the longest WordPress string, and short enough
 * that a run of thousands of entries notices one bad pattern only once.
 */
export const PATTERN_BUDGET_MS = 100

// Generous on purpose: a fresh worker loads in tens of milliseconds, but on a
// machine busy with a test suite or a build it can take far longer, and a
// worker that has not started yet has run nobody's pattern.
const START_BUDGET_MS = 10_000

export type RegexOp =
  | { kind: 'exec'; id: string; source: string; flags: string; text: string; normalise?: boolean }
  | { kind: 'replace'; id: string; source: string; flags: string; text: string; replacement: string; capitaliseTag?: string }
export type RegexOpResult = { id: string; match?: string | null; text?: string }

// Slots of the shared Int32Array. DONE is what the main thread waits on; the
// worker writes the op it is on to CURRENT and bumps TICK as it starts each
// one, which is how a stalled op is told from a slow batch of quick ones.
const DONE = 0
const CURRENT = 1
const TICK = 2
const READY = 3

/**
 * One op, evaluated. Self-contained, because its source text is what the
 * worker runs: it may reference nothing outside itself, not even a helper
 * from this module. It is also what the in-thread measurement switch calls,
 * so the two paths cannot evaluate differently.
 */
function evaluate(op: RegexOp): RegexOpResult {
  if (op.kind === 'exec') {
    const text = op.normalise ? op.text.normalize('NFC') : op.text
    const source = op.normalise ? op.source.normalize('NFC') : op.source
    const m = new RegExp(source, op.flags).exec(text)
    return { id: op.id, match: m ? m[0] : null }
  }
  const re = new RegExp(op.source, op.flags)
  const tag = op.capitaliseTag
  const text =
    tag === undefined
      ? op.text.replace(re, op.replacement)
      : op.text.replace(re, (m: string) => {
          // A literal replacement keeps the capital of what it replaced, in
          // the locale's own casing: Önizleme becomes Ön izleme.
          const first = [...m][0]
          if (!first || first === first.toLocaleLowerCase(tag)) return op.replacement
          const [head = '', ...rest] = [...op.replacement]
          return head.toLocaleUpperCase(tag) + rest.join('')
        })
  return { id: op.id, text }
}

// The worker's whole program. Written as a function so tsc and vitest's
// transform both turn it into plain JavaScript, then started from its source
// text with eval: a worker file would exist only in dist/, and the tests run
// the TypeScript sources. It imports nothing but worker_threads: every regex
// source arrives built, so the casing tables and literal expansion stay on the
// main thread. `evaluate` is defined beside it in the same eval'd text.
function workerMain(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { workerData } = require('node:worker_threads') as typeof import('node:worker_threads')
  const { port, shared } = workerData as { port: MessagePort; shared: SharedArrayBuffer }
  const state = new Int32Array(shared)
  port.on('message', (ops: RegexOp[]) => {
    const out: RegexOpResult[] = []
    ops.forEach((op, i) => {
      Atomics.store(state, CURRENT, i)
      Atomics.add(state, TICK, 1)
      // A pattern the schema let through cannot throw here; if one ever does,
      // its op yields no result rather than taking the worker down, which
      // would read to the main thread as a hang and skip the pattern for good.
      try {
        out.push(evaluate(op))
      } catch {
        // no result
      }
    })
    port.postMessage(out)
    Atomics.store(state, DONE, 1)
    Atomics.notify(state, DONE)
  })
  Atomics.store(state, READY, 1)
  Atomics.notify(state, READY)
}

// The slot names are constants in this module, which the eval'd text cannot
// see, so they are prepended as declarations of their own.
const WORKER_SOURCE = [
  `const DONE = ${DONE}, CURRENT = ${CURRENT}, TICK = ${TICK}, READY = ${READY};`,
  evaluate.toString(),
  `(${workerMain.toString()})()`,
].join('\n')

let worker: Worker | undefined
let port: MessagePort | undefined
let state: Int32Array | undefined
let inThread = false
// Every pattern given up on in this process, with the label to report it by.
const skipped = new Map<string, string>()
// The skipped patterns this run asked for, for its summary. Filled when a
// pattern hangs and again whenever a later call asks for one skipped earlier,
// so a second review in the same TUI session still names it once, though it
// never runs it.
let reported = new Map<string, string>()

function start(): { port: MessagePort; state: Int32Array } {
  const shared = new SharedArrayBuffer(4 * 4)
  const channel = new MessageChannel()
  state = new Int32Array(shared)
  port = channel.port1
  worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { port: channel.port2, shared },
    transferList: [channel.port2],
  })
  // The worker must not keep a finished CLI process alive.
  worker.unref()
  port.unref()
  // Wait for the worker to be listening before anything is timed against it.
  // Without this the first op of the first call is charged with the worker's
  // start-up, and on a slow start a harmless pattern is skipped for good.
  if (Atomics.wait(state, READY, 0, START_BUDGET_MS) === 'timed-out' && Atomics.load(state, READY) === 0) {
    stop()
    throw new Error(`the locale rules worker did not start within ${START_BUDGET_MS / 1000} s`)
  }
  return { port, state }
}

function stop(): void {
  void worker?.terminate()
  worker = undefined
  port = undefined
  state = undefined
}

/**
 * Runs the ops in the worker, synchronously, and returns a result per op that
 * finished, in op order. An op whose pattern ran over budget, and every op of
 * a pattern skipped earlier in the process, yields no result; callers read
 * results by id, so a missing one reads as no match and no change.
 *
 * `label` names a pattern for the person, by its note or its text, when it
 * is skipped.
 */
export function runRegexOps(ops: readonly RegexOp[], label: (id: string) => string = (id) => id): RegexOpResult[] {
  let pending = ops.filter((op) => {
    const known = skipped.get(op.id)
    if (known === undefined) return true
    reported.set(op.id, known)
    return false
  })
  if (inThread) return pending.map(evaluate)
  // Only the batch that finished contributes: a batch with a hung op is
  // thrown away whole, so the results are always in op order.
  const results: RegexOpResult[] = []
  while (pending.length > 0) {
    const w = worker && port && state ? { port, state } : start()
    Atomics.store(w.state, DONE, 0)
    w.port.postMessage(pending)
    let lastTick = Atomics.load(w.state, TICK)
    let hung: number | undefined
    // Woken every budget interval: if the worker started no new op in a whole
    // interval, the op it is on has run past the budget. A batch of a thousand
    // quick ops may take longer than one interval in all and is never blamed,
    // because each interval sees the tick move.
    while (Atomics.load(w.state, DONE) === 0) {
      Atomics.wait(w.state, DONE, 0, PATTERN_BUDGET_MS)
      if (Atomics.load(w.state, DONE) === 1) break
      const tick = Atomics.load(w.state, TICK)
      if (tick === lastTick) {
        hung = Atomics.load(w.state, CURRENT)
        break
      }
      lastTick = tick
    }
    if (hung === undefined) {
      const msg = receiveMessageOnPort(w.port)
      results.push(...((msg?.message as RegexOpResult[] | undefined) ?? []))
      break
    }
    // The ops before the hung one finished, but their results went with the
    // worker, so everything but the hung pattern is sent again to a fresh one.
    // Every op of that pattern goes, not only the one that hung: the next text
    // could hang it just the same.
    stop()
    const id = pending[hung]!.id
    const name = label(id)
    skipped.set(id, name)
    reported.set(id, name)
    pending = pending.filter((op) => op.id !== id)
  }
  return results
}

/** Pattern ids skipped in this process, with the label each is reported by, and clears the list. */
export function takeSkipped(): { id: string; label: string }[] {
  const out = [...reported].map(([id, label]) => ({ id, label }))
  reported = new Map()
  return out
}

export function skippedFor(id: string): boolean {
  return skipped.has(id)
}

// For the overhead measurement only: the same evaluation, in this thread and
// with no budget, to compare the sandbox's cost against. Never set elsewhere.
export function evaluateInThreadForMeasurement(on: boolean): void {
  inThread = on
}

/** For tests: a fresh worker and no memory of skipped patterns. */
export function resetSandbox(): void {
  stop()
  skipped.clear()
  reported = new Map()
  inThread = false
}
