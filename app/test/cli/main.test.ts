import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { stripVTControlCharacters } from 'node:util'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { main, type CliDeps } from '../../src/cli.js'
import { displayWidth } from '../../src/ui/layout.js'
import type { TranslateOptions, TranslateSummary } from '../../src/commands/translate.js'
import type { AgentStatus, DiscoverOptions } from '../../src/agent/discover.js'
import type { DiscoverModelsOptions, ModelCheck, ModelServer } from '../../src/draft/discover.js'
import { DEFAULT_QWEN_MODEL } from '../../src/draft/qwen.js'
import { installLocaleFixture } from '../locale-fixture.js'

// The default local model differs by platform (the MLX build on Apple silicon
// only), so patterns name whichever this machine gets.
const MODEL_RE = DEFAULT_QWEN_MODEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const samplePo = fileURLToPath(new URL('../fixtures/po/sample.po', import.meta.url))
const pkg = createRequire(import.meta.url)('../../package.json') as { version: string }

interface Sink {
  isTTY?: boolean
  text: string
  write(chunk: string): boolean
}

function sink(isTTY = false): Sink {
  return {
    isTTY,
    text: '',
    write(chunk: string) {
      this.text += chunk
      return true
    },
  }
}

type FakeStdin = PassThrough & { isTTY?: boolean }

function stdinWith(input: string | undefined, isTTY: boolean): FakeStdin {
  const stream = new PassThrough() as FakeStdin
  stream.isTTY = isTTY
  if (input !== undefined) stream.write(input)
  stream.end()
  return stream
}

interface FakeTranslate {
  fn: (opts: TranslateOptions) => Promise<TranslateSummary>
  calls: TranslateOptions[]
}

function summaryFor(opts: TranslateOptions, patch: Partial<TranslateSummary> = {}): TranslateSummary {
  return { file: opts.file, total: 12, pending: 7, fromTm: 1, translated: 6, fuzzy: 1, skipped: 0, ...patch }
}

function fakeTranslate(plan: (opts: TranslateOptions, call: number) => Partial<TranslateSummary> | Error = () => ({})): FakeTranslate {
  const calls: TranslateOptions[] = []
  return {
    calls,
    async fn(opts) {
      calls.push(opts)
      const emit = opts.onProgress ?? (() => undefined)
      emit({ type: 'start', file: opts.file, total: 12, pending: 7 })
      const outcome = plan(opts, calls.length)
      if (outcome instanceof Error) throw outcome
      const summary = summaryFor(opts, outcome)
      emit({ type: 'tm-hit', count: summary.fromTm })
      emit({ type: 'batch-start', index: 1, of: 1, size: 6, at: Date.now() })
      emit({ type: 'batch-done', index: 1, translated: summary.translated, fuzzy: summary.fuzzy, at: Date.now() })
      emit({ type: 'done', summary })
      return summary
    },
  }
}

interface Harness {
  stdout: Sink
  stderr: Sink
  run(argv: string[], deps?: Omit<CliDeps, 'streams'> & { stdin?: FakeStdin; tty?: boolean; stdoutTty?: boolean }): Promise<number>
}

function harness(): Harness {
  const stdout = sink()
  const stderr = sink()
  return {
    stdout,
    stderr,
    run(argv, deps = {}) {
      const { stdin, tty, stdoutTty, ...rest } = deps
      stderr.isTTY = tty === true
      stdout.isTTY = stdoutTty === true
      return main(argv, { env: {}, ...rest, streams: { stdin: stdin ?? stdinWith(undefined, false), stdout, stderr } })
    },
  }
}

let home: string
let file: string
let savedEnv: NodeJS.ProcessEnv

beforeEach(async () => {
  savedEnv = { ...process.env }
  home = await mkdtemp(join(tmpdir(), 'polyglots-cli-main-'))
  file = join(home, 'sample.po')
  await copyFile(samplePo, file)
  process.env.POLYGLOTS_HOME = home
  // Named rather than assumed: polyglots has no default locale, and these
  // tests are about everything but choosing one (test/cli/locale.test.ts).
  await mkdir(join(home, 'config'), { recursive: true })
  await writeFile(join(home, 'config', 'config.json'), JSON.stringify({ defaultLocale: 'tr' }))
  process.env.DEEPL_API_KEY = 'dpl-test-key-0123456789:fx'
  delete process.env.OPENAI_API_KEY
})

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  await rm(home, { recursive: true, force: true })
})

