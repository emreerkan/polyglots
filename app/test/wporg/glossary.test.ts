import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { GlossaryEntry } from '../../src/types.js'
import {
  dedupeGlossaryEntries,
  fetchGlossary,
  glossaryExportUrl,
  glossaryUrl,
  parseGlossaryCsv,
} from '../../src/wporg/glossary.js'

// The tr glossary as translate.wordpress.org exported it on 2026-10-15.
const fixture = readFileSync(fileURLToPath(new URL('../fixtures/wporg/glossary-tr.csv', import.meta.url)), 'utf8')

const BASE = 'https://translate.wordpress.org/locale/tr/default/glossary/'

const find = (entries: GlossaryEntry[], term: string, pos?: string) =>
  entries.find((e) => e.sourceTerm === term && (pos === undefined || e.partOfSpeech === pos))

const findAll = (entries: GlossaryEntry[], term: string, pos: string) =>
  entries.filter((e) => e.sourceTerm === term && e.partOfSpeech === pos)

const csv = (...rows: string[]) => ['en,tr,pos,description', ...rows].join('\n') + '\n'

describe('parseGlossaryCsv', () => {
  const entries = parseGlossaryCsv(fixture, 'tr')

  it('emits every row of the frozen fixture, duplicates included', () => {
    expect(entries).toHaveLength(512)
  })

  it('extracts known source -> translation pairs', () => {
    expect(find(entries, 'plugin')).toMatchObject({ translation: 'eklenti', partOfSpeech: 'noun' })
    expect(find(entries, 'permalink')).toMatchObject({ translation: 'kalıcı bağlantı' })
    expect(find(entries, 'domain name')).toMatchObject({ translation: 'alan adı' })
  })

  it('keeps the same term with different parts of speech, and case, as separate entries', () => {
    expect(find(entries, 'post', 'verb')?.translation).toBe('gönder')
    expect(find(entries, 'post', 'noun')?.translation).toBe('yazı')
    expect(find(entries, 'Post', 'noun')?.translation).toBe('Yazı')
  })

  it('stamps the locale and a part of speech on every entry', () => {
    for (const e of entries) {
      expect(e.locale).toBe('tr')
      expect(e.partOfSpeech).toBeTruthy()
    }
  })

  it('carries the description as notes, and omits notes when it is empty', () => {
    expect(find(entries, 'accent color')?.notes).toBe('Özelleştiricide kullanılan renk paletleri için')
    expect(find(entries, 'post', 'verb')).not.toHaveProperty('notes')
  })

  // Four descriptions in the export run over more than one line. The scraper
  // collapsed the same notes to one line, and the prompts expect that.
  it('never produces leading, trailing, doubled or line-breaking whitespace', () => {
    for (const e of entries) {
      for (const value of [e.sourceTerm, e.translation, e.partOfSpeech ?? '', e.notes ?? '']) {
        expect(value).toBe(value.trim())
        expect(value).not.toMatch(/\s{2}|\n/)
      }
    }
    expect(find(entries, 'Appearance')?.notes).toMatch(/^Genel bağlamda "Görünüm" WordPress bağlamında/)
  })

  it('reads quoted fields with commas, doubled quotes and line breaks', () => {
    const parsed = parseGlossaryCsv(csv('"a, b","x ""y"" z",noun,"line one\nline two"'), 'tr')
    expect(parsed).toEqual([
      { locale: 'tr', sourceTerm: 'a, b', translation: 'x "y" z', partOfSpeech: 'noun', notes: 'line one line two' },
    ])
  })

  it('reads CRLF line endings and a byte order mark', () => {
    const text = '﻿en,tr,pos,description\r\nplugin,eklenti,noun,\r\ntheme,tema,noun,\r\n'
    expect(parseGlossaryCsv(text, 'tr').map((e) => e.sourceTerm)).toEqual(['plugin', 'theme'])
  })

  // The second header is the locale's own code, so columns are read by place.
  it('reads the columns by position whatever the locale column is called', () => {
    const text = 'en,nl,pos,description\nplugin,plugin,noun,\n'
    expect(parseGlossaryCsv(text, 'nl/formal')).toEqual([
      { locale: 'nl/formal', sourceTerm: 'plugin', translation: 'plugin', partOfSpeech: 'noun' },
    ])
  })

  it('skips rows without a source or a translation, and tolerates missing trailing columns', () => {
    const parsed = parseGlossaryCsv(csv('plugin,,noun,', ',eklenti,noun,', '', 'theme,tema'), 'tr')
    expect(parsed).toEqual([{ locale: 'tr', sourceTerm: 'theme', translation: 'tema' }])
  })

  // A login page or an error page answered with 200 must not become an empty
  // glossary that replaces a good one: sync refuses on zero entries.
  it('returns [] for empty text, html, or a file that is not a glossary export', () => {
    expect(parseGlossaryCsv('', 'tr')).toEqual([])
    expect(parseGlossaryCsv('<html><body><p>nothing</p></body></html>', 'tr')).toEqual([])
    expect(parseGlossaryCsv('source,target\nplugin,eklenti\n', 'tr')).toEqual([])
  })
})

