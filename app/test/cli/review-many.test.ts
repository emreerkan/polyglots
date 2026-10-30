import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main, type CliDeps } from '../../src/cli.js'
import type { ReviewOptions } from '../../src/commands/review.js'
import type { ReviewSummary } from '../../src/types.js'

// `review a.po b.po`: several local files through the batch Fetch runs, so
// the command line can do what the menu's marked files do.

function sink() {
  return {
    isTTY: false,
    text: '',
    write(chunk: string) {
      this.text += chunk
      return true
    },
  }
}

function stdinWith() {
  const stream = new PassThrough() as PassThrough & { isTTY?: boolean }
  stream.isTTY = false
  stream.end()
  return stream
}

const reviewSummary = (file: string, patch: Partial<ReviewSummary> = {}): ReviewSummary => ({
  file,
  locale: 'tr',
  total: 20,
  skipped: 0,
  reviewed: 20,
  problems: 3,
  needsReview: 0,
  approvable: 17,
  unreviewed: 0,
  repaired: 2,
  written: 3,
  pending: 0,
  byRule: {},
  byGroup: {},
  problemsFile: file.replace(/\.po$/, '-repaired.po'),
  ...patch,
})

const po = (language: string | undefined) => `msgid ""
msgstr ""
"Project-Id-Version: Themes - Koji\\n"
${language === undefined ? '' : `"Language: ${language}\\n"\n`}"MIME-Version: 1.0\\n"
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Save"
msgstr "Kaydet"
`

let home: string
let savedEnv: NodeJS.ProcessEnv
let a: string
let b: string

async function config(values: Record<string, unknown>) {
  await mkdir(join(home, 'config'), { recursive: true })
  await writeFile(join(home, 'config', 'config.json'), JSON.stringify(values))
}

beforeEach(async () => {
  savedEnv = { ...process.env }
  home = await mkdtemp(join(tmpdir(), 'polyglots-cli-review-many-'))
  process.env.POLYGLOTS_HOME = home
  await config({ defaultLocale: 'tr' })
  a = join(home, 'a-tr.po')
  b = join(home, 'b-tr.po')
  await writeFile(a, po('tr'))
  await writeFile(b, po('tr'))
})

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  await rm(home, { recursive: true, force: true })
})

async function run(argv: string[], deps: Omit<CliDeps, 'streams'> = {}) {
  const stdout = sink()
  const stderr = sink()
  const code = await main(argv, { env: {}, ...deps, streams: { stdin: stdinWith(), stdout, stderr } })
  return { code, stdout: stdout.text, stderr: stderr.text }
}

