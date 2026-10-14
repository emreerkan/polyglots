import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { main, type CliDeps } from '../../src/cli.js'
import { LintNotStarted } from '../../src/lint/errors.js'
import type { MakePotOptions } from '../../src/lint/make-pot.js'

interface Sink {
  isTTY?: boolean
  text: string
  write(chunk: string): boolean
}
const sink = (): Sink => ({
  isTTY: false,
  text: '',
  write(chunk: string) {
    this.text += chunk
    return true
  },
})

function run(argv: string[], deps: Omit<CliDeps, 'streams'> = {}) {
  const stdout = sink()
  const stderr = sink()
  const stdin = new PassThrough()
  stdin.end()
  return main(['lint', ...argv], { env: {}, ...deps, streams: { stdin, stdout, stderr } }).then((code) => ({ code, out: stdout.text, err: stderr.text }))
}

const HEADER = 'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n\n'
const entry = (msgid: string, refs: string[], comment?: string): string =>
  `${comment ? `#. ${comment}\n` : ''}#: ${refs.join(' ')}\nmsgid ${JSON.stringify(msgid)}\nmsgstr ""\n\n`
const ERROR_POT = HEADER + entry('Hello %s', ['plugin.php:3'])
const WARNING_POT = HEADER + entry('Post', ['plugin.php:3'])
const CLEAN_POT = HEADER + entry('Save changes', ['plugin.php:3'])

function fakeMakePot(body: string) {
  const calls: MakePotOptions[] = []
  return {
    calls,
    fn: async (opts: MakePotOptions) => {
      calls.push(opts)
      await writeFile(opts.out, body)
    },
  }
}
const refuseMakePot = async (): Promise<void> => {
  throw new Error('make-pot must not run for a .pot')
}

let home: string
let plugin: string
let savedHome: string | undefined

beforeEach(async () => {
  savedHome = process.env.POLYGLOTS_HOME
  home = await mkdtemp(join(tmpdir(), 'polyglots-lint-cli-'))
  process.env.POLYGLOTS_HOME = home
  plugin = join(home, 'my-plugin')
  await mkdir(join(plugin, 'languages'), { recursive: true })
  await writeFile(join(plugin, 'plugin.php'), "<?php\n\necho __( 'Post' );\n")
})
afterEach(async () => {
  if (savedHome === undefined) delete process.env.POLYGLOTS_HOME
  else process.env.POLYGLOTS_HOME = savedHome
  await rm(home, { recursive: true, force: true })
})

describe('polyglots lint <folder>', () => {
  it('makes a .pot in a temporary folder, lints it, removes the folder, and exits 1 on an error', async () => {
    const make = fakeMakePot(ERROR_POT)
    const r = await run([plugin], { makePot: make.fn })
    expect(r.code).toBe(1)
    expect(make.calls[0]!.dir).toBe(resolve(plugin))
    expect(existsSync(dirname(make.calls[0]!.out))).toBe(false)
    expect(r.out).toMatch(/translators-comment/)
    expect(r.out).toMatch(/"Hello %s"\s+plugin\.php:3/)
  })
  it('exits 2 with make-pot\'s own lines when the .pot cannot be made, and removes the folder', async () => {
    const calls: MakePotOptions[] = []
    const r = await run([plugin], {
      makePot: async (opts) => {
        calls.push(opts)
        throw new LintNotStarted('wp i18n make-pot failed with exit code 1, so the lint did not start.', ['Error: Not a valid source directory.'])
      },
    })
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/make-pot failed with exit code 1/)
    expect(r.err).toMatch(/Error: Not a valid source directory\./)
    expect(r.out).toBe('')
    expect(existsSync(dirname(calls[0]!.out))).toBe(false)
  })
  it('removes the temporary folder after an unexpected throw too', async () => {
    const calls: MakePotOptions[] = []
    const r = await run([plugin], {
      makePot: async (opts) => {
        calls.push(opts)
        throw new Error('boom')
      },
    })
    expect(r.code).toBe(2)
    expect(existsSync(dirname(calls[0]!.out))).toBe(false)
  })
  it('passes the download notice to stderr', async () => {
    const r = await run([plugin], {
      makePot: async (opts) => {
        opts.notice('No wp command found: downloading WP-CLI 2.12.0')
        await writeFile(opts.out, CLEAN_POT)
      },
    })
    expect(r.err).toMatch(/downloading WP-CLI 2\.12\.0/)
    expect(r.out).not.toMatch(/downloading/)
  })
  it('says no problems in 0 strings for a plugin with nothing to translate', async () => {
    const r = await run([plugin], { makePot: fakeMakePot(HEADER).fn })
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/No problems in 0 strings\./)
  })
  it('reads markers from the folder', async () => {
    await writeFile(join(plugin, 'plugin.php'), "<?php\n\necho __( 'Post' ); // polyglots-ignore\n")
    const r = await run([plugin], { makePot: fakeMakePot(WARNING_POT).fn })
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/No problems in 1 string\./)
  })
  it('reads a marker on a CRLF line', async () => {
    await writeFile(join(plugin, 'plugin.php'), "<?php\r\n\r\necho __( 'Post' ); // polyglots-ignore\r\n")
    const r = await run([plugin], { makePot: fakeMakePot(WARNING_POT).fn })
    expect(r.out).toMatch(/No problems in 1 string\./)
  })
  it('exits 2 on a bad settings file without running make-pot', async () => {
    await writeFile(join(plugin, '.polyglots-lint.json'), '{"rules":{"nope":"off"}}')
    const r = await run([plugin], { makePot: refuseMakePot })
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/unknown rule "nope"/)
  })
  it('applies the settings file in the folder', async () => {
    await writeFile(join(plugin, '.polyglots-lint.json'), '{"rules":{"ambiguous-word":"error"}}')
    const r = await run([plugin], { makePot: fakeMakePot(WARNING_POT).fn })
    expect(r.code).toBe(1)
  })
})

