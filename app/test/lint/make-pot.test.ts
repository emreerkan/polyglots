import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LintNotStarted } from '../../src/lint/errors.js'
import { findCommand, makePot, spawnPlan, type MakePotIo, type MakePotOptions, type WpCliPin } from '../../src/lint/make-pot.js'

const PHAR = Buffer.from('<?php // a fake phar')
const sha512 = (b: Buffer): string => createHash('sha512').update(b).digest('hex')
const PIN: WpCliPin = { version: '9.9.9', url: 'https://example.test/wp-cli-9.9.9.phar', sha512: sha512(PHAR), size: PHAR.length }

let dir: string
let cacheDir: string
let opts: MakePotOptions & { notices: string[] }

interface FakeIo extends MakePotIo {
  runs: Array<[string, string[]]>
  fetches: string[]
}

function io(over: Partial<MakePotIo> & { onPath?: Record<string, string> } = {}): FakeIo {
  const { onPath = { php: '/usr/bin/php' }, ...rest } = over
  const runs: Array<[string, string[]]> = []
  const fetches: string[] = []
  return {
    env: {},
    which: (cmd) => onPath[cmd],
    run: async (cmd, args) => {
      runs.push([cmd, args])
      await writeFile(args.at(-2)!, 'msgid ""\nmsgstr ""\n')
      return { code: 0, stdout: 'Success: POT file successfully generated.', stderr: '' }
    },
    fetch: async (url) => {
      fetches.push(url)
      return new Response(PHAR)
    },
    cacheDir,
    ...rest,
    runs,
    fetches,
  }
}

const notStarted = async (p: Promise<unknown>): Promise<LintNotStarted> => {
  try {
    await p
  } catch (err) {
    if (err instanceof LintNotStarted) return err
    throw err
  }
  throw new Error('did not throw')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'make-pot-'))
  cacheDir = join(dir, 'cache')
  const notices: string[] = []
  opts = { dir: join(dir, 'plugin'), out: join(dir, 'out.pot'), notice: (l) => notices.push(l), notices }
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const MAKE_POT_ARGS = (o: MakePotOptions) => ['i18n', 'make-pot', o.dir, o.out, '--skip-audit']

describe('which make-pot runs', () => {
  it('takes POLYGLOTS_WP_BIN before wp on PATH', async () => {
    const fake = io({ env: { POLYGLOTS_WP_BIN: '/opt/wp' }, onPath: { wp: '/usr/local/bin/wp', php: '/usr/bin/php' } })
    await makePot(opts, fake, PIN)
    expect(fake.runs).toEqual([['/opt/wp', MAKE_POT_ARGS(opts)]])
  })
  it('takes wp on PATH and downloads nothing', async () => {
    const fake = io({ onPath: { wp: '/usr/local/bin/wp', php: '/usr/bin/php' } })
    await makePot(opts, fake, PIN)
    expect(fake.runs).toEqual([['/usr/local/bin/wp', MAKE_POT_ARGS(opts)]])
    expect(fake.fetches).toEqual([])
  })
  it('refuses with advice when there is neither wp nor php, before downloading', async () => {
    const fake = io({ onPath: {} })
    const err = await notStarted(makePot(opts, fake, PIN))
    expect(err.message).toMatch(/No wp command and no PHP/)
    expect(err.detail.join('\n')).toMatch(/npx wp-env run cli wp i18n make-pot/)
    expect(fake.fetches).toEqual([])
  })
})

describe('the pinned phar', () => {
  const phar = () => join(cacheDir, 'wp-cli-9.9.9.phar')

  it('downloads it once, says so, keeps it, and runs it with php', async () => {
    const fake = io()
    await makePot(opts, fake, PIN)
    expect(fake.fetches).toEqual([PIN.url])
    expect(opts.notices).toHaveLength(1)
    expect(opts.notices[0]).toMatch(/9\.9\.9/)
    expect(opts.notices[0]).toContain(cacheDir)
    expect(await readFile(phar())).toEqual(PHAR)
    expect(fake.runs).toEqual([['/usr/bin/php', [phar(), ...MAKE_POT_ARGS(opts)]]])
  })
  it('uses a kept phar that still matches, without downloading', async () => {
    await mkdir(cacheDir, { recursive: true })
    await writeFile(phar(), PHAR)
    const fake = io()
    await makePot(opts, fake, PIN)
    expect(fake.fetches).toEqual([])
    expect(opts.notices).toEqual([])
  })
  it('downloads again when the kept phar no longer matches', async () => {
    await mkdir(cacheDir, { recursive: true })
    await writeFile(phar(), 'truncated')
    const fake = io()
    await makePot(opts, fake, PIN)
    expect(fake.fetches).toEqual([PIN.url])
    expect(await readFile(phar())).toEqual(PHAR)
  })
  it('refuses a download that does not match the pin, names both hashes, and keeps nothing', async () => {
    const fake = io({ fetch: async () => new Response('something else') })
    const err = await notStarted(makePot(opts, fake, PIN))
    expect(err.message).toMatch(/does not match the pinned SHA-512/)
    expect(err.detail.join('\n')).toContain(PIN.sha512)
    expect(err.detail.join('\n')).toContain(sha512(Buffer.from('something else')))
    expect(await readdir(cacheDir).catch(() => [])).toEqual([])
    expect(fake.runs).toEqual([])
  })
  it('refuses with advice when offline', async () => {
    const fake = io({ fetch: async () => { throw new TypeError('fetch failed') } })
    const err = await notStarted(makePot(opts, fake, PIN))
    expect(err.message).toMatch(/Could not download WP-CLI 9\.9\.9: fetch failed/)
    expect(err.detail.join('\n')).toMatch(/\.pot made elsewhere/)
  })
  it('refuses when GitHub answers with an error status', async () => {
    const fake = io({ fetch: async () => new Response('gone', { status: 404 }) })
    const err = await notStarted(makePot(opts, fake, PIN))
    expect(err.message).toMatch(/answered 404/)
  })
})