describe('review with several files', () => {
  it('reviews every file with the same database handles and control', async () => {
    const calls: ReviewOptions[] = []
    const r = await run(['review', a, b], {
      reviewFile: async (opts) => {
        calls.push(opts)
        return reviewSummary(opts.file)
      },
    })
    expect(r.code).toBe(0)
    expect(calls.map((c) => c.file)).toEqual([a, b])
    expect(new Set<Database.Database | undefined>(calls.map((c) => c.db)).size).toBe(1)
    expect(calls[0]!.db).toBeDefined()
    expect(new Set<Database.Database | undefined>(calls.map((c) => c.jobsDb)).size).toBe(1)
    expect(new Set(calls.map((c) => c.control)).size).toBe(1)
    expect(r.stdout).toContain('Reviewed')
    expect(r.stdout).toMatch(/done\s+2/)
  })

  it('passes the review options to every file', async () => {
    const calls: ReviewOptions[] = []
    await run(['review', a, b, '--no-ai', '--fresh', '--batch-size', '40', '--out-dir', '/tmp/out'], {
      reviewFile: async (opts) => {
        calls.push(opts)
        return reviewSummary(opts.file)
      },
    })
    for (const c of calls) expect(c).toMatchObject({ noAi: true, fresh: true, batchSize: 40, locale: 'tr', outDir: '/tmp/out' })
  })

  // The single-file commands print a run's warnings, the debug notice among
  // them, with the warn prefix. A batch printed them bare, so the one line a
  // debug run must not go unnoticed read like any other progress line.
  it('prints a run warning with the warn prefix', async () => {
    const r = await run(['review', a, b, '--debug'], {
      reviewFile: async (opts) => {
        opts.onWarn?.('Debug mode: prompts and agent output are saved in /tmp/x')
        return reviewSummary(opts.file)
      },
    })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('! Debug mode: prompts and agent output are saved in /tmp/x')
  })

  it('runs up to --parallel files at once', async () => {
    const c = join(home, 'c-tr.po')
    await writeFile(c, po('tr'))
    let running = 0
    let peak = 0
    const r = await run(['review', a, b, c, '--parallel', '2'], {
      reviewFile: async (opts) => {
        running++
        peak = Math.max(peak, running)
        await new Promise((res) => setTimeout(res, 5))
        running--
        return reviewSummary(opts.file)
      },
    })
    expect(r.code).toBe(0)
    expect(peak).toBe(2)
  })

  it('runs one file at a time without --parallel', async () => {
    let running = 0
    let peak = 0
    await run(['review', a, b], {
      reviewFile: async (opts) => {
        running++
        peak = Math.max(peak, running)
        await new Promise((res) => setTimeout(res, 5))
        running--
        return reviewSummary(opts.file)
      },
    })
    expect(peak).toBe(1)
  })

  it('refuses --parallel above 8 and says why', async () => {
    const r = await run(['review', a, b, '--parallel', '9'], { reviewFile: async (opts) => reviewSummary(opts.file) })
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/--parallel is at most 8/)
  })

  it('carries on past a failure and exits 1', async () => {
    const r = await run(['review', a, b], {
      reviewFile: async (opts) => {
        if (opts.file === a) throw new Error('quota exhausted')
        return reviewSummary(opts.file)
      },
    })
    expect(r.code).toBe(1)
    expect(r.stdout).toMatch(/a-tr\.po.*quota exhausted/)
    expect(r.stdout).toMatch(/done\s+1/)
    expect(r.stdout).toMatch(/failed\s+1/)
    expect(r.stdout).toContain('Reviewed with failures')
  })

  // Each goes back to a different contributor.
  it('prints the requester message of every reviewed file', async () => {
    const r = await run(['review', a, b], { reviewFile: async (opts) => reviewSummary(opts.file) })
    expect(r.stdout.match(/Message for the requester/g)?.length).toBe(2)
  })

  describe('with a reply template', () => {
    async function template(name: string, text: string) {
      await mkdir(join(home, 'config', 'templates', 'tr_TR'), { recursive: true })
      await writeFile(join(home, 'config', 'templates', 'tr_TR', `${name}.txt`), text)
    }
    const reviewed = async (opts: ReviewOptions) =>
      opts.file === a ? reviewSummary(opts.file) : reviewSummary(opts.file, { problems: 0, repaired: 0, written: 0, problemsFile: undefined })

    it('prints one reply per file instead of the requester messages, with --requester in every one', async () => {
      await template('approved', 'Hello @{username},\n\n{No problems.|I fixed a few.}\n\n{results}\n')
      const r = await run(['review', a, b, '--requester', 'ayse'], { reviewFile: reviewed })
      expect(r.code).toBe(0)
      expect(r.stdout).not.toContain('Message for the requester')
      expect(r.stdout).toContain(`Reply (${a}, approved template):`)
      expect(r.stdout).toContain(`Reply (${b}, approved template):`)
      expect(r.stdout.match(/Hello @ayse,/g)?.length).toBe(2)
      expect(r.stdout).toContain('No problems.')
    })

    it('fills every reply from --template', async () => {
      await template('approved', 'Hello.\n')
      await template('declined', 'Not yet, @{username}.\n')
      const r = await run(['review', a, b, '--template', 'declined'], { reviewFile: reviewed })
      expect(r.stdout.match(/Not yet, @\{username\}\./g)?.length).toBe(2)
    })

    it('refuses a --template that does not exist before running anything', async () => {
      await template('approved', 'Hello.\n')
      let ran = false
      const r = await run(['review', a, b, '--template', 'nope'], {
        reviewFile: async (opts) => {
          ran = true
          return reviewSummary(opts.file)
        },
      })
      expect(r.code).not.toBe(0)
      expect(ran).toBe(false)
      expect(r.stderr).toContain('No reply template "nope"')
    })
  })

  it('exits 3 when the batch was stopped part way', async () => {
    const r = await run(['review', a, b], {
      reviewFile: async (opts) => reviewSummary(opts.file, { pending: 5 }),
    })
    expect(r.code).toBe(3)
  })

  describe('locale', () => {
    // With nothing configured each file is read for its own locale, so a
    // folder holding two languages' exports is one command, not two.
    it('reads each file its own locale from its header when none is set', async () => {
      await config({})
      await writeFile(b, po('ja'))
      const calls: ReviewOptions[] = []
      const r = await run(['review', a, b], {
        reviewFile: async (opts) => {
          calls.push(opts)
          return reviewSummary(opts.file)
        },
      })
      expect(r.code).toBe(0)
      expect(calls.map((c) => [c.file, c.locale])).toEqual([
        [a, 'tr'],
        [b, 'ja'],
      ])
      expect(r.stderr).toMatch(/Language header/)
    })

    it('uses --locale for every file when it is given', async () => {
      await config({})
      await writeFile(b, po('ja'))
      const calls: ReviewOptions[] = []
      await run(['review', a, b, '--locale', 'tr'], {
        reviewFile: async (opts) => {
          calls.push(opts)
          return reviewSummary(opts.file)
        },
      })
      expect(calls.map((c) => c.locale)).toEqual(['tr', 'tr'])
    })

    // Refused before anything runs: one file nobody can place would otherwise
    // be found out after the others had spent their calls.
    it('refuses before running anything when a file names no locale, and says which', async () => {
      await config({})
      await writeFile(b, po(undefined))
      const calls: ReviewOptions[] = []
      const r = await run(['review', a, b], {
        reviewFile: async (opts) => {
          calls.push(opts)
          return reviewSummary(opts.file)
        },
      })
      expect(r.code).toBe(2)
      expect(r.stderr).toContain('b-tr.po')
      expect(calls).toEqual([])
    })
  })

  describe('outputs', () => {
    // Two inputs from different folders share a basename, so --out-dir would
    // send both reviews to one output file and keep only the last writer.
    it('refuses before running anything when two files would write one output, and names both', async () => {
      const x = join(home, 'x')
      const y = join(home, 'y')
      await mkdir(x)
      await mkdir(y)
      await writeFile(join(x, 'foo-tr.po'), po('tr'))
      await writeFile(join(y, 'foo-tr.po'), po('tr'))
      const calls: ReviewOptions[] = []
      const r = await run(['review', join(x, 'foo-tr.po'), join(y, 'foo-tr.po'), '--out-dir', join(home, 'out')], {
        reviewFile: async (opts) => {
          calls.push(opts)
          return reviewSummary(opts.file)
        },
      })
      expect(r.code).toBe(2)
      expect(calls).toEqual([])
      expect(r.stderr).toContain(join(x, 'foo-tr.po'))
      expect(r.stderr).toContain(join(y, 'foo-tr.po'))
      expect(r.stderr).toContain('foo-tr-repaired.po')
    })

    it('runs files with distinct names into one --out-dir', async () => {
      const calls: ReviewOptions[] = []
      const r = await run(['review', a, b, '--out-dir', join(home, 'out')], {
        reviewFile: async (opts) => {
          calls.push(opts)
          return reviewSummary(opts.file)
        },
      })
      expect(r.code).toBe(0)
      expect(calls.map((c) => c.file)).toEqual([a, b])
    })

    // A glob over a folder that was reviewed before matches the earlier
    // outputs too; the menu refuses to mark them, and so does this.
    it('leaves out earlier review outputs and says which', async () => {
      const repaired = join(home, 'a-tr-repaired.po')
      const problems = join(home, 'b-tr-problems.po')
      await writeFile(repaired, po('tr'))
      await writeFile(problems, po('tr'))
      const calls: ReviewOptions[] = []
      const r = await run(['review', join(home, '*.po')], {
        reviewFile: async (opts) => {
          calls.push(opts)
          return reviewSummary(opts.file)
        },
      })
      expect(r.code).toBe(0)
      expect(calls.map((c) => c.file)).toEqual([a, b])
      expect(r.stderr).toContain('a-tr-repaired.po')
      expect(r.stderr).toContain('b-tr-problems.po')
      expect(r.stdout).toMatch(/done\s+2/)
    })

    // Only a glob matches an output by accident. A name written out is the
    // same request a single file named on its own is: on a project run the
    // repaired file of one phase was named beside two others to be checked by
    // the rules, and was dropped.
    it('reviews a review output named beside other files', async () => {
      const repaired = join(home, 'a-tr-repaired.po')
      await writeFile(repaired, po('tr'))
      const calls: ReviewOptions[] = []
      const r = await run(['review', repaired, b, '--out-dir', join(home, 'out')], {
        reviewFile: async (opts) => {
          calls.push(opts)
          return reviewSummary(opts.file)
        },
      })
      expect(r.code).toBe(0)
      expect(calls.map((c) => c.file)).toEqual([repaired, b])
      expect(r.stderr).not.toContain('Left out')
    })

    it('keeps a named output when a glob beside it matches it too', async () => {
      const repaired = join(home, 'a-tr-repaired.po')
      await writeFile(repaired, po('tr'))
      const calls: ReviewOptions[] = []
      const r = await run(['review', repaired, join(home, '*.po'), '--out-dir', join(home, 'out')], {
        reviewFile: async (opts) => {
          calls.push(opts)
          return reviewSummary(opts.file)
        },
      })
      expect(r.code).toBe(0)
      expect(calls.map((c) => c.file).sort()).toEqual([a, repaired, b].sort())
    })

    it('reviews the one file left after outputs are left out the way it reviews one file', async () => {
      const repaired = join(home, 'a-tr-repaired.po')
      await writeFile(repaired, po('tr'))
      const calls: ReviewOptions[] = []
      const r = await run(['review', join(home, 'a-*.po')], {
        reviewFile: async (opts) => {
          calls.push(opts)
          return reviewSummary(opts.file)
        },
      })
      expect(r.code).toBe(0)
      expect(calls.map((c) => c.file)).toEqual([a])
      expect(r.stdout).toMatch(/flagged\s+3/)
    })

    it('refuses when every file the globs matched is a review output', async () => {
      const repaired = join(home, 'a-tr-repaired.po')
      const problems = join(home, 'b-tr-problems.po')
      await writeFile(repaired, po('tr'))
      await writeFile(problems, po('tr'))
      const calls: ReviewOptions[] = []
      const r = await run(['review', join(home, '*-p*.po'), join(home, '*-repaired.po')], {
        reviewFile: async (opts) => {
          calls.push(opts)
          return reviewSummary(opts.file)
        },
      })
      expect(r.code).toBe(2)
      expect(calls).toEqual([])
    })

    // Named alone it is still reviewed: someone pointing at one file by name
    // means it, and the single-file command stays as it was.
    it('still reviews a review output named on its own', async () => {
      const repaired = join(home, 'a-tr-repaired.po')
      await writeFile(repaired, po('tr'))
      const calls: ReviewOptions[] = []
      const r = await run(['review', repaired], {
        reviewFile: async (opts) => {
          calls.push(opts)
          return reviewSummary(opts.file)
        },
      })
      expect(r.code).toBe(0)
      expect(calls.map((c) => c.file)).toEqual([repaired])
    })
  })

  // The one-file run keeps its own summary, not the batch table.
  it('keeps the single-file summary for one file', async () => {
    const r = await run(['review', a], { reviewFile: async (opts) => reviewSummary(opts.file) })
    expect(r.code).toBe(0)
    expect(r.stdout).not.toMatch(/done\s+1/)
    expect(r.stdout).toMatch(/flagged\s+3/)
  })
})
