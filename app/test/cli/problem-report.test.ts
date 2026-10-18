import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main, type CliDeps } from '../../src/cli.js'
import { reviewFile } from '../../src/commands/review.js'
import { translateFile } from '../../src/commands/translate.js'
import { openDb, replaceGlossary } from '../../src/storage/index.js'
import { fakeEngine, fakeReview, samplePo } from '../commands/translate/helpers.js'
import { useLocaleFixture } from '../locale-fixture.js'

// After a run with a problem the command line offers a problem report: asked
// on a terminal, sent unasked with --send-report, never otherwise. The run is
// the real reviewFile with only the agent swapped for one that fails, so the
// given-up batch is the one the jobs store really records. sendReport is the
// seam: nothing here reaches the reports endpoint.

const QUESTION = 'Send a problem report to the polyglots maintainer? [y/N/v] '
const CONTACT = 'How can the maintainer reach you? (optional)'
const HINT = 'Turn these offers off with: polyglots config set problemReports never'

const PO = `msgid ""
msgstr ""
"Language: tr\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=2; plural=(n > 1);\\n"

msgid "Open the sidebar"
msgstr "Yan menüyü aç"
`

// A terminal that answers each question as it is asked. Answers written all
// at once would be read by the first question's readline and lost when it
// closes, which is not how a person types.
function terminal(tty: boolean, answers: string[]) {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean }
  stdin.isTTY = tty
  if (!tty) stdin.end()
  const asked: string[] = []
  const stderr = {
    isTTY: tty,
    text: '',
    write(chunk: string) {
      this.text += chunk
      if (tty && (chunk.includes(QUESTION) || chunk.includes(CONTACT))) {
        asked.push(chunk)
        const answer = answers.shift()
        setImmediate(() => (answer === undefined ? stdin.end() : stdin.write(`${answer}\n`)))
      }
      return true
    },
  }
  const stdout = {
    isTTY: false,
    text: '',
    write(chunk: string) {
      this.text += chunk
      return true
    },
  }
  return { stdin, stdout, stderr, asked }
}

let home: string
let file: string

async function config(values: Record<string, unknown>) {
  await mkdir(join(home, 'config'), { recursive: true })
  await writeFile(join(home, 'config', 'config.json'), JSON.stringify({ defaultLocale: 'tr', reviewProvider: 'claude', ...values }))
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyglots-cli-problem-report-'))
  process.env.POLYGLOTS_HOME = home
  file = join(home, 'plugin-tr.po')
  await writeFile(file, PO)
  const db = openDb()
  replaceGlossary(db, 'tr', [{ locale: 'tr', sourceTerm: 'sidebar', translation: 'kenar çubuğu', partOfSpeech: 'noun' }])
  db.close()
})

useLocaleFixture('tr_TR.yaml')

afterEach(async () => {
  // main() starts its update and glossary checks in the background, and one
  // can still be writing into the home when the test ends, so a single rmdir
  // met a folder that had just gained a file and failed with ENOTEMPTY under
  // load. Retrying is what test/setup/isolate-home.ts does for the same race.
  await rm(home, { recursive: true, force: true, maxRetries: 3 })
})

// Fails both attempts, so the one batch is given up and its last row final.
const failingReview: CliDeps['reviewFile'] = (opts) =>
  reviewFile({
    ...opts,
    adjudicate: async () => {
      throw new Error('claude exited with exit code 1')
    },
    mcpConfigPath: join(home, 'mcp.json'),
  })

function recorder(answer: Awaited<ReturnType<NonNullable<CliDeps['sendReport']>>> = { ok: true, id: 'r1' }) {
  const bodies: Buffer[] = []
  const sendReport = vi.fn(async (body: Buffer) => {
    bodies.push(body)
    return answer
  })
  const sent = () => bodies.map((b) => JSON.parse(gunzipSync(b).toString('utf8')) as { contact?: string; runs: unknown[] })
  return { sendReport, sent }
}

async function run(argv: string[], t: ReturnType<typeof terminal>, deps: Omit<CliDeps, 'streams'>) {
  const code = await main(argv, { env: {}, ...deps, streams: { stdin: t.stdin, stdout: t.stdout, stderr: t.stderr } })
  return { code, stderr: t.stderr.text, stdout: t.stdout.text }
}

