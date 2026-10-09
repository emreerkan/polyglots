import { render, type RenderOptions } from 'ink'
import { App } from './App.js'
import { defaultCommands, type TuiCommands } from './commands.js'
import { createActivity, type Activity } from './hooks/activity.js'
import { closeServices, createServices } from './services.js'
import { stopOnSignal } from '../jobs/stop-on-signal.js'

export const EXIT_INTERRUPTED = 130

export interface RunTuiOptions {
  isTTY?: boolean
  exit?: (code: number) => void
  stdin?: RenderOptions['stdin']
  stdout?: RenderOptions['stdout']
  stderr?: RenderOptions['stderr']
  patchConsole?: boolean
  interactive?: boolean
  commands?: TuiCommands
  cwd?: string
  // For tests: a run already in flight, and a shorter wait on the stats
  // server's close than the two seconds a person gets.
  activity?: Activity
  closeTimeoutMs?: number
  // For tests: how long a line written on the way out may take to drain.
  writeTimeoutMs?: number
  // For tests: sends the signal on once it has been recorded, which for real
  // ends the process.
  raise?: (signal: NodeJS.Signals) => void
  // The update check main() started, for the header. Undefined when it is
  // off; resolves undefined when there is nothing newer.
  update?: Promise<string | undefined>
}

export async function runTui(opts: RunTuiOptions = {}): Promise<void> {
  const { isTTY = Boolean(process.stdin.isTTY), exit = process.exit, commands, cwd } = opts
  if (!isTTY) {
    throw new Error('The interactive menu needs a terminal; run a subcommand instead (see polyglots --help).')
  }
  // The alternate screen is Ink's own, including its teardown: Ink registers
  // a signal-exit hook that unmounts, and unmounting leaves the alternate
  // screen, so SIGTERM, SIGINT and an exit from anywhere give the terminal
  // back. Ctrl+C is the frame's to handle, not Ink's, because quitting during
  // a run asks first.
  const renderOptions: RenderOptions = { alternateScreen: true, exitOnCtrlC: false }
  if (opts.stdin) renderOptions.stdin = opts.stdin
  if (opts.stdout) renderOptions.stdout = opts.stdout
  if (opts.stderr) renderOptions.stderr = opts.stderr
  if (opts.patchConsole !== undefined) renderOptions.patchConsole = opts.patchConsole
  if (opts.interactive !== undefined) renderOptions.interactive = opts.interactive

  const activity = opts.activity ?? createActivity()
  const services = createServices()
  const stderr = opts.stderr ?? process.stderr
  const writeOut = (stream: NodeJS.WritableStream, text: string) => writeBounded(stream, text, opts.writeTimeoutMs)
  const instance = render(<App commands={commands} cwd={cwd} activity={activity} services={services} {...(opts.update === undefined ? {} : { update: opts.update })} />, renderOptions)
  // A signal never reaches the quit prompt or the exit code below, so a run
  // stopped by one is recorded as it happens; see stopOnSignal.
  const stopRuns = (commands ?? defaultCommands).stopOwnRuns
  const unwatchSignals = stopOnSignal({
    busy: () => activity.busy,
    stop: () => void stopRuns(),
    ...(opts.raise === undefined ? {} : { raise: opts.raise }),
  })
  try {
    await instance.waitUntilExit()
  } catch (err) {
    unwatchSignals()
    const trace = `\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    // A render crash with a run still going would leave that run writing
    // files from a process with no UI, so this is the same hard exit as a
    // quit during a run, with the trace written where it can be read.
    if (activity.busy) {
      await writeOut(stderr, `${trace}\nInterrupted; abandoning the run in progress.\n`)
      exit(EXIT_INTERRUPTED)
      throw err
    }
    // A stats server that will not close keeps Node alive behind the
    // rethrown error as surely as after a clean quit, so the error is
    // printed here and the process ends with it.
    if ((await closeServices(services, opts.closeTimeoutMs)) === 'timeout') {
      await writeOut(stderr, trace)
      exit(1)
    }
    throw err
  }

  unwatchSignals()

  // Before anything else: a listening server would keep Node alive after the
  // UI is gone, with nothing on screen to say why the shell has not come back.
  const closed = await closeServices(services, opts.closeTimeoutMs)

  // Printed after the alternate screen is gone, onto the screen the person
  // returns to, which is the only place it survives.
  const stdout = opts.stdout ?? process.stdout
  if (services.lastOutput !== undefined && exitSummaryWanted(commands ?? defaultCommands)) {
    await writeOut(stdout, `Last output: ${services.lastOutput}\n`)
  }

  // A translate/import/sync still in flight would keep the process alive and
  // keep writing files with no UI. The quit prompt already asked; exit hard.
  if (activity.busy) {
    // Said in the run history before the process goes, or the reaper later
    // files this deliberate quit as abandoned and stats counts it as a fault.
    // A failure to write it must not keep the process alive with no UI.
    try {
      (commands ?? defaultCommands).stopOwnRuns()
    } catch {
      // The reaper still ends the row, as abandoned; a wrong count beats a hung exit.
    }
    await writeOut(stderr, '\nStopped the run in progress; finished work is cached.\n')
    exit(EXIT_INTERRUPTED)
    return
  }
  // The server did not close in time, so its socket would hold the process
  // open past the restored terminal. Nothing else is left to finish.
  if (closed === 'timeout') exit(0)
}

const WRITE_TIMEOUT_MS = 1000

// Resolves once the stream has taken the text. On a pipe the write is
// asynchronous, and exiting straight after it can cut off the very line
// that was written to survive the exit.
//
// Or once the wait has gone on long enough. A pipe whose reader has stopped
// reading (a pager left open, a stalled ssh session) never calls back, and
// every caller here is on the way to exit: waiting on it would keep the
// process alive with the UI already gone, which in the busy paths means a run
// still writing files with nothing on screen. The line is worth a second, not
// the exit. The timer is unref'd so it never holds the process itself.
function writeBounded(stream: NodeJS.WritableStream, text: string, timeoutMs = WRITE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    timer.unref?.()
    stream.write(text, () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function exitSummaryWanted(commands: TuiCommands): boolean {
  try {
    return commands.loadTuiState().settings.exitSummary
  } catch {
    return true
  }
}
