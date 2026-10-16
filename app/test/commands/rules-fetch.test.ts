import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { diffRules, planRulesFetch, writeRulesFetch } from '../../src/commands/rules-fetch.js'
import { dataClient } from '../../src/data/download.js'
import { DataError } from '../../src/data/manifest.js'
import { localeRulesFile, parseLocaleRules, RulesFileError } from '../../src/rules/load.js'
import { bytes, serve, type TestServer } from '../data/server.js'

const fixture = fileURLToPath(new URL('../fixtures/locale/tr_TR.yaml', import.meta.url))
const sha512 = (b: Buffer | string) => createHash('sha512').update(b).digest('hex')

let home: string
let server: TestServer | undefined
let served: Buffer

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyglots-rules-fetch-'))
  vi.stubEnv('POLYGLOTS_HOME', home)
  served = await readFile(fixture)
})

afterEach(async () => {
  await server?.close()
  server = undefined
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

// One manifest listing tr, its file served beside it; `patch` overrides the
// entry's fields, so each refusal is one field away from the happy path.
async function publish(body: Buffer | string, patch: Record<string, unknown> = {}) {
  const file = '/locales/tr_TR/rules.yaml'
  const routes: Record<string, ReturnType<typeof bytes>> = { [file]: bytes(body) }
  server = await serve({
    '/index.json': (req, res) => {
      const entry = {
        locale: 'tr_TR',
        slug: 'tr',
        url: server!.url(file),
        sha512: sha512(body),
        schema: 2,
        minPolyglots: '0.1.0',
        status: 'maintained',
        maintainers: ['emreerkan', 'someone'],
        ...patch,
      }
      bytes(JSON.stringify({ schema: 1, generated: '2026-10-16T00:00:00Z', tm: [], rules: [entry] }))(req, res)
    },
    ...routes,
  })
  vi.stubEnv('POLYGLOTS_DATA_URL', server.url('/index.json'))
}

async function writeLocal(text: string | Buffer) {
  const path = localeRulesFile('tr')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
  return path
}

describe('planRulesFetch', () => {
  it('writes a new file byte for byte', async () => {
    await publish(served)
    const plan = await planRulesFetch('tr', dataClient)
    expect(plan.state).toBe('new')
    expect(plan.path).toBe(localeRulesFile('tr'))
    expect(existsSync(plan.path)).toBe(false)
    await writeRulesFetch(plan)
    expect(await readFile(plan.path)).toEqual(served)
  })

  it('writes nothing and asks nothing when identical', async () => {
    await publish(served)
    const path = await writeLocal(served)
    const plan = await planRulesFetch('tr', dataClient)
    expect(plan.state).toBe('same')
    expect(await readFile(path)).toEqual(served)
  })

  it('names the status and the maintainers as WordPress.org usernames, never as links', async () => {
    await publish(served, { status: 'draft' })
    const plan = await planRulesFetch('tr', dataClient)
    expect(plan.summary.at(-1)).toBe('status: draft · maintainers (wordpress.org): emreerkan, someone')
    expect(plan.summary.join('\n')).not.toMatch(/github|https?:/i)
  })

  it.each([
    ['file schema', { schema: 3 }, 'needs rules schema 3; this polyglots reads up to 2. Update polyglots.'],
    ['minPolyglots', { minPolyglots: '99.0.0' }, 'tr_TR rules need polyglots 99.0.0 or later; this is'],
    ['sha512', { sha512: '0'.repeat(128) }, 'does not match the sha512'],
  ])('refuses on %s and writes nothing', async (_name, patch, message) => {
    await publish(served, patch)
    const err = await planRulesFetch('tr', dataClient).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DataError)
    expect((err as Error).message).toContain(message)
    expect(existsSync(localeRulesFile('tr'))).toBe(false)
  })

  it('refuses a locale the manifest does not have, naming the ones it does', async () => {
    await publish(served)
    await expect(planRulesFetch('de', dataClient)).rejects.toThrow('No polyglots-data entry for de. Available: tr')
  })

  it('refuses an invalid file', async () => {
    const bad = 'schema: 2\npatterns:\n  - find: "("\n'
    await publish(bad)
    const err = await planRulesFetch('tr', dataClient).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RulesFileError)
    expect((err as RulesFileError).line).toBe(3)
    expect(existsSync(localeRulesFile('tr'))).toBe(false)
  })

  it('refuses a runaway regex the probe catches', async () => {
    const bad = 'schema: 2\npatterns:\n  - find: "(a+)+$"\n'
    await publish(bad)
    await expect(planRulesFetch('tr', dataClient)).rejects.toThrow(/took longer than 100 ms/)
  })

  it('refuses a file that is not UTF-8, which could not be written back as the bytes that were verified', async () => {
    const bad = Buffer.concat([Buffer.from('guidance: '), Buffer.from([0xff, 0xfe, 0x41]), Buffer.from('\n')])
    await publish(bad)
    await expect(planRulesFetch('tr', dataClient)).rejects.toThrow(/not UTF-8/)
  })

  it('keeps a byte order mark, so the written file still matches the sha512', async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), served])
    await publish(withBom)
    const plan = await planRulesFetch('tr', dataClient)
    await writeRulesFetch(plan)
    expect(await readFile(plan.path)).toEqual(withBom)
  })

  it('replaces a local file that is not valid, saying it compared against nothing', async () => {
    await publish(served)
    await writeLocal('patterns: [\n')
    const plan = await planRulesFetch('tr', dataClient)
    expect(plan.state).toBe('changed')
    expect(plan.summary[0]).toMatch(/^The local file is not valid \(.*\); compared against nothing\.$/)
  })

  it('summarises prompt text, fix patterns and sentenceEnd', async () => {
    const after = [
      'schema: 2',
      'guidance: |-',
      '  b first line',
      '  b second line',
      'patterns:',
      '  - find: (\\s)yada\\b',
      '    replace: $1ya da',
      '    level: fix',
      '    note: ya da is two words',
      'sentenceEnd:',
      '  unmarked: true',
      '',
    ].join('\n')
    await publish(after)
    await writeLocal('guidance: a\n')
    const plan = await planRulesFetch('tr', dataClient)
    expect(plan.state).toBe('changed')
    const text = plan.summary.join('\n')
    expect(text).toContain('guidance changed:\n  b first line\n  b second line')
    expect(text).toContain('note: ya da is two words')
    expect(text).toContain('fix added: (\\s)yada\\b → $1ya da')
    expect(text).toContain('sentenceEnd: changed')
    expect(text).toContain('rules.enable, proper nouns, 0 hint and 0 error patterns: unchanged')
  })
})

