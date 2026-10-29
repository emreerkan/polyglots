import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveConfig } from '../../src/config.js'
import React from 'react'
import type { Fetched, Ready, Resolution } from '../../src/commands/fetch.js'
import type { TranslateOptions } from '../../src/commands/translate.js'
import { CommandsProvider, type ReviewFileOptions, type TuiCommands } from '../../src/tui/commands.js'
import { App } from '../../src/tui/App.js'
import { Fetch } from '../../src/tui/screens/Fetch.js'
import type { ProjectRef } from '../../src/wporg/projects.js'
import {
  fakeCommands,
  flat,
  openFromHome,
  keys,
  makeHome,
  render,
  reviewSummaryOf,
  summaryOf,
  tick,
  waitFor,
  waitForText,
  cleanup,
  type Home,
} from './helpers.js'

let home: Home

beforeEach(async () => {
  home = await makeHome()
  // Named rather than assumed: polyglots has no default locale (no-locale.test.tsx).
  saveConfig({ defaultLocale: 'tr' })
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

// "missing" does not exist, "quiet" has nothing in the chosen status, and every
// other slug resolves as a theme with five strings.
const resolveProjects: TuiCommands['resolveProjects'] = async (refs: ProjectRef[], opts) =>
  refs.map((r): Resolution => {
    if (r.slug === 'missing') return { input: r.slug, state: 'not-found', reason: 'no theme or plugin' }
    if (r.slug === 'quiet') return { input: r.slug, state: 'empty', reason: `nothing ${opts.status}` }
    return { input: r.slug, state: 'ready', type: 'wp-themes', slug: r.slug, count: 5 }
  })

const fetchProjects: TuiCommands['fetchProjects'] = async (ready: Ready[], opts) =>
  ready.map((p): Fetched => ({ input: p.input, state: 'fetched', file: `${opts.outDir}/wp-themes-${p.slug}-tr.po` }))

function mount(overrides: Partial<TuiCommands> = {}, onBack: () => void = () => undefined) {
  const commands = fakeCommands({ resolveProjects, fetchProjects, ...overrides })
  const view = render(
    <CommandsProvider value={commands}>
      <Fetch onBack={onBack} />
    </CommandsProvider>,
  )
  return { ...view, commands }
}

type View = ReturnType<typeof mount>

async function enterList(view: View, lines: string[]) {
  await waitForText(view.lastFrame, /Projects/)
  for (const line of lines) {
    view.stdin.write(line)
    await tick()
    view.stdin.write(keys.enter)
    await tick()
  }
  view.stdin.write(keys.enter)
  await waitForText(view.lastFrame, /What to get/)
}

// From the "what to get" step to the options, choosing untranslated when asked.
async function chooseAndResolve(view: View, status: 'waiting' | 'untranslated') {
  if (status === 'untranslated') {
    view.stdin.write(keys.down)
    await tick()
  }
  view.stdin.write(keys.enter)
  await waitForText(view.lastFrame, /enter to continue/)
}

async function toOptions(view: View) {
  view.stdin.write(keys.enter)
  await waitForText(view.lastFrame, /Parallel/)
}

describe('Fetch list', () => {
  it('takes several projects, one per line', async () => {
    const view = mount()
    await waitForText(view.lastFrame, /Projects/)
    view.stdin.write('koji')
    await tick()
    view.stdin.write(keys.enter)
    await tick()
    view.stdin.write('sydney')
    await waitForText(view.lastFrame, 'sydney')
    expect(view.lastFrame()).toContain('koji')
  })

  // A list copied from a browser arrives as one paste with its line breaks.
  it('splits a pasted list into its lines', async () => {
    const view = mount()
    await waitForText(view.lastFrame, /Projects/)
    view.stdin.write('koji\rsydney\r')
    await waitForText(view.lastFrame, 'sydney')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /What to get/)
  })

  // translate.wordpress.org is asked by the slug's export path; a wp code in
  // a config.json edited by hand is read as the slug, as the CLI reads it.
  it('resolves the projects under the slug when config holds a wp code', async () => {
    saveConfig({ defaultLocale: 'tr_TR' })
    const asked = vi.fn(resolveProjects)
    const view = mount({ resolveProjects: asked })
    await enterList(view, ['koji'])
    await chooseAndResolve(view, 'waiting')
    expect(asked.mock.calls[0]![1].locale).toBe('tr')
  })

  it('does not move on from an empty list', async () => {
    const view = mount()
    await waitForText(view.lastFrame, /Projects/)
    view.stdin.write(keys.enter)
    await tick(20)
    expect(view.lastFrame()).not.toMatch(/What to get/)
  })
})

// The same choice as --no-readme (#33), asked with what to get, since both
// decide what the check of the list looks for.
describe('Fetch readme choice', () => {
  function recording() {
    const readme: Array<boolean | undefined> = []
    const record: TuiCommands['resolveProjects'] = async (refs, opts) => {
      readme.push(opts.readme)
      return resolveProjects(refs, opts)
    }
    return { readme, record }
  }

  it("fetches a plugin's readme too unless it is turned off", async () => {
    const { readme, record } = recording()
    const view = mount({ resolveProjects: record })
    await enterList(view, ['koji'])
    expect(flat(view.lastFrame())).toMatch(/Plugin readme: also fetched/)
    await chooseAndResolve(view, 'waiting')
    expect(readme).toEqual([true])
  })

  it('takes the code only after r', async () => {
    const { readme, record } = recording()
    const view = mount({ resolveProjects: record })
    await enterList(view, ['koji'])
    view.stdin.write('r')
    await waitForText(view.lastFrame, /Plugin readme: not fetched/)
    await chooseAndResolve(view, 'waiting')
    expect(readme).toEqual([false])
  })
})

describe('Fetch resolution', () => {
  it('shows counts, and marks the empty and the missing', async () => {
    const view = mount()
    await enterList(view, ['koji', 'missing', 'quiet'])
    await chooseAndResolve(view, 'waiting')
    const frame = flat(view.lastFrame())
    expect(frame).toMatch(/koji theme, 5 waiting/)
    expect(frame).toMatch(/missing not found/)
    expect(frame).toMatch(/quiet nothing waiting/)
  })

  it('says so and stops when nothing has work', async () => {
    const view = mount()
    await enterList(view, ['missing', 'quiet'])
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Nothing to do/)
  })
})

