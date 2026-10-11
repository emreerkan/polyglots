import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main, type CliDeps } from '../../src/cli.js'
import { starterTemplate, templateFile, templatesDir } from '../../src/reply/templates.js'
import type { ReviewSummary } from '../../src/types.js'

const samplePo = fileURLToPath(new URL('../fixtures/po/sample.po', import.meta.url))

function sink() {
  return { isTTY: false, text: '', write(chunk: string) { this.text += chunk; return true } }
}

async function run(argv: string[], deps: Omit<CliDeps, 'streams'> = {}) {
  const stdout = sink()
  const stderr = sink()
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean }
  stdin.end()
  const code = await main(argv, { env: {}, ...deps, streams: { stdin, stdout, stderr } })
  return { code, stdout: stdout.text, stderr: stderr.text }
}

// A terminal on both ends, answering the confirmation with `answer`.
async function runInTerminal(argv: string[], answer: string) {
  const stdout = sink()
  const stderr = { ...sink(), isTTY: true }
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean }
  stdin.isTTY = true
  stdin.end(`${answer}\n`)
  const code = await main(argv, { env: {}, streams: { stdin, stdout, stderr } })
  return { code, stdout: stdout.text, stderr: stderr.text }
}

let home: string
let saved: NodeJS.ProcessEnv
beforeEach(async () => {
  saved = { ...process.env }
  home = await mkdtemp(join(tmpdir(), 'polyglots-cli-template-'))
  process.env.POLYGLOTS_HOME = home
  await mkdir(join(home, 'config'), { recursive: true })
  await writeFile(join(home, 'config', 'config.json'), JSON.stringify({ defaultLocale: 'tr' }))
})
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  await rm(home, { recursive: true, force: true })
})

async function writeTemplate(locale: string, name: string, text: string) {
  const file = templateFile(locale, name)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text, 'utf8')
  return file
}

describe('template path', () => {
  it('prints the locale folder, or the named template file', async () => {
    expect((await run(['template', 'path', 'tr'])).stdout.trim()).toBe(templatesDir('tr'))
    expect((await run(['template', 'path', 'tr', 'declined'])).stdout.trim()).toBe(templateFile('tr', 'declined'))
  })

  it('refuses a name that is not a file name', async () => {
    const r = await run(['template', 'path', 'tr', '../escape'])
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/template name/i)
  })
})

describe('template edit', () => {
  it('writes the approved starter and opens it in the editor', async () => {
    const opened: string[] = []
    const r = await run(['template', 'edit', 'tr'], { openEditor: async (f) => void opened.push(f) })
    expect(r.code).toBe(0)
    const file = templateFile('tr', 'approved')
    expect(opened).toEqual([file])
    expect(await readFile(file, 'utf8')).toBe(starterTemplate('tr', 'approved'))
    expect(r.stdout).toContain(file)
  })

  it('writes the named starter for another locale', async () => {
    await run(['template', 'edit', 'de', 'declined'], { openEditor: async () => undefined })
    expect(await readFile(templateFile('de', 'declined'), 'utf8')).toBe(starterTemplate('de', 'declined'))
  })

  it('never overwrites a template that exists', async () => {
    const file = await writeTemplate('tr', 'approved', 'Mine.')
    await run(['template', 'edit', 'tr', 'approved'], { openEditor: async () => undefined })
    expect(await readFile(file, 'utf8')).toBe('Mine.')
  })
})

