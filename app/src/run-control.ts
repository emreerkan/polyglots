export type RunState = 'running' | 'paused' | 'stopping'

// What a batch loop should do when it reaches a boundary.
export type Gate = 'go' | 'stop'

export interface RunControl {
  readonly state: RunState
  pause(): void
  resume(): void
  stop(): void
  // Awaited at a batch boundary, never inside one. A paused run therefore always
  // finishes the batch it is in, and whatever that batch decided is persisted by
  // the normal path before anything parks.
  gate(): Promise<Gate>
  subscribe(listener: (state: RunState) => void): () => void
}

export function createRunControl(): RunControl {
  let state: RunState = 'running'
  // Every parked gate, not just one. A single slot was enough while one review
  // owned a control, but a fetch batch shares one control across parallel jobs,
  // and a single slot kept only the last waiter: the others never woke.
  const waiting = new Set<() => void>()
  const listeners = new Set<(state: RunState) => void>()

  const set = (next: RunState): void => {
    if (state === next) return
    state = next
    // Anything that is not a pause frees a gate that is already waiting.
    // Released before the listeners are told, not after: the listeners are
    // the caller's, and one that threw used to skip the release and leave
    // every parked job parked for good, which hung a batch that waits for
    // all of its workers. The released gates continue as microtasks, so the
    // listeners still run, and print, first.
    if (next !== 'paused') {
      for (const release of waiting) release()
      waiting.clear()
    }
    for (const listener of listeners) listener(next)
  }

  return {
    get state() {
      return state
    },
    // A stopping run is on its way out, so a late keypress must not park it.
    pause: () => set(state === 'running' ? 'paused' : state),
    resume: () => set(state === 'paused' ? 'running' : state),
    stop: () => set('stopping'),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async gate() {
      // A loop rather than a single await: a resume followed by another pause
      // before the loop gets its turn must park again, not fall through.
      while (state === 'paused') {
        await new Promise<void>((resolve) => {
          waiting.add(resolve)
        })
      }
      return state === 'stopping' ? 'stop' : 'go'
    },
  }
}