describe('Fetch options', () => {
  it("shows review's options for waiting strings", async () => {
    const view = mount()
    await enterList(view, ['koji'])
    await chooseAndResolve(view, 'waiting')
    await toOptions(view)
    const frame = view.lastFrame()
    expect(frame).toMatch(/Skip AI/)
    expect(frame).not.toMatch(/Draft engine/)
    expect(frame).toMatch(/Review 1 project/)
  })

  it("shows translate's options for untranslated strings", async () => {
    const view = mount()
    await enterList(view, ['koji'])
    await chooseAndResolve(view, 'untranslated')
    await toOptions(view)
    const frame = view.lastFrame()
    expect(frame).toMatch(/Draft engine/)
    expect(frame).not.toMatch(/Skip AI/)
    expect(frame).toMatch(/Translate 1 project/)
  })

  // With No AI chosen, review is rules-only whatever this field says, so it
  // says so and does not offer a "no" it cannot honour.
  it('holds Skip AI on with No AI chosen', async () => {
    saveConfig({ defaultLocale: 'tr', reviewProvider: 'none' })
    const view = mount()
    await enterList(view, ['koji'])
    await chooseAndResolve(view, 'waiting')
    await toOptions(view)
    expect(view.lastFrame()).toMatch(/Skip AI:\s+yes/)
    for (const k of [keys.down, keys.down, keys.down, ' ']) {
      view.stdin.write(k)
      await tick()
    }
    expect(view.lastFrame()).toMatch(/Skip AI:\s+yes/)
  })

  it('steps parallel between 1 and 8 and stops at both ends', async () => {
    const view = mount()
    await enterList(view, ['koji'])
    await chooseAndResolve(view, 'waiting')
    await toOptions(view)
    view.stdin.write(keys.left)
    await tick()
    expect(view.lastFrame()).toMatch(/Parallel:\s+1/)
    for (let i = 0; i < 10; i++) {
      view.stdin.write(keys.right)
      await tick()
    }
    await waitForText(view.lastFrame, /Parallel:\s+8/)
  })
})

