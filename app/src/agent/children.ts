import { spawnSync, type ChildProcess } from 'node:child_process'

// The agent CLIs this process has started and that have not exited yet.
//
// On POSIX a child is not ended with its parent. The app quits with
// process.exit(), and Ctrl+C or a kill ends the process by the default action,
// and either way an agent still running was left behind with pid 1 as its
// parent. An antigravity session that had hung after answering was found that
// way, alive long after the run that started it had gone, and it ignored
// SIGTERM while it waited on its own shutdown. So the leftovers are killed
// with SIGKILL, on exit and on the signals: there is no time to wait for a
// polite exit, and the one agent that needed killing would not have taken one.
const live = new Set<ChildProcess>()
let hooked = false

export function trackAgent(child: ChildProcess): void {
  if (child.pid === undefined) return
  live.add(child)
  child.once('exit', () => live.delete(child))
  // 'exit' runs on process.exit() and on a natural end. It must stay
  // synchronous, which is why the kill below is. The signals are handled in
  // stopOnSignal, where the process already listens for them: a listener of
  // its own here would make Ink's signal-exit stand aside in the app.
  if (!hooked) {
    hooked = true
    process.once('exit', killAgents)
  }
}

export function liveAgents(): number {
  return live.size
}

/** Kills every agent still running. Synchronous, so it can run on exit and in a signal handler. */
export function killAgents(): void {
  for (const child of live) {
    try {
      if (process.platform === 'win32') {
        // A child started through cmd.exe is the shell; the agent is below it.
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        child.kill('SIGKILL')
      }
    } catch {
      // Already gone between the check and the kill.
    }
  }
  live.clear()
}
