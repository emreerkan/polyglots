import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDb, replaceGlossary } from '../../../src/storage/index.js'
import { openJobsDb } from '../../../src/jobs/index.js'
import { configFile } from '../../../src/paths.js'
import { configuredProperNouns, reviewFile } from '../../../src/commands/review.js'

const HEADER = `msgid ""
msgstr ""
"MIME-Version: 1.0\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Language: ru\\n"
`

const SINGULAR = `
msgid "Save all changes"
msgstr "Сохранить все изменения"
`

const PLURAL = `
msgid "%d file"
msgid_plural "%d files"
msgstr[0] "%d файл"
msgstr[1] "%d файла"
msgstr[2] "%d файлов"
`

const RU = 'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);'

describe('reviewFile: Plural-Forms', () => {
  let home: string
  let file: string
  let db: Database.Database

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'polyglots-review-plurals-'))
    file = join(home, 'plugin-ru.po')
    db = openDb(join(home, 'polyglots.db'))
    replaceGlossary(db, 'ru', [{ locale: 'ru', sourceTerm: 'file', translation: 'файл', partOfSpeech: 'noun' }])
  })

  afterEach(async () => {
    db.close()
    await rm(home, { recursive: true, force: true })
  })

  const adjudicate = vi.fn(async (batch: { id: number }[]) =>
    batch.map((c) => ({ id: c.id, problem: false, categories: [] as never[], reason: 'ok' })),
  )

  it('refuses a catalogue with plural entries and no header, before any agent or job row', async () => {
    await writeFile(file, HEADER + SINGULAR + PLURAL, 'utf8')
    adjudicate.mockClear()
    await expect(reviewFile({ file, locale: 'ru', db, adjudicate })).rejects.toThrow(
      `${file} has plural entries but no Plural-Forms header; polyglots will not guess how many forms ru uses`,
    )
    expect(adjudicate).not.toHaveBeenCalled()
    const jobs = openJobsDb()
    try {
      expect((jobs.prepare('SELECT count(*) AS n FROM run').get() as { n: number }).n).toBe(0)
    } finally {
      jobs.close()
    }
  })

  it('runs the same catalogue without its plural entries', async () => {
    await writeFile(file, HEADER + SINGULAR, 'utf8')
    const summary = await reviewFile({ file, locale: 'ru', db, adjudicate })
    expect(summary.reviewed).toBe(1)
  })

  // Above two forms the expression is what says which form is which, so the
  // model is shown it.
  it('hands the adjudicator the Plural-Forms header above two forms', async () => {
    await writeFile(file, HEADER + `"Plural-Forms: ${RU}\\n"\n` + SINGULAR + PLURAL, 'utf8')
    const seen: unknown[] = []
    await reviewFile({
      file,
      locale: 'ru',
      db,
      adjudicate: async (batch, opts) => {
        seen.push(opts.pluralForms)
        return batch.map((c) => ({ id: c.id, problem: false, categories: [], reason: 'ok' }))
      },
    })
    expect(seen).toEqual([RU])
  })

  // WordPress core's approved Arabic, where the forms for zero, one and two say
  // the number in words. The formula is what tells the placeholder rule so; a
  // header without one leaves msgstr[0] read as the singular, as before.
  it('reads the placeholders of each plural form by the header\'s formula', async () => {
    const AR =
      'nplurals=6; plural=(n == 0) ? 0 : ((n == 1) ? 1 : ((n == 2) ? 2 : ((n % 100 >= 3 && n % 100 <= 10) ? 3 : ((n % 100 >= 11 && n % 100 <= 99) ? 4 : 5))));'
    const ARABIC = `
msgid "%d result found."
msgid_plural "%d results found."
msgstr[0] "لم يتم العثور على نتائج."
msgstr[1] "تم العثور على نتيجة واحدة."
msgstr[2] "تم العثور على نتيجتين."
msgstr[3] "تم العثور على %d نتائج."
msgstr[4] "تم العثور على %d نتيجة."
msgstr[5] "تم العثور على %d نتيجة."
`
    replaceGlossary(db, 'ar', [{ locale: 'ar', sourceTerm: 'block', translation: 'مكوّن', partOfSpeech: 'noun' }])
    const review = async (pluralForms: string) => {
      await writeFile(file, HEADER.replace('Language: ru', 'Language: ar') + `"Plural-Forms: ${pluralForms}\\n"\n` + ARABIC, 'utf8')
      return reviewFile({ file, locale: 'ar', db, noAi: true, mcpConfigPath: '' })
    }
    // With the formula the spelled-out forms are no error, only a suspect
    // naming translate.wordpress.org's warning; without it they are an error.
    const read = await review(AR)
    expect(read.problems).toBe(0)
    expect(read.needsReview).toBe(1)
    const unread = await review('nplurals=6;')
    expect(unread.problems).toBe(1)
    expect(unread.byRule).toMatchObject({ placeholder: 1 })
  })

  // With a model, the same entry is put to it with translate.wordpress.org's
  // warning as a suspect, and the model may clear it like any other suspect.
  // Without a formula the old error stands, which no model can clear.
  it('lets the model weigh the warning translate.wordpress.org would give a spelled-out form', async () => {
    const AR =
      'nplurals=6; plural=(n == 0) ? 0 : ((n == 1) ? 1 : ((n == 2) ? 2 : ((n % 100 >= 3 && n % 100 <= 10) ? 3 : ((n % 100 >= 11 && n % 100 <= 99) ? 4 : 5))));'
    const ARABIC = `
msgid "%d result found."
msgid_plural "%d results found."
msgstr[0] "لم يتم العثور على نتائج."
msgstr[1] "تم العثور على نتيجة واحدة."
msgstr[2] "تم العثور على نتيجتين."
msgstr[3] "تم العثور على %d نتائج."
msgstr[4] "تم العثور على %d نتيجة."
msgstr[5] "تم العثور على %d نتيجة."
`
    replaceGlossary(db, 'ar', [{ locale: 'ar', sourceTerm: 'block', translation: 'مكوّن', partOfSpeech: 'noun' }])
    const review = async (pluralForms: string) => {
      await writeFile(file, HEADER.replace('Language: ru', 'Language: ar') + `"Plural-Forms: ${pluralForms}\\n"\n` + ARABIC, 'utf8')
      const asked: { severity: string; message: string }[][] = []
      const summary = await reviewFile({
        file,
        locale: 'ar',
        db,
        fresh: true,
        adjudicate: async (batch) => {
          asked.push(...batch.map((c) => (c as { hints: { severity: string; message: string }[] }).hints))
          return batch.map((c) => ({ id: c.id, problem: false, categories: [], reason: 'ok' }))
        },
      })
      return { summary, asked }
    }
    const read = await review(AR)
    expect(read.asked).toEqual([
      [
        {
          rule: 'placeholder',
          severity: 'suspect',
          message:
            'translate.wordpress.org warns about placeholder(s) %d in msgstr[0], though the form is right for the numbers its plural formula serves',
        },
      ],
    ])
    expect(read.summary.problems).toBe(0)
    expect(read.summary.approvable).toBe(1)
    const unread = await review('nplurals=6;')
    expect(unread.summary.problems).toBe(1)
  })

  // The header is in the prompt, so it is in the verdict key. A cache that left
  // it out would serve a verdict reached under one plural expression to a prompt
  // carrying another, and nothing in the output would say so. The control run
  // with the header unchanged is what proves the cache is live at all, so the
  // miss after the edit is the header's doing and not a cache that never hits.
  it('asks again for the plural entry when only the Plural-Forms header changes', async () => {
    const CS = 'nplurals=3; plural=(n==1 ? 0 : n>=2 && n<=4 ? 1 : 2);'
    const judged: string[][] = []
    const run = async (expression: string) => {
      await writeFile(file, HEADER + `"Plural-Forms: ${expression}\\n"\n` + SINGULAR + PLURAL, 'utf8')
      const msgids: string[] = []
      await reviewFile({
        file,
        locale: 'ru',
        db,
        adjudicate: async (batch) => {
          msgids.push(...batch.map((c) => (c as { msgid: string }).msgid))
          return batch.map((c) => ({ id: c.id, problem: false, categories: [], reason: 'ok' }))
        },
      })
      judged.push(msgids)
    }
    await run(RU)
    await run(RU)
    await run(CS)
    expect(judged[0]).toContain('%d file')
    expect(judged[1]).not.toContain('%d file')
    expect(judged[2]).toContain('%d file')
  })
})

describe('configuredProperNouns', () => {
  async function writeConfig(properNouns: Record<string, string[]>) {
    await mkdir(dirname(configFile()), { recursive: true })
    await writeFile(configFile(), JSON.stringify({ properNouns }), 'utf8')
  }

  // A translation set is the language's own work in another register, so it
  // shares the language's names. Splitting on - and _ alone never reached nl.
  it('reads a set locale\'s own list and its language\'s', async () => {
    await writeConfig({ 'nl/formal': ['Rijksmuseum'], nl: ['Amsterdam'] })
    expect(configuredProperNouns('nl/formal')).toEqual(['Rijksmuseum', 'Amsterdam'])
  })

  it('still reads a regional locale\'s language list', async () => {
    await writeConfig({ pt: ['Lisboa'] })
    expect(configuredProperNouns('pt-br')).toEqual(['Lisboa'])
  })
})