describe('running make-pot', () => {
  const withWp = { onPath: { wp: '/usr/local/bin/wp' } }

  it('stops with make-pot\'s own stderr when it fails', async () => {
    const fake = io({ ...withWp, run: async () => ({ code: 1, stdout: '', stderr: 'Error: Not a valid source directory.\n' }) })
    const err = await notStarted(makePot(opts, fake, PIN))
    expect(err.message).toMatch(/make-pot failed with exit code 1, so the lint did not start/)
    expect(err.detail).toEqual(['Error: Not a valid source directory.'])
  })
  it('stops when make-pot exits 0 but writes no file', async () => {
    const fake = io({ ...withWp, run: async () => ({ code: 0, stdout: '', stderr: '' }) })
    const err = await notStarted(makePot(opts, fake, PIN))
    expect(err.message).toMatch(/wrote no \.pot/)
  })
  it('stops when the command cannot be started at all', async () => {
    const fake = io({ env: { POLYGLOTS_WP_BIN: '/nowhere/wp' }, run: async () => { throw new Error('spawn /nowhere/wp ENOENT') } })
    const err = await notStarted(makePot(opts, fake, PIN))
    expect(err.message).toMatch(/Could not run \/nowhere\/wp: spawn \/nowhere\/wp ENOENT/)
  })
})

// Node refuses to spawn a .bat or .cmd without a shell since the fix for
// CVE-2024-27980, and wp on Windows is wp.bat.
describe('spawnPlan', () => {
  it('runs a .bat on Windows through the shell, with every argument quoted', () => {
    expect(spawnPlan('C:\\tools\\wp.bat', ['i18n', 'C:\\My Plugin'], 'win32')).toEqual({
      file: '"C:\\tools\\wp.bat"',
      args: ['"i18n"', '"C:\\My Plugin"'],
      shell: true,
    })
  })
  it('runs an .exe on Windows, and anything elsewhere, directly', () => {
    expect(spawnPlan('C:\\php\\php.exe', ['a b'], 'win32')).toEqual({ file: 'C:\\php\\php.exe', args: ['a b'], shell: false })
    expect(spawnPlan('/usr/local/bin/wp', ['a b'], 'darwin')).toEqual({ file: '/usr/local/bin/wp', args: ['a b'], shell: false })
  })
})

// Review finding I3: a download that drops after the headers is still a
// failure to start, not a crash.
describe('a download cut off part way', () => {
  it('stops with LintNotStarted', async () => {
    const broken = { ok: true, status: 200, arrayBuffer: async () => { throw new TypeError('terminated') } } as unknown as Response
    const err = await notStarted(makePot(opts, io({ fetch: async () => broken }), PIN))
    expect(err.message).toMatch(/Could not download WP-CLI 9\.9\.9: terminated/)
  })
})

// Review finding I2: Composer's vendor\bin holds a sh proxy named wp beside
// wp.bat, and the proxy cannot be run on Windows.
describe('findCommand', () => {
  it('takes the PATHEXT file on Windows over the one with no extension', async () => {
    const bin = join(dir, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'wp'), '#!/bin/sh')
    await writeFile(join(bin, 'wp.bat'), '@echo off')
    expect(findCommand('wp', { PATH: bin, PATHEXT: '.com;.exe;.bat' }, 'win32')).toBe(join(bin, 'wp.bat'))
  })
  it('resolves a bare POLYGLOTS_WP_BIN through PATH', async () => {
    const fake = io({ env: { POLYGLOTS_WP_BIN: 'wp-custom' }, onPath: { 'wp-custom': '/x/wp-custom.bat' } })
    await makePot(opts, fake, PIN)
    expect(fake.runs[0]![0]).toBe('/x/wp-custom.bat')
  })
})
