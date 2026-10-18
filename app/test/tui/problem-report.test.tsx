import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { homedir } from 'node:os'
import { readdirSync } from 'node:fs'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import React from 'react'
import { saveConfig } from '../../src/config.js'
import { reviewFile } from '../../src/commands/review.js'
import type { TranslateOptions } from '../../src/commands/translate.js'
import { openJobsDb } from '../../src/jobs/db.js'
import { logsDir } from '../../src/logs/paths.js'
import { finishRun, recordBatchFailure, startRun } from '../../src/jobs/index.js'
import { openDb, replaceGlossary } from '../../src/storage/index.js'
import { CommandsProvider, type ReviewFile, type TuiCommands } from '../../src/tui/commands.js'
import { Review } from '../../src/tui/screens/Review.js'
import { Translate } from '../../src/tui/screens/Translate.js'
import { useLocaleFixture } from '../locale-fixture.js'
import { agentStatus, cleanup, ESC_DELAY, fakeCommands, flat, keys, makeHome, render, summaryOf, tick, waitFor, waitForText, type Home } from './helpers.js'

// The finished screen of a run with a problem offers a problem report, under
// the summary. The runs are the real reviewFile with only the agent swapped
// for one that fails both attempts, so the given-up batch is the one the jobs
// store really records; sendReport is the seam, and nothing here reaches the
// reports endpoint.

const OFFER = 'Send a problem report to the polyglots maintainer?'
const HINT = 's send · v see what is sent · esc no'
const CONTACT = 'How can the maintainer reach you?'

const PO = `msgid ""
msgstr ""
"Language: tr\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=2; plural=(n > 1);\\n"

msgid "Open the sidebar"
msgstr "Yan menüyü aç"
`

let home: Home
let cwd: string

beforeEach(async () => {
  home = await makeHome()
  cwd = join(home.path, 'work')
  await mkdir(cwd)
  await writeFile(join(cwd, 'a.po'), PO)
  await writeFile(join(cwd, 'b.po'), PO)
  // Newest first in the picker: .., a.po, b.po.
  await utimes(join(cwd, 'a.po'), 5000, 5000)
  await utimes(join(cwd, 'b.po'), 4000, 4000)
  const db = openDb()
  replaceGlossary(db, 'tr', [{ locale: 'tr', sourceTerm: 'sidebar', translation: 'kenar çubuğu', partOfSpeech: 'noun' }])
  db.close()
})

// After makeHome, so the rules file lands in the home the test reads.
useLocaleFixture('tr_TR.yaml')

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

// Fails both attempts on a.po, so its one batch is given up with a final row.
// b.po runs on the rules alone: a run of its own, with nothing given up.
const failingReview: ReviewFile = (opts) =>
  reviewFile({
    ...opts,
    ...(opts.file.endsWith('b.po')
      ? { noAi: true }
      : {
          adjudicate: async () => {
            throw new Error('claude exited with exit code 1')
          },
        }),
    mcpConfigPath: join(home.path, 'mcp.json'),
  })

const cleanReview: ReviewFile = (opts) => reviewFile({ ...opts, noAi: true, mcpConfigPath: join(home.path, 'mcp.json') })

function mount(screen: 'review' | 'translate', overrides: Partial<TuiCommands> = {}) {
  const commands = fakeCommands(overrides)
  const onBack = vi.fn()
  const view = render(
    <CommandsProvider value={commands}>
      {screen === 'review' ? <Review cwd={cwd} onBack={onBack} /> : <Translate cwd={cwd} onBack={onBack} />}
    </CommandsProvider>,
  )
  return { ...view, commands, onBack }
}

type View = ReturnType<typeof mount>

async function press(view: View, ...sequence: string[]) {
  for (const k of sequence) {
    view.stdin.write(k)
    await tick(k === keys.esc ? ESC_DELAY : 0)
  }
}

const frame = (view: View) => flat(view.lastFrame())

// a.po, then Start: locale, batch size, skip AI, start over, start.
async function reviewA(view: View) {
  await waitForText(view.lastFrame, 'a.po')
  await press(view, keys.down, keys.enter)
  await waitForText(view.lastFrame, 'Start review')
  await press(view, keys.down, keys.down, keys.down, keys.down, keys.enter)
  await waitForText(() => frame(view), 'a another file')
}