describe('diffRules', () => {
  const parse = (text: string) => parseLocaleRules(text, 'test.yaml')

  it('lists every key against nothing, in the order of the spec', () => {
    const after = parse(
      [
        'schema: 2',
        'rules:',
        '  enable: [title-case]',
        'guidance: g',
        'capitalization: |',
        '  Cap line one.',
        '  Cap line two.',
        'register:',
        '  audit: formal audit',
        '  translate: formal translate',
        'formality: formal',
        'mistakes:',
        '  - wrong: foo',
        '    right: bar',
        'patterns:',
        '  - text: baz',
        '    level: error',
        '    note: no baz',
        '  - text: qux',
        '    replace: quux',
        '    level: fix',
        '    when:',
        '      source: Q',
        '',
      ].join('\n'),
    )
    expect(diffRules(undefined, after)).toEqual([
      'guidance changed:',
      '  g',
      'capitalization changed:',
      '  Cap line one.',
      '  Cap line two.',
      'register.audit changed:',
      '  formal audit',
      'register.translate changed:',
      '  formal translate',
      'formality changed: formal',
      'right: bar',
      'note: no baz',
      'fix added: qux → quux (when the source has Q)',
      'sentenceEnd: unchanged',
      'rules.enable, proper nouns, 1 hint and 1 error patterns: changed',
    ])
  })

  it('says removed for prompt text the new file drops, and lists a removed fix', () => {
    const before = parse('schema: 2\nguidance: g\nregister: both\npatterns:\n  - text: a\n    replace: b\n    level: fix\n')
    const after = parse('schema: 2\nregister:\n  audit: both\n')
    expect(diffRules(before, after)).toEqual([
      'guidance removed',
      'register.translate removed',
      'fix removed: a → b',
      'sentenceEnd: unchanged',
      'rules.enable, proper nouns, 0 hint and 0 error patterns: unchanged',
    ])
  })

  it('shows a fix whose notSource changed, and names the condition', () => {
    const before = parse('schema: 2\npatterns:\n  - text: a\n    replace: b\n    level: fix\n    when: { notSource: x }\n')
    const after = parse('schema: 2\npatterns:\n  - text: a\n    replace: b\n    level: fix\n    when: { notSource: y }\n')
    expect(diffRules(before, after).slice(0, 2)).toEqual([
      'fix removed: a → b (when the source lacks x)',
      'fix added: a → b (when the source lacks y)',
    ])
  })

  it('shows a changed fix as the old one removed and the new one added', () => {
    const before = parse('patterns:\n  - text: a\n    replace: b\n    level: fix\n')
    const after = parse('patterns:\n  - text: a\n    replace: c\n    level: fix\n')
    expect(diffRules(before, after)).toEqual([
      'fix removed: a → b',
      'fix added: a → c',
      'sentenceEnd: unchanged',
      'rules.enable, proper nouns, 0 hint and 0 error patterns: unchanged',
    ])
  })

  it('treats | and |- capitalization as the same text', () => {
    const before = parse('schema: 2\ncapitalization: |\n  Same.\n')
    const after = parse('schema: 2\ncapitalization: |-\n  Same.\n')
    expect(diffRules(before, after)).not.toContain('capitalization changed:')
  })

  it('counts a proper noun change on the count line', () => {
    const before = parse('properNouns:\n  always: [A]\n')
    const after = parse('properNouns:\n  always: [A, B]\n')
    expect(diffRules(before, after)).toContain('rules.enable, proper nouns, 0 hint and 0 error patterns: changed')
  })
})
