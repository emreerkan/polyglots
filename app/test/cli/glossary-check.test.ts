import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { main, type CliDeps } from '../../src/cli.js'
import { saveConfig } from '../../src/config.js'
import type { StaleGlossary } from '../../src/glossary/freshness.js'
import { openDb, replaceGlossary } from '../../src/storage/index.js'

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

const STALE: StaleGlossary = { locale: 'tr', syncedAt: Date.UTC(2026, 8, 19), changedAt: Date.UTC(2026, 8, 20) }

// A terminal on stderr, no newer polyglots, and a stale tr glossary by
// default, so each test says only what it changes.
async function run(argv: string[], deps: CliDeps & { tty?: boolean } = {}) {
  const { tty = true, ...rest } = deps
  const stdout = sink(false)
  const stderr = sink(tty)
  const stdin = new PassThrough()
  stdin.end()
  const checkGlossary = vi.fn(async () => [STALE])
  const code = await main(argv, {
    env: {},
    sendUsage: () => undefined,
    checkUpdate: async () => undefined,
    checkGlossary,
    ...rest,
    streams: { stdin, stdout, stderr },
  })
  return { code, out: stdout.text, err: stderr.text, checkGlossary }
}

const NOTICE = 'The tr glossary on translate.wordpress.org changed after your copy (synced 2026-09-19). Update with: polyglots glossary sync --locale tr'

describe('the glossary notice', () => {
  it('ends a working command with the sync command, on stderr only', async () => {
    const { err, out } = await run(['stats', '--out', 'x.html'], { writeStats })
    expect(err).toContain(NOTICE)
    expect(out).not.toContain('glossary')
  })

  it('comes after the update notice when both are due', async () => {
    const { err } = await run(['stats', '--out', 'x.html'], { writeStats, checkUpdate: async () => '9.9.9' })
    const lines = err.trimEnd().split('\n')
    expect(lines.at(-2)).toContain('9.9.9')
    expect(lines.at(-1)).toContain(NOTICE)
  })

  it('says nothing when every glossary is current', async () => {
    const { err } = await run(['stats', '--out', 'x.html'], { writeStats, checkGlossary: async () => [] })
    expect(err).not.toContain('glossary')
  })

  it('never waits on a check that has not answered, and survives one that throws', async () => {
    const pending = await run(['stats', '--out', 'x.html'], { writeStats, checkGlossary: () => new Promise(() => undefined) })
    expect(pending.code).toBe(0)
    expect(pending.err).not.toContain('glossary')
    const thrown = await run(['stats', '--out', 'x.html'], {
      writeStats,
      checkGlossary: () => {
        throw new Error('boom')
      },
    })
    expect(thrown.code).toBe(0)
  })

  // As glossary sync itself does: the check read the old sync time when the
  // command started, and the copy is current by the time it ends.
  it('is not printed for a glossary synced while the command ran', async () => {
    const sync = async () => {
      const db = openDb()
      replaceGlossary(db, 'tr', [{ locale: 'tr', sourceTerm: 'plugin', translation: 'eklenti' }])
      db.close()
      return writeStats()
    }
    const { err } = await run(['stats', '--out', 'x.html'], { writeStats: sync })
    expect(err).not.toContain('glossary')
  })

  it('is printed after the interactive app closes', async () => {
    const { err } = await run([], { runTui: async () => undefined })
    expect(err).toContain(NOTICE)
  })
})

// The same switch as the update check: both only ask a server whether there
// is news, and one setting is easier to find than two.
describe('when the glossary check runs', () => {
  it('never for config or help', async () => {
    expect((await run(['config', 'get'])).checkGlossary).not.toHaveBeenCalled()
    expect((await run(['--help'])).checkGlossary).not.toHaveBeenCalled()
  })

  it('never when stderr is not a terminal', async () => {
    expect((await run(['stats', '--out', 'x.html'], { writeStats, tty: false })).checkGlossary).not.toHaveBeenCalled()
  })

  it.each([
    ['NO_UPDATE_NOTIFIER', { NO_UPDATE_NOTIFIER: '1' }],
    ['CI', { CI: 'true' }],
  ])('never when %s is set', async (_name, env) => {
    expect((await run(['stats', '--out', 'x.html'], { writeStats, env })).checkGlossary).not.toHaveBeenCalled()
  })

  it('never when updateCheck is off', async () => {
    saveConfig({ updateCheck: false })
    expect((await run(['stats', '--out', 'x.html'], { writeStats })).checkGlossary).not.toHaveBeenCalled()
  })
})