function sentBodies(sendReport: TuiCommands['sendReport']) {
  return vi.mocked(sendReport).mock.calls.map(([body]) => JSON.parse(gunzipSync(body).toString('utf8')) as { contact?: string; runs: unknown[] })
}

describe('the problem report offer in the app', () => {
  it('offers a report after a review whose batch was given up, and s sends it with the contact typed', async () => {
    saveConfig({ defaultLocale: 'tr', reviewProvider: 'claude' })
    const view = mount('review', { reviewFile: failingReview })
    await reviewA(view)
    await waitForText(() => frame(view), `1 batch failed. ${OFFER}`)
    expect(frame(view)).toContain(HINT)
    // Said once, on the first offer ever, how to turn the offers off.
    expect(frame(view)).toContain('Turn these offers off')

    await press(view, 's')
    await waitForText(() => frame(view), CONTACT)
    // Typed a key at a time, as a person types: the a in slack must not be the
    // finished screen's "another file", nor the c its copy.
    await press(view, ...'slack:emre'.split(''))
    await waitForText(() => frame(view), 'slack:emre')
    expect(view.onBack).not.toHaveBeenCalled()
    expect(frame(view)).not.toContain('Locale:')
    await press(view, keys.enter)
    await waitForText(() => frame(view), 'Sent. Report r1.')
    expect(view.commands.sendReport).toHaveBeenCalledTimes(1)
    const [sent] = sentBodies(view.commands.sendReport)
    expect(sent!.contact).toBe('slack:emre')
    expect(sent!.runs).toHaveLength(1)
    // Sent, so neither offered again nor sendable twice.
    expect(frame(view)).not.toContain(OFFER)
    await press(view, 's')
    expect(view.commands.sendReport).toHaveBeenCalledTimes(1)
    expect(view.onBack).not.toHaveBeenCalled()
  })

  // The version discovery already read, not a second spawn: the app probes
  // every provider at launch and keeps the answer for the process.
  it('names the provider version discovery found in the report it sends', async () => {
    saveConfig({ defaultLocale: 'tr', reviewProvider: 'claude' })
    const discoverAgents = vi.fn(async () => [agentStatus('claude', { version: '2.1.0 (Claude Code)' }), agentStatus('antigravity')])
    const view = mount('review', { reviewFile: failingReview, discoverAgents })
    await reviewA(view)
    await waitForText(() => frame(view), OFFER)
    await press(view, 's')
    await waitForText(() => frame(view), CONTACT)
    await press(view, keys.enter)
    await waitForText(() => frame(view), 'Sent. Report r1.')
    const [sent] = sentBodies(view.commands.sendReport) as unknown as Array<{ provider: { name: string; version?: string } }>
    expect(sent!.provider).toMatchObject({ name: 'claude', version: '2.1.0 (Claude Code)' })
  })

  it('sends without a version when discovery fails', async () => {
    saveConfig({ defaultLocale: 'tr', reviewProvider: 'claude' })
    const discoverAgents = vi.fn(async () => {
      throw new Error('probe failed')
    })
    const view = mount('review', { reviewFile: failingReview, discoverAgents })
    await reviewA(view)
    await waitForText(() => frame(view), OFFER)
    await press(view, 's')
    await waitForText(() => frame(view), CONTACT)
    await press(view, keys.enter)
    await waitForText(() => frame(view), 'Sent. Report r1.')
    const [sent] = sentBodies(view.commands.sendReport) as unknown as Array<{ provider: { version?: string } }>
    expect(sent!.provider.version).toBeUndefined()
  })

  it('prefills the contact line with the wp.org username, and enter keeps it', async () => {
    saveConfig({ defaultLocale: 'tr', reviewProvider: 'claude', wporgUsername: 'emre-test' })
    const view = mount('review', { reviewFile: failingReview })
    await reviewA(view)
    await waitForText(() => frame(view), OFFER)
    await press(view, 's')
    await waitForText(() => frame(view), `${CONTACT} emre-test`)
    await press(view, keys.enter)
    await waitForText(() => frame(view), 'Sent. Report r1.')
    expect(sentBodies(view.commands.sendReport)[0]!.contact).toBe('emre-test')
  })

  it('says why it was not sent, and where the report was kept', async () => {
    saveConfig({ defaultLocale: 'tr', reviewProvider: 'claude' })
    const sendReport = vi.fn(async () => ({ ok: false as const, message: 'the server answered 502' }))
    const view = mount('review', { reviewFile: failingReview, sendReport })
    await reviewA(view)
    await waitForText(() => frame(view), OFFER)
    await press(view, 's')
    await waitForText(() => frame(view), CONTACT)
    await press(view, keys.enter)
    await waitForText(() => frame(view), 'Not sent: the server answered 502. Saved as')
    // The path wraps at the frame's width, so it is read from the folder.
    const kept = readdirSync(logsDir()).filter((name) => /^report-.*\.json\.gz$/.test(name))
    expect(kept).toHaveLength(1)
    expect(frame(view).replace(/\s/g, '')).toContain(join(logsDir(), kept[0]!).replace(/\s/g, ''))
  })

  it('lists what the report holds with v, until esc, and esc on the offer hides it', async () => {
    saveConfig({ defaultLocale: 'tr', reviewProvider: 'claude' })
    const view = mount('review', { reviewFile: failingReview })
    await reviewA(view)
    await waitForText(() => frame(view), OFFER)
    await press(view, 'v')
    await waitForText(() => frame(view), 'run 1: run record and 2 batch failure(s)')
    expect(frame(view)).toMatch(/run1\.jsonl/)
    await press(view, keys.esc)
    await waitForText(() => frame(view), HINT)
    expect(frame(view)).not.toContain('batch failure(s)')
    await press(view, keys.esc)
    await waitFor(() => !frame(view).includes(OFFER))
    // The offer took the escape; the screen is still the finished review.
    expect(view.onBack).not.toHaveBeenCalled()
    expect(frame(view)).toContain('a another file')
    await press(view, 's')
    expect(view.commands.sendReport).not.toHaveBeenCalled()
    // With the offer gone, esc is the screen's again.
    await press(view, keys.esc)
    await waitFor(() => view.onBack.mock.calls.length === 1)
  })

  // a still goes to the next file with the offer showing, and the offer, being
  // this run's, must not keep the picker's escape for itself.
  it('leaves with the finished screen: a picks another file, and esc there goes back', async () => {
    saveConfig({ defaultLocale: 'tr', reviewProvider: 'claude' })
    const view = mount('review', { reviewFile: failingReview })
    await reviewA(view)
    await waitForText(() => frame(view), OFFER)
    await press(view, 'a')
    await waitForText(() => frame(view), 'b.po')
    expect(frame(view)).not.toContain(OFFER)
    await press(view, keys.esc)
    await waitFor(() => view.onBack.mock.calls.length === 1)
  })

  // A send still in flight when the person moves on belongs to the run it was
  // about; its answer must not appear under the next run's summary.
  it('drops the answer of a send that finishes under a later run', async () => {
    saveConfig({ defaultLocale: 'tr', reviewProvider: 'claude' })
    let answer: (r: { ok: true; id: string }) => void = () => {}
    const sendReport = vi.fn(() => new Promise<{ ok: true; id: string }>((resolve) => (answer = resolve)))
    const view = mount('review', { reviewFile: failingReview, sendReport })
    await reviewA(view)
    await waitForText(() => frame(view), OFFER)
    await press(view, 's')
    await waitForText(() => frame(view), CONTACT)
    await press(view, keys.enter)
    await waitForText(() => frame(view), 'Sending the problem report')
    await waitFor(() => sendReport.mock.calls.length === 1)
    // b.po runs on the rules alone: a clean run, with nothing to offer.
    await press(view, 'a')
    await waitForText(() => frame(view), 'b.po')
    // .., a-repaired.po (written by the run), a.po, b.po.
    await press(view, keys.down, keys.down, keys.down, keys.enter)
    await waitForText(view.lastFrame, 'Start review')
    await press(view, keys.down, keys.down, keys.down, keys.down, keys.enter)
    await waitForText(() => frame(view), 'a another file')
    answer({ ok: true, id: 'r1' })
    await tick(50)
    expect(frame(view)).toContain('Review b.po')
    expect(frame(view)).not.toContain('Sent. Report')
  })

  // Dropped from the screen it was about, a send that failed still names the
  // file it was saved as: nothing retries, so a path never shown is a report
  // nobody sends.
  describe('a send that fails after the person moved on', () => {
    const NOTICE = 'The earlier problem report was not sent. Saved as'

    async function sendThenLeave(view: View) {
      await reviewA(view)
      await waitForText(() => frame(view), OFFER)
      await press(view, 's')
      await waitForText(() => frame(view), CONTACT)
      await press(view, keys.enter)
      await waitForText(() => frame(view), 'Sending the problem report')
      await press(view, 'a')
      await waitForText(() => frame(view), 'b.po')
    }

    async function reviewB(view: View) {
      // .., a-repaired.po (written by the run), a.po, b.po.
      await press(view, keys.down, keys.down, keys.down, keys.enter)
      await waitForText(view.lastFrame, 'Start review')
      await press(view, keys.down, keys.down, keys.down, keys.down, keys.enter)
      await waitForText(() => frame(view), 'a another file')
    }

    function held() {
      let answer: (r: { ok: false; message: string }) => void = () => {}
      const sendReport = vi.fn(() => new Promise<{ ok: false; message: string }>((resolve) => (answer = resolve)))
      return { sendReport, fail: () => answer({ ok: false, message: 'could not reach ada.tools' }) }
    }

    it('names the saved file on the finished screen already showing', async () => {
      saveConfig({ defaultLocale: 'tr', reviewProvider: 'claude' })
      const { sendReport, fail } = held()
      const view = mount('review', { reviewFile: failingReview, sendReport })
      await sendThenLeave(view)
      await reviewB(view)
      fail()
      await waitForText(() => frame(view), NOTICE)
      expect(frame(view)).toContain('Review b.po')
      expect(frame(view)).not.toContain('Not sent: could not reach')
    })

    it('holds it for the next finished screen when it fails between runs, and says it once', async () => {
      saveConfig({ defaultLocale: 'tr', reviewProvider: 'claude' })
      const { sendReport, fail } = held()
      const view = mount('review', { reviewFile: failingReview, sendReport })
      await sendThenLeave(view)
      fail()
      await tick(50)
      expect(frame(view)).not.toContain(NOTICE)
      await reviewB(view)
      await waitForText(() => frame(view), NOTICE)
      const kept = readdirSync(logsDir()).filter((name) => /^report-.*\.json\.gz$/.test(name))
      expect(kept).toHaveLength(1)
      expect(frame(view).replace(/\s/g, '')).toContain(join(logsDir(), kept[0]!).replace(/\s/g, ''))
      // Once: the screen after that one does not repeat it.
      await press(view, 'a')
      await waitForText(() => frame(view), 'b.po')
      await reviewB(view)
      await tick(50)
      expect(frame(view)).not.toContain(NOTICE)
    })
  })

  // A No-AI review names no model, as on the command line: no model took
  // part. The run is made to fail by a throw from inside it, after its row
  // exists, since a rules-only run gives up no batch.
  describe('a No-AI review', () => {
    beforeEach(async () => {
      // configuredModel reads agy's settings under the OS home, which the
      // test setup points at a temporary folder for each test.
      await mkdir(join(homedir(), '.gemini', 'antigravity-cli'), { recursive: true })
      await writeFile(join(homedir(), '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ model: 'gemini-flash' }))
      saveConfig({ defaultLocale: 'tr', reviewProvider: 'antigravity' })
    })

    const throwing: ReviewFile = (opts) =>
      reviewFile({
        ...opts,
        mcpConfigPath: join(home.path, 'mcp.json'),
        onProgress: () => {
          throw new Error('the terminal went away')
        },
      })

    async function sendIt(view: View) {
      await waitForText(() => frame(view), OFFER)
      await press(view, 's')
      await waitForText(() => frame(view), CONTACT)
      await press(view, keys.enter)
      await waitForText(() => frame(view), 'Sent. Report r1.')
      return (sentBodies(view.commands.sendReport) as unknown as Array<{ provider: unknown }>)[0]!.provider
    }

    it('names no model in the report from one file', async () => {
      const view = mount('review', { reviewFile: throwing })
      await waitForText(view.lastFrame, 'a.po')
      await press(view, keys.down, keys.enter)
      await waitForText(view.lastFrame, 'Start review')
      // Locale, batch size, skip AI (on), start over, start.
      await press(view, keys.down, keys.down, ' ')
      await waitForText(() => frame(view), /Skip AI checks:\s*yes/)
      await press(view, keys.down, keys.down, keys.enter)
      expect(await sendIt(view)).toEqual({ name: 'rules' })
    })

    it('names no model in the report from a batch of files', async () => {
      const view = mount('review', { reviewFile: throwing })
      await waitForText(view.lastFrame, 'a.po')
      await press(view, '*', keys.down, keys.enter)
      await waitForText(view.lastFrame, /Parallel/)
      // Locale, parallel, batch size, start over, skip AI (on), start.
      await press(view, keys.down, keys.down, keys.down, keys.down, ' ')
      await waitForText(() => frame(view), /Skip AI:\s*yes/)
      await press(view, keys.down, keys.enter)
      expect(await sendIt(view)).toEqual({ name: 'rules' })
    })
  })

  it('offers nothing after a clean review', async () => {
    saveConfig({ defaultLocale: 'tr', reviewProvider: 'claude' })
    const view = mount('review', { reviewFile: cleanReview })
    await reviewA(view)
    await tick(50)
    expect(frame(view)).not.toContain(OFFER)
  })

  it('offers nothing when problemReports is never', async () => {
    saveConfig({ defaultLocale: 'tr', reviewProvider: 'claude', problemReports: 'never' })
    const view = mount('review', { reviewFile: failingReview })
    await reviewA(view)
    await tick(50)
    expect(frame(view)).toContain('a another file')
    expect(frame(view)).not.toContain(OFFER)
  })

  it('makes one offer for a batch of files, naming the one file that had a problem', async () => {
    saveConfig({ defaultLocale: 'tr', reviewProvider: 'claude' })
    const view = mount('review', { reviewFile: failingReview })
    await waitForText(view.lastFrame, 'a.po')
    await press(view, '*', keys.down, keys.enter)
    await waitForText(view.lastFrame, /Parallel/)
    // Locale, parallel, batch size, start over, skip AI, start.
    await press(view, keys.down, keys.down, keys.down, keys.down, keys.down, keys.enter)
    await waitForText(() => frame(view), `1 batch failed in 1 file. ${OFFER}`)
    expect(frame(view).split(OFFER)).toHaveLength(2)
    await press(view, 's')
    await waitForText(() => frame(view), CONTACT)
    await press(view, keys.enter)
    await waitForText(() => frame(view), 'Sent. Report r1.')
    expect(sentBodies(view.commands.sendReport)[0]!.runs).toHaveLength(1)
  })

  it('offers a report after a translation that gave up a batch', async () => {
    saveConfig({ defaultLocale: 'tr' })
    // A run row with a given-up batch, as translateFile records one, without
    // standing up a draft engine to fail.
    const translateFile = vi.fn(async (opts: TranslateOptions) => {
      const jobs = openJobsDb()
      const id = startRun(jobs, { file: opts.file, command: 'translate', locale: 'tr', nplurals: 2, batchSize: 50, engine: 'deepl' })
      opts.onRunStarted?.(id)
      recordBatchFailure(jobs, { runId: id, batch: 1, attempt: 2, size: 1, phase: 'drafting', reason: 'timeout', ms: 10, final: true, at: Date.now() })
      finishRun(jobs, id, { entries: 1, flagged: 0, repaired: 0, unreviewed: 0, approvable: 0, byCategory: {} })
      jobs.close()
      const summary = summaryOf(opts.file, { skipped: 1 })
      opts.onProgress?.({ type: 'start', file: opts.file, total: summary.total, pending: summary.pending })
      opts.onProgress?.({ type: 'done', summary })
      return summary
    })
    const view = mount('translate', { translateFile })
    await waitForText(view.lastFrame, 'a.po')
    await press(view, keys.down, keys.enter)
    await waitForText(view.lastFrame, 'Start translation')
    // Mode, engine, locale, batch size, start over, start.
    await press(view, keys.down, keys.down, keys.down, keys.down, keys.down, keys.enter)
    await waitForText(() => frame(view), `1 batch failed. ${OFFER}`)
    await press(view, 's')
    await waitForText(() => frame(view), CONTACT)
    await press(view, keys.enter)
    await waitForText(() => frame(view), 'Sent. Report r1.')
  })
})
