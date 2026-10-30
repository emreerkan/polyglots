import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { main, type CliDeps } from '../../src/cli.js'
import { editGlossary, type EditGlossaryOptions } from '../../src/commands/glossary-edit.js'
import { importGlossaryCsv } from '../../src/commands/glossary-import.js'
import type { GlossaryEditorOptions, GlossaryEditorServer } from '../../src/glossary/editor/server.js'
import { openDb } from '../../src/storage/db.js'
import { replaceGlossary } from '../../src/storage/glossary.js'
import { countGlossaryEdits, effectiveGlossary } from '../../src/storage/glossary-edits.js'

interface Sink {
  isTTY: boolean
  text: string
  write(chunk: string): boolean
}

function sink(): Sink {
  return {
    isTTY: false,
    text: '',
    write(chunk: string) {
      this.text += chunk
      return true
    },
  }
}

async function run(argv: string[], deps: Omit<CliDeps, 'streams'> = {}) {
  const stdout = sink()
  const stderr = sink()
  const stdin = new PassThrough()
  stdin.end()
  const code = await main(argv, {
    env: { NO_COLOR: '1' },
    sendUsage: () => undefined,
    checkUpdate: async () => undefined,
    checkGlossary: async () => [],
    ...deps,
    streams: { stdin, stdout, stderr },
  })
  return { code, out: stdout.text, err: stderr.text }
}

let home: string
let saved: string | undefined

beforeEach(async () => {
  saved = process.env.POLYGLOTS_HOME
  home = await mkdtemp(join(tmpdir(), 'polyglots-cli-glossary-'))
  process.env.POLYGLOTS_HOME = home
  await mkdir(join(home, 'config'), { recursive: true })
  await writeFile(join(home, 'config', 'config.json'), JSON.stringify({ defaultLocale: 'tr' }))
})

afterEach(async () => {
  if (saved === undefined) delete process.env.POLYGLOTS_HOME
  else process.env.POLYGLOTS_HOME = saved
  await rm(home, { recursive: true, force: true })
})

type EditGlossary = NonNullable<CliDeps['editGlossary']>

// Records the options and answers as a server that came up and was stopped.
function fakeEdit(serving: { mode?: 'polyglots' | 'CSV'; locale?: string; opened?: boolean } = {}) {
  const calls: EditGlossaryOptions[] = []
  const fn: EditGlossary = async (opts, onReady) => {
    calls.push(opts)
    onReady({
      url: 'http://127.0.0.1:5/tok/',
      mode: serving.mode ?? (opts.source.kind === 'db' ? 'polyglots' : 'CSV'),
      locale: serving.locale ?? opts.source.locale ?? 'tr',
      opened: serving.opened ?? true,
    })
    return 'stopped'
  }
  return { fn, calls }
}

describe('glossary edit', () => {
  it('opens the configured locale from polyglots.db when no CSV is named', async () => {
    const edit = fakeEdit()
    const { code, out } = await run(['glossary', 'edit'], { editGlossary: edit.fn })
    expect(code).toBe(0)
    expect(edit.calls.map((c) => c.source)).toEqual([{ kind: 'db', locale: 'tr' }])
    expect(out).toContain('Glossary editor at http://127.0.0.1:5/tok/ (polyglots, tr). Press Ctrl+C to stop.')
    expect(out.trimEnd().split('\n').at(-1)).toContain('Stopped')
  })

  it('passes a normalized --locale through for polyglots.db', async () => {
    const edit = fakeEdit()
    await run(['glossary', 'edit', '--locale', 'PT-BR'], { editGlossary: edit.fn })
    expect(edit.calls.map((c) => c.source)).toEqual([{ kind: 'db', locale: 'pt-br' }])
  })

  it('opens a CSV with --csv, with no locale unless one is named', async () => {
    const edit = fakeEdit({ locale: 'tr' })
    const { code, out } = await run(['glossary', 'edit', '--csv', 'x.csv'], { editGlossary: edit.fn })
    expect(code).toBe(0)
    expect(edit.calls.map((c) => c.source)).toEqual([{ kind: 'csv', file: 'x.csv' }])
    expect(out).toContain('Glossary editor at http://127.0.0.1:5/tok/ (CSV, tr). Press Ctrl+C to stop.')
  })

  it('passes --locale through for a CSV', async () => {
    const edit = fakeEdit()
    await run(['glossary', 'edit', '--csv', 'x.csv', '--locale', 'de'], { editGlossary: edit.fn })
    expect(edit.calls.map((c) => c.source)).toEqual([{ kind: 'csv', file: 'x.csv', locale: 'de' }])
  })

  it('says to open the address by hand when no browser opened', async () => {
    const { err } = await run(['glossary', 'edit'], { editGlossary: fakeEdit({ opened: false }).fn })
    expect(err).toContain('No browser opened here; open the address above in yours.')
  })

  // The server ends itself when the page closes or sits idle; the person
  // must be told how to get it back rather than left at a dead prompt.
  it('says how to open it again when the editor closed itself', async () => {
    const fn: EditGlossary = async (_opts, onReady) => {
      onReady({ url: 'http://127.0.0.1:5/tok/', mode: 'polyglots', locale: 'tr', opened: true })
      return 'closed'
    }
    const { out } = await run(['glossary', 'edit'], { editGlossary: fn })
    expect(out).toContain('The glossary editor closed')
    expect(out).toContain('polyglots glossary edit')
    expect(out).not.toContain('Stopped')
  })

  it('hands the CLI opener to the command, so a test or demo decides whether a browser starts', async () => {
    const opened: string[] = []
    let given: EditGlossaryOptions['openBrowser']
    const fn: EditGlossary = async (opts, onReady) => {
      given = opts.openBrowser
      onReady({ url: 'u', mode: 'polyglots', locale: 'tr', opened: true })
      return 'stopped'
    }
    await run(['glossary', 'edit'], { editGlossary: fn, openBrowser: async (url) => (opened.push(url), true) })
    await given?.('http://x/')
    expect(opened).toEqual(['http://x/'])
  })
})