describe('Fetch run', () => {
  it('reviews every fetched project with the options chosen', async () => {
    const calls: ReviewFileOptions[] = []
    const view = mount({
      reviewFile: vi.fn(async (opts: ReviewFileOptions) => {
        calls.push(opts)
        return reviewSummaryOf(opts.file)
      }),
    })
    await enterList(view, ['koji', 'sydney', 'missing'])
    await chooseAndResolve(view, 'waiting')
    await toOptions(view)
    // Parallel → batch size → start over (toggle on) → skip AI → start.
    view.stdin.write(keys.right)
    await tick()
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(' ')
    await tick()
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /2 done, 0 failed, 1 skipped/)
    expect(calls.map((c) => c.file.split('/').pop())).toEqual(['wp-themes-koji-tr.po', 'wp-themes-sydney-tr.po'])
    expect(calls[0]).toMatchObject({ fresh: true, locale: 'tr' })
    expect(calls[0]!.noAi).toBeUndefined()
    expect(calls[0]!.db).toBeDefined()
    expect(calls[0]!.db).toBe(calls[1]!.db)
    expect(calls[0]!.control).toBe(calls[1]!.control)
  })

  // Every project in a fetch run spawns the configured provider, so each one
  // must run the binary discovery checked, not whatever is first on PATH.
  it('runs the agent binary named by POLYGLOTS_AGENT_BIN for every project', async () => {
    vi.stubEnv('POLYGLOTS_AGENT_BIN', '/opt/claude/bin/claude')
    try {
      const calls: ReviewFileOptions[] = []
      const view = mount({
        reviewFile: vi.fn(async (opts: ReviewFileOptions) => {
          calls.push(opts)
          return reviewSummaryOf(opts.file)
        }),
      })
      await enterList(view, ['koji', 'sydney'])
      await chooseAndResolve(view, 'waiting')
      await toOptions(view)
      for (let i = 0; i < 4; i++) {
        view.stdin.write(keys.down)
        await tick()
      }
      view.stdin.write(keys.enter)
      await waitForText(view.lastFrame, /2 done/)
      expect(calls.map((c) => c.bin)).toEqual(['/opt/claude/bin/claude', '/opt/claude/bin/claude'])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('translates in pending mode with the chosen engine', async () => {
    const calls: TranslateOptions[] = []
    const view = mount({
      translateFile: vi.fn(async (opts: TranslateOptions) => {
        calls.push(opts)
        return summaryOf(opts.file)
      }),
    })
    await enterList(view, ['koji'])
    await chooseAndResolve(view, 'untranslated')
    await toOptions(view)
    // Parallel → batch size → draft engine (next one) → start over → start.
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.right)
    await tick()
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /1 done/)
    expect(calls[0]).toMatchObject({ mode: 'pending', draftEngine: 'openai' })
  })

  it('lists how each project ended, failures included', async () => {
    const view = mount({
      reviewFile: vi.fn(async (opts: ReviewFileOptions) => {
        if (opts.file.includes('boom')) throw new Error('quota exhausted')
        return reviewSummaryOf(opts.file)
      }),
    })
    await enterList(view, ['koji', 'boom', 'quiet'])
    await chooseAndResolve(view, 'waiting')
    await toOptions(view)
    for (let i = 0; i < 4; i++) {
      view.stdin.write(keys.down)
      await tick()
    }
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /1 done, 1 failed, 1 skipped/)
    const frame = flat(view.lastFrame())
    expect(frame).toMatch(/boom failed quota exhausted/)
    expect(frame).toMatch(/koji done/)
  })
})

describe('Fetch waiting on wp.org', () => {
  it('shows that it is waiting on wp.org while checking the list', async () => {
    let release!: () => void
    const view = mount({
      resolveProjects: async (refs, opts) => {
        opts.onWait?.(45_000, 'https://translate.wordpress.org/')
        await new Promise<void>((r) => (release = r))
        return resolveProjects(refs, opts)
      },
    })
    await enterList(view, ['koji'])
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /asked to slow down.*45s/)
    release()
    await waitForText(view.lastFrame, /enter to continue/)
  })
})

describe('Menu entry', () => {
  it('reaches the fetch screen from the menu', async () => {
    const commands = fakeCommands({ resolveProjects, fetchProjects })
    const view = render(<App commands={commands} />)
    await waitForText(view.lastFrame, 'Fetch from translate.wordpress.org')
    await openFromHome(view.stdin, 'fetch')
    await waitFor(() => /Projects/.test(view.lastFrame()))
  })
})