describe('template delete', () => {
  it('deletes with --yes and says which one', async () => {
    const file = await writeTemplate('tr', 'declined', 'Not yet.')
    const r = await run(['template', 'delete', 'tr', 'declined', '--yes'])
    expect(r.code).toBe(0)
    expect(existsSync(file)).toBe(false)
    expect(r.stdout).toContain('Deleted the declined reply template for tr')
  })

  it('asks first in a terminal, and deletes on yes', async () => {
    const file = await writeTemplate('tr', 'approved', 'Mine.')
    const r = await runInTerminal(['template', 'delete', 'tr', 'approved'], 'y')
    expect(r.stderr).toContain('Delete the approved reply template for tr? [y/N]')
    expect(r.code).toBe(0)
    expect(existsSync(file)).toBe(false)
  })

  it('keeps the template when the answer is not yes', async () => {
    const file = await writeTemplate('tr', 'approved', 'Mine.')
    const r = await runInTerminal(['template', 'delete', 'tr', 'approved'], 'n')
    expect(r.code).toBe(1)
    expect(await readFile(file, 'utf8')).toBe('Mine.')
  })

  it('refuses without --yes when nobody can be asked', async () => {
    const file = await writeTemplate('tr', 'approved', 'Mine.')
    const r = await run(['template', 'delete', 'tr', 'approved'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--yes')
    expect(await readFile(file, 'utf8')).toBe('Mine.')
  })

  it('says so when there is no such template', async () => {
    const r = await run(['template', 'delete', 'tr', 'nope', '--yes'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('No reply template "nope" for tr')
  })
})

describe('template list', () => {
  it('says how to make one when there are none', async () => {
    const r = await run(['template', 'list'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/no reply templates/i)
    expect(r.stdout).toContain('polyglots template edit')
  })

  it('lists every locale’s templates, or one locale’s', async () => {
    await writeTemplate('tr', 'approved', 'A')
    await writeTemplate('tr', 'declined', 'B')
    await writeTemplate('de', 'approved', 'C')
    const all = await run(['template', 'list'])
    expect(all.stdout).toMatch(/tr_TR: approved, declined/)
    expect(all.stdout).toMatch(/de_DE: approved/)
    const tr = await run(['template', 'list', 'tr'])
    expect(tr.stdout).toContain(templateFile('tr', 'approved'))
    expect(tr.stdout).toContain(templateFile('tr', 'declined'))
    expect(tr.stdout).not.toContain('de_DE')
  })
})

describe('review with a reply template', () => {
  let file: string
  beforeEach(async () => {
    file = join(home, 'sample.po')
    await copyFile(samplePo, file)
  })

  function summary(patch: Partial<ReviewSummary> = {}): ReviewSummary {
    return {
      file: 'plugin-tr.po',
      locale: 'tr',
      total: 120,
      skipped: 4,
      reviewed: 116,
      problems: 14,
      needsReview: 0,
      approvable: 102,
      unreviewed: 0,
      repaired: 9,
      written: 14,
      pending: 0,
      byRule: { 'title-case': 11 },
      byGroup: { 'title-case': 9 },
      problemsFile: '/tmp/plugin-tr-problems.po',
      ...patch,
    }
  }

  const reviewing = (s: ReviewSummary) => {
    const calls: unknown[] = []
    return { calls, fn: (async (opts: unknown) => (calls.push(opts), s)) as CliDeps['reviewFile'] & object }
  }

  const TEMPLATE = 'Hello @{username},\n\n{No problems.|I fixed a few.}\n\n{results_copy}\n\nCheers!\n'

  it('prints no reply when the locale has no template', async () => {
    const r = await run(['review', file, '--no-ai'], { reviewFile: reviewing(summary()).fn })
    expect(r.code).toBe(0)
    expect(r.stdout).not.toMatch(/reply/i)
  })

  it('prints the filled approved reply after the requester message, unwrapped', async () => {
    await writeTemplate('tr', 'approved', TEMPLATE)
    await writeTemplate('tr', 'declined', 'Not yet, @{username}.')
    const r = await run(['review', file, '--no-ai', '--requester', 'ayse'], { reviewFile: reviewing(summary()).fn })
    expect(r.code).toBe(0)
    const message = 'I fixed 9 entries, which you can see <a href="">here</a>. They included ~5 title-case issues.'
    expect(r.stdout).toContain('Reply (approved template):')
    expect(r.stdout).toContain(`Hello @ayse,\n\nI fixed a few.\n\n${message}\n\nCheers!`)
    expect(r.stdout.indexOf('Message for the requester:')).toBeLessThan(r.stdout.indexOf('Reply (approved template):'))
  })

  it('uses the template --template names, and leaves {username} without --requester', async () => {
    await writeTemplate('tr', 'approved', TEMPLATE)
    await writeTemplate('tr', 'declined', 'Not yet, @{username}. {none|some}')
    const r = await run(['review', file, '--no-ai', '--template', 'declined'], {
      reviewFile: reviewing(summary({ repaired: 0, byGroup: {} })).fn,
    })
    expect(r.stdout).toContain('Reply (declined template):')
    expect(r.stdout).toContain('Not yet, @{username}. none')
  })

  it('takes the some-problems text and warns above the reply when entries are flagged but none repaired', async () => {
    await writeTemplate('tr', 'approved', TEMPLATE)
    const r = await run(['review', file, '--no-ai'], {
      reviewFile: reviewing(summary({ repaired: 0, written: 2, needsReview: 2, byGroup: {} })).fn,
    })
    expect(r.stdout).toContain('I fixed a few.')
    const caution = '2 entries are flagged for you. Check the verdict sentence before you post.'
    expect(r.stdout).toContain(caution)
    expect(r.stdout.indexOf(caution)).toBeLessThan(r.stdout.indexOf('Hello @'))
  })

  it('refuses an unknown --template before reviewing anything', async () => {
    await writeTemplate('tr', 'approved', TEMPLATE)
    const review = reviewing(summary())
    const r = await run(['review', file, '--no-ai', '--template', 'nope'], { reviewFile: review.fn })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('nope')
    expect(r.stderr).toContain('polyglots template edit tr nope')
    expect(review.calls).toEqual([])
  })

  // A run stopped part way has entries nobody has looked at, and a reply
  // saying there were no problems would be a verdict on work not done.
  it('prints no reply for a run that stopped early', async () => {
    await writeTemplate('tr', 'approved', TEMPLATE)
    const r = await run(['review', file, '--no-ai'], { reviewFile: reviewing(summary({ pending: 30 })).fn })
    expect(r.stdout).not.toContain('Reply (')
  })
})
