import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main } from '../../src/cli.js'
import { localeRulesFile } from '../../src/rules/load.js'

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/locale/${name}`, import.meta.url))

function sink() {
  return { isTTY: false, text: '', write(chunk: string) { this.text += chunk; return true } }
}

async function run(argv: string[]) {
  const stdout = sink()
  const stderr = sink()
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean }
  stdin.end()
  const code = await main(argv, { env: {}, streams: { stdin, stdout, stderr } })
  return { code, out: stdout.text, err: stderr.text }
}

// An empty home on purpose: --file is how a locale team checks a file before
// publishing it, on a machine that may never have run polyglots, so it must
// need no config, no locale and no database.
let home: string
let saved: NodeJS.ProcessEnv
beforeEach(async () => {
  saved = { ...process.env }
  home = await mkdtemp(join(tmpdir(), 'polyglots-cli-rules-check-'))
  process.env.POLYGLOTS_HOME = home
})
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  await rm(home, { recursive: true, force: true })
})

async function writeFileIn(name: string, text: string) {
  const file = join(home, name)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text, 'utf8')
  return file
}

describe('rules check --file', () => {
  it('reports a regex that runs away on a test string as an error', async () => {
    const file = await writeFileIn('bad.yaml', "schema: 1\npatterns:\n  - find: '^(a+)+$'\n    level: hint\n")
    const { out, code } = await run(['rules', 'check', '--file', file, '--json'])
    expect(code).toBe(1)
    expect(JSON.parse(out)).toMatchObject({
      valid: false,
      line: 3,
      error: 'patterns.0.find took longer than 100 ms on a test string (a regex that can run away)',
    })
  })

  it('checks a file by path with an empty home', async () => {
    const { out, code } = await run(['rules', 'check', '--file', fixture('tr_TR.yaml'), '--json'])
    expect(code).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ valid: true, schema: 2, register: true, sentenceEnd: false })
  })

  it('prints one JSON object and nothing else', async () => {
    const { out, err } = await run(['rules', 'check', '--file', fixture('tr_TR.yaml'), '--json'])
    expect(err).toBe('')
    expect(out.trim().split('\n')).toHaveLength(1)
    const report = JSON.parse(out)
    expect(report.path).toBe(fixture('tr_TR.yaml'))
    expect(report.rules).toEqual({ enable: ['title-case', 'apostrophe', 'ampersand', 'number-format'], disable: [] })
    expect(report.capitalization).toBeGreaterThan(0)
    expect(report).not.toHaveProperty('formality')
  })

  it('counts patterns by level apart from mistakes, and reports the schema-2 keys', async () => {
    const file = await writeFileIn(
      'x.yaml',
      [
        'schema: 2',
        'mistakes:',
        '  - wrong: önizleme',
        'patterns:',
        '  - text: a',
        '  - text: b',
        '    level: error',
        '  - text: c',
        '    replace: d',
        '    level: fix',
        'guidance: Be brief.',
        'capitalization: |-',
        '  Sentence case.',
        'formality: informal',
        'sentenceEnd:',
        '  unmarked: true',
        '',
      ].join('\n'),
    )
    const report = JSON.parse((await run(['rules', 'check', '--file', file, '--json'])).out)
    expect(report).toEqual({
      valid: true,
      path: file,
      schema: 2,
      mistakes: 1,
      patterns: { hint: 1, error: 1, fix: 1 },
      guidance: 9,
      capitalization: 14,
      register: false,
      formality: 'informal',
      sentenceEnd: true,
    })
  })

  // | keeps the final newline and |- drops it; the count must not depend on which.
  it('counts capitalization the same under | and |-', async () => {
    const kept = await writeFileIn('kept.yaml', 'schema: 2\ncapitalization: |\n  Sentence case.\n')
    const dropped = await writeFileIn('dropped.yaml', 'schema: 2\ncapitalization: |-\n  Sentence case.\n')
    const a = JSON.parse((await run(['rules', 'check', '--file', kept, '--json'])).out)
    const b = JSON.parse((await run(['rules', 'check', '--file', dropped, '--json'])).out)
    expect(a.capitalization).toBe(14)
    expect(b.capitalization).toBe(14)
  })

  it('exits 1 with the error and line for a bad file', async () => {
    const file = await writeFileIn('new.yaml', 'schema: 4\n')
    const { out, code } = await run(['rules', 'check', '--file', file, '--json'])
    expect(code).toBe(1)
    expect(JSON.parse(out)).toEqual({
      valid: false,
      path: file,
      error: 'needs rules schema 4; this polyglots reads up to 3. Update polyglots.',
      line: 1,
    })
  })

  it('names the file and line of a bad file in the human output, on stderr', async () => {
    const file = await writeFileIn('bad.yaml', 'rules:\n  enable: [nope]\n')
    const { out, err, code } = await run(['rules', 'check', '--file', file])
    expect(code).toBe(1)
    expect(out).toBe('')
    expect(err).toContain(`${file}:2`)
    expect(err).toMatch(/nope/)
  })

  it('reports a missing file as invalid, exit 1', async () => {
    const file = join(home, 'absent.yaml')
    const json = await run(['rules', 'check', '--file', file, '--json'])
    expect(json.code).toBe(1)
    expect(JSON.parse(json.out)).toEqual({ valid: false, path: file, error: 'no such file' })
    const human = await run(['rules', 'check', '--file', file])
    expect(human.code).toBe(1)
    expect(human.err).toContain(`${file} no such file`)
  })

  it('refuses --file with a locale', async () => {
    const { code, err } = await run(['rules', 'check', 'tr', '--file', fixture('tr_TR.yaml')])
    expect(code).toBe(2)
    expect(err).toMatch(/locale or --file, not both/)
  })

  it('says 0 disabled, not 0 disableds', async () => {
    const { out, code } = await run(['rules', 'check', '--file', fixture('tr_TR.yaml')])
    expect(code).toBe(0)
    expect(out).toContain('rules: 4 enabled extras, 0 disabled')
    expect(out).not.toMatch(/disableds/)
  })

  it('shows the schema-2 keys in the human summary', async () => {
    const { out } = await run(['rules', 'check', '--file', fixture('tr_TR.yaml')])
    expect(out).toMatch(/^ {2}schema: 2$/m)
    expect(out).toMatch(/^ {2}capitalization: \d+ of 2500 characters$/m)
    expect(out).toMatch(/^ {2}register: set$/m)
    expect(out).not.toMatch(/formality|sentenceEnd/)
  })

  it('names the dateTime when set', async () => {
    const file = await writeFileIn('d.yaml', "schema: 3\ndateTime:\n  clock: 24h\n  order: dmy\n  formats:\n    'F j, Y': 'j F Y'\n    'g:i a': 'H:i'\n")
    const { out } = await run(['rules', 'check', '--file', file])
    expect(out).toMatch(/^ {2}schema: 3$/m)
    expect(out).toMatch(/^ {2}dateTime: clock 24h, order dmy, 2 formats$/m)
    const json = await run(['rules', 'check', '--json', '--file', file])
    expect(JSON.parse(json.out)).toMatchObject({ valid: true, schema: 3, dateTime: { clock: '24h', order: 'dmy', formats: 2 } })
  })

  it('names the name order when set', async () => {
    const file = await writeFileIn('n.yaml', 'schema: 3\nnames:\n  order: family-first\n')
    const { out } = await run(['rules', 'check', '--file', file])
    expect(out).toMatch(/^ {2}names: family-first$/m)
    const json = await run(['rules', 'check', '--json', '--file', file])
    expect(JSON.parse(json.out)).toMatchObject({ valid: true, schema: 3, names: 'family-first' })
  })

  it('says register: default when the file sets none, and names formality and sentenceEnd when set', async () => {
    const file = await writeFileIn('f.yaml', 'schema: 2\nformality: formal\nsentenceEnd:\n  unmarked: true\n')
    const { out } = await run(['rules', 'check', '--file', file])
    expect(out).toMatch(/^ {2}register: default$/m)
    expect(out).toMatch(/^ {2}capitalization: none$/m)
    expect(out).toMatch(/^ {2}formality: formal$/m)
    expect(out).toMatch(/^ {2}sentenceEnd: set$/m)
  })
})

describe('rules check <locale> --json', () => {
  beforeEach(async () => {
    await mkdir(join(home, 'config'), { recursive: true })
    await writeFile(join(home, 'config', 'config.json'), JSON.stringify({ defaultLocale: 'tr' }))
  })

  it('reports the locale file', async () => {
    const file = localeRulesFile('tr')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'guidance: Be brief.\n', 'utf8')
    const { out, code } = await run(['rules', 'check', '--json'])
    expect(code).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ valid: true, path: file, schema: 1, guidance: 9, register: false })
  })

  // Human output keeps "no rules file" as an answer, not a fault; a script
  // asking for JSON asked whether there is a valid file, and there is not.
  it('answers no such file with exit 1 when the locale has no file', async () => {
    const { out, code } = await run(['rules', 'check', 'tr', '--json'])
    expect(code).toBe(1)
    expect(JSON.parse(out)).toEqual({ valid: false, path: localeRulesFile('tr'), error: 'no such file' })
    const human = await run(['rules', 'check', 'tr'])
    expect(human.code).toBe(0)
    expect(human.out).toContain('No rules file for tr; only the universal checks run.')
  })
})

describe('rules check --file: a YAML syntax error', () => {
  it('keeps the column the parser reports, in both outputs', async () => {
    const file = join(home, 'syntax.yaml')
    await writeFile(file, 'guidance: "open\n', 'utf8')
    const json = JSON.parse((await run(['rules', 'check', '--file', file, '--json'])).out)
    expect(json.valid).toBe(false)
    expect(json.line).toBeGreaterThan(0)
    expect(json.column).toBeGreaterThan(0)
    const human = await run(['rules', 'check', '--file', file])
    expect(human.err).toContain(`${file}:${json.line}:${json.column} `)
  })
})