// A list of thirty projects is minutes of requests, and an export of a big
// plugin takes minutes on its own. Every line is on screen while that runs,
// the one being worked on marked with a spinner, and a count says how far.
describe('Fetch progress', () => {
  const SPIN = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/

  it('lists every project while the list is checked and marks the one in progress', async () => {
    let release!: () => void
    const view = mount({
      resolveProjects: async (refs, opts) => {
        opts.onProgress?.({ input: 'koji', state: 'checking' })
        opts.onProgress?.({ input: 'koji', state: 'checked', results: [{ input: 'koji', state: 'ready', type: 'wp-themes', slug: 'koji', count: 5 }] })
        opts.onProgress?.({ input: 'sydney', state: 'checking' })
        await new Promise<void>((r) => (release = r))
        return resolveProjects(refs, opts)
      },
    })
    await enterList(view, ['koji', 'sydney', 'astra'])
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Checking projects: 1\/3/)
    const frame = flat(view.lastFrame())
    expect(frame).toMatch(/koji theme, 5 waiting/)
    expect(frame).toMatch(new RegExp(`${SPIN.source} sydney checking`))
    expect(frame).toMatch(/astra queued/)
    release()
    await waitForText(view.lastFrame, /enter to continue/)
  })

  it('lists every export while they download and marks the one in progress', async () => {
    let release!: () => void
    const view = mount({
      fetchProjects: async (ready, opts) => {
        opts.onProgress?.({ input: 'koji', state: 'downloading' })
        opts.onProgress?.({ input: 'koji', state: 'downloaded', result: { input: 'koji', state: 'fetched', file: '/x/koji.po' } })
        opts.onProgress?.({ input: 'sydney', state: 'downloading' })
        await new Promise<void>((r) => (release = r))
        return fetchProjects(ready, opts)
      },
    })
    await enterList(view, ['koji', 'sydney', 'missing'])
    await chooseAndResolve(view, 'waiting')
    await toOptions(view)
    for (let i = 0; i < 4; i++) {
      view.stdin.write(keys.down)
      await tick()
    }
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Downloading exports: 1\/2/)
    const frame = flat(view.lastFrame())
    expect(frame).toMatch(/koji saved/)
    expect(frame).toMatch(new RegExp(`${SPIN.source} sydney downloading`))
    expect(frame).not.toMatch(/missing/)
    release()
  })
})

// Leaving part way asks first, since a long list is minutes of work to throw
// away, and a yes cancels the requests rather than leaving them running.
describe('Fetch stopped part way', () => {
  // Never answers, and records the signal it was handed.
  function hanging() {
    const seen: { signal?: AbortSignal } = {}
    const wait = (signal: AbortSignal | undefined) =>
      new Promise<never>((_resolve, reject) => {
        seen.signal = signal
        signal?.addEventListener('abort', () => reject(signal.reason))
      })
    return { seen, wait }
  }

  for (const [name, key] of [
    ['q', 'q'],
    ['esc', keys.esc],
  ] as const) {
    it(`asks before ${name} stops the check, and goes back to the menu on yes`, async () => {
      const { seen, wait } = hanging()
      const onBack = vi.fn()
      const view = mount({ resolveProjects: async (_refs, opts) => wait(opts.signal) }, onBack)
      await enterList(view, ['koji'])
      view.stdin.write(keys.enter)
      await waitForText(view.lastFrame, /Checking projects/)
      view.stdin.write(key)
      await waitForText(view.lastFrame, /Stop checking and go back to the menu\?/)
      expect(onBack).not.toHaveBeenCalled()
      view.stdin.write('y')
      await tick()
      expect(onBack).toHaveBeenCalledTimes(1)
      expect(seen.signal?.aborted).toBe(true)
    })
  }

  it('keeps checking on no', async () => {
    const { seen, wait } = hanging()
    const onBack = vi.fn()
    const view = mount({ resolveProjects: async (_refs, opts) => wait(opts.signal) }, onBack)
    await enterList(view, ['koji'])
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Checking projects/)
    view.stdin.write('q')
    await waitForText(view.lastFrame, /Stop checking/)
    view.stdin.write('n')
    await tick()
    expect(flat(view.lastFrame())).not.toMatch(/Stop checking/)
    expect(flat(view.lastFrame())).toMatch(/Checking projects/)
    expect(onBack).not.toHaveBeenCalled()
    expect(seen.signal?.aborted).toBe(false)
  })

  it('asks before q stops the downloads, and goes back to the menu on yes', async () => {
    const { seen, wait } = hanging()
    const onBack = vi.fn()
    const view = mount({ fetchProjects: async (_ready, opts) => wait(opts.signal) }, onBack)
    await enterList(view, ['koji'])
    await chooseAndResolve(view, 'waiting')
    await toOptions(view)
    for (let i = 0; i < 4; i++) {
      view.stdin.write(keys.down)
      await tick()
    }
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Downloading exports/)
    view.stdin.write('q')
    await waitForText(view.lastFrame, /Stop the downloads and go back to the menu\?/)
    expect(flat(view.lastFrame())).toMatch(/already saved stay in/)
    view.stdin.write('y')
    await tick()
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(seen.signal?.aborted).toBe(true)
  })

  it('cancels the check when the screen goes away', async () => {
    const { seen, wait } = hanging()
    const view = mount({ resolveProjects: async (_refs, opts) => wait(opts.signal) })
    await enterList(view, ['koji'])
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Checking projects/)
    view.unmount()
    expect(seen.signal?.aborted).toBe(true)
  })
})