describe('editGlossary', () => {
  function fakeServer() {
    let finish!: () => void
    const done = new Promise<void>((resolve) => (finish = resolve))
    let closed = 0
    const server: GlossaryEditorServer = {
      url: 'http://127.0.0.1:7/tok/',
      port: 7,
      done,
      close: async () => void closed++,
    }
    const starts: GlossaryEditorOptions[] = []
    const start = async (opts: GlossaryEditorOptions) => (starts.push(opts), server)
    return { server, start, starts, finish, closed: () => closed }
  }

  it('starts the source, opens the browser, and closes when stopped', async () => {
    const s = fakeServer()
    const opened: string[] = []
    const ready: unknown[] = []
    const end = await editGlossary(
      {
        source: { kind: 'db', locale: 'tr' },
        start: s.start,
        openBrowser: async (url) => (opened.push(url), false),
        untilStopped: async () => {},
      },
      (serving) => ready.push(serving),
    )
    expect(end).toBe('stopped')
    expect(s.starts.map((o) => o.source)).toEqual([{ kind: 'db', locale: 'tr' }])
    expect(opened).toEqual(['http://127.0.0.1:7/tok/'])
    expect(ready).toEqual([{ url: 'http://127.0.0.1:7/tok/', mode: 'polyglots', locale: 'tr', opened: false }])
    expect(s.closed()).toBe(1)
  })

  it('ends as closed when the server ends itself', async () => {
    const s = fakeServer()
    const ended = editGlossary(
      { source: { kind: 'db', locale: 'tr' }, start: s.start, openBrowser: async () => true, untilStopped: () => new Promise(() => {}) },
      () => s.finish(),
    )
    expect(await ended).toBe('closed')
    expect(s.closed()).toBe(1)
  })

  it("names a CSV's locale from its header when none is given", async () => {
    const file = join(home, 'g.csv')
    await writeFile(file, 'en,de,pos,description\npost,Beitrag,noun,\n')
    const s = fakeServer()
    let locale: string | undefined
    await editGlossary(
      { source: { kind: 'csv', file }, start: s.start, openBrowser: async () => true, untilStopped: async () => {} },
      (serving) => (locale = `${serving.mode} ${serving.locale}`),
    )
    expect(locale).toBe('CSV de')
  })

  it('names the given locale over the header, and the configured one for a file not there yet', async () => {
    const file = join(home, 'g.csv')
    await writeFile(file, 'en,de,pos,description\n')
    const s = fakeServer()
    const seen: string[] = []
    const opts = { start: s.start, openBrowser: async () => true, untilStopped: async () => {} }
    await editGlossary({ ...opts, source: { kind: 'csv', file, locale: 'de-ch' } }, (r) => seen.push(r.locale))
    await editGlossary({ ...opts, source: { kind: 'csv', file: join(home, 'new.csv') } }, (r) => seen.push(r.locale))
    expect(seen).toEqual(['de-ch', 'tr'])
  })
})