// stdout and stderr decide colour separately: in `translate x.po | tee log`
// the summary goes down a pipe while progress is still on a terminal.
describe('per-stream colour', () => {
  it('paints stderr and stdout separately, so a piped summary carries no escape codes', async () => {
    const h = harness()
    const translate = fakeTranslate()
    const code = await h.run(['translate', file, '--draft-engine', 'deepl'], {
      translate: translate.fn, tty: true, env: { FORCE_COLOR: undefined } as NodeJS.ProcessEnv,
    })
    expect(code).toBe(0)
    expect(h.stdout.text).not.toMatch(/\x1b\[/)
    expect(h.stderr.text).toMatch(/\x1b\[/)
  })
})

describe('per-stream width', () => {
  // A pipe cannot say whether it is tee or > file, so a narrow terminal on
  // stderr does not narrow a piped summary below 80: cut to 30 columns, a
  // saved log would lose its values for good.
  it('keeps a piped summary at least 80 wide beside a narrow terminal', async () => {
    const h = harness()
    const stderr = h.stderr as Sink & { columns?: number }
    stderr.columns = 30
    const translate = fakeTranslate()
    const code = await h.run(['translate', file, '--draft-engine', 'deepl'], { translate: translate.fn, tty: true })
    expect(code).toBe(0)
    const boxLines = h.stdout.text.split('\n').filter((l) => /^[╭│╰]/.test(l))
    expect(boxLines.length).toBeGreaterThan(0)
    expect(Math.max(...boxLines.map(displayWidth))).toBeGreaterThan(30)
    for (const l of boxLines) expect(displayWidth(l)).toBeLessThanOrEqual(80)
  })
})

describe('translate summary output', () => {
  it('prints a header on stderr naming the file, locale and reviewer', async () => {
    const h = harness()
    await h.run(['translate', file, '--draft-engine', 'deepl'], { translate: fakeTranslate().fn })
    expect(h.stderr.text).toContain(`polyglots translate  ${file}`)
    expect(h.stderr.text).toMatch(/locale\s+tr/)
    expect(h.stderr.text).toMatch(/draft\s+deepl/)
    expect(h.stderr.text).toMatch(/review\s+claude/)
  })

  it('prints the contract summary line on stdout and exits 0', async () => {
    const h = harness()
    const translate = fakeTranslate()
    const code = await h.run(['translate', file], { translate: translate.fn })
    expect(code).toBe(0)
    expect(h.stdout.text).toContain('✓ Done')
    expect(h.stdout.text).toMatch(/translated\s+6/)
    expect(h.stdout.text).toMatch(/fuzzy\s+1  check before upload/)
    expect(h.stdout.text).toMatch(/from TM\s+1/)
    expect(h.stdout.text).toMatch(/skipped\s+0/)
    expect(h.stdout.text).toContain(`› Open ${file} in your .po editor to review.`)
    expect(h.stderr.text).toContain('▰▰▰▰▰▰▰▰▰▰ 7/7  batch 1/1  fuzzy 1')
  })

  it('passes flags and config defaults through to translateFile', async () => {
    await mkdir(join(home, 'config'), { recursive: true })
    await writeFile(join(home, 'config', 'config.json'), JSON.stringify({ batchSize: 4, defaultLocale: 'de' }))
    const h = harness()
    const translate = fakeTranslate()
    await h.run(['translate', file], { translate: translate.fn })
    expect(translate.calls[0]).toMatchObject({ file, locale: 'de', mode: 'pending', draftEngine: 'deepl', batchSize: 4, dryRun: false })
    expect(translate.calls[0]?.secrets?.DEEPL_API_KEY).toBe('dpl-test-key-0123456789:fx')

    translate.calls.length = 0
    process.env.OPENAI_API_KEY = 'sk-test-key-0123456789'
    await h.run(['translate', file, '--locale', 'TR', '--batch-size', '2', '--draft-engine', 'openai', '--model', 'opus'], {
      translate: translate.fn,
    })
    expect(translate.calls[0]).toMatchObject({ locale: 'tr', batchSize: 2, draftEngine: 'openai', model: 'opus' })
  })

  it('uses dry-run wording and never claims a write', async () => {
    const h = harness()
    const translate = fakeTranslate()
    const code = await h.run(['translate', file, '--dry-run'], { translate: translate.fn })
    expect(code).toBe(0)
    expect(translate.calls[0]?.dryRun).toBe(true)
    expect(h.stdout.text).toContain('• Dry run')
    expect(h.stdout.text).toMatch(/translated\s+6/)
    expect(h.stdout.text).toContain('› Nothing was written.')
    expect(h.stdout.text).not.toContain('.po editor')
  })

  // --mode all exists to translate an entry again. Without a word for it, a
  // cached draft was replayed forever and a user re-running after a bad batch
  // had no recourse short of deleting jobs.db.
  it('forwards --fresh so a cached draft can be refused', async () => {
    const h = harness()
    const translate = fakeTranslate()
    const code = await h.run(['translate', file, '--fresh'], { translate: translate.fn })
    expect(code).toBe(0)
    expect(translate.calls[0]).toMatchObject({ fresh: true })
  })

  it('processes several files in order and prints one summary per file', async () => {
    const second = join(home, 'second.po')
    await copyFile(samplePo, second)
    const h = harness()
    const translate = fakeTranslate()
    const code = await h.run(['translate', file, second], { translate: translate.fn })
    expect(code).toBe(0)
    expect(translate.calls.map((c) => c.file)).toEqual([file, second])
    const lines = h.stdout.text.trim().split('\n').filter((l) => l.startsWith('›'))
    expect(h.stdout.text.match(/✓ Done/g)).toHaveLength(2)
    expect(lines).toEqual([`› Open ${file} in your .po editor to review.`, `› Open ${second} in your .po editor to review.`])
  })

  it('reports a file that throws, continues with the next file and exits 1 at the end', async () => {
    const second = join(home, 'second.po')
    await copyFile(samplePo, second)
    const h = harness()
    const translate = fakeTranslate((_opts, call) => (call === 1 ? new Error('bad po syntax') : {}))
    const code = await h.run(['translate', file, second], { translate: translate.fn })
    expect(code).toBe(1)
    expect(translate.calls.map((c) => c.file)).toEqual([file, second])
    expect(h.stderr.text).toContain(`✗ ${file}: bad po syntax`)
    expect(h.stdout.text.match(/✓ Done/g)).toHaveLength(1)
    expect(h.stdout.text).toContain(`› Open ${second} in your .po editor to review.`)
    expect(h.stdout.text).not.toContain(`Open ${file} in your .po editor`)
  })

  it('exits 3 with a Stopped summary on a quota stop and does not touch later files', async () => {
    const second = join(home, 'second.po')
    await copyFile(samplePo, second)
    const h = harness()
    const translate = fakeTranslate(() => ({ translated: 2, fuzzy: 0, stopped: 'DeepL quota exceeded' }))
    const code = await h.run(['translate', file, second], { translate: translate.fn })
    expect(code).toBe(3)
    expect(translate.calls).toHaveLength(1)
    expect(h.stdout.text).not.toContain('✓ Done')
    expect(h.stdout.text).toContain('! Stopped')
    expect(h.stdout.text).toMatch(/translated\s+2/)
    expect(h.stdout.text).toContain('› Re-run the same command to resume.')
    expect(h.stderr.text).toContain('! Stopped: DeepL quota exceeded')
  })
})

describe('translate --all confirmation', () => {
  it('asks on a TTY, counts already-translated entries and continues on "y"', async () => {
    const h = harness()
    const translate = fakeTranslate()
    const code = await h.run(['translate', file, '--all'], { translate: translate.fn, stdin: stdinWith('y\n', true), tty: true })
    expect(code).toBe(0)
    expect(h.stderr.text).toContain('This will re-translate 5 already-translated entries. Continue? [y/N]')
    expect(translate.calls[0]?.mode).toBe('all')
  })

  it('aborts with exit 1 on "n" without calling translateFile', async () => {
    const h = harness()
    const translate = fakeTranslate()
    const code = await h.run(['translate', file, '--all'], { translate: translate.fn, stdin: stdinWith('n\n', true), tty: true })
    expect(code).toBe(1)
    expect(stripVTControlCharacters(h.stderr.text)).toContain('! Aborted.')
    expect(translate.calls).toHaveLength(0)
    expect(h.stdout.text).toBe('')
  })

  it('treats a closed prompt (Ctrl-D) as "no" instead of hanging', async () => {
    const h = harness()
    const translate = fakeTranslate()
    const code = await h.run(['translate', file, '--all'], { translate: translate.fn, stdin: stdinWith(undefined, true), tty: true })
    expect(code).toBe(1)
    expect(stripVTControlCharacters(h.stderr.text)).toContain('! Aborted.')
    expect(translate.calls).toHaveLength(0)
  })

  it('skips the prompt with --yes', async () => {
    const h = harness()
    const translate = fakeTranslate()
    const code = await h.run(['translate', file, '--all', '--yes'], { translate: translate.fn, stdin: stdinWith(undefined, true), tty: true })
    expect(code).toBe(0)
    expect(h.stderr.text).not.toContain('Continue?')
    expect(translate.calls[0]?.mode).toBe('all')
  })

  it('skips the prompt for --all --dry-run because nothing is written', async () => {
    const h = harness()
    const translate = fakeTranslate()
    const code = await h.run(['translate', file, '--all', '--dry-run'], { translate: translate.fn, stdin: stdinWith(undefined, false) })
    expect(code).toBe(0)
    expect(h.stderr.text).not.toContain('Continue?')
    expect(h.stderr.text).not.toContain('--all requires --yes')
    expect(translate.calls[0]).toMatchObject({ mode: 'all', dryRun: true })
  })

  it('requires --yes when stderr is redirected even though stdin is a TTY', async () => {
    const h = harness()
    const translate = fakeTranslate()
    const code = await h.run(['translate', file, '--all'], { translate: translate.fn, stdin: stdinWith('y\n', true), tty: false })
    expect(code).toBe(2)
    expect(h.stderr.text).toMatch(/--all requires --yes/)
    expect(h.stderr.text).not.toContain('Continue?')
    expect(translate.calls).toHaveLength(0)
  })
})

describe('glossary sync', () => {
  interface FakeSync {
    fn: CliDeps['syncGlossary'] & object
    calls: Array<{ locale: string }>
  }

  function fakeSync(outcome: { entries: number } | Error = { entries: 42 }): FakeSync {
    const calls: Array<{ locale: string }> = []
    return {
      calls,
      async fn(opts) {
        calls.push({ locale: opts.locale })
        if (outcome instanceof Error) throw outcome
        return outcome
      },
    }
  }

  it('uses the config default locale and prints the synced count', async () => {
    await mkdir(join(home, 'config'), { recursive: true })
    await writeFile(join(home, 'config', 'config.json'), JSON.stringify({ defaultLocale: 'de' }))
    const h = harness()
    const sync = fakeSync({ entries: 42 })
    const code = await h.run(['glossary', 'sync'], { syncGlossary: sync.fn })
    expect(code).toBe(0)
    expect(sync.calls).toEqual([{ locale: 'de' }])
    expect(h.stdout.text).toBe('✓ Synced 42 glossary entries for de.\n')
  })

  it('passes a normalized --locale override through', async () => {
    const h = harness()
    const sync = fakeSync({ entries: 3 })
    const code = await h.run(['glossary', 'sync', '--locale', 'PT-BR'], { syncGlossary: sync.fn })
    expect(code).toBe(0)
    expect(sync.calls).toEqual([{ locale: 'pt-br' }])
    expect(h.stdout.text).toBe('✓ Synced 3 glossary entries for pt-br.\n')
  })

  it('exits 1 with the error message when the sync throws', async () => {
    const h = harness()
    const sync = fakeSync(new Error('No glossary entries found for locale "tr"; existing cache left untouched'))
    const code = await h.run(['glossary', 'sync'], { syncGlossary: sync.fn })
    expect(code).toBe(1)
    expect(h.stderr.text).toContain('✗ No glossary entries found for locale "tr"')
    expect(h.stdout.text).toBe('')
  })
})

// Proper nouns live in the locale rules file, the list the Locale rules screen
// edits as Always capitalized. The commands write it through the same editor,
// so the person's comments and the other sections come back as they were.
async function rulesNouns(code: string): Promise<string[] | undefined> {
  const text = await readFile(join(home, 'config', 'locales', `${code}.yaml`), 'utf8')
  return (parseYaml(text) as { properNouns?: { always?: string[] } } | null)?.properNouns?.always
}

describe('config add-name', () => {
  // The name goes on the end of the list the file already has, so the
  // Turkish rules file keeps Türkiye and gains the new name after it.
  it('adds a name to the locale rules file, after the names it already lists', async () => {
    installLocaleFixture('tr_TR.yaml')
    const h = harness()
    expect(await h.run(['config', 'add-name', 'Türk Dil Kurumu'])).toBe(0)
    const always = await rulesNouns('tr_TR')
    expect(always).toContain('Türkiye')
    expect(always!.at(-1)).toBe('Türk Dil Kurumu')
    expect(h.stdout.text).toContain('Türk Dil Kurumu')
  })

  it('does not duplicate a name already present', async () => {
    await harness().run(['config', 'add-name', 'İzmir'])
    const h = harness()
    expect(await h.run(['config', 'add-name', 'İzmir'])).toBe(0)
    expect((await rulesNouns('tr_TR'))!.filter((n) => n === 'İzmir')).toHaveLength(1)
  })

  it('honours --locale and leaves the other locale alone', async () => {
    await harness().run(['config', 'add-name', 'Berlin', '--locale', 'de'])
    expect(await rulesNouns('de_DE')).toEqual(['Berlin'])
    await expect(readFile(join(home, 'config', 'locales', 'tr_TR.yaml'), 'utf8')).rejects.toThrow()
  })

  it('rejects an empty name', async () => {
    const h = harness()
    const code = await h.run(['config', 'add-name', '   '])
    expect(code).toBe(2)
  })

  it('switches the review provider from the CLI', async () => {
    const h = harness()
    expect(await h.run(['config', 'set', 'reviewProvider', 'antigravity'])).toBe(0)
    expect(h.stdout.text).toContain('reviewProvider = antigravity')

    const read = harness()
    await read.run(['config', 'get', 'reviewProvider'])
    expect(read.stdout.text.trim()).toBe('antigravity')
  })

  // The value reaches a cache key and a stats row, so a typo that silently
  // became a third provider would fragment both.
  it('refuses a provider it does not have', async () => {
    const h = harness()
    expect(await h.run(['config', 'set', 'reviewProvider', 'gemini'])).toBe(2)
    expect(h.stderr.text).toMatch(/claude, antigravity/)
  })

  it('points config get at list-names, since the names left config.json', async () => {
    const h = harness()
    expect(await h.run(['config', 'get', 'properNouns'])).toBe(2)
    expect(h.stderr.text).toContain('list-names')
  })

  it('points config set at add-name instead of taking a raw value', async () => {
    const h = harness()
    const code = await h.run(['config', 'set', 'properNouns', 'İzmir'])
    expect(code).toBe(2)
    expect(h.stderr.text).toContain('add-name')
  })
})

describe('config list-names and remove-name', () => {
  async function seed() {
    for (const name of ['Berlin', 'Deutsche Bahn', 'München']) await harness().run(['config', 'add-name', name, '--locale', 'de'])
  }
  const lines = (text: string) => stripVTControlCharacters(text).trim().split('\n').map((l) => l.trim().replace(/\s+/g, ' '))

  it('numbers the locale names in the order they were added', async () => {
    await seed()
    const h = harness()
    expect(await h.run(['config', 'list-names', '--locale', 'de'])).toBe(0)
    expect(lines(h.stdout.text)).toEqual(['Proper nouns for de:', '1 Berlin', '2 Deutsche Bahn', '3 München'])
  })

  it('lists the names the locale rules file carries', async () => {
    installLocaleFixture('tr_TR.yaml')
    const h = harness()
    expect(await h.run(['config', 'list-names'])).toBe(0)
    expect(lines(h.stdout.text)).toContain('1 Türk')
  })

  it('removes by number or by name', async () => {
    await seed()
    expect(await harness().run(['config', 'remove-name', '1', 'München', '--locale', 'de'])).toBe(0)
    expect(await rulesNouns('de_DE')).toEqual(['Deutsche Bahn'])
  })

  it('removes a name the rules file carries by writing the list without it', async () => {
    installLocaleFixture('tr_TR.yaml')
    expect(await harness().run(['config', 'remove-name', 'Türkiye'])).toBe(0)
    const always = await rulesNouns('tr_TR')
    expect(always).not.toContain('Türkiye')
    expect(always).toContain('Türkçe')
  })

  it('refuses the whole call when one item matches nothing', async () => {
    await seed()
    const h = harness()
    expect(await h.run(['config', 'remove-name', '2', 'Hamburg', '--locale', 'de'])).toBe(2)
    expect(h.stderr.text).toContain('Hamburg')
    expect(await rulesNouns('de_DE')).toHaveLength(3)
  })
})

// Names added before 0.29 sit in config.json. They move into each locale's
// rules file once, on the first command, and config.json loses the key. A
// rules file that cannot take them keeps them in config.json, where review
// still reads them, so nothing is lost on the way.
describe('moving proper nouns out of config.json', () => {
  async function legacy(properNouns: Record<string, string[]>) {
    await writeFile(join(home, 'config', 'config.json'), JSON.stringify({ defaultLocale: 'tr', properNouns }))
  }
  const configJson = async () => JSON.parse(await readFile(join(home, 'config', 'config.json'), 'utf8'))

  it('moves each locale into its rules file and says so once', async () => {
    installLocaleFixture('tr_TR.yaml')
    await legacy({ tr: ['Kadıköy'], de: ['Berlin'] })
    const h = harness()
    expect(await h.run(['config', 'list-names', '--locale', 'de'])).toBe(0)
    expect(h.stdout.text).toContain('Berlin')
    expect(await rulesNouns('de_DE')).toEqual(['Berlin'])
    const tr = await rulesNouns('tr_TR')
    expect(tr).toContain('Türkiye')
    expect(tr!.at(-1)).toBe('Kadıköy')
    expect(await configJson()).not.toHaveProperty('properNouns')
    expect(h.stderr.text).toContain('tr_TR.yaml')

    const again = harness()
    await again.run(['config', 'list-names'])
    expect(again.stderr.text).toBe('')
  })

  it('keeps a locale in config.json when its rules file is broken, and moves the rest', async () => {
    await legacy({ tr: ['Kadıköy'], de: ['Berlin'] })
    await mkdir(join(home, 'config', 'locales'), { recursive: true })
    await writeFile(join(home, 'config', 'locales', 'tr_TR.yaml'), 'rules: [not, a, map\n')
    const h = harness()
    expect(await h.run(['config', 'list-names', '--locale', 'de'])).toBe(0)
    expect(await rulesNouns('de_DE')).toEqual(['Berlin'])
    expect((await configJson()).properNouns).toEqual({ tr: ['Kadıköy'] })
    expect(h.stderr.text).toContain('tr_TR.yaml')
  })
})

describe('split', () => {
  const summary = (over: Record<string, unknown> = {}) => ({
    file: '/tmp/plugin-tr.po',
    dir: '/tmp/plugin-tr-split',
    entries: 9326,
    size: 1000,
    parts: Array.from({ length: 10 }, (_, i) => ({ file: `/tmp/plugin-tr-split/plugin-tr-${i + 1}.po`, entries: i === 9 ? 326 : 1000 })),
    leftBehind: [],
    ...over,
  })

  it('reports the shape of the split, including the short last part', async () => {
    const h = harness()
    const splitPo = vi.fn(async () => summary())
    expect(await h.run(['split', file, '--size', '1000'], { splitPo })).toBe(0)
    expect(h.stdout.text).toContain('9326 entries into 10 parts of 1000, last 326.')
    expect(h.stdout.text).toContain('/tmp/plugin-tr-split')
  })

  // Nothing to add when the file divides exactly; saying "last 1000" would read
  // as though the tail were special.
  it('says nothing about a tail that is a full part', async () => {
    const h = harness()
    const splitPo = vi.fn(async () =>
      summary({ entries: 2000, parts: [{ file: 'a', entries: 1000 }, { file: 'b', entries: 1000 }] }),
    )
    await h.run(['split', file, '--size', '1000'], { splitPo })
    expect(h.stdout.text).toContain('2000 entries into 2 parts of 1000.')
    expect(h.stdout.text).not.toMatch(/last/)
  })

  it('passes the size and force through', async () => {
    const h = harness()
    const calls: unknown[] = []
    const splitPo = vi.fn(async (opts: unknown) => {
      calls.push(opts)
      return summary()
    })
    await h.run(['split', file, '--size', '250', '--force'], { splitPo })
    expect(calls).toEqual([{ file, size: 250, force: true }])
  })

  // A leftover from an earlier, finer split looks exactly like work waiting to
  // be submitted, so it is named rather than deleted.
  it('names files it left alone', async () => {
    const h = harness()
    const splitPo = vi.fn(async () => summary({ leftBehind: ['plugin-tr-19.po'] }))
    await h.run(['split', file, '--size', '1000'], { splitPo })
    expect(h.stderr.text).toContain('plugin-tr-19.po')
  })

  it('requires a size rather than inventing one', async () => {
    const h = harness()
    const splitPo = vi.fn()
    expect(await h.run(['split', file], { splitPo })).toBe(2)
    expect(splitPo).not.toHaveBeenCalled()
  })

  it('refuses a size that is not a positive integer', async () => {
    const h = harness()
    const splitPo = vi.fn()
    expect(await h.run(['split', file, '--size', '0'], { splitPo })).toBe(2)
    expect(splitPo).not.toHaveBeenCalled()
  })
})

describe('review', () => {
  interface FakeReview {
    fn: CliDeps['reviewFile'] & object
    calls: Array<{ file: string; locale: string; outDir?: string; noAi?: boolean; batchSize?: number; fresh?: boolean }>
  }

  function summary(overrides = {}) {
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
      byRule: { placeholder: 3, 'title-case': 11 },
      byGroup: { 'title-case': 8, other: 3 },
      problemsFile: '/tmp/plugin-tr-problems.po',
      ...overrides,
    }
  }

  function fakeReview(outcome: ReturnType<typeof summary> | Error = summary()): FakeReview {
    const calls: FakeReview['calls'] = []
    return {
      calls,
      async fn(opts) {
        calls.push({
          file: opts.file,
          locale: opts.locale,
          outDir: opts.outDir,
          noAi: opts.noAi,
          batchSize: opts.batchSize,
          fresh: opts.fresh,
        })
        if (outcome instanceof Error) throw outcome
        return outcome
      },
    }
  }

  it('reviews the file and reports counts and both paths', async () => {
    const h = harness()
    const review = fakeReview()
    const code = await h.run(['review', file], { reviewFile: review.fn })

    expect(code).toBe(0)
    expect(review.calls).toEqual([
      { file, locale: 'tr', outDir: undefined, noAi: undefined, batchSize: 25, fresh: undefined },
    ])
    expect(h.stdout.text).toMatch(/flagged\s+14/)
    expect(h.stdout.text).toMatch(/approvable\s+102/)
    expect(h.stdout.text).toContain('/tmp/plugin-tr-problems.po')
    expect(h.stdout.text).not.toContain('report')
  })

  it('prints a header on stderr naming the file, locale and reviewer', async () => {
    const h = harness()
    await h.run(['review', file, '--no-ai'], { reviewFile: fakeReview(summary({})).fn })
    expect(h.stderr.text).toContain(`polyglots review  ${file}`)
    expect(h.stderr.text).toMatch(/locale\s+tr/)
    expect(h.stderr.text).toMatch(/review\s+rules only/)
  })

  it('counts undecided entries as flagged, since they are written to the file too', async () => {
    const h = harness()
    const review = fakeReview(summary({ problems: 0, needsReview: 5, approvable: 0 }))
    await h.run(['review', file, '--no-ai'], { reviewFile: review.fn })

    expect(h.stdout.text).toMatch(/flagged\s+5/)
    expect(h.stdout.text).not.toMatch(/flagged\s+0/)
  })

  it('reports the needs-your-eye count from a rules-only run', async () => {
    const h = harness()
    const review = fakeReview(summary({ problems: 3, needsReview: 11, approvable: 102 }))
    const code = await h.run(['review', file, '--no-ai'], { reviewFile: review.fn })

    expect(code).toBe(0)
    expect(h.stdout.text).toMatch(/guesses\s+11  re-run without --no-ai to decide them/)
  })

  it('says so when nothing was flagged and names no po file', async () => {
    const h = harness()
    const review = fakeReview(summary({ problems: 0, approvable: 116, problemsFile: undefined, byRule: {} }))
    const code = await h.run(['review', file], { reviewFile: review.fn })

    expect(code).toBe(0)
    expect(h.stdout.text).toMatch(/nothing flagged/i)
    expect(h.stdout.text).not.toContain('-problems.po')
  })

  it('forwards --locale, --out-dir, --no-ai and --batch-size', async () => {
    const h = harness()
    const review = fakeReview()
    const code = await h.run(
      ['review', file, '--locale', 'PT-BR', '--out-dir', '/tmp/out', '--no-ai', '--batch-size', '10'],
      { reviewFile: review.fn },
    )

    expect(code).toBe(0)
    expect(review.calls).toEqual([
      { file, locale: 'pt-br', outDir: '/tmp/out', noAi: true, batchSize: 10, fresh: undefined },
    ])
  })

  // translate has always taken its default from config; review quietly used a
  // hard-coded 25, so setting a project default only half worked.
  it('takes the batch size from the config when no flag is given', async () => {
    await mkdir(join(home, 'config'), { recursive: true })
    await writeFile(join(home, 'config', 'config.json'), JSON.stringify({ batchSize: 50 }))
    const h = harness()
    const review = fakeReview()
    await h.run(['review', file], { reviewFile: review.fn })

    expect(review.calls[0]).toMatchObject({ batchSize: 50 })
  })

  // A run that stops on an exhausted quota must say so. Silently printing a
  // smaller "approvable" than the file contains would read as a finished review.
  it('says it stopped early and how much is left', async () => {
    const h = harness()
    const review = fakeReview(summary({ problems: 12, approvable: 40, pending: 2850, written: 12 }))
    await h.run(['review', file], { reviewFile: review.fn })

    expect(h.stdout.text).toMatch(/stopped early/i)
    expect(h.stdout.text).toMatch(/not reached\s+2850/)
    // Both: the file holds what was found so far, and the rest needs a re-run.
    expect(h.stdout.text).toContain('› Wrote ')
    expect(h.stdout.text).toContain('› Re-run the same command to carry on.')
  })

  // It used to print both, which reads as a finished review that found nothing.
  it('does not call a stopped submission approvable', async () => {
    const h = harness()
    const review = fakeReview(summary({ problems: 0, approvable: 0, pending: 6, written: 0, problemsFile: undefined, byRule: {} }))
    await h.run(['review', file], { reviewFile: review.fn })

    expect(h.stdout.text).toMatch(/stopped early/i)
    expect(h.stdout.text).not.toMatch(/looks approvable/i)
  })

  it('says nothing about stopping when the run reached the end', async () => {
    const h = harness()
    const review = fakeReview(summary({ pending: 0 }))
    await h.run(['review', file], { reviewFile: review.fn })

    expect(h.stdout.text).not.toMatch(/stopped early/i)
  })

  // An interrupted review picks up from its marker by default, so starting over
  // needs a word for it.
  it('forwards --fresh so a resume can be refused', async () => {
    const h = harness()
    const review = fakeReview()
    const code = await h.run(['review', file, '--fresh'], { reviewFile: review.fn })

    expect(code).toBe(0)
    expect(review.calls[0]).toMatchObject({ fresh: true })
  })

  it('exits 2 when the file does not exist', async () => {
    const h = harness()
    const review = fakeReview()
    const code = await h.run(['review', join(home, 'nope.po')], { reviewFile: review.fn })

    expect(code).toBe(2)
    expect(review.calls).toEqual([])
  })

  it('exits 1 with the message when the review throws', async () => {
    const h = harness()
    const review = fakeReview(new Error('No cached glossary for locale "tr"; run: polyglots glossary sync'))
    const code = await h.run(['review', file], { reviewFile: review.fn })

    expect(code).toBe(1)
    expect(h.stderr.text).toContain('No cached glossary')
  })

  it('mentions unreviewed entries when some could not be checked', async () => {
    const h = harness()
    const review = fakeReview(summary({ unreviewed: 7 }))
    await h.run(['review', file], { reviewFile: review.fn })
    expect(h.stdout.text).toMatch(/unreviewed\s+7  could not be reviewed; flagged/)
  })

  it('says how much of the work it already did', async () => {
    const h = harness()
    const review = fakeReview(
      summary({ problems: 412, needsReview: 0, approvable: 2393, repaired: 380, written: 412 }),
    )
    await h.run(['review', file], { reviewFile: review.fn })

    expect(h.stdout.text).toMatch(/repaired\s+380  32 left for you/)
  })

  // Whitespace-only fixes are written but count as neither a problem nor a
  // needsReview entry, so flagged (problems + needsReview) undercounts what
  // was written. Subtracting repaired from flagged instead of written would
  // print a negative "left for you" here.
  it('never goes negative when everything written was a mechanical fix', async () => {
    const h = harness()
    const review = fakeReview(summary({ problems: 0, needsReview: 0, approvable: 10, repaired: 10, written: 10 }))
    await h.run(['review', file], { reviewFile: review.fn })

    expect(h.stdout.text).toMatch(/repaired\s+10  0 left for you/)
    expect(h.stdout.text).not.toMatch(/-\d+ left for you/)
  })

  it('prints the message to post back to the requester', async () => {
    const h = harness()
    const review = fakeReview(
      summary({ repaired: 37, byGroup: { glossary: 24, meaning: 11, 'title-case': 6, other: 5 } }),
    )
    await h.run(['review', file], { reviewFile: review.fn })

    expect(h.stdout.text).toContain('Message for the requester:')
    expect(h.stdout.text).toContain(
      'I fixed 37 entries, which you can see <a href="">here</a>. They included ~25 glossary inconsistencies, ' +
        '~10 meaning and fluency problems and ~5 title-case issues, plus a few smaller ones.',
    )
  })

  // Nothing repaired is nothing to report, and printing a headline with no
  // sentence under it would read as output that went missing.
  it('prints no requester message when nothing was repaired', async () => {
    const h = harness()
    const review = fakeReview(summary({ repaired: 0, byGroup: {} }))
    await h.run(['review', file], { reviewFile: review.fn })

    expect(h.stdout.text).not.toContain('Message for the requester')
  })

  it('says nothing about repairs when there were none', async () => {
    const h = harness()
    const review = fakeReview(
      summary({ problems: 0, approvable: 116, repaired: 0, problemsFile: undefined, byRule: {} }),
    )
    await h.run(['review', file], { reviewFile: review.fn })
    expect(h.stdout.text).not.toContain('repaired')
  })
})

describe('glossary export', () => {
  interface FakeExport {
    fn: CliDeps['exportGlossary'] & object
    calls: Array<{ locale: string; file?: string; delimiter?: string }>
  }

  function fakeExport(outcome: { entries: number; csv: string; file?: string } | Error): FakeExport {
    const calls: Array<{ locale: string; file?: string; delimiter?: string }> = []
    return {
      calls,
      async fn(opts) {
        calls.push({ locale: opts.locale, file: opts.file, delimiter: opts.delimiter })
        if (outcome instanceof Error) throw outcome
        return outcome
      },
    }
  }

  it('writes to the given path and reports the count', async () => {
    const h = harness()
    const exp = fakeExport({ entries: 511, csv: 'x', file: '/tmp/g.csv' })
    const code = await h.run(['glossary', 'export', '/tmp/g.csv'], { exportGlossary: exp.fn })
    expect(code).toBe(0)
    expect(exp.calls).toEqual([{ locale: 'tr', file: '/tmp/g.csv', delimiter: ';' }])
    expect(h.stdout.text).toBe('✓ Exported 511 glossary terms (tr) to /tmp/g.csv\n')
  })

  it('prints the csv to stdout when no path is given', async () => {
    const h = harness()
    const exp = fakeExport({ entries: 2, csv: 'Term;Translation;Notes\na;b;c\n' })
    const code = await h.run(['glossary', 'export'], { exportGlossary: exp.fn })
    expect(code).toBe(0)
    expect(exp.calls).toEqual([{ locale: 'tr', file: undefined, delimiter: ';' }])
    expect(h.stdout.text).toBe('Term;Translation;Notes\na;b;c\n')
  })

  it('forwards --locale and --delimiter', async () => {
    const h = harness()
    const exp = fakeExport({ entries: 1, csv: 'x', file: 'g.csv' })
    const code = await h.run(['glossary', 'export', 'g.csv', '--locale', 'PT-BR', '--delimiter', ','], {
      exportGlossary: exp.fn,
    })
    expect(code).toBe(0)
    expect(exp.calls).toEqual([{ locale: 'pt-br', file: 'g.csv', delimiter: ',' }])
  })

  it('rejects a delimiter that is not a comma or semicolon', async () => {
    const h = harness()
    const exp = fakeExport({ entries: 1, csv: 'x' })
    const code = await h.run(['glossary', 'export', '--delimiter', '|'], { exportGlossary: exp.fn })
    expect(code).toBe(2)
    expect(exp.calls).toEqual([])
    expect(h.stderr.text).toContain('delimiter')
  })

  it('exits 1 with the message when nothing is cached for the locale', async () => {
    const h = harness()
    const exp = fakeExport(new Error('No cached glossary for locale "de"; run: polyglots glossary sync --locale de'))
    const code = await h.run(['glossary', 'export', '--locale', 'de'], { exportGlossary: exp.fn })
    expect(code).toBe(1)
    expect(h.stderr.text).toContain('No cached glossary for locale "de"')
    expect(h.stdout.text).toBe('')
  })
})

describe('tm import', () => {
  it('forwards --project and the config default locale to the importer', async () => {
    await mkdir(join(home, 'config'), { recursive: true })
    await writeFile(join(home, 'config', 'config.json'), JSON.stringify({ defaultLocale: 'de' }))
    const h = harness()
    const calls: Array<{ files: string[]; locale: string; project?: string }> = []
    const importTmx: CliDeps['importTmx'] = async (files, opts) => {
      calls.push({ files, locale: opts.locale, project: opts.project })
      opts.onProgress?.({ file: files[0] ?? '', entries: 5, upserted: 4 })
      return { files: files.length, entries: 5, upserted: 4 }
    }
    const code = await h.run(['tm', 'import', file, '--project', 'woocommerce'], { importTmx })
    expect(code).toBe(0)
    expect(calls).toEqual([{ files: [file], locale: 'de', project: 'woocommerce' }])
    expect(h.stderr.text).toContain(`${file}: 5 entries, 4 upserted`)
    expect(h.stdout.text).toBe('✓ Imported 1 file(s): 5 entries, 4 upserted (locale de).\n')
  })
})

describe('no arguments', () => {
  it('dispatches to runTui and exits 0 when it resolves', async () => {
    const h = harness()
    let calls = 0
    const code = await h.run([], {
      runTui: async () => {
        calls += 1
      },
    })
    expect(code).toBe(0)
    expect(calls).toBe(1)
    expect(h.stdout.text).toBe('')
  })

  it('exits 1 with the message when runTui rejects', async () => {
    const h = harness()
    const code = await h.run([], {
      runTui: async () => {
        throw new Error('The interactive menu needs a terminal; run a subcommand instead (see polyglots --help).')
      },
    })
    expect(code).toBe(1)
    expect(h.stderr.text).toContain('needs a terminal')
  })
})

describe('--version', () => {
  it('prints the package.json version', async () => {
    const h = harness()
    const code = await h.run(['--version'])
    expect(code).toBe(0)
    expect(h.stdout.text.trim()).toBe(pkg.version)
  })
})

describe('environment help', () => {
  // The two variables a run reads that change what leaves it: where debug
  // files are kept, and where a problem report is sent.
  // Fetch runs the same reviews and translates and reads both, so its help
  // names them too.
  it('names POLYGLOTS_DEBUG and POLYGLOTS_REPORTS_URL under review, translate and fetch', async () => {
    for (const command of ['review', 'translate', 'fetch']) {
      const h = harness()
      expect(await h.run([command, '--help'])).toBe(0)
      const text = h.stdout.text.replace(/\s+/g, ' ')
      // Fetch has no --debug flag, so the line says what it does instead of
      // pointing at a flag one of the three commands lacks.
      expect(text).toContain("POLYGLOTS_DEBUG=1 save each batch's prompt and agent output beside the run log, for every review, translate and fetch run")
      expect(text).not.toContain('what --debug does')
      expect(text).toContain('POLYGLOTS_REPORTS_URL where problem reports go (default: https://ada.tools/polyglots/api/reports)')
    }
  })
})

describe('translate fail-fast on a missing engine key', () => {
  it('exits 1 before prompting or calling translateFile', async () => {
    delete process.env.DEEPL_API_KEY
    const h = harness()
    const translate = fakeTranslate()
    const code = await h.run(['translate', file, '--all'], { translate: translate.fn, stdin: stdinWith('y\n', true), tty: true })
    expect(code).toBe(1)
    expect(translate.calls).toHaveLength(0)
    expect(h.stderr.text).toMatch(/DEEPL_API_KEY/)
    expect(h.stderr.text).toContain('config set-key DEEPL_API_KEY')
    expect(h.stderr.text).not.toContain('Continue?')
    expect(h.stdout.text).toBe('')
  })

  it('names the key of the selected engine', async () => {
    const h = harness()
    const translate = fakeTranslate()
    const code = await h.run(['translate', file, '--draft-engine', 'openai'], { translate: translate.fn })
    expect(code).toBe(1)
    expect(h.stderr.text).toMatch(/OPENAI_API_KEY/)
    expect(translate.calls).toHaveLength(0)
  })
})

describe('translate error output on a TTY', () => {
  it('clears the live progress line before printing the error', async () => {
    const h = harness()
    const translate = fakeTranslate(() => new Error('boom'))
    const code = await h.run(['translate', file], { translate: translate.fn, tty: true })
    expect(code).toBe(1)
    expect(h.stderr.text).toMatch(new RegExp(`\\r\\x1b\\[2K\\x1b\\[31m✗\\x1b\\[39m ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: boom\\n$`))
    expect(h.stderr.text).not.toMatch(/0\/7Error/)
  })
})

describe('corrupt config file', () => {
  beforeEach(async () => {
    await mkdir(join(home, 'config'), { recursive: true })
    await writeFile(join(home, 'config', 'config.json'), '{ not json')
  })

  it('still shows help and exits 0', async () => {
    const h = harness()
    const code = await h.run(['--help'])
    expect(code).toBe(0)
    expect(h.stdout.text).toMatch(/^\s+translate\b/m)
    const sub = harness()
    expect(await sub.run(['translate', '--help'])).toBe(0)
    // The defaults stand in for the unreadable file, and they name no locale.
    expect(sub.stdout.text.replace(/\s+/g, ' ')).toContain("default: defaultLocale, else the file's Language header")
    expect(sub.stdout.text).toContain('POLYGLOTS_AGENT_BIN')
    expect(sub.stdout.text).toContain('POLYGLOTS_CLAUDE_BIN')
  })

  it('fails a translate run with the config error instead of silently using defaults', async () => {
    const h = harness()
    const translate = fakeTranslate()
    const code = await h.run(['translate', file], { translate: translate.fn })
    expect(code).toBe(1)
    expect(h.stderr.text).toMatch(/Invalid JSON in config file/)
    expect(translate.calls).toHaveLength(0)
  })
})

describe('config set-key prompt', () => {
  it('reports a cancelled hidden prompt (Ctrl-C) with exit 1 instead of hanging', async () => {
    const h = harness()
    const code = await h.run(['config', 'set-key', 'DEEPL_API_KEY'], { stdin: stdinWith('\x03', true) })
    expect(code).toBe(1)
    expect(h.stderr.text).toContain('! Cancelled.')
    expect(h.stdout.text).toBe('')
  })

  it('treats a closed hidden prompt as cancelled', async () => {
    const h = harness()
    const code = await h.run(['config', 'set-key', 'DEEPL_API_KEY'], { stdin: stdinWith(undefined, true) })
    expect(code).toBe(1)
    expect(h.stderr.text).toContain('! Cancelled.')
  })

  it('reads a piped value without echoing it', async () => {
    const h = harness()
    const key = 'dpl-PIPED-0123456789:fx'
    const code = await h.run(['config', 'set-key', 'DEEPL_API_KEY'], { stdin: stdinWith(`${key}\n`, false) })
    expect(code).toBe(0)
    expect(h.stdout.text + h.stderr.text).not.toContain(key)
    expect(h.stdout.text).toContain('dpl-…fx')
  })
})

describe('usage errors through injected streams', () => {
  it('routes commander errors to the injected stderr with exit 2', async () => {
    const h = harness()
    const code = await h.run(['translate', file, '--bogus'])
    expect(code).toBe(2)
    expect(h.stderr.text).toMatch(/unknown option/i)
    expect(h.stdout.text).toBe('')
  })
})

describe('doctor', () => {
  function agent(provider: AgentStatus['provider'], patch: Partial<AgentStatus> = {}): AgentStatus {
    const bin = provider === 'claude' ? 'claude' : 'agy'
    return {
      provider,
      bin,
      binSource: 'default',
      path: `/opt/bin/${bin}`,
      version: '2.1.292',
      auth: { state: 'signed-in', ...(provider === 'claude' ? { detail: 'claude.ai' } : {}) },
      setup: { state: 'ok' },
      usable: true,
      notes: [],
      ...patch,
    }
  }

  // Never the real discovery: what is installed on the machine running the
  // suite must not decide whether it passes.
  function fakeDiscover(statuses: AgentStatus[] | ((opts: DiscoverOptions) => AgentStatus[])) {
    const calls: DiscoverOptions[] = []
    const fn = async (opts: DiscoverOptions = {}) => {
      calls.push(opts)
      return typeof statuses === 'function' ? statuses(opts) : statuses
    }
    return { fn, calls }
  }

  const agyMissing = agent('antigravity', { usable: false, reason: 'agy not on PATH', auth: { state: 'unknown' } })
  delete agyMissing.path
  delete agyMissing.version

  it('prints one line per provider and the configured one, and exits 0 when it is usable', async () => {
    const h = harness()
    const discover = fakeDiscover([agent('claude'), agyMissing])
    const code = await h.run(['doctor'], { discoverAgents: discover.fn })
    expect(code).toBe(0)
    const lines = h.stdout.text.trim().split('\n')
    expect(lines.find((l) => l.startsWith('claude'))).toMatch(/ready\s+\/opt\/bin\/claude\s+2\.1\.292\s+signed in \(claude\.ai\)/)
    expect(lines.find((l) => l.startsWith('antigravity'))).toMatch(/unavailable\s+agy not on PATH/)
    expect(h.stdout.text).toContain('Review provider: claude (ready)')
    expect(discover.calls).toEqual([{ refresh: true, account: true }])
  })

  it('exits 1 when the configured provider is unusable', async () => {
    const h = harness()
    expect(await h.run(['config', 'set', 'reviewProvider', 'antigravity'])).toBe(0)
    const d = harness()
    const code = await d.run(['doctor'], { discoverAgents: fakeDiscover([agent('claude'), agyMissing]).fn })
    expect(code).toBe(1)
    expect(d.stdout.text).toContain('Review provider: antigravity (unavailable: agy not on PATH)')
  })

  it('ends with a status line for the configured provider', async () => {
    const h = harness()
    await h.run(['doctor'], { discoverAgents: fakeDiscover([agent('claude'), agyMissing]).fn })
    expect(h.stdout.text).toMatch(/^✓ Review provider: claude \(ready\)$/m)
  })

  it('marks an unavailable configured provider with a cross', async () => {
    const h = harness()
    const missingClaude = agent('claude', { usable: false, reason: 'not on PATH' })
    await h.run(['doctor'], { discoverAgents: fakeDiscover([missingClaude]).fn })
    expect(h.stdout.text).toMatch(/^✗ Review provider: claude \(unavailable: not on PATH\)$/m)
  })

  it('keeps --json raw even when colour is forced', async () => {
    const h = harness()
    await h.run(['doctor', '--json'], { discoverAgents: fakeDiscover([agent('claude')]).fn, env: { FORCE_COLOR: '1' } })
    expect(() => JSON.parse(h.stdout.text)).not.toThrow()
    expect(h.stdout.text).not.toMatch(/\x1b\[/)
  })

  it('colours the status column when colour is on, without moving the columns', async () => {
    const plain = harness()
    await plain.run(['doctor'], { discoverAgents: fakeDiscover([agent('claude'), agyMissing]).fn })
    const painted = harness()
    await painted.run(['doctor'], { discoverAgents: fakeDiscover([agent('claude'), agyMissing]).fn, env: { FORCE_COLOR: '1' } })
    expect(painted.stdout.text).toMatch(/\x1b\[/)
    expect(stripVTControlCharacters(painted.stdout.text)).toBe(plain.stdout.text)
  })

  it('prints notes beneath their provider', async () => {
    const h = harness()
    const statuses = [agent('claude'), agent('antigravity', { auth: { state: 'unknown' }, notes: ['sign-in unknown: no token file'] })]
    await h.run(['doctor'], { discoverAgents: fakeDiscover(statuses).fn })
    expect(h.stdout.text).toMatch(/antigravity[^\n]*\n\s+note: sign-in unknown: no token file/)
  })

  it('prints parseable JSON with --json', async () => {
    const h = harness()
    const code = await h.run(['doctor', '--json'], { discoverAgents: fakeDiscover([agent('claude'), agyMissing]).fn })
    expect(code).toBe(0)
    const parsed = JSON.parse(h.stdout.text) as { configured: string; agents: AgentStatus[] }
    expect(parsed.configured).toBe('claude')
    expect(parsed.agents.map((a) => a.provider)).toEqual(['claude', 'antigravity'])
    expect(parsed.agents[1]!.reason).toBe('agy not on PATH')
  })

  it('warns on stderr before --live and passes live through', async () => {
    const h = harness()
    const discover = fakeDiscover((opts) => [
      agent('claude', opts.live ? { live: { ok: true, ms: 4200 } } : {}),
      agyMissing,
    ])
    const code = await h.run(['doctor', '--live'], { discoverAgents: discover.fn })
    expect(code).toBe(0)
    expect(h.stderr.text).toContain('Sends one prompt to each usable agent; this spends a request on metered plans.')
    expect(discover.calls).toEqual([{ refresh: true, account: true, live: true }])
    expect(h.stdout.text).toMatch(/claude[^\n]*live ok 4\.2s/)
  })

  it('shows antigravity signed in, with each quota line beneath it', async () => {
    const h = harness()
    const quota = {
      ms: 3000,
      lines: [
        { group: 'Gemini Models', limit: 'Gemini Weekly Limit', remaining: 90, resetsAt: '2026-10-24T17:13:13Z' },
        { group: 'Claude and GPT models', limit: 'Claude Weekly Limit', remaining: 4, resetsAt: '2026-10-21T08:00:00Z' },
      ],
    }
    await h.run(['doctor'], { discoverAgents: fakeDiscover([agent('claude'), agent('antigravity', { quota })]).fn })
    expect(h.stdout.text).toMatch(/antigravity[^\n]*signed in/)
    expect(h.stdout.text).toMatch(/antigravity[^\n]*\n\s+quota: Gemini Models 90% left \(Gemini Weekly Limit, resets 2026-10-24T17:13:13Z\)\n\s+quota: Claude and GPT models 4% left/)
  })

  it('says how to sign in when antigravity is signed out', async () => {
    const h = harness()
    expect(await h.run(['config', 'set', 'reviewProvider', 'antigravity'])).toBe(0)
    const out = agent('antigravity', {
      auth: { state: 'signed-out', detail: 'is signed out: run agy once to sign in' },
      usable: false,
      reason: 'antigravity is signed out: run agy once to sign in',
    })
    const d = harness()
    const code = await d.run(['doctor'], { discoverAgents: fakeDiscover([agent('claude'), out]).fn })
    expect(code).toBe(1)
    expect(d.stdout.text).toContain('Review provider: antigravity (unavailable: antigravity is signed out: run agy once to sign in)')
  })

  it('exits 1 with --live when the configured provider fails its prompt', async () => {
    const h = harness()
    const discover = fakeDiscover([agent('claude', { live: { ok: false, ms: 300, error: 'claude reported an error: quota' } }), agyMissing])
    const code = await h.run(['doctor', '--live'], { discoverAgents: discover.fn })
    expect(code).toBe(1)
    expect(h.stdout.text).toContain('live failed: claude reported an error: quota')
  })
})

describe('which agent binary a run is given', () => {
  async function binSeen(env: Record<string, string>): Promise<string | undefined> {
    const setup = harness()
    expect(await setup.run(['config', 'set', 'reviewProvider', 'antigravity'])).toBe(0)
    Object.assign(process.env, env)
    let bin: string | undefined = 'never called'
    const h = harness()
    await h.run(['review', file, '--no-ai'], {
      reviewFile: async (opts) => {
        bin = opts.bin
        return {
          file, locale: 'tr', total: 1, skipped: 0, reviewed: 1, problems: 0, needsReview: 0, approvable: 1,
          unreviewed: 0, repaired: 0, written: 0, pending: 0, byRule: {}, byGroup: {},
        }
      },
    })
    return bin
  }

  beforeEach(() => {
    delete process.env.POLYGLOTS_AGENT_BIN
    delete process.env.POLYGLOTS_CLAUDE_BIN
  })

  // It used to win for antigravity too, and drove the claude binary with
  // antigravity's argv.
  it('does not hand POLYGLOTS_CLAUDE_BIN to an antigravity review', async () => {
    expect(await binSeen({ POLYGLOTS_CLAUDE_BIN: '/x/claude' })).toBeUndefined()
  })

  it('hands POLYGLOTS_AGENT_BIN to an antigravity review', async () => {
    expect(await binSeen({ POLYGLOTS_AGENT_BIN: '/x/agent' })).toBe('/x/agent')
  })
})

describe('local models', () => {
  const ollama: ModelServer = {
    target: { baseUrl: 'http://localhost:11434', kind: 'ollama', label: 'Ollama', source: 'default' },
    state: 'up',
    kind: 'ollama',
    selectable: true,
    models: [
      { name: `${DEFAULT_QWEN_MODEL}`, model: `${DEFAULT_QWEN_MODEL}`, size: 17_200_000_000, parameterSize: '27B', quantization: 'Q4_K_M' },
      { name: 'llama3.2:latest', model: 'llama3.2:latest', size: 2_019_393_189, parameterSize: '3.2B', quantization: 'Q4_K_M' },
    ],
  }
  const lmStudio: ModelServer = {
    target: { baseUrl: 'http://localhost:1234', kind: 'openai-compatible', label: 'LM Studio', source: 'default' },
    state: 'up',
    kind: 'openai-compatible',
    selectable: true,
    models: [{ name: 'qwen2.5-7b-instruct' }],
  }
  const llamaCpp: ModelServer = {
    target: { baseUrl: 'http://localhost:8080', kind: 'openai-compatible', label: 'llama.cpp server', source: 'default' },
    state: 'down',
    error: 'not running',
    selectable: false,
    models: [],
  }
  const down = (s: ModelServer): ModelServer => ({ target: s.target, state: 'down', error: 'not running', selectable: false, models: [] })
  const installed: ModelCheck = { state: 'installed', model: `${DEFAULT_QWEN_MODEL}`, baseUrl: 'http://localhost:11434' }
  const missing = (model: string): ModelCheck => ({
    state: 'missing',
    model,
    baseUrl: 'http://localhost:11434',
    message: `${model} is not installed in Ollama at http://localhost:11434. Pull it with: ollama pull ${model}`,
  })

  // Never the real discovery: what happens to be listening on the machine
  // running the suite must not decide whether it passes, and no test may
  // send a request to a real local server.
  function fakeModels(servers: ModelServer[]) {
    const calls: DiscoverModelsOptions[] = []
    const fn = async (opts: DiscoverModelsOptions = {}) => {
      calls.push(opts)
      return servers
    }
    return { fn, calls }
  }

  function fakeCheck(result: ModelCheck | Error) {
    const calls: Array<{ kind?: string; baseUrl: string; model: string }> = []
    const fn = async (o: { kind?: 'ollama' | 'openai-compatible'; baseUrl: string; model: string }) => {
      calls.push(o)
      if (result instanceof Error) throw result
      return result
    }
    return { fn, calls }
  }

  async function useQwen(): Promise<void> {
    await mkdir(join(home, 'config'), { recursive: true })
    await writeFile(join(home, 'config', 'config.json'), JSON.stringify({ defaultDraftEngine: 'qwen' }))
  }

  describe('models', () => {
    it('prints each server, its models and the draft model line', async () => {
      const h = harness()
      const discover = fakeModels([ollama, lmStudio, llamaCpp])
      const code = await h.run(['models'], { discoverModels: discover.fn, checkLocalModel: fakeCheck(installed).fn })
      expect(code).toBe(0)
      const out = h.stdout.text
      expect(out).toMatch(/Ollama\s+http:\/\/localhost:11434\s+2 models/)
      expect(out).toMatch(new RegExp(String.raw`${MODEL_RE}\s+17\.2 GB\s+27B\s+Q4_K_M\s+\(configured\)`))
      expect(out).toMatch(/llama3\.2:latest\s+2\.0 GB\s+3\.2B\s+Q4_K_M/)
      // Selectable since #5, so no longer marked as listing only.
      expect(out).toMatch(/LM Studio\s+http:\/\/localhost:1234\s+1 model\n/)
      expect(out).not.toContain('listing only')
      expect(out).toContain('qwen2.5-7b-instruct')
      expect(out).toContain('Not running: llama.cpp server (http://localhost:8080)')
      expect(out).toContain(`Local model: ${DEFAULT_QWEN_MODEL} (Ollama, installed)`)
      expect(discover.calls[0]).toMatchObject({ refresh: true })
    })

    it('marks the local model line by whether it is installed', async () => {
      const ok = harness()
      await ok.run(['models'], { discoverModels: fakeModels([ollama]).fn, checkLocalModel: fakeCheck(installed).fn })
      expect(ok.stdout.text).toMatch(new RegExp(String.raw`^✓ Local model: ${MODEL_RE} \(Ollama, installed\)$`, 'm'))
      const gone = harness()
      await gone.run(['models'], { discoverModels: fakeModels([ollama]).fn, checkLocalModel: fakeCheck(missing('qwen3.8:9b')).fn })
      expect(gone.stdout.text).toMatch(/^! Local model: qwen3\.8:9b \(Ollama, not installed\)$/m)
    })

    it('keeps --json raw even when colour is forced', async () => {
      const h = harness()
      await h.run(['models', '--json'], { discoverModels: fakeModels([ollama]).fn, checkLocalModel: fakeCheck(installed).fn, env: { FORCE_COLOR: '1' } })
      expect(() => JSON.parse(h.stdout.text)).not.toThrow()
      expect(h.stdout.text).not.toMatch(/\x1b\[/)
    })

    it('reads the same with colour on, once the codes are stripped', async () => {
      const plain = harness()
      await plain.run(['models'], { discoverModels: fakeModels([ollama, lmStudio, llamaCpp]).fn, checkLocalModel: fakeCheck(installed).fn })
      const painted = harness()
      await painted.run(['models'], { discoverModels: fakeModels([ollama, lmStudio, llamaCpp]).fn, checkLocalModel: fakeCheck(installed).fn, env: { FORCE_COLOR: '1' } })
      expect(painted.stdout.text).toMatch(/\x1b\[/)
      expect(stripVTControlCharacters(painted.stdout.text)).toBe(plain.stdout.text)
    })

    it('names the pull command when the draft model is not installed', async () => {
      const h = harness()
      await h.run(['models'], { discoverModels: fakeModels([ollama]).fn, checkLocalModel: fakeCheck(missing('qwen3.8:9b')).fn })
      expect(h.stdout.text).toContain('Local model: qwen3.8:9b (Ollama, not installed)')
      expect(h.stdout.text).toContain('Pull it with: ollama pull qwen3.8:9b')
    })

    it('exits 1 when no server is up', async () => {
      const h = harness()
      const code = await h.run(['models'], {
        discoverModels: fakeModels([down(ollama), down(lmStudio), llamaCpp]).fn,
        checkLocalModel: fakeCheck({ ...installed, state: 'unreachable', message: 'Ollama is not reachable' }).fn,
      })
      expect(code).toBe(1)
      expect(h.stdout.text).toContain('Not running: Ollama (http://localhost:11434)')
    })

    it('prints parseable JSON with --json', async () => {
      const h = harness()
      const code = await h.run(['models', '--json'], {
        discoverModels: fakeModels([ollama, llamaCpp]).fn,
        checkLocalModel: fakeCheck(installed).fn,
      })
      expect(code).toBe(0)
      const parsed = JSON.parse(h.stdout.text) as { servers: ModelServer[]; configured: ModelCheck }
      expect(parsed.servers.map((s) => s.target.label)).toEqual(['Ollama', 'llama.cpp server'])
      expect(parsed.configured).toEqual(installed)
    })

    it('strips control characters from what a listener reports', async () => {
      const h = harness()
      const hostile: ModelServer = { ...lmStudio, models: [{ name: '\x1b[2Jevil\x07' }] }
      await h.run(['models'], { discoverModels: fakeModels([hostile]).fn, checkLocalModel: fakeCheck(installed).fn })
      expect(h.stdout.text).toContain('evil')
      expect(h.stdout.text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
    })
  })

  describe('translate pre-flight', () => {
    it('warns on stderr when the model is missing, and still translates', async () => {
      await useQwen()
      const h = harness()
      const translate = fakeTranslate()
      const check = fakeCheck(missing(`${DEFAULT_QWEN_MODEL}`))
      const code = await h.run(['translate', file], { translate: translate.fn, checkLocalModel: check.fn })
      expect(code).toBe(0)
      expect(check.calls).toEqual([{ kind: 'ollama', baseUrl: 'http://localhost:11434', model: `${DEFAULT_QWEN_MODEL}` }])
      expect(h.stderr.text).toContain(`! ${DEFAULT_QWEN_MODEL} is not installed in Ollama at http://localhost:11434. Pull it with: ollama pull ${DEFAULT_QWEN_MODEL}`)
      expect(translate.calls).toHaveLength(1)
    })

    it('checks once for a multi-file run, before the first file', async () => {
      const second = join(home, 'second.po')
      await copyFile(samplePo, second)
      const h = harness()
      const translate = fakeTranslate()
      const check = fakeCheck(installed)
      await h.run(['translate', file, second, '--draft-engine', 'qwen'], { translate: translate.fn, checkLocalModel: check.fn })
      expect(check.calls).toHaveLength(1)
      expect(translate.calls).toHaveLength(2)
      expect(h.stderr.text).not.toContain('Warning')
    })

    it('still translates when the check itself throws', async () => {
      await useQwen()
      const h = harness()
      const translate = fakeTranslate()
      const code = await h.run(['translate', file], { translate: translate.fn, checkLocalModel: fakeCheck(new Error('boom')).fn })
      expect(code).toBe(0)
      expect(h.stderr.text).toContain('! could not check the local model: boom')
      expect(translate.calls).toHaveLength(1)
    })

    it('never checks for a metered engine', async () => {
      const h = harness()
      const check = fakeCheck(installed)
      await h.run(['translate', file, '--draft-engine', 'deepl'], { translate: fakeTranslate().fn, checkLocalModel: check.fn })
      expect(check.calls).toEqual([])
    })
  })

  describe('config', () => {
    async function configJson() {
      return JSON.parse(await readFile(join(home, 'config', 'config.json'), 'utf8'))
    }

    it('sets ollama.model, and warns without failing when it is not installed', async () => {
      const h = harness()
      const check = fakeCheck(missing('llama3.2:1b'))
      const code = await h.run(['config', 'set', 'ollama.model', ' llama3.2:1b '], { checkLocalModel: check.fn })
      expect(code).toBe(0)
      expect((await configJson()).ollama).toEqual({ baseUrl: 'http://localhost:11434', model: 'llama3.2:1b' })
      expect(h.stdout.text).toBe('✓ ollama.model = llama3.2:1b\n')
      expect(h.stderr.text).toContain('! llama3.2:1b is not installed')
      expect(check.calls).toEqual([{ kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3.2:1b' }])
    })

    it('says nothing more when the model is installed', async () => {
      const h = harness()
      await h.run(['config', 'set', 'ollama.model', `${DEFAULT_QWEN_MODEL}`], { checkLocalModel: fakeCheck(installed).fn })
      expect(h.stderr.text).toBe('')
    })

    it('refuses a model name with whitespace inside', async () => {
      const h = harness()
      expect(await h.run(['config', 'set', 'ollama.model', 'llama 3'], { checkLocalModel: fakeCheck(installed).fn })).toBe(2)
    })

    it('sets ollama.baseUrl, keeping the model', async () => {
      const h = harness()
      expect(await h.run(['config', 'set', 'ollama.baseUrl', 'http://box:11434/'])).toBe(0)
      expect((await configJson()).ollama).toEqual({ baseUrl: 'http://box:11434/', model: `${DEFAULT_QWEN_MODEL}` })
    })

    it('refuses an ollama.baseUrl that is not an http URL', async () => {
      const h = harness()
      expect(await h.run(['config', 'set', 'ollama.baseUrl', 'not-a-url'])).toBe(2)
      expect(h.stderr.text).toContain('ollama.baseUrl')
    })

    it('round-trips localModelServers through config get, and clears it with an empty string', async () => {
      const h = harness()
      expect(await h.run(['config', 'set', 'localModelServers', 'http://box:11434, https://models.lan'])).toBe(0)
      const read = harness()
      await read.run(['config', 'get', 'localModelServers'])
      expect(read.stdout.text.trim()).toBe('http://box:11434,https://models.lan')

      expect(await harness().run(['config', 'set', 'localModelServers', ''])).toBe(0)
      expect((await configJson()).localModelServers).toEqual([])
    })

    it('refuses a localModelServers entry that is not an http URL', async () => {
      const h = harness()
      expect(await h.run(['config', 'set', 'localModelServers', 'http://box:11434,box:1234'])).toBe(2)
      expect(h.stderr.text).toContain('box:1234')
    })

    it('prints the bare model name for config get ollama.model', async () => {
      const h = harness()
      await h.run(['config', 'get', 'ollama.model'])
      expect(h.stdout.text).toBe(`${DEFAULT_QWEN_MODEL}\n`)
      const url = harness()
      await url.run(['config', 'get', 'ollama.baseUrl'])
      expect(url.stdout.text).toBe('http://localhost:11434\n')
    })

    it('points a bare ollama at the dotted keys', async () => {
      const h = harness()
      expect(await h.run(['config', 'set', 'ollama', 'x'])).toBe(2)
      expect(h.stderr.text).toContain('ollama.model')
    })
  })
})

// A locale with only the universal checks used to be reviewed in silence, so
// nobody could tell an absent finding from a passed check. Told once, before
// the run, and never a refusal.
describe('universal-only notice', () => {
  const NOTICE = "! No locale rules for de; only the universal checks run. Fetch your locale team's file with: polyglots rules fetch de, or start one with: polyglots rules edit de"

  it('is printed to stderr before a review of a locale with no rules of its own', async () => {
    const h = harness()
    const calls: string[] = []
    const code = await h.run(['review', file, '--locale', 'de', '--no-ai'], {
      reviewFile: async (opts) => {
        calls.push(h.stderr.text)
        return {
          file: opts.file, locale: opts.locale, total: 1, skipped: 0, reviewed: 1, problems: 0, needsReview: 0,
          approvable: 1, unreviewed: 0, repaired: 0, written: 0, pending: 0, byRule: {}, byGroup: {},
        }
      },
    })
    expect(code).toBe(0)
    expect(calls[0]).toContain(NOTICE)
  })

  it('is printed before a translate too', async () => {
    const h = harness()
    const translate = fakeTranslate()
    await h.run(['translate', file, '--locale', 'de'], { translate: translate.fn })
    expect(h.stderr.text).toContain(NOTICE)
  })

  it('is not printed for Turkish or Swedish', async () => {
    for (const locale of ['tr', 'sv']) {
      const h = harness()
      await h.run(['translate', file, '--locale', locale], { translate: fakeTranslate().fn })
      expect(h.stderr.text).not.toContain('no locale rules')
    }
  })
})

describe('local model support', () => {
  const installed = (target: { kind?: 'ollama' | 'openai-compatible'; baseUrl: string; model: string }): ModelCheck => ({
    state: 'installed',
    kind: target.kind ?? 'ollama',
    baseUrl: target.baseUrl,
    model: target.model,
  })

  // Never the real check: no test may send a request to a real local server.
  function fakeCheck(answer: (o: { kind?: 'ollama' | 'openai-compatible'; baseUrl: string; model: string }) => ModelCheck = installed) {
    const calls: Array<{ kind?: string; baseUrl: string; model: string }> = []
    const fn = async (o: { kind?: 'ollama' | 'openai-compatible'; baseUrl: string; model: string }) => {
      calls.push(o)
      return answer(o)
    }
    return { fn, calls }
  }

  async function writeConfig(config: Record<string, unknown>): Promise<void> {
    await mkdir(join(home, 'config'), { recursive: true })
    await writeFile(join(home, 'config', 'config.json'), JSON.stringify(config))
  }

  async function configJson() {
    return JSON.parse(await readFile(join(home, 'config', 'config.json'), 'utf8'))
  }

  function fakeReviewFile() {
    const calls: Array<Parameters<NonNullable<CliDeps['reviewFile']>>[0]> = []
    const fn: NonNullable<CliDeps['reviewFile']> = async (opts) => {
      calls.push(opts)
      return {
        file: opts.file,
        locale: opts.locale,
        total: 1,
        skipped: 0,
        reviewed: 1,
        problems: 0,
        needsReview: 0,
        approvable: 1,
        unreviewed: 0,
        repaired: 0,
        written: 0,
        pending: 0,
        byRule: {},
        byGroup: {},
      }
    }
    return { fn, calls }
  }

  describe('translate', () => {
    it('reads --draft-engine qwen as local', async () => {
      const h = harness()
      const translate = fakeTranslate()
      expect(await h.run(['translate', file, '--draft-engine', 'qwen'], { translate: translate.fn, checkLocalModel: fakeCheck().fn })).toBe(0)
      expect(translate.calls[0]!.draftEngine).toBe('local')
    })

    it('passes --local-model through, and checks that model rather than the configured one', async () => {
      const h = harness()
      const translate = fakeTranslate()
      const check = fakeCheck()
      await h.run(['translate', file, '--draft-engine', 'local', '--local-model', 'llama3.2'], { translate: translate.fn, checkLocalModel: check.fn })
      expect(translate.calls[0]!.localModel).toBe('llama3.2')
      expect(check.calls).toEqual([{ kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3.2' }])
    })

    it('refuses an unknown engine, naming local', async () => {
      const h = harness()
      expect(await h.run(['translate', file, '--draft-engine', 'bing'], { translate: fakeTranslate().fn })).toBe(2)
      expect(h.stderr.text).toMatch(/deepl, openai, local/)
    })

    it('refuses an OpenAI-compatible server with no model before translating', async () => {
      await writeConfig({ localServerKind: 'openai-compatible' })
      const h = harness()
      const translate = fakeTranslate()
      expect(await h.run(['translate', file, '--draft-engine', 'local'], { translate: translate.fn, checkLocalModel: fakeCheck().fn })).toBe(1)
      expect(h.stderr.text).toContain('openaiCompatible.model is not set')
      expect(translate.calls).toHaveLength(0)
    })

    it('gives a local reviewer a small batch, says it is experimental, and checks its model', async () => {
      await writeConfig({ reviewProvider: 'local', batchSize: 100 })
      const h = harness()
      const translate = fakeTranslate()
      const check = fakeCheck()
      await h.run(['translate', file, '--draft-engine', 'deepl'], { translate: translate.fn, checkLocalModel: check.fn })
      expect(translate.calls[0]!.batchSize).toBe(12)
      expect(h.stderr.text).toContain('Local review is experimental')
      expect(check.calls).toHaveLength(1)
    })
  })

  describe('review', () => {
    it('defaults a local review to a batch of 12, warns that it is experimental, and checks the model', async () => {
      await writeConfig({ reviewProvider: 'local' })
      const h = harness()
      const review = fakeReviewFile()
      const check = fakeCheck()
      expect(await h.run(['review', file], { reviewFile: review.fn, checkLocalModel: check.fn })).toBe(0)
      expect(review.calls[0]!.batchSize).toBe(12)
      expect(review.calls[0]!.bin).toBeUndefined()
      expect(h.stderr.text).toContain('Local review is experimental')
      // Stock Ollama with no context set: always one line saying to set it.
      expect(h.stderr.text).toContain('polyglots config set ollama.contextLength')
      expect(check.calls).toEqual([{ kind: 'ollama', baseUrl: 'http://localhost:11434', model: `${DEFAULT_QWEN_MODEL}` }])
    })

    it('keeps an explicit --batch-size, and warns when it will not fit the context', async () => {
      await writeConfig({ reviewProvider: 'local', ollama: { baseUrl: 'http://localhost:11434', model: `${DEFAULT_QWEN_MODEL}`, contextLength: 8192 } })
      const h = harness()
      const review = fakeReviewFile()
      await h.run(['review', file, '--batch-size', '100'], { reviewFile: review.fn, checkLocalModel: fakeCheck().fn })
      expect(review.calls[0]!.batchSize).toBe(100)
      expect(h.stderr.text).toMatch(/more than the 8,192-token context.*Use a batch size of \d+ or less/)
    })

    it('uses the context the server reports when none is configured', async () => {
      await writeConfig({ reviewProvider: 'local' })
      const h = harness()
      await h.run(['review', file, '--batch-size', '100'], {
        reviewFile: fakeReviewFile().fn,
        checkLocalModel: fakeCheck((o) => ({ ...installed(o), contextLength: 4096 })).fn,
      })
      expect(h.stderr.text).toMatch(/4,096-token context/)
    })

    it('says nothing about local models when an agent reviews', async () => {
      const h = harness()
      const check = fakeCheck()
      await h.run(['review', file], { reviewFile: fakeReviewFile().fn, checkLocalModel: check.fn })
      expect(check.calls).toHaveLength(0)
      expect(h.stderr.text).not.toContain('experimental')
    })
  })

  describe('config', () => {
    it('takes reviewProvider local only when told, and says it is experimental', async () => {
      const h = harness()
      expect(await h.run(['config', 'set', 'reviewProvider', 'local'])).toBe(0)
      expect((await configJson()).reviewProvider).toBe('local')
      expect(h.stderr.text).toContain('Local review is experimental')
    })

    it('reads defaultDraftEngine qwen as local', async () => {
      const h = harness()
      await h.run(['config', 'set', 'defaultDraftEngine', 'qwen'])
      expect((await configJson()).defaultDraftEngine).toBe('local')
    })

    it('sets the OpenAI-compatible model and checks it on that server', async () => {
      const h = harness()
      const check = fakeCheck()
      expect(await h.run(['config', 'set', 'openaiCompatible.model', 'qwen/qwen3-8b'], { checkLocalModel: check.fn })).toBe(0)
      expect((await configJson()).openaiCompatible).toEqual({ baseUrl: 'http://localhost:1234', model: 'qwen/qwen3-8b' })
      expect(check.calls).toEqual([{ kind: 'openai-compatible', baseUrl: 'http://localhost:1234', model: 'qwen/qwen3-8b' }])
      h.stdout.text = ''
      await h.run(['config', 'get', 'openaiCompatible.model'])
      expect(h.stdout.text).toBe('qwen/qwen3-8b\n')
    })

    it('sets the OpenAI-compatible base URL, refusing one that is not http', async () => {
      const h = harness()
      expect(await h.run(['config', 'set', 'openaiCompatible.baseUrl', 'http://localhost:8080'])).toBe(0)
      expect((await configJson()).openaiCompatible.baseUrl).toBe('http://localhost:8080')
      expect(await h.run(['config', 'set', 'openaiCompatible.baseUrl', 'localhost:8080'])).toBe(2)
    })

    it('sets which kind of local server is used, refusing anything else', async () => {
      const h = harness()
      expect(await h.run(['config', 'set', 'localServerKind', 'openai-compatible'])).toBe(0)
      expect((await configJson()).localServerKind).toBe('openai-compatible')
      expect(await h.run(['config', 'set', 'localServerKind', 'lmstudio'])).toBe(2)
    })

    it('unsets a context length with an empty value', async () => {
      const h = harness()
      await h.run(['config', 'set', 'ollama.contextLength', '16384'])
      expect(await h.run(['config', 'set', 'ollama.contextLength', ''])).toBe(0)
      expect((await configJson()).ollama).not.toHaveProperty('contextLength')
      await h.run(['config', 'set', 'openaiCompatible.contextLength', '8192'])
      expect(await h.run(['config', 'set', 'openaiCompatible.contextLength', ''])).toBe(0)
      expect((await configJson()).openaiCompatible).not.toHaveProperty('contextLength')
    })

    it('names every settable part when ollama is set whole', async () => {
      const h = harness()
      expect(await h.run(['config', 'set', 'ollama', 'x'])).toBe(2)
      expect(h.stderr.text).toContain('ollama.contextLength')
    })

    it('sets a context length as a positive whole number', async () => {
      const h = harness()
      expect(await h.run(['config', 'set', 'ollama.contextLength', '16384'])).toBe(0)
      expect((await configJson()).ollama.contextLength).toBe(16384)
      expect(await h.run(['config', 'set', 'openaiCompatible.contextLength', '0'])).toBe(2)
    })
  })

  describe('doctor', () => {
    const agents = async () => []

    it('reports the local reviewer and exits by its model check', async () => {
      await writeConfig({ reviewProvider: 'local' })
      const h = harness()
      expect(await h.run(['doctor'], { discoverAgents: agents, checkLocalModel: fakeCheck().fn })).toBe(0)
      expect(h.stdout.text).toContain(`Review provider: local (experimental) ollama:${DEFAULT_QWEN_MODEL} (installed)`)
      const missing = harness()
      const code = await missing.run(['doctor'], {
        discoverAgents: agents,
        checkLocalModel: fakeCheck((o) => ({ ...installed(o), state: 'missing', message: 'not pulled' })).fn,
      })
      expect(code).toBe(1)
      expect(missing.stdout.text).toContain('(not installed)')
    })
  })

  describe('doctor without a local model', () => {
    it('still prints the agents, says no model is chosen, and exits 1', async () => {
      await writeConfig({ reviewProvider: 'local', localServerKind: 'openai-compatible' })
      const h = harness()
      const agent = {
        provider: 'claude' as const,
        bin: 'claude',
        binSource: 'default' as const,
        path: '/opt/bin/claude',
        version: '2.1.292',
        auth: { state: 'signed-in' as const },
        setup: { state: 'ok' as const },
        usable: true,
        notes: [],
      }
      const check = fakeCheck()
      const code = await h.run(['doctor'], { discoverAgents: async () => [agent], checkLocalModel: check.fn })
      expect(code).toBe(1)
      expect(h.stdout.text).toMatch(/claude\s+ready/)
      expect(h.stdout.text).toContain('Review provider: local (experimental) (no model chosen)')
      expect(check.calls).toHaveLength(0)
    })
  })

  describe('models', () => {
    it('marks the configured OpenAI-compatible model and names it as the local model', async () => {
      await writeConfig({ localServerKind: 'openai-compatible', openaiCompatible: { baseUrl: 'http://localhost:1234', model: 'qwen2.5-7b-instruct' } })
      const lm: ModelServer = {
        target: { baseUrl: 'http://localhost:1234', kind: 'openai-compatible', label: 'LM Studio', source: 'default' },
        state: 'up',
        kind: 'openai-compatible',
        selectable: true,
        models: [{ name: 'qwen2.5-7b-instruct' }, { name: 'other' }],
      }
      const h = harness()
      await h.run(['models'], { discoverModels: async () => [lm], checkLocalModel: fakeCheck().fn })
      expect(h.stdout.text).toMatch(/qwen2\.5-7b-instruct\s+\(configured\)/)
      expect(h.stdout.text).not.toMatch(/other\s+\(configured\)/)
      expect(h.stdout.text).toContain('Local model: qwen2.5-7b-instruct (OpenAI-compatible, installed)')
    })
  })
})

describe('stats', () => {
  const result = {
    file: '/tmp/s.html', submissions: 3, entries: 300, flagged: 30, incomplete: 0,
    translateRuns: 0, translateEntries: 0, weeks: [1, 4], topProjects: [{ project: 'akismet', runs: 3, entries: 300, flagged: 30 }],
  }

  it('summarises the page it wrote in a box, with the top projects below', async () => {
    const h = harness()
    const code = await h.run(['stats'], { writeStats: async () => result })
    expect(code).toBe(0)
    expect(h.stdout.text).toContain('• Statistics')
    expect(h.stdout.text).toMatch(/submissions\s+3/)
    expect(h.stdout.text).toMatch(/akismet\s+300 entries\s+10% flagged/)
    expect(h.stdout.text.trimEnd().split('\n').at(-1)).toBe('› Wrote /tmp/s.html')
  })

  // A cron job or a pipe has no one to open a browser for and nothing to
  // press Ctrl+C, so off a terminal it writes the file, as it always did.
  it('writes the file rather than serving when stdout is not a terminal', async () => {
    const h = harness()
    let served = false
    await h.run(['stats'], { writeStats: async () => result, serveStats: async () => void (served = true) })
    expect(served).toBe(false)
    expect(h.stdout.text).toContain('Wrote /tmp/s.html')
  })

  it('serves the page on a terminal, prints where, and says when it stopped', async () => {
    const h = harness()
    const calls: Array<{ open?: boolean; since?: string }> = []
    let wrote = false
    const code = await h.run(['stats', '--since', '2026-09-01'], {
      stdoutTty: true,
      env: { NO_COLOR: '1' },
      writeStats: async () => ((wrote = true), result),
      serveStats: async (opts, onReady) => {
        calls.push({ ...(opts.open === undefined ? {} : { open: opts.open }), ...(opts.since ? { since: opts.since } : {}) })
        const { file: _file, ...summary } = result
        onReady({ url: 'http://127.0.0.1:5/tok/', opened: true, summary })
      },
    })
    expect(code).toBe(0)
    expect(wrote).toBe(false)
    expect(calls).toEqual([{ open: true, since: '2026-09-01' }])
    expect(h.stdout.text).toContain('Serving http://127.0.0.1:5/tok/')
    expect(h.stdout.text).toContain('Opened in your browser. Ctrl+C to stop.')
    expect(h.stdout.text.trimEnd().split('\n').at(-1)).toContain('Stopped')
  })

  // Another polyglots already serves the page: this one points at it and
  // ends, since there is nothing of its own to keep up or stop.
  it('points at the page another polyglots serves, and returns without waiting', async () => {
    const h = harness()
    const code = await h.run(['stats'], {
      stdoutTty: true,
      env: { NO_COLOR: '1' },
      serveStats: async (_opts, onReady) => {
        const { file: _file, ...summary } = result
        onReady({ url: 'http://127.0.0.1:29117/tok/', opened: true, summary, sharedWith: { pid: 4242 } })
      },
    })
    expect(code).toBe(0)
    expect(h.stdout.text).toContain('Serving http://127.0.0.1:29117/tok/')
    expect(h.stdout.text).toMatch(/another polyglots \(pid 4242\)/)
    expect(h.stdout.text).not.toContain('Ctrl+C to stop')
    expect(h.stdout.text).not.toContain('Stopped')
  })

  it('warns when the stats port was taken, since the page settings will not carry over', async () => {
    const h = harness()
    await h.run(['stats'], {
      stdoutTty: true,
      env: { NO_COLOR: '1' },
      serveStats: async (_opts, onReady) => {
        const { file: _file, ...summary } = result
        onReady({ url: 'http://127.0.0.1:5/tok/', opened: true, summary, portInUse: 29117 })
      },
    })
    expect(h.stderr.text).toMatch(/Port 29117 is in use by another program/)
    expect(h.stderr.text).toMatch(/port 5/)
  })

  // The TUI keeps the server silent; on the command line a failed request
  // would otherwise leave no trace but a 500 in the browser.
  it('writes server errors to stderr while serving', async () => {
    const h = harness()
    await h.run(['stats'], {
      stdoutTty: true,
      env: { NO_COLOR: '1' },
      serveStats: async (opts) => opts.onError?.(new Error('no such table: run')),
    })
    expect(h.stderr.text).toContain('no such table: run')
  })

  it('passes --no-open through, for a machine where the browser is somewhere else', async () => {
    const h = harness()
    const calls: Array<boolean | undefined> = []
    await h.run(['stats', '--no-open'], {
      stdoutTty: true,
      serveStats: async (opts) => void calls.push(opts.open),
    })
    expect(calls).toEqual([false])
  })

  it('writes the file with --out even on a terminal', async () => {
    const h = harness()
    let served = false
    await h.run(['stats', '--out', '/tmp/s.html'], {
      stdoutTty: true,
      writeStats: async () => result,
      serveStats: async () => void (served = true),
    })
    expect(served).toBe(false)
  })
})

describe('NO_COLOR', () => {
  const COMMANDS: string[][] = [
    ['config', 'get'],
    ['config', 'get', 'no-such-key'],
    ['rules', 'check'],
    ['rules', 'path'],
    ['doctor'],
    ['models'],
    ['stats', '--out', '__TMP__/s.html'],
    ['translate', '__FILE__'],
    ['review', '__FILE__', '--no-ai'],
  ]

  // Both streams on a terminal, so a command whose output would be coloured
  // without NO_COLOR is caught, on stdout as well as stderr.
  async function runOnTty(argv: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
    const h = harness()
    const tmp = await mkdtemp(join(tmpdir(), 'pg-nocolor-'))
    const args = argv.map((a) => a.replace('__TMP__', tmp).replace('__FILE__', file))
    await h.run(args, {
      tty: true,
      stdoutTty: true,
      env,
      translate: fakeTranslate().fn,
      reviewFile: async (opts) => ({
        file: opts.file, locale: opts.locale, total: 3, skipped: 0, reviewed: 3, problems: 1, needsReview: 0,
        approvable: 2, unreviewed: 0, repaired: 0, written: 1, pending: 0, byRule: {}, byGroup: {}, problemsFile: 'p.po',
      }),
      discoverAgents: async () => [],
      discoverModels: async () => [],
      writeStats: async () => ({ file: join(tmp, 's.html'), submissions: 1, entries: 10, flagged: 1, incomplete: 0, translateRuns: 0, translateEntries: 0, weeks: [1, 3], topProjects: [{ project: 'p', runs: 1, entries: 10, flagged: 1 }] }),
    })
    await rm(tmp, { recursive: true, force: true })
    return { stdout: h.stdout.text, stderr: h.stderr.text }
  }

  // ESC[2K is the progress line's clear, cursor control rather than colour.
  const COLOUR = /\x1b\[(?!2K)/

  it.each(COMMANDS.map((c) => [c]))('%j prints no escape codes', async (argv) => {
    const { stdout, stderr } = await runOnTty(argv, { NO_COLOR: '1' })
    expect(stdout).not.toMatch(COLOUR)
    expect(stderr).not.toMatch(COLOUR)
  })

  // The guard on the guard: without NO_COLOR the same runs are coloured on the
  // stream that carries their result, so the sweep above is testing the
  // variable and not a harness that never paints. config get and rules path
  // are raw on purpose and have no coloured run to compare against.
  it.each([
    [['config', 'get', 'no-such-key'], 'stderr'],
    [['rules', 'check'], 'stdout'],
    [['doctor'], 'stdout'],
    [['models'], 'stdout'],
    [['stats', '--out', '__TMP__/s.html'], 'stdout'],
    [['translate', '__FILE__'], 'stdout'],
    [['review', '__FILE__', '--no-ai'], 'stdout'],
  ] as const)('%j is coloured on %s without NO_COLOR', async (argv, stream) => {
    expect((await runOnTty([...argv], {}))[stream]).toMatch(COLOUR)
  })
})

describe('raw outputs', () => {
  it('keeps config get raw on a coloured terminal', async () => {
    const h = harness()
    await h.run(['config', 'get', 'batchSize'], { tty: true, env: { FORCE_COLOR: '1' } })
    expect(h.stdout.text).toMatch(/^\d+\n$/)
  })

  it('keeps rules path raw on a coloured terminal', async () => {
    const h = harness()
    await h.run(['rules', 'path'], { tty: true, env: { FORCE_COLOR: '1' } })
    expect(h.stdout.text).not.toMatch(/\x1b\[/)
    expect(h.stdout.text.trim().split('\n')).toHaveLength(1)
  })
})

describe('confirmations', () => {
  it('confirms config set with a check line', async () => {
    const h = harness()
    await h.run(['config', 'set', 'batchSize', '7'])
    expect(h.stdout.text).toBe('✓ batchSize = 7\n')
  })
})

// Ctrl+C in a review or translate is SIGINT with nothing else listening, so
// without this the run's row is left at running and later filed as
// abandoned. Signals are emitted, never sent: the real one ends the worker.
describe('a signal during a run', () => {
  function watch() {
    const order: string[] = []
    return {
      order,
      deps: {
        stopOwnRuns: () => (order.push('stop'), 1),
        raiseSignal: (s: NodeJS.Signals) => void order.push(`raise ${s}`),
      },
    }
  }

  it.each(['SIGINT', 'SIGTERM'] as const)('review records %s as a stop, then sends it on', async (sig) => {
    const h = harness()
    const w = watch()
    const before = process.listenerCount(sig)
    await h.run(['review', file, '--no-ai'], {
      ...w.deps,
      reviewFile: async () => {
        process.emit(sig, sig)
        return {
          file, locale: 'tr' as const, total: 1, skipped: 0, reviewed: 1, problems: 0, needsReview: 0, approvable: 1, unreviewed: 0, repaired: 0,
          written: 0, pending: 0, byRule: {}, byGroup: {},
        }
      },
    })
    expect(w.order).toEqual(['stop', `raise ${sig}`])
    expect(process.listenerCount(sig)).toBe(before)
  })

  it('translate records SIGINT as a stop, then sends it on', async () => {
    const h = harness()
    const w = watch()
    const t = fakeTranslate(() => {
      process.emit('SIGINT', 'SIGINT')
      return {}
    })
    await h.run(['translate', file], { ...w.deps, translate: t.fn })
    expect(w.order).toEqual(['stop', 'raise SIGINT'])
  })

  it('stops listening once the run is over', async () => {
    const h = harness()
    const w = watch()
    const before = process.listenerCount('SIGINT')
    await h.run(['translate', file], { ...w.deps, translate: fakeTranslate().fn })
    expect(process.listenerCount('SIGINT')).toBe(before)
    expect(w.order).toEqual([])
  })
})