describe('polyglots lint <file.pot>', () => {
  const pot = () => join(plugin, 'languages', 'my-plugin.pot')

  it('lints the file directly and exits 0 when clean', async () => {
    await writeFile(pot(), CLEAN_POT)
    const r = await run([pot()], { makePot: refuseMakePot })
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/No problems in 1 string\./)
  })
  it('exits 0 on warnings, and 1 with --strict', async () => {
    await writeFile(pot(), WARNING_POT)
    expect((await run([pot()], { makePot: refuseMakePot })).code).toBe(0)
    expect((await run([pot(), '--strict'], { makePot: refuseMakePot })).code).toBe(1)
  })
  it('finds the sources one folder up from languages/ and reads the marker there', async () => {
    await writeFile(join(plugin, 'plugin.php'), "<?php\n\necho __( 'Post' ); // polyglots-ignore\n")
    await writeFile(pot(), WARNING_POT)
    const r = await run([pot()], { makePot: refuseMakePot })
    expect(r.out).toMatch(/No problems in 1 string\./)
    expect(r.err).toBe('')
  })
  it('reads sources from --source', async () => {
    const elsewhere = join(home, 'elsewhere')
    await mkdir(elsewhere)
    await writeFile(join(elsewhere, 'plugin.php'), "<?php\n\necho __( 'Post' ); // polyglots-ignore\n")
    await writeFile(join(home, 'loose.pot'), WARNING_POT)
    const r = await run([join(home, 'loose.pot'), '--source', elsewhere], { makePot: refuseMakePot })
    expect(r.out).toMatch(/No problems in 1 string\./)
  })
  it('says so when the sources cannot be found, and lints anyway', async () => {
    await writeFile(join(home, 'loose.pot'), WARNING_POT)
    const r = await run([join(home, 'loose.pot')], { makePot: refuseMakePot })
    expect(r.err).toMatch(/markers were not read/)
    expect(r.out).toMatch(/ambiguous-word/)
  })
  it('writes JSON with --format json', async () => {
    await writeFile(pot(), ERROR_POT)
    const r = await run([pot(), '--format', 'json'], { makePot: refuseMakePot })
    const data = JSON.parse(r.out)
    expect(data.version).toBe(1)
    expect(data.pot).toBe(pot())
    expect(data.errors).toBe(1)
    expect(data.findings[0].rule).toBe('translators-comment')
    expect(r.code).toBe(1)
  })
  it('writes GitHub annotations with --format github, then the total', async () => {
    await writeFile(pot(), ERROR_POT)
    const saved = process.env.GITHUB_WORKSPACE
    process.env.GITHUB_WORKSPACE = home
    try {
      const r = await run([pot(), '--format', 'github'], { makePot: refuseMakePot })
      expect(r.out).toMatch(/^::error file=my-plugin\/plugin\.php,line=3,title=polyglots translators-comment::"Hello %25s": /m)
      expect(r.out).toMatch(/1 error, 0 warnings in 1 string\./)
    } finally {
      if (saved === undefined) delete process.env.GITHUB_WORKSPACE
      else process.env.GITHUB_WORKSPACE = saved
    }
  })
})