describe('the problem report offer on the command line', () => {
  it('asks on a terminal, and y sends once with the contact typed', async () => {
    await config({ wporgUsername: 'emre-test' })
    const { sendReport, sent } = recorder()
    const t = terminal(true, ['y', 'slack:emre'])
    const r = await run(['review', file], t, { reviewFile: failingReview, sendReport })
    expect(r.code).toBe(0)
    expect(sendReport).toHaveBeenCalledTimes(1)
    expect(sent()[0]!.contact).toBe('slack:emre')
    expect(sent()[0]!.runs).toHaveLength(1)
    // The configured name is offered in brackets as the answer an empty line keeps.
    expect(t.asked[1]).toContain(`${CONTACT} [emre-test] `)
    expect(r.stderr).toContain('Sent. Report r1.')
    expect(r.stderr).toContain(HINT)
  })

  it('keeps the configured name on an empty answer, and drops it on -', async () => {
    await config({ wporgUsername: 'emre-test' })
    const kept = recorder()
    await run(['review', file], terminal(true, ['y', '']), { reviewFile: failingReview, sendReport: kept.sendReport })
    expect(kept.sent()[0]!.contact).toBe('emre-test')
    const dropped = recorder()
    await run(['review', file, '--fresh'], terminal(true, ['y', '-']), { reviewFile: failingReview, sendReport: dropped.sendReport })
    expect(dropped.sent()[0]!.contact).toBeUndefined()
  })

  it('says how to turn the offers off on the first offer only', async () => {
    await config({})
    const first = await run(['review', file], terminal(true, ['n']), { reviewFile: failingReview, sendReport: recorder().sendReport })
    expect(first.stderr).toContain(HINT)
    const second = await run(['review', file, '--fresh'], terminal(true, ['n']), { reviewFile: failingReview, sendReport: recorder().sendReport })
    expect(second.stderr).toContain(QUESTION)
    expect(second.stderr).not.toContain(HINT)
  })

  it('sends nothing on N, and the exit code is the same', async () => {
    await config({})
    const { sendReport } = recorder()
    const t = terminal(true, ['N'])
    const r = await run(['review', file], t, { reviewFile: failingReview, sendReport })
    expect(r.code).toBe(0)
    expect(t.asked).toHaveLength(1)
    expect(sendReport).not.toHaveBeenCalled()
  })

  it('lists what is sent on v, then asks again', async () => {
    await config({})
    const { sendReport } = recorder()
    const t = terminal(true, ['v', 'n'])
    const r = await run(['review', file], t, { reviewFile: failingReview, sendReport })
    expect(t.asked).toHaveLength(2)
    expect(sendReport).not.toHaveBeenCalled()
    const text = r.stderr.replace(/\s+/g, ' ')
    expect(text).toMatch(/run1\.jsonl \d+(\.\d)? (B|KiB)/)
    expect(text).toContain('run 1: run record and 2 batch failure(s)')
  })

  it('asks nothing and sends nothing without a terminal', async () => {
    await config({})
    const { sendReport } = recorder()
    const t = terminal(false, [])
    const r = await run(['review', file], t, { reviewFile: failingReview, sendReport })
    expect(r.code).toBe(0)
    expect(r.stderr).not.toContain(QUESTION)
    expect(sendReport).not.toHaveBeenCalled()
  })

  it('sends without asking under --send-report, with no contact line, and says so on stderr', async () => {
    await config({ wporgUsername: 'emre-test' })
    const { sendReport, sent } = recorder({ ok: true, id: 'r9' })
    const t = terminal(false, [])
    const r = await run(['review', file, '--send-report'], t, { reviewFile: failingReview, sendReport })
    expect(r.code).toBe(0)
    expect(r.stderr).not.toContain(QUESTION)
    expect(sendReport).toHaveBeenCalledTimes(1)
    expect(sent()[0]!.contact).toBeUndefined()
    expect(r.stderr).toContain('Sent. Report r9.')
    expect(r.stdout).not.toContain('Sent.')
  })

  it('asks nothing with problemReports: never, even under --send-report', async () => {
    await config({ problemReports: 'never' })
    const { sendReport } = recorder()
    const t = terminal(true, ['y', ''])
    const r = await run(['review', file, '--send-report'], t, { reviewFile: failingReview, sendReport })
    expect(t.asked).toHaveLength(0)
    expect(r.stderr).not.toContain(QUESTION)
    expect(sendReport).not.toHaveBeenCalled()
  })

  it('asks nothing after a clean run', async () => {
    await config({})
    const { sendReport } = recorder()
    const t = terminal(true, ['y', ''])
    const r = await run(['review', file, '--no-ai'], t, { reviewFile: (opts) => reviewFile(opts), sendReport })
    expect(r.code).toBe(0)
    expect(t.asked).toHaveLength(0)
    expect(sendReport).not.toHaveBeenCalled()
  })

  it('names the saved file when sending fails', async () => {
    await config({})
    const { sendReport } = recorder({ ok: false, message: 'could not reach ada.tools' })
    const r = await run(['review', file], terminal(true, ['y', '']), { reviewFile: failingReview, sendReport })
    const match = /Not sent: could not reach ada\.tools\. Saved as (\S+\.json\.gz)\./.exec(r.stderr)
    expect(match).not.toBeNull()
    expect(match![1]!.startsWith(join(home, 'data', 'logs', 'report-'))).toBe(true)
    expect(existsSync(match![1]!)).toBe(true)
    expect(gunzipSync(await readFile(match![1]!)).toString('utf8')).toContain('"runs"')
  })

  it('offers once for a review of several files, covering only the file with a problem', async () => {
    await config({})
    const good = join(home, 'good-tr.po')
    await writeFile(good, PO)
    const { sendReport, sent } = recorder()
    const t = terminal(true, ['y', ''])
    // The second file runs on the rules alone: a run of its own, with nothing given up.
    const r = await run(['review', file, good], t, {
      reviewFile: (opts) => (opts.file === good ? reviewFile({ ...opts, noAi: true }) : failingReview(opts)),
      sendReport,
    })
    expect(t.asked.filter((q) => q.includes(QUESTION))).toHaveLength(1)
    expect(sendReport).toHaveBeenCalledTimes(1)
    expect(sent()[0]!.runs).toHaveLength(1)
    expect(r.stderr).toContain('Sent. Report r1.')
  })

  it('offers after a review that threw, below the error, and keeps exit 1', async () => {
    await config({})
    const { sendReport } = recorder()
    const r = await run(['review', file, '--send-report'], terminal(false, []), {
      // A run that ends failed: the throw comes from inside it, after its row exists.
      reviewFile: (opts) =>
        reviewFile({
          ...opts,
          adjudicate: async () => [],
          mcpConfigPath: join(home, 'mcp.json'),
          onProgress: (e) => {
            if (e.type === 'batch-start') throw new Error('the terminal went away')
          },
        }),
      sendReport,
    })
    expect(r.code).toBe(1)
    expect(sendReport).toHaveBeenCalledTimes(1)
    expect(r.stderr.indexOf('the terminal went away')).toBeLessThan(r.stderr.indexOf('Sent. Report r1.'))
  })

  it('offers after a translate the breaker stopped, and keeps its exit code', async () => {
    await config({})
    const target = join(home, 'sample.po')
    await copyFile(samplePo, target)
    const { sendReport } = recorder()
    // A dummy key, so translate's key check passes; the fake engine never uses it.
    const savedKey = process.env.DEEPL_API_KEY
    process.env.DEEPL_API_KEY = 'dpl-test-key-0123456789:fx'
    const engine = fakeEngine()
    engine.failWith = () => new Error('deepl exploded')
    let r: Awaited<ReturnType<typeof run>>
    try {
      r = await run(['translate', target, '--draft-engine', 'deepl', '--batch-size', '1', '--send-report'], terminal(false, []), {
        translate: (opts) => translateFile({ ...opts, engine, review: fakeReview(), mcpConfigPath: join(home, 'mcp.json') }),
        sendReport,
      })
    } finally {
      if (savedKey === undefined) delete process.env.DEEPL_API_KEY
      else process.env.DEEPL_API_KEY = savedKey
    }
    expect(r.code).toBe(3)
    expect(sendReport).toHaveBeenCalledTimes(1)
  })

  it('names the provider\'s version in the report, asked once of the configured provider', async () => {
    await config({ reviewProvider: 'antigravity' })
    const { sendReport, sent } = recorder()
    const providerVersion = vi.fn(async () => '1.4.0')
    await run(['review', file, '--send-report'], terminal(false, []), {
      reviewFile: failingReview,
      sendReport,
      providerVersion,
      checkProvider: async () => ({ signIn: { state: 'unknown', ms: 0 }, at: 0 }),
    })
    expect(providerVersion).toHaveBeenCalledTimes(1)
    expect(providerVersion).toHaveBeenCalledWith('antigravity')
    expect((sent()[0] as unknown as { provider: { name: string; version?: string } }).provider).toMatchObject({ name: 'antigravity', version: '1.4.0' })
  })

  // A no costs nothing: the version is asked only once a report is built, so
  // a slow or hanging binary cannot hold the process after the answer.
  it('asks the provider for its version only once a report is built, never on a no', async () => {
    await config({})
    const providerVersion = vi.fn(async () => '1.4.0')
    const r = await run(['review', file], terminal(true, ['n']), { reviewFile: failingReview, sendReport: recorder().sendReport, providerVersion })
    expect(r.stderr).toContain(QUESTION)
    expect(providerVersion).not.toHaveBeenCalled()
  })

  it('names the model, batch size and parallel in a report from fetch', async () => {
    // configuredModel reads agy's own settings under the OS home, which the
    // test setup points at a temporary folder for each test.
    await mkdir(join(homedir(), '.gemini', 'antigravity-cli'), { recursive: true })
    await writeFile(join(homedir(), '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ model: 'gemini-flash' }))
    await config({ reviewProvider: 'antigravity' })
    const { sendReport, sent } = recorder()
    const outDir = join(home, 'out')
    await run(['fetch', 'koji', '--get', 'waiting', '--out-dir', outDir, '--batch-size', '40', '--parallel', '2', '--send-report'], terminal(false, []), {
      resolveProjects: async (refs) => refs.map((r) => ({ input: r.slug, state: 'ready' as const, type: 'wp-themes' as const, slug: r.slug, count: 1 })),
      fetchProjects: async (ready, opts) => {
        await mkdir(opts.outDir, { recursive: true })
        return Promise.all(
          ready.map(async (p) => {
            const target = join(opts.outDir, `wp-themes-${p.slug}-tr.po`)
            await writeFile(target, PO)
            return { input: p.input, state: 'fetched' as const, file: target }
          }),
        )
      },
      reviewFile: failingReview,
      sendReport,
      providerVersion: async () => undefined,
      checkProvider: async () => ({ signIn: { state: 'unknown', ms: 0 }, at: 0 }),
    })
    expect(sendReport).toHaveBeenCalledTimes(1)
    expect(sent()[0]).toMatchObject({ provider: { name: 'antigravity', model: 'gemini-flash' }, batchSize: 40, parallel: 2 })
  })

  // A rules-only run names no model, on every command: no model took part,
  // and "provider rules, model gemini-flash" would send the maintainer after
  // one that did not run.
  it('names no model for a rules-only review, of one file or several', async () => {
    await mkdir(join(homedir(), '.gemini', 'antigravity-cli'), { recursive: true })
    await writeFile(join(homedir(), '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ model: 'gemini-flash' }))
    await config({ reviewProvider: 'antigravity' })
    const second = join(home, 'second-tr.po')
    await writeFile(second, PO)
    // Thrown from inside the run, after its row exists, so the run ends failed.
    const throwing: CliDeps['reviewFile'] = (opts) =>
      reviewFile({
        ...opts,
        onProgress: () => {
          throw new Error('the terminal went away')
        },
      })
    const { sendReport, sent } = recorder()
    await run(['review', file, '--no-ai', '--send-report'], terminal(false, []), { reviewFile: throwing, sendReport, providerVersion: async () => undefined })
    await run(['review', file, second, '--no-ai', '--fresh', '--send-report'], terminal(false, []), { reviewFile: throwing, sendReport, providerVersion: async () => undefined })
    expect(sendReport).toHaveBeenCalledTimes(2)
    for (const report of sent() as unknown as Array<{ provider: { name: string; model?: string } }>) expect(report.provider).toEqual({ name: 'rules' })
  })

  it('sends without a version when asking for it fails', async () => {
    await config({})
    const { sendReport, sent } = recorder()
    await run(['review', file, '--send-report'], terminal(false, []), {
      reviewFile: failingReview,
      sendReport,
      providerVersion: () => {
        throw new Error('spawn EACCES')
      },
    })
    expect(sendReport).toHaveBeenCalledTimes(1)
    expect((sent()[0] as unknown as { provider: { version?: string } }).provider.version).toBeUndefined()
  })

  it('config set problemReports takes ask and never, and config get lists it', async () => {
    const t = () => terminal(false, [])
    expect((await run(['config', 'get'], t(), {})).stdout).toContain('problemReports = ask')
    expect((await run(['config', 'set', 'problemReports', 'never'], t(), {})).stdout).toContain('problemReports = never')
    expect((await run(['config', 'get'], t(), {})).stdout).toContain('problemReports = never')
    expect((await run(['config', 'set', 'problemReports', 'ask'], t(), {})).stdout).toContain('problemReports = ask')
    expect((await run(['config', 'set', 'problemReports', 'maybe'], t(), {})).code).toBe(2)
  })
})
