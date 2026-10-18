import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProbeExec } from '../../src/agent/providers.js'
import { openJobsDb } from '../../src/jobs/db.js'
import { startRun } from '../../src/jobs/runs.js'
import { boundedVersion, buildFor, contactLine, providerVersion, VERSION_WAIT_MS } from '../../src/report/offer.js'

// The report names the provider's version, as the server's mail summary does
// ("antigravity 1.4.0"). One --version call, never the real binary here: a
// fake agy on a temporary PATH and a fake exec that records what it is asked.

const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function pathWith(name: string): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'polyglots-offer-'))
  dirs.push(dir)
  const bin = join(dir, name)
  writeFileSync(bin, '#!/bin/sh\nexit 0\n')
  chmodSync(bin, 0o755)
  return { PATH: dir }
}

function recording(answer: Awaited<ReturnType<ProbeExec>> | 'throw' | 'hang') {
  const calls: Array<{ cmd: string; args: string[]; timeoutMs: number }> = []
  const exec: ProbeExec = (cmd, args, opts) => {
    calls.push({ cmd, args, timeoutMs: opts.timeoutMs })
    if (answer === 'throw') throw new Error('spawn failed')
    if (answer === 'hang') return new Promise(() => {})
    return Promise.resolve(answer)
  }
  return { exec, calls }
}

describe('providerVersion', () => {
  it('reads the first line of <bin> --version, with a short timeout', async () => {
    const env = pathWith('agy')
    const { exec, calls } = recording({ code: 0, stdout: '\n1.4.0\nextra\n', stderr: '', timedOut: false })
    await expect(providerVersion('antigravity', { exec, env, platform: 'darwin' })).resolves.toBe('1.4.0')
    expect(calls).toEqual([{ cmd: join(env.PATH!, 'agy'), args: ['--version'], timeoutMs: VERSION_WAIT_MS }])
  })

  // buildFor is the one place the version is cut, to what the endpoint
  // takes; a second, shorter cap here made the CLI and the app send
  // different lengths of the same line.
  it('hands back the whole first line, leaving the cut to buildFor', async () => {
    const env = pathWith('agy')
    const line = `agy ${'9'.repeat(116)}`
    const { exec } = recording({ code: 0, stdout: `${line}\n`, stderr: '', timedOut: false })
    await expect(providerVersion('antigravity', { exec, env, platform: 'darwin' })).resolves.toBe(line)
  })

  it('asks nothing for a local model or no reviewer, nor for a binary not on PATH', async () => {
    const { exec, calls } = recording({ code: 0, stdout: '1', stderr: '', timedOut: false })
    await expect(providerVersion('local', { exec, env: pathWith('agy') })).resolves.toBeUndefined()
    await expect(providerVersion('none', { exec, env: pathWith('agy') })).resolves.toBeUndefined()
    await expect(providerVersion('antigravity', { exec, env: { PATH: '' } })).resolves.toBeUndefined()
    expect(calls).toEqual([])
  })

  it('is undefined, never a throw, when the call fails or exits non-zero', async () => {
    const env = pathWith('agy')
    await expect(providerVersion('antigravity', { exec: recording('throw').exec, env, platform: 'darwin' })).resolves.toBeUndefined()
    const failed = recording({ code: 2, stdout: 'usage', stderr: '', timedOut: false }).exec
    await expect(providerVersion('antigravity', { exec: failed, env, platform: 'darwin' })).resolves.toBeUndefined()
  })
})

describe('boundedVersion', () => {
  it('gives up on a version that has not come within the wait, and never rejects', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let value: string | undefined | 'pending' = 'pending'
    void boundedVersion(new Promise(() => {})).then((v) => (value = v))
    await vi.advanceTimersByTimeAsync(VERSION_WAIT_MS - 1)
    expect(value).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(value).toBeUndefined()
    await expect(boundedVersion(Promise.reject(new Error('no')))).resolves.toBeUndefined()
    await expect(boundedVersion(Promise.resolve('1.4.0'))).resolves.toBe('1.4.0')
  })
})

// The endpoint refuses the whole report over one bad field, and a refusal
// comes after the upload: the report is then only saved, over a detail
// nobody needed. So every line of free text is made acceptable before it goes.
describe('contactLine', () => {
  it('turns a pasted tab or newline into a space rather than a refused report', () => {
    expect(contactLine('slack:\temre')).toBe('slack: emre')
    expect(contactLine('  emre\r\n')).toBe('emre')
    expect(contactLine('\u0007')).toBeUndefined()
  })
})

describe('buildFor', () => {
  function withRun<T>(fn: (jobs: ReturnType<typeof openJobsDb>, runId: number) => T): T {
    const jobs = openJobsDb()
    try {
      const runId = startRun(jobs, { file: '/tmp/plugin-tr.po', command: 'review', locale: 'tr', nplurals: 2, batchSize: 100, engine: 'e' })
      return fn(jobs, runId)
    } finally {
      jobs.close()
    }
  }

  it('cuts the model and version to what the endpoint takes, as one line', () => {
    const report = withRun((jobs, runId) =>
      buildFor(jobs, [runId], { provider: 'antigravity', model: `gemini\t${'x'.repeat(300)}`, version: '\u001b[1m1.4.0\u001b[0m' }),
    )
    const { model, version } = report.provider
    expect(model!.length).toBeLessThanOrEqual(128)
    expect(model!.startsWith('gemini x')).toBe(true)
    expect(version).toBe('[1m1.4.0 [0m')
    for (const text of [model!, version!]) expect(text).not.toMatch(/[\u0000-\u001f\u007f]/)
  })

  it('leaves out a model with nothing but control characters, which the endpoint would refuse as empty', () => {
    const report = withRun((jobs, runId) => buildFor(jobs, [runId], { provider: 'claude', model: '\n\t' }))
    expect(report.provider).toEqual({ name: 'claude' })
  })
})