describe('glossary import', () => {
  const csv = (body: string) => `en,tr,pos,description\n${body}`

  it('refuses a CSV with a problem, naming its row counted after the header, and writes nothing', async () => {
    const file = join(home, 'terms.csv')
    await writeFile(file, csv('quiz,sınav,noun,\nlesson,,noun,\ncourse,kurs,thing,\n'))
    const { code, err } = await run(['glossary', 'import', file])
    expect(code).toBe(1)
    expect(err).toContain('Row 2 (lesson): no translation')
    expect(err).toContain('Row 3 (course): unknown part of speech "thing"')
    expect(err).toContain('header')
    expect(err).toContain('nothing was imported')
    const db = openDb()
    try {
      expect(countGlossaryEdits(db, 'tr')).toBe(0)
    } finally {
      db.close()
    }
  })

  it('imports the rows as local edits and says how many terms were replaced and added', async () => {
    const db = openDb()
    replaceGlossary(db, 'tr', [{ locale: 'tr', sourceTerm: 'Quiz', translation: 'test', partOfSpeech: 'noun' }])
    db.close()
    const file = join(home, 'terms.csv')
    await writeFile(file, csv('quiz,sınav,noun,\nlesson,ders,noun,\nlesson,öğret,verb,\n'))
    const { code, out } = await run(['glossary', 'import', file])
    expect(code).toBe(0)
    expect(out).toContain(
      `Imported ${file}: 1 terms replaced, 1 added, as local edits for tr. Discard them in polyglots glossary edit.`,
    )
    const check = openDb()
    try {
      expect(effectiveGlossary(check, 'tr').map((r) => [r.term, r.translation, r.origin])).toEqual([
        ['quiz', 'sınav', 'added'],
        ['lesson', 'ders', 'added'],
        ['lesson', 'öğret', 'added'],
      ])
    } finally {
      check.close()
    }
  })

  // As in the editor: --locale is obeyed, but a header naming another
  // language is said, since it usually means the wrong file or the wrong flag.
  it('says on stderr when --locale overrides a header naming another locale, and imports anyway', async () => {
    const file = join(home, 'de.csv')
    await writeFile(file, 'en,de,pos,description\npost,Beitrag,noun,\n')
    const { code, out, err } = await run(['glossary', 'import', file, '--locale', 'tr'])
    expect(code).toBe(0)
    expect(err).toContain(`The file's header says "de", but the import uses tr as asked.`)
    expect(out).toContain('0 terms replaced, 1 added, as local edits for tr.')
  })

  it('says nothing when --locale shares the header slug, as nl/formal does with nl', async () => {
    const file = join(home, 'nl.csv')
    await writeFile(file, 'en,nl,pos,description\npost,bericht,noun,\n')
    const { code, err } = await run(['glossary', 'import', file, '--locale', 'nl/formal'])
    expect(code).toBe(0)
    expect(err).not.toContain('header says')
  })

  it('passes a normalized --locale through', async () => {
    const calls: Array<{ file: string; locale?: string }> = []
    const { code, out } = await run(['glossary', 'import', 'x.csv', '--locale', 'PT-BR'], {
      importGlossary: async (opts) => (calls.push({ file: opts.file, ...(opts.locale ? { locale: opts.locale } : {}) }), { file: opts.file, locale: 'pt-br', replaced: 0, added: 2 }),
    })
    expect(code).toBe(0)
    expect(calls).toEqual([{ file: 'x.csv', locale: 'pt-br' }])
    expect(out).toContain('Imported x.csv: 0 terms replaced, 2 added, as local edits for pt-br.')
  })
})

describe('importGlossaryCsv', () => {
  it("imports into the header's locale when none is given", async () => {
    const file = join(home, 'de.csv')
    await writeFile(file, 'en,de,pos,description\npost,Beitrag,noun,\n')
    const db = openDb(':memory:')
    try {
      const result = await importGlossaryCsv({ file, db })
      expect(result).toEqual({ file, locale: 'de', replaced: 0, added: 1 })
      expect(countGlossaryEdits(db, 'de')).toBe(1)
    } finally {
      db.close()
    }
  })

  it('imports into the given locale over the header', async () => {
    const file = join(home, 'de.csv')
    await writeFile(file, 'en,de,pos,description\npost,Beitrag,noun,\n')
    const db = openDb(':memory:')
    try {
      expect((await importGlossaryCsv({ file, locale: 'de-ch', db })).locale).toBe('de-ch')
      expect(countGlossaryEdits(db, 'de-ch')).toBe(1)
    } finally {
      db.close()
    }
  })

  it('refuses a header that names no wp.org locale when none is given', async () => {
    const file = join(home, 'x.csv')
    await writeFile(file, 'en,klingon,pos,description\npost,x,noun,\n')
    const db = openDb(':memory:')
    try {
      await expect(importGlossaryCsv({ file, db })).rejects.toThrow(/klingon.*--locale/)
    } finally {
      db.close()
    }
  })

  it('refuses a file that is not a glossary export', async () => {
    const file = join(home, 'x.csv')
    await writeFile(file, 'Term,Translation\npost,yazı\n')
    const db = openDb(':memory:')
    try {
      await expect(importGlossaryCsv({ file, db })).rejects.toThrow(/first column must be "en"/)
    } finally {
      db.close()
    }
  })
})
