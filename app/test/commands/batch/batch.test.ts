import { describe, expect, it } from 'vitest'
import { MAX_PARALLEL, runProjects, type ProjectEvent } from '../../../src/commands/batch.js'
import { createRunControl, type RunControl } from '../../../src/run-control.js'
import { ProviderRefusal } from '../../../src/agent/agy-check.js'

// A job the test finishes by hand, so the order and overlap of jobs is the
// test's to decide rather than the timer's.
function deferred() {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('runProjects', () => {
  it('never runs more than the parallel count at once', async () => {
    let running = 0
    let peak = 0
    const files = Array.from({ length: 7 }, (_, i) => `f${i}.po`)
    await runProjects(files, {
      parallel: 3,
      run: async () => {
        running++
        peak = Math.max(peak, running)
        await tick()
        running--
        return 'ok'
      },
    })
    expect(peak).toBe(3)
  })

  it('clamps the parallel count to 1..8', async () => {
    const peakFor = async (parallel: number) => {
      let running = 0
      let peak = 0
      await runProjects(
        Array.from({ length: 12 }, (_, i) => `f${i}.po`),
        {
          parallel,
          run: async () => {
            running++
            peak = Math.max(peak, running)
            await tick()
            running--
          },
        },
      )
      return peak
    }
    expect(await peakFor(0)).toBe(1)
    expect(await peakFor(50)).toBe(MAX_PARALLEL)
    expect(MAX_PARALLEL).toBe(8)
  })

  it('reports a failed job and lets the rest finish', async () => {
    const outcomes = await runProjects(['a.po', 'b.po', 'c.po'], {
      parallel: 2,
      run: async (file) => {
        if (file === 'b.po') throw new Error('quota exhausted')
        return file.toUpperCase()
      },
    })
    expect(outcomes).toEqual([
      { file: 'a.po', state: 'done', summary: 'A.PO' },
      { file: 'b.po', state: 'failed', reason: 'quota exhausted' },
      { file: 'c.po', state: 'done', summary: 'C.PO' },
    ])
  })

  it('returns outcomes in input order whatever order the jobs finish in', async () => {
    const gates = { 'a.po': deferred(), 'b.po': deferred() }
    const done = runProjects(['a.po', 'b.po'], {
      parallel: 2,
      run: async (file) => {
        await gates[file as keyof typeof gates].promise
        return file
      },
    })
    await tick()
    gates['b.po'].resolve()
    await tick()
    gates['a.po'].resolve()
    expect((await done).map((o) => o.file)).toEqual(['a.po', 'b.po'])
  })

  // Stopping mid-batch is ordinary use: look at what is done, resume later.
  // Running jobs reach their own boundary and stop there; the batch must not
  // start anything new.
  it('starts nothing new once stopped, and marks the unstarted as stopped', async () => {
    const control = createRunControl()
    const first = deferred()
    const started: string[] = []
    const done = runProjects(['a.po', 'b.po', 'c.po'], {
      parallel: 1,
      control,
      run: async (file) => {
        started.push(file)
        if (file === 'a.po') await first.promise
        return file
      },
    })
    await tick()
    control.stop()
    first.resolve()
    const outcomes = await done
    expect(started).toEqual(['a.po'])
    expect(outcomes).toEqual([
      { file: 'a.po', state: 'done', summary: 'a.po' },
      { file: 'b.po', state: 'stopped' },
      { file: 'c.po', state: 'stopped' },
    ])
  })

  // A signed-out or exhausted provider is true of every file still queued,
  // so the first refusal stops the batch: the refused file and the ones never
  // started end stopped, not failed, since nothing went wrong in polyglots.
  it('stops the batch on a provider refusal and records it as stopped, not failed', async () => {
    const control = createRunControl()
    const started: string[] = []
    const outcomes = await runProjects(['a.po', 'b.po', 'c.po'], {
      parallel: 1,
      control,
      run: async (file) => {
        started.push(file)
        throw new ProviderRefusal('antigravity is signed out.')
      },
    })
    expect(started).toEqual(['a.po'])
    expect(control.state).toBe('stopping')
    expect(outcomes).toEqual([
      { file: 'a.po', state: 'stopped', reason: 'antigravity is signed out.' },
      { file: 'b.po', state: 'stopped' },
      { file: 'c.po', state: 'stopped' },
    ])
  })

  // A pause parks the pool as well as the jobs, so a resume continues the
  // batch instead of the pool racing ahead while every job sits at its gate.
  it('starts nothing new while paused, and carries on after resume', async () => {
    const control = createRunControl()
    const first = deferred()
    const started: string[] = []
    const done = runProjects(['a.po', 'b.po'], {
      parallel: 1,
      control,
      run: async (file) => {
        started.push(file)
        if (file === 'a.po') await first.promise
        return file
      },
    })
    await tick()
    control.pause()
    first.resolve()
    await tick()
    expect(started).toEqual(['a.po'])
    control.resume()
    await done
    expect(started).toEqual(['a.po', 'b.po'])
  })

  it('hands every job the same control', async () => {
    const control = createRunControl()
    const seen = new Set<RunControl>()
    await runProjects(['a.po', 'b.po', 'c.po'], {
      parallel: 2,
      control,
      run: async (_file, c) => {
        seen.add(c)
      },
    })
    expect([...seen]).toEqual([control])
  })

  it('tells the caller when each project starts and ends', async () => {
    const events: ProjectEvent<string>[] = []
    await runProjects(['a.po'], { parallel: 1, run: async () => 'ok', onEvent: (e) => events.push(e) })
    expect(events).toEqual([
      { type: 'project-start', file: 'a.po' },
      { type: 'project-end', outcome: { file: 'a.po', state: 'done', summary: 'ok' } },
    ])
  })
})
