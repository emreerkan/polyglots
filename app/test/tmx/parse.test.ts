import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTmx, parseTmx } from '../../src/tmx/parse.js'

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'tmx', 'sample.tmx')

function tmx(body: string, srclang = 'en', headerExtra = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<tmx version="1.4">
  <header creationtool="Poedit" srclang="${srclang}" ${headerExtra}/>
  <body>${body}</body>
</tmx>`
}

function tu(src: string, tgt: string, srcLang = 'en', tgtLang = 'tr', extra = ''): string {
  return `<tu>${extra}<tuv xml:lang="${srcLang}"><seg>${src}</seg></tuv><tuv xml:lang="${tgtLang}"><seg>${tgt}</seg></tuv></tu>`
}

describe('parseTmx with the PoEdit-style fixture', () => {
  it('extracts exactly the usable en→tr pairs in document order', async () => {
    const xml = await readFile(FIXTURE, 'utf8')
    const entries = parseTmx(xml, { targetLocale: 'tr' })
    expect(entries).toEqual([
      { source: 'Save changes', target: 'Değişiklikleri kaydet', locale: 'tr' },
      {
        source: 'Terms & Conditions <b>apply</b>',
        target: 'Şartlar & Koşullar <b>geçerlidir</b>',
        locale: 'tr',
      },
      { source: 'Welcome, %s!', target: 'Hoş geldin, %s!', locale: 'tr' },
      { source: ' Read more ', target: ' Devamını oku ', locale: 'tr' },
      { source: 'Post', target: 'Gönder', locale: 'tr', context: 'verb' },
    ])
  })

  it('does not derive project from creationtool', async () => {
    const xml = await readFile(FIXTURE, 'utf8')
    for (const entry of parseTmx(xml, { targetLocale: 'tr' })) {
      expect(entry.project).toBeUndefined()
    }
  })

  // polyglots-data tags every unit with the projects it came from, first
  // the one it was taken from; a unit in two projects carries two props.
  it('takes the first x-project', () => {
    const tmx = `<tmx><header srclang="en"/><body><tu><prop type="x-project">wp/dev</prop><prop type="x-project">woo</prop><tuv xml:lang="en"><seg>A</seg></tuv><tuv xml:lang="tr-TR"><seg>B</seg></tuv></tu></body></tmx>`
    expect(parseTmx(tmx, { targetLocale: 'tr' })[0]).toMatchObject({ project: 'wp/dev', locale: 'tr' })
  })

  it('leaves the project undefined without an x-project or a project option', () => {
    expect(parseTmx(tmx(tu('A', 'B')), { targetLocale: 'tr' })[0]?.project).toBeUndefined()
  })

  it('prefers the project option to an x-project', () => {
    const body = tu('A', 'B', 'en', 'tr', '<prop type="x-project">wp/dev</prop>')
    expect(parseTmx(tmx(body), { targetLocale: 'tr', project: 'mine' })[0]?.project).toBe('mine')
  })

  it('skips an empty x-project for the next one', () => {
    const body = tu('A', 'B', 'en', 'tr', '<prop type="x-project"> </prop><prop type="x-project">woo</prop>')
    expect(parseTmx(tmx(body), { targetLocale: 'tr' })[0]?.project).toBe('woo')
  })

  it('selects the de pair when de is the target locale', async () => {
    const xml = await readFile(FIXTURE, 'utf8')
    expect(parseTmx(xml, { targetLocale: 'de' })).toEqual([
      { source: 'Settings', target: 'Einstellungen', locale: 'de' },
    ])
  })
})

describe('parseTmx inline tags', () => {
  it('keeps text from bpt/ept/it/hi/ph and drops the markup', () => {
    const xml = tmx(
      tu(
        'Click <bpt i="1">&lt;a href="x"&gt;</bpt>here<ept i="1">&lt;/a&gt;</ept> <hi type="bold">now</hi><it pos="begin">&lt;br/&gt;</it>',
        '<bpt i="1">&lt;a href="x"&gt;</bpt>buraya<ept i="1">&lt;/a&gt;</ept> tıkla <ph x="1">%d</ph>',
      ),
    )
    expect(parseTmx(xml, { targetLocale: 'tr' })).toEqual([
      {
        source: 'Click <a href="x">here</a> now<br/>',
        target: '<a href="x">buraya</a> tıkla %d',
        locale: 'tr',
      },
    ])
  })

  it('handles nested sub elements inside inline tags', () => {
    const xml = tmx(tu('A<bpt i="1">&lt;b&gt;<sub>alt</sub></bpt>B', 'X<ph>y</ph>Z'))
    expect(parseTmx(xml, { targetLocale: 'tr' })[0]).toMatchObject({
      source: 'A<b>altB',
      target: 'XyZ',
    })
  })

  it('reads CDATA segments verbatim', () => {
    const xml = tmx(tu('<![CDATA[a < b & c]]>', '<![CDATA[a < b ve c]]>'))
    expect(parseTmx(xml, { targetLocale: 'tr' })[0]).toMatchObject({
      source: 'a < b & c',
      target: 'a < b ve c',
    })
  })

  it('decodes numeric character references', () => {
    const xml = tmx(tu('caf&#233; &#x2014; ok', 'kahve &#8212; tamam'))
    expect(parseTmx(xml, { targetLocale: 'tr' })[0]).toMatchObject({
      source: 'café — ok',
      target: 'kahve — tamam',
    })
  })
})

describe('parseTmx skipping rules', () => {
  it('skips whitespace-only segments', () => {
    const xml = tmx(tu('Hello', '   ') + tu('World', 'Dünya'))
    expect(parseTmx(xml, { targetLocale: 'tr' })).toEqual([
      { source: 'World', target: 'Dünya', locale: 'tr' },
    ])
  })

  it('skips a tu whose source side is missing', () => {
    const xml = tmx('<tu><tuv xml:lang="tr"><seg>Yalnız</seg></tuv></tu>' + tu('A', 'B'))
    expect(parseTmx(xml, { targetLocale: 'tr' })).toEqual([{ source: 'A', target: 'B', locale: 'tr' }])
  })

  it('skips a tu with an empty source seg', () => {
    const xml = tmx(tu('', 'Boş'))
    expect(parseTmx(xml, { targetLocale: 'tr' })).toEqual([])
  })

  it('returns an empty list for an empty body', () => {
    expect(parseTmx(tmx(''), { targetLocale: 'tr' })).toEqual([])
    expect(parseTmx(tmx('   '), { targetLocale: 'tr' })).toEqual([])
  })

  it('returns an empty list when the target language appears nowhere', () => {
    const xml = tmx(tu('A', 'B', 'en', 'de'))
    expect(parseTmx(xml, { targetLocale: 'tr' })).toEqual([])
  })
})

describe('parseTmx locale normalization', () => {
  it.each([
    ['en', 'tr'],
    ['en-US', 'tr-TR'],
    ['en_US', 'tr_TR'],
    ['EN', 'TR'],
    ['en-GB', 'Tr_tr'],
  ])('matches srclang %s and tuv %s against target "tr"', (src, tgt) => {
    const xml = tmx(tu('Yes', 'Evet', src, tgt), src)
    expect(parseTmx(xml, { targetLocale: 'tr' })).toEqual([{ source: 'Yes', target: 'Evet', locale: 'tr' }])
  })

  it.each([
    ['tr_TR', 'tr-tr'],
    ['tr-TR', 'tr-tr'],
    ['TR', 'tr'],
    [' Tr_tr ', 'tr-tr'],
  ])('accepts a regional targetLocale %s against a bare tr tuv and emits it normalized as %s', (target, emitted) => {
    const xml = tmx(tu('Yes', 'Evet', 'en', 'tr'))
    expect(parseTmx(xml, { targetLocale: target })).toEqual([{ source: 'Yes', target: 'Evet', locale: emitted }])
  })

  it('treats header srclang="*all*" as no default source language', () => {
    const xml = tmx(tu('Yes', 'Evet'), '*all*')
    expect(parseTmx(xml, { targetLocale: 'tr' })).toEqual([{ source: 'Yes', target: 'Evet', locale: 'tr' }])
  })

  it('treats a tu-level srclang="*all*" as no default source language', () => {
    const xml = tmx(`<tu srclang="*ALL*">${tu('Yes', 'Evet').slice(4)}`, 'fr')
    expect(parseTmx(xml, { targetLocale: 'tr' })).toEqual([{ source: 'Yes', target: 'Evet', locale: 'tr' }])
  })

  it('falls back to the TMX 1.1 lang attribute when xml:lang is absent', () => {
    const xml = tmx('<tu><tuv lang="EN-US"><seg>Yes</seg></tuv><tuv lang="tr_TR"><seg>Evet</seg></tuv></tu>')
    expect(parseTmx(xml, { targetLocale: 'tr' })).toEqual([{ source: 'Yes', target: 'Evet', locale: 'tr' }])
  })

  it('does not match a different region when the target locale is regional', () => {
    const xml = tmx(tu('Yes', 'Sim', 'en', 'pt-PT'))
    expect(parseTmx(xml, { targetLocale: 'pt-BR' })).toEqual([])
    expect(parseTmx(xml, { targetLocale: 'pt' })).toHaveLength(1)
  })

  it('does not treat a language with the same prefix letters as a match', () => {
    const xml = tmx(tu('Yes', 'Ja', 'en', 'de'))
    expect(parseTmx(xml, { targetLocale: 'd' })).toEqual([])
  })

  it('honors a tu-level srclang override', () => {
    const xml = tmx(
      `<tu srclang="fr"><tuv xml:lang="en"><seg>Yes</seg></tuv><tuv xml:lang="fr"><seg>Oui</seg></tuv><tuv xml:lang="tr"><seg>Evet</seg></tuv></tu>`,
    )
    expect(parseTmx(xml, { targetLocale: 'tr' })).toEqual([{ source: 'Oui', target: 'Evet', locale: 'tr' }])
  })

  it('falls back to the first non-target tuv when srclang is absent', () => {
    const xml = `<tmx version="1.4"><header creationtool="x"/><body>${tu('Yes', 'Evet')}</body></tmx>`
    expect(parseTmx(xml, { targetLocale: 'tr' })).toEqual([{ source: 'Yes', target: 'Evet', locale: 'tr' }])
  })
})

describe('parseTmx shape handling', () => {
  it('handles a body containing a single tu', () => {
    const xml = tmx(tu('One', 'Bir'))
    expect(parseTmx(xml, { targetLocale: 'tr' })).toEqual([{ source: 'One', target: 'Bir', locale: 'tr' }])
  })

  it('handles a tu with a single tuv without crashing', () => {
    const xml = tmx('<tu><tuv xml:lang="en"><seg>Solo</seg></tuv></tu>')
    expect(parseTmx(xml, { targetLocale: 'tr' })).toEqual([])
  })

  it('uses the first matching target tuv when several exist', () => {
    const xml = tmx(
      `<tu><tuv xml:lang="en"><seg>Hi</seg></tuv><tuv xml:lang="tr"><seg>Selam</seg></tuv><tuv xml:lang="tr-TR"><seg>Merhaba</seg></tuv></tu>`,
    )
    expect(parseTmx(xml, { targetLocale: 'tr' })).toEqual([{ source: 'Hi', target: 'Selam', locale: 'tr' }])
  })

  it('accepts a UTF-8 byte order mark before the XML declaration', () => {
    const xml = '\uFEFF' + tmx(tu('Yes', 'Evet'))
    expect(parseTmx(xml, { targetLocale: 'tr' })).toEqual([{ source: 'Yes', target: 'Evet', locale: 'tr' }])
  })

  it('handles 20k translation units', () => {
    const count = 20_000
    const body = Array.from({ length: count }, (_, i) => tu(`Source ${i}`, `Kaynak ${i}`)).join('')
    const entries = parseTmx(tmx(body), { targetLocale: 'tr' })
    expect(entries).toHaveLength(count)
    expect(entries[0]).toEqual({ source: 'Source 0', target: 'Kaynak 0', locale: 'tr' })
    expect(entries[count - 1]).toEqual({ source: `Source ${count - 1}`, target: `Kaynak ${count - 1}`, locale: 'tr' })
  })

  it.each(['<tmx><body><tu>', '<tmx><body></tmx>', '<tmx><body><tu></body></tmx>', 'not xml'])(
    'throws on malformed XML %s instead of returning partial data',
    (xml) => {
      expect(() => parseTmx(xml, { targetLocale: 'tr' })).toThrow(/invalid tmx/i)
    },
  )

  it('throws when the root is not a tmx document', () => {
    expect(() => parseTmx('<html><body>hi</body></html>', { targetLocale: 'tr' })).toThrow(/tmx/i)
  })
})

describe('parseTmx context and project', () => {
  it('reads context from prop type="x-context"', () => {
    const xml = tmx(tu('Post', 'Gönder', 'en', 'tr', '<prop type="x-context">verb</prop>'))
    expect(parseTmx(xml, { targetLocale: 'tr' })[0]).toMatchObject({ context: 'verb' })
  })

  it('reads context from note when no x-context prop exists', () => {
    const xml = tmx(tu('Post', 'Gönder', 'en', 'tr', '<note>noun</note>'))
    expect(parseTmx(xml, { targetLocale: 'tr' })[0]).toMatchObject({ context: 'noun' })
  })

  it('prefers x-context prop over note and ignores other props', () => {
    const xml = tmx(
      tu('Post', 'Gönder', 'en', 'tr', '<prop type="x-other">junk</prop><note>noun</note><prop type="x-context">verb</prop>'),
    )
    expect(parseTmx(xml, { targetLocale: 'tr' })[0]).toMatchObject({ context: 'verb' })
  })

  it('omits context when neither prop nor note is present', () => {
    const entry = parseTmx(tmx(tu('A', 'B')), { targetLocale: 'tr' })[0]
    expect(entry).not.toHaveProperty('context')
  })

  it('sets project from opts and ignores creationtool everywhere', () => {
    const xml = tmx(`<tu creationtool="Poedit">${tu('A', 'B').slice(4)}`, 'en', 'creationtoolversion="3.5.2"')
    expect(xml).toContain('creationtool="Poedit"')
    expect(parseTmx(xml, { targetLocale: 'tr', project: 'woocommerce' })).toEqual([
      { source: 'A', target: 'B', locale: 'tr', project: 'woocommerce' },
    ])
    expect(parseTmx(xml, { targetLocale: 'tr' })[0]).not.toHaveProperty('project')
  })
})

describe('loadTmx', () => {
  it('reads and parses a file from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'polyglots-tmx-'))
    const file = join(dir, 'mem.tmx')
    await writeFile(file, tmx(tu('File', 'Dosya')), 'utf8')
    expect(await loadTmx(file, { targetLocale: 'tr', project: 'p' })).toEqual([
      { source: 'File', target: 'Dosya', locale: 'tr', project: 'p' },
    ])
  })

  it.each([
    ['UTF-8 with BOM', (s: string) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf8')])],
    ['UTF-16 LE with BOM', (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')])],
    ['UTF-16 BE with BOM', (s: string) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(s, 'utf16le').swap16()])],
    ['UTF-16 LE without BOM', (s: string) => Buffer.from(s, 'utf16le')],
    ['UTF-16 BE without BOM', (s: string) => Buffer.from(s, 'utf16le').swap16()],
  ])('decodes a %s file', async (_name, encode) => {
    const dir = await mkdtemp(join(tmpdir(), 'polyglots-tmx-'))
    const file = join(dir, 'mem.tmx')
    const xml = tmx(tu('Yes', 'Evet')).replace('encoding="UTF-8"', 'encoding="UTF-16"')
    await writeFile(file, encode(xml))
    expect(await loadTmx(file, { targetLocale: 'tr' })).toEqual([{ source: 'Yes', target: 'Evet', locale: 'tr' }])
  })

  it('parses the checked-in fixture', async () => {
    const entries = await loadTmx(FIXTURE, { targetLocale: 'tr' })
    expect(entries).toHaveLength(5)
  })

  it('rejects for a missing file', async () => {
    await expect(loadTmx('/nonexistent/polyglots/x.tmx', { targetLocale: 'tr' })).rejects.toThrow()
  })
})
