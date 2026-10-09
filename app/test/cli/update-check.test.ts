import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { main, type CliDeps } from '../../src/cli.js'
import { saveConfig } from '../../src/config.js'
import type { RunTuiOptions } from '../../src/tui/index.js'
import { updateCommand } from '../../src/update/index.js'
import { VERSION } from '../../src/version.js'

interface Sink {
  text: string
  isTTY: boolean
  write(chunk: string): boolean
}

function sink(isTTY: boolean): Sink {
  return {
    text: '',
    isTTY,
    write(chunk: string) {
      this.text += chunk
      return true
    },
  }
}

const writeStats = async () => ({ file: 'x.html', submissions: 0, entries: 0, incomplete: 0, translateRuns: 0, translateEntries: 0, flagged: 0, weeks: [], topProjects: [] })

// A terminal on stderr and a newer version by default, so each test says only
// what it changes.
async function run(argv: string[], deps: CliDeps & { tty?: boolean } = {}) {
  const { tty = true, ...rest } = deps
  const stdout = sink(false)
  const stderr = sink(tty)
  const stdin = new PassThrough()
  stdin.end()
  const checkUpdate = vi.fn(async () => '9.9.9' as string | undefined)
  const code = await main(argv, { env: {}, sendUsage: () => undefined, checkUpdate, ...rest, streams: { stdin, stdout, stderr } })
  return { code, out: stdout.text, err: stderr.text, checkUpdate }
}

describe('the update notice', () => {
  it('ends a working command with how to update, on stderr only', async () => {
    const { err, out } = await run(['stats', '--out', 'x.html'], { writeStats })
    expect(err).toContain(`polyglots 9.9.9 is available (you have ${VERSION}). Update with: ${updateCommand()}`)
    expect(out).not.toContain('9.9.9')
  })

  it('is the last thing the command prints', async () => {
    const { err } = await run(['stats', '--out', 'x.html'], { writeStats })
    expect(err.trimEnd().split('\n').at(-1)).toContain('9.9.9')
  })

  it('says nothing when there is no newer version', async () => {
    const { err } = await run(['stats', '--out', 'x.html'], { writeStats, checkUpdate: async () => undefined })
    expect(err).not.toContain('available')
  })

  // A check still out when the command ends is not waited for: the next
  // command reads what it saved.
  it('never waits on a check that has not answered', async () => {
    const { err, code } = await run(['stats', '--out', 'x.html'], { writeStats, checkUpdate: () => new Promise(() => undefined) })
    expect(code).toBe(0)
    expect(err).not.toContain('available')
  })

  it('survives a check that throws', async () => {
    const { code } = await run(['stats', '--out', 'x.html'], {
      writeStats,
      checkUpdate: () => {
        throw new Error('boom')
      },
    })
    expect(code).toBe(0)
  })

  it('is printed after the interactive app closes, and handed to it for the header', async () => {
    let handed: RunTuiOptions | undefined
    const { err } = await run([], { runTui: async (opts) => void (handed = opts) })
    expect(await handed?.update).toBe('9.9.9')
    expect(err).toContain('polyglots 9.9.9 is available')
  })
})

describe('when the check runs', () => {
  it('never for config, help or doctor-like commands', async () => {
    expect((await run(['config', 'get'])).checkUpdate).not.toHaveBeenCalled()
    expect((await run(['--help'])).checkUpdate).not.toHaveBeenCalled()
    expect((await run(['usage-stats', 'show'])).checkUpdate).not.toHaveBeenCalled()
  })

  // Piped or captured, nobody reads stderr as it happens, and a scripted run
  // should not grow a line it never asked for.
  it('never when stderr is not a terminal', async () => {
    expect((await run(['stats', '--out', 'x.html'], { writeStats, tty: false })).checkUpdate).not.toHaveBeenCalled()
  })

  it.each([
    ['NO_UPDATE_NOTIFIER', { NO_UPDATE_NOTIFIER: '1' }],
    ['CI', { CI: 'true' }],
  ])('never when %s is set', async (_name, env) => {
    expect((await run(['stats', '--out', 'x.html'], { writeStats, env })).checkUpdate).not.toHaveBeenCalled()
  })

  it('never when the setting is off', async () => {
    saveConfig({ updateCheck: false })
    expect((await run(['stats', '--out', 'x.html'], { writeStats })).checkUpdate).not.toHaveBeenCalled()
  })

  it('still with DO_NOT_TRACK set', async () => {
    expect((await run(['stats', '--out', 'x.html'], { writeStats, env: { DO_NOT_TRACK: '1' } })).checkUpdate).toHaveBeenCalledTimes(1)
  })
})

describe('config set updateCheck', () => {
  it('takes on and off', async () => {
    expect((await run(['config', 'set', 'updateCheck', 'off'])).out).toContain('updateCheck = off')
    expect((await run(['config', 'set', 'updateCheck', 'on'])).out).toContain('updateCheck = on')
    expect((await run(['config', 'set', 'updateCheck', 'maybe'])).code).toBe(2)
  })
})