describe('polyglots lint refusals', () => {
  it('exits 2 on an unknown format', async () => {
    const r = await run([plugin, '--format', 'sarif'], { makePot: refuseMakePot })
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/--format must be text, json or github/)
  })
  it('exits 2 on a path that does not exist', async () => {
    const r = await run([join(home, 'missing')], { makePot: refuseMakePot })
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/does not exist/)
  })
  it('exits 2 on a file that is not a .pot', async () => {
    await writeFile(join(home, 'x.po'), CLEAN_POT)
    const r = await run([join(home, 'x.po')], { makePot: refuseMakePot })
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/neither a folder nor a \.pot file/)
  })
  it('names POLYGLOTS_WP_BIN and the exit codes in its help', async () => {
    const r = await run(['--help'])
    expect(r.out).toMatch(/POLYGLOTS_WP_BIN/)
    expect(r.out).toMatch(/2 the lint did not start/)
  })
})

describe('review findings', () => {
  // I3: a .pot without a header entry used to crash with exit 1, which CI
  // reads as "the strings have errors".
  it('exits 2 when the .pot cannot be read', async () => {
    await writeFile(join(home, 'bad.pot'), entry('Post', ['plugin.php:3']))
    const r = await run([join(home, 'bad.pot')], { makePot: refuseMakePot })
    expect(r.code).toBe(2)
    expect(r.err).not.toBe('')
  })
  // I1: make-pot keeps only the Text Domain header's domain, or the folder
  // name; a mismatch otherwise reads as a clean pass.
  it('warns when make-pot found nothing outside the header', async () => {
    const headerOnly = HEADER + '#. Plugin Name of the plugin\n#: plugin.php\nmsgid "My Plugin"\nmsgstr ""\n\n'
    const r = await run([plugin], { makePot: fakeMakePot(headerOnly).fn })
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/No problems in 0 strings\./)
    expect(r.err).toMatch(/Text Domain/)
  })
})

describe('second pass', () => {
  it('passes --domain to make-pot', async () => {
    const make = fakeMakePot(CLEAN_POT)
    await run([plugin, '--domain', 'acme'], { makePot: make.fn })
    expect(make.calls[0]!.domain).toBe('acme')
  })
  it('refuses a --domain that is not a text domain', async () => {
    const r = await run([plugin, '--domain', 'a b'], { makePot: refuseMakePot })
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/--domain/)
  })
  it('names --domain when make-pot found nothing outside the header', async () => {
    const r = await run([plugin], { makePot: fakeMakePot(HEADER).fn })
    expect(r.err).toMatch(/--domain/)
  })
  // m10
  it('says --source does nothing for a folder', async () => {
    const r = await run([plugin, '--source', home], { makePot: fakeMakePot(CLEAN_POT).fn })
    expect(r.err).toMatch(/--source is only for a \.pot/)
  })
  // m3: GitHub resolves annotation paths from the repository root.
  it('writes annotation paths from GITHUB_WORKSPACE when it is set', async () => {
    const saved = process.env.GITHUB_WORKSPACE
    process.env.GITHUB_WORKSPACE = home
    try {
      const r = await run([plugin, '--format', 'github'], { makePot: fakeMakePot(ERROR_POT).fn })
      expect(r.out).toMatch(/^::error file=my-plugin\/plugin\.php,line=3,/m)
    } finally {
      if (saved === undefined) delete process.env.GITHUB_WORKSPACE
      else process.env.GITHUB_WORKSPACE = saved
    }
  })
  it('leaves file and line out for a plugin outside GITHUB_WORKSPACE', async () => {
    const saved = process.env.GITHUB_WORKSPACE
    process.env.GITHUB_WORKSPACE = join(home, 'elsewhere')
    try {
      const r = await run([plugin, '--format', 'github'], { makePot: fakeMakePot(ERROR_POT).fn })
      expect(r.out).toMatch(/^::error title=polyglots translators-comment::/m)
    } finally {
      if (saved === undefined) delete process.env.GITHUB_WORKSPACE
      else process.env.GITHUB_WORKSPACE = saved
    }
  })
  it('says --domain does nothing for a .pot', async () => {
    await writeFile(join(home, 'loose.pot'), CLEAN_POT)
    const r = await run([join(home, 'loose.pot'), '--domain', 'acme'], { makePot: refuseMakePot })
    expect(r.err).toMatch(/--domain is only for a folder/)
  })
  it('leaves file and line out when the sources were not found', async () => {
    await writeFile(join(home, 'loose.pot'), ERROR_POT)
    const r = await run([join(home, 'loose.pot'), '--format', 'github'], { makePot: refuseMakePot })
    expect(r.out).toMatch(/^::error title=polyglots translators-comment::/m)
  })
})
