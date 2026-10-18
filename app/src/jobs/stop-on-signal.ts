import { killAgents } from '../agent/children.js'
import { flushDebugCaptures } from '../agent/run.js'

// A run killed by a signal leaves its row at running, which the reaper later
// files as abandoned, and stats counts that beside crashes. SIGINT and SIGTERM
// are someone choosing to stop the run, Ctrl+C above all, and what it finished
// is cached for the next one, so the stop is recorded before the process goes.
// SIGHUP, the terminal going away, is nobody's choice and is left to the
// reaper.
//
// The handler does not take over the exit. It records, detaches, and sends the
// same signal again, so whatever would have happened without it still does:
// the default action in the plain CLI, Ink's signal-exit teardown in the TUI.
// That matters in the TUI because signal-exit stands aside while any other
// listener is attached; staying attached would leave the process alive with
// its screen half torn down.

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const

export interface StopOnSignalOptions {
  /** Whether a run is going in this process right now. */
  busy: () => boolean
  /** Records this process's running rows as stopped. Synchronous, as a signal handler must be. */
  stop: () => void
  /** Sends the signal on. Injected for tests, where the real one ends the worker. */
  raise?: (signal: NodeJS.Signals) => void
}

/** Listens until the returned function is called, or until the first signal. */
export function stopOnSignal({ busy, stop, raise = (signal) => process.kill(process.pid, signal) }: StopOnSignalOptions): () => void {
  const unwatch = () => {
    for (const signal of STOP_SIGNALS) process.off(signal, onSignal)
  }
  function onSignal(signal: NodeJS.Signals) {
    unwatch()
    if (busy()) {
      try {
        stop()
      } catch {
        // The reaper still ends the row, as abandoned. A signal is no place to hang.
      }
    }
    // The signal's default action ends the process without running exit
    // handlers, so the agents it started are killed here or not at all. A
    // debug run's output so far is written first: no close event follows.
    flushDebugCaptures()
    killAgents()
    raise(signal)
  }
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal)
  return unwatch
}