describe('dedupeGlossaryEntries', () => {
  const e = (sourceTerm: string, translation: string, extra: Partial<GlossaryEntry> = {}): GlossaryEntry => ({
    locale: 'tr',
    sourceTerm,
    translation,
    partOfSpeech: 'noun',
    ...extra,
  })

  it('collapses rows identical in locale, term, part of speech and translation, keeping first-seen order', () => {
    expect(dedupeGlossaryEntries([e('image', 'görsel'), e('theme', 'tema'), e('image', 'görsel')])).toEqual([
      e('image', 'görsel'),
      e('theme', 'tema'),
    ])
  })

  it('fills in notes from a later duplicate when the kept entry has none', () => {
    expect(dedupeGlossaryEntries([e('account', 'hesap'), e('account', 'hesap', { notes: 'ctx' })])).toEqual([
      e('account', 'hesap', { notes: 'ctx' }),
    ])
    expect(dedupeGlossaryEntries([e('account', 'hesap', { notes: 'first' }), e('account', 'hesap', { notes: 'second' })])).toEqual([
      e('account', 'hesap', { notes: 'first' }),
    ])
  })

  it('keeps alternates that differ in translation, part of speech, case or locale', () => {
    const input = [
      e('author', 'yazar'),
      e('author', 'geliştirici'),
      e('post', 'gönder', { partOfSpeech: 'verb' }),
      e('post', 'yazı'),
      e('Post', 'Yazı'),
      e('post', 'yazı', { locale: 'az' }),
    ]
    expect(dedupeGlossaryEntries(input)).toEqual(input)
  })

  it('does not mutate its input', () => {
    const first = e('image', 'görsel')
    dedupeGlossaryEntries([first, e('image', 'görsel', { notes: 'x' })])
    expect(first).not.toHaveProperty('notes')
  })

  it('reduces the fixture to 511 entries, merging the known duplicate without losing alternates', () => {
    const deduped = dedupeGlossaryEntries(parseGlossaryCsv(fixture, 'tr'))
    expect(deduped).toHaveLength(511)
    expect(findAll(deduped, 'image', 'noun')).toEqual([{ locale: 'tr', sourceTerm: 'image', partOfSpeech: 'noun', translation: 'görsel' }])
    expect(findAll(deduped, 'author', 'noun').map((x) => x.translation)).toEqual(['yazar', 'geliştirici'])
    expect(findAll(deduped, 'header', 'noun').map((x) => x.translation)).toEqual(['başlık', 'üst kısım'])
  })
})

describe('glossaryUrl', () => {
  it('builds the per-locale default glossary url', () => {
    expect(glossaryUrl('tr')).toBe(BASE)
    expect(glossaryUrl('de')).toBe('https://translate.wordpress.org/locale/de/default/glossary/')
  })

  it('encodes locale slugs', () => {
    expect(glossaryUrl('pt-br')).toBe('https://translate.wordpress.org/locale/pt-br/default/glossary/')
    // A slash separates the translation set (nl/formal); anything else odd is encoded.
    expect(glossaryUrl('nl/formal')).toBe('https://translate.wordpress.org/locale/nl/formal/glossary/')
    expect(glossaryUrl('a b')).toBe('https://translate.wordpress.org/locale/a%20b/default/glossary/')
  })
})

describe('glossaryExportUrl', () => {
  // With the trailing slash: without it wp.org answers with a redirect.
  it('names the CSV export of the locale glossary', () => {
    expect(glossaryExportUrl('tr')).toBe(`${BASE}-export/`)
    expect(glossaryExportUrl('nl/formal')).toBe('https://translate.wordpress.org/locale/nl/formal/glossary/-export/')
  })
})

describe('fetchGlossary', () => {
  it('fetches the export once with the injected fetch and returns deduped entries', async () => {
    const calls: string[] = []
    const entries = await fetchGlossary('tr', async (url) => {
      calls.push(url)
      return fixture
    })
    expect(calls).toEqual([glossaryExportUrl('tr')])
    expect(entries).toHaveLength(511)
  })

  it('passes the locale through to the url and to every entry', async () => {
    const calls: string[] = []
    const entries = await fetchGlossary('nl/formal', async (url) => {
      calls.push(url)
      return csv('plugin,plugin,noun,')
    })
    expect(calls).toEqual([glossaryExportUrl('nl/formal')])
    expect(entries).toEqual([{ locale: 'nl/formal', sourceTerm: 'plugin', translation: 'plugin', partOfSpeech: 'noun' }])
  })

  it('propagates fetch failures', async () => {
    await expect(
      fetchGlossary('tr', async () => {
        throw new Error('network down')
      }),
    ).rejects.toThrow('network down')
  })
})
