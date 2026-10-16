import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { po as gettextPo } from 'gettext-parser'
import { loadPo } from '../../src/po/po-file.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, '..', 'fixtures', 'po', 'sample.po')
const edgeFixture = join(here, '..', 'fixtures', 'po', 'edge.po')

function entryOrder(text: string): string[] {
  return [...text.matchAll(/^#: (.*)$/gm)].map((m) => m[1])
}

const CTX = '\u0004'

describe('loadPo', () => {
  it('reads nplurals from the Plural-Forms header', async () => {
    const file = await loadPo(fixture)
    expect(file.nplurals).toBe(2)
    expect(file.headers['Language']).toBe('tr')
  })

  it('defaults nplurals to 2 when the header is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'polyglots-po-'))
    const path = join(dir, 'no-plural.po')
    const src = (await readFile(fixture, 'utf8')).replace(/"Plural-Forms:[^\n]*\n/, '')
    expect(src).not.toContain('Plural-Forms')
    await writeFile(path, src)
    const file = await loadPo(path)
    expect(file.nplurals).toBe(2)
    await rm(dir, { recursive: true, force: true })
  })

  // The raw header, so the prompts can carry the expression that says which
  // form is which, and undefined when absent rather than a guessed default.
  it('keeps the raw Plural-Forms header, and says whether there are plural entries', async () => {
    const file = await loadPo(fixture)
    expect(file.pluralForms).toMatch(/^nplurals=2;/)
    expect(file.hasPlurals()).toBe(true)
    const dir = await mkdtemp(join(tmpdir(), 'polyglots-po-'))
    const path = join(dir, 'no-plural.po')
    await writeFile(path, (await readFile(fixture, 'utf8')).replace(/"Plural-Forms:[^\n]*\n/, ''))
    expect((await loadPo(path)).pluralForms).toBeUndefined()
    const singular = join(dir, 'singular.po')
    await writeFile(singular, 'msgid ""\nmsgstr ""\n"Language: tr\\n"\n\nmsgid "Save"\nmsgstr "Kaydet"\n')
    expect((await loadPo(singular)).hasPlurals()).toBe(false)
    await rm(dir, { recursive: true, force: true })
  })

  it('parses a 3-form Plural-Forms header', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'polyglots-po-'))
    const path = join(dir, 'three.po')
    const src = (await readFile(fixture, 'utf8')).replace(
      /"Plural-Forms:[^\n]*\n/,
      '"Plural-Forms: nplurals=3; plural=(n==1 ? 0 : n>=2 && n<=4 ? 1 : 2);\\n"\n',
    )
    await writeFile(path, src)
    const file = await loadPo(path)
    expect(file.nplurals).toBe(3)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('PoFile.units', () => {
  it('lists every non-header entry in "all" mode', async () => {
    const file = await loadPo(fixture)
    const all = file.units('all')
    expect(all).toHaveLength(12)
    expect(all.map((u) => u.msgid)).not.toContain('')
  })

  it('selects empty and fuzzy entries in "pending" mode', async () => {
    const file = await loadPo(fixture)
    const keys = file.units('pending').map((u) => u.key)
    expect(keys.sort()).toEqual(
      [
        'Save Changes',
        'Form entries',
        `post type singular name${CTX}Form`,
        'One submission was deleted.',
        'Thank you for installing %s.',
        'Drag fields from the left panel onto the canvas to build your form. You can reorder fields at any time.',
        'You have %1$s new entries. <a href="%2$s">View them</a>.',
      ].sort(),
    )
    expect(keys).not.toContain('Settings')
    expect(keys).not.toContain('%d entry')
    expect(keys).not.toContain(`post type general name${CTX}Forms`)
  })

  it('treats a plural entry with only some slots filled as translated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'polyglots-po-'))
    const path = join(dir, 'partial.po')
    const src = (await readFile(fixture, 'utf8')).replace(
      'msgstr[0] ""\nmsgstr[1] ""',
      'msgstr[0] "Bir gönderim silindi."\nmsgstr[1] ""',
    )
    await writeFile(path, src)
    const file = await loadPo(path)
    expect(file.units('pending').map((u) => u.key)).not.toContain('One submission was deleted.')
    await rm(dir, { recursive: true, force: true })
  })

  it('derives the key with msgctxt using the gettext separator', async () => {
    const file = await loadPo(fixture)
    const unit = file.units('all').find((u) => u.msgctxt === 'post type singular name')
    expect(unit).toBeDefined()
    expect(unit!.key).toBe(`post type singular name${CTX}Form`)
    expect(unit!.msgid).toBe('Form')
    const plain = file.units('all').find((u) => u.msgid === 'Settings')
    expect(plain!.key).toBe('Settings')
    expect(plain!.msgctxt).toBeUndefined()
  })

  it('exposes msgidPlural, comments and split references', async () => {
    const file = await loadPo(fixture)
    const all = file.units('all')
    const plural = all.find((u) => u.msgid === 'One submission was deleted.')!
    expect(plural.msgidPlural).toBe('%d submissions were deleted.')

    const withExtracted = all.find((u) => u.msgid === 'Thank you for installing %s.')!
    expect(withExtracted.comments).toEqual(['translators: %s: plugin name'])
    expect(withExtracted.references).toEqual(['includes/admin/notices.php:18'])

    const withTranslator = all.find((u) => u.msgid === 'Powered by Sample Forms')!
    expect(withTranslator.comments).toEqual(['Keep the brand name untranslated.'])

    const multiRef = all.find((u) => u.msgid.startsWith('Drag fields'))!
    expect(multiRef.references).toEqual(['includes/admin/help.php:12', 'includes/admin/help.php:47'])
    expect(multiRef.msgid).toBe(
      'Drag fields from the left panel onto the canvas to build your form. You can reorder fields at any time.',
    )

    const html = all.find((u) => u.msgid.startsWith('You have'))!
    expect(html.msgid).toBe('You have %1$s new entries. <a href="%2$s">View them</a>.')
    expect(html.comments).toEqual(['translators: 1: number of entries, 2: link to the entries page'])
  })
})

describe('PoFile.apply', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'polyglots-po-'))
    path = join(dir, 'sample.po')
    await copyFile(fixture, path)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes a single msgstr and marks non-fuzzy', async () => {
    const file = await loadPo(path)
    file.apply([{ key: 'Save Changes', text: ['Değişiklikleri Kaydet'], fuzzy: false }])
    const entry = file.raw.translations['']['Save Changes']
    expect(entry.msgstr).toEqual(['Değişiklikleri Kaydet'])
    expect(entry.comments?.flag ?? '').not.toContain('fuzzy')
    expect(file.units('pending').map((u) => u.key)).not.toContain('Save Changes')
  })

  it('writes a plural array respecting nplurals', async () => {
    const file = await loadPo(path)
    file.apply([
      { key: 'One submission was deleted.', text: ['Bir gönderim silindi.', '%d gönderim silindi.'], fuzzy: false },
    ])
    const entry = file.raw.translations['']['One submission was deleted.']
    expect(entry.msgstr).toEqual(['Bir gönderim silindi.', '%d gönderim silindi.'])
  })

  it('pads or truncates plural text to nplurals', async () => {
    const file = await loadPo(path)
    file.apply([{ key: 'One submission was deleted.', text: ['Tek'], fuzzy: true }])
    expect(file.raw.translations['']['One submission was deleted.'].msgstr).toEqual(['Tek', ''])
    file.apply([{ key: '%d entry', text: ['a', 'b', 'c'], fuzzy: false }])
    expect(file.raw.translations['']['%d entry'].msgstr).toEqual(['a', 'b'])
  })

  it('uses only text[0] for a singular entry even if more strings are given', async () => {
    const file = await loadPo(path)
    file.apply([{ key: 'Save Changes', text: ['Kaydet', 'ignored'], fuzzy: false }])
    expect(file.raw.translations['']['Save Changes'].msgstr).toEqual(['Kaydet'])
  })

  it('addresses entries by msgctxt key', async () => {
    const file = await loadPo(path)
    file.apply([{ key: `post type singular name${CTX}Form`, text: ['Form'], fuzzy: false }])
    expect(file.raw.translations['post type singular name']['Form'].msgstr).toEqual(['Form'])
    expect(file.raw.translations['post type general name']['Forms'].msgstr).toEqual(['Formlar'])
  })

  it('sets the fuzzy flag while preserving php-format', async () => {
    const file = await loadPo(path)
    file.apply([{ key: 'Thank you for installing %s.', text: ['%s yüklediğiniz için teşekkürler.'], fuzzy: true }])
    const flag = file.raw.translations['']['Thank you for installing %s.'].comments?.flag ?? ''
    const flags = flag.split(',').map((f) => f.trim())
    expect(flags).toContain('php-format')
    expect(flags).toContain('fuzzy')
    expect(file.units('pending').map((u) => u.key)).toContain('Thank you for installing %s.')
  })

  it('clears the fuzzy flag and leaves no empty flag comment', async () => {
    const file = await loadPo(path)
    file.apply([{ key: 'Form entries', text: ['Form kayıtları'], fuzzy: false }])
    const entry = file.raw.translations['']['Form entries']
    expect(entry.comments?.flag).toBeUndefined()
    expect(file.units('pending').map((u) => u.key)).not.toContain('Form entries')
  })

  it('clears fuzzy but keeps other flags', async () => {
    const src = (await readFile(path, 'utf8')).replace('#, fuzzy\nmsgid "Form entries"', '#, fuzzy, php-format\nmsgid "Form entries"')
    await writeFile(path, src)
    const file = await loadPo(path)
    file.apply([{ key: 'Form entries', text: ['Form kayıtları'], fuzzy: false }])
    expect(file.raw.translations['']['Form entries'].comments?.flag).toBe('php-format')
  })

  it('does not leave a multi-line reason behind as an unowned comment', async () => {
    const file = await loadPo(path)
    const key = 'Thank you for installing %s.'
    file.apply([{ key, text: ['%s icin tesekkurler.'], fuzzy: true, reason: 'first line\nsecond line' }])
    // Written as one note, so the second half cannot be mistaken for a comment
    // the contributor wrote, which setNotes would then preserve for good.
    expect(file.raw.translations[''][key].comments?.translator).toBe('polyglots: first line second line')
    file.apply([{ key, text: ['%s icin tesekkurler.'], fuzzy: false }])
    expect(file.raw.translations[''][key].comments?.translator).toBeUndefined()
  })

  it('writes the notes of a non-fuzzy entry as translator comments', async () => {
    const file = await loadPo(path)
    file.apply([{ key: 'Save Changes', text: ['Değişiklikleri Kaydet'], fuzzy: false, notes: ['polyglots: locale rule: two words'] }])
    expect(file.raw.translations['']['Save Changes'].comments?.translator).toBe('polyglots: locale rule: two words')
  })

  // The notes say what a rule changed, the reason why a human must look; the
  // change comes first because the reason is often about the changed text.
  it('writes the notes before the reason of a fuzzy entry', async () => {
    const file = await loadPo(path)
    const key = 'Thank you for installing %s.'
    file.apply([{ key, text: ['%s yüklediğiniz için teşekkürler.'], fuzzy: true, reason: 'check the tone', notes: ['locale rule: two words'] }])
    expect(file.raw.translations[''][key].comments?.translator).toBe('polyglots: locale rule: two words\npolyglots: check the tone')
  })

  it('ignores unknown keys and does not touch other entries', async () => {
    const file = await loadPo(path)
    const before = structuredClone(file.raw.translations)
    file.apply([{ key: 'does not exist', text: ['x'], fuzzy: false }])
    expect(file.raw.translations).toEqual(before)
  })
})

describe('PoFile.save', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'polyglots-po-'))
    path = join(dir, 'sample.po')
    await copyFile(fixture, path)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips the fixture with identical parsed structure', async () => {
    const original = gettextPo.parse(await readFile(fixture))
    const file = await loadPo(path)
    await file.save()
    const reparsed = gettextPo.parse(await readFile(path))
    const withoutHeaderText = (t: typeof original.translations) => ({
      ...t,
      '': { ...t[''], '': { ...t[''][''], msgstr: [] } },
    })
    expect(withoutHeaderText(reparsed.translations)).toEqual(withoutHeaderText(original.translations))
    expect(reparsed.translations[''][''].comments?.translator).toBe(
      'Translation of Plugins - Sample Forms - Stable (latest release) in Turkish\n' +
        'This file is distributed under the same license as the Plugins - Sample Forms - Stable (latest release) package.',
    )
    expect(reparsed.charset).toBe(original.charset)
    const { 'PO-Revision-Date': _a, 'X-Generator': _b, 'Content-Type': ctOriginal, ...restOriginal } = original.headers
    const { 'PO-Revision-Date': _c, 'X-Generator': _d, 'Content-Type': ctReparsed, ...restReparsed } = reparsed.headers
    expect(restReparsed).toEqual(restOriginal)
    expect(ctReparsed.toLowerCase()).toBe(ctOriginal.toLowerCase())
  })

  it('is stable across a second load and save', async () => {
    const file = await loadPo(path)
    await file.save()
    const first = await readFile(path, 'utf8')
    const again = await loadPo(path)
    await again.save()
    const second = await readFile(path, 'utf8')
    expect(second.replace(/PO-Revision-Date:[^\n]*/, '')).toBe(first.replace(/PO-Revision-Date:[^\n]*/, ''))
  })

  it('updates PO-Revision-Date and X-Generator', async () => {
    const file = await loadPo(path)
    await file.save()
    const reparsed = gettextPo.parse(await readFile(path))
    expect(reparsed.headers['X-Generator']).toBe('polyglots')
    expect(reparsed.headers['PO-Revision-Date']).not.toBe('2026-09-01 12:00+0000')
    expect(reparsed.headers['PO-Revision-Date']).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\+0000$/)
  })

  // The review marker rides in a header, so a header set on the object has to
  // survive the compile.
  it('writes a header set on the loaded file', async () => {
    const file = await loadPo(path)
    file.setHeader('X-Polyglots-Review', '{"done":3}')
    await file.save()
    expect(gettextPo.parse(await readFile(path)).headers['X-Polyglots-Review']).toBe('{"done":3}')
  })

  it('leaves no temp file behind and updates the target', async () => {
    const file = await loadPo(path)
    file.apply([{ key: 'Save Changes', text: ['Değişiklikleri Kaydet'], fuzzy: false }])
    await file.save()
    expect(await readdir(dir)).toEqual(['sample.po'])
    const reparsed = gettextPo.parse(await readFile(path))
    expect(reparsed.translations['']['Save Changes'].msgstr).toEqual(['Değişiklikleri Kaydet'])
    expect(reparsed.translations['']['Form entries'].comments?.flag).toBe('fuzzy')
  })

  it('persists applied plurals, fuzzy flags and preserved flags', async () => {
    const file = await loadPo(path)
    file.apply([
      { key: 'One submission was deleted.', text: ['Bir gönderim silindi.', '%d gönderim silindi.'], fuzzy: false },
      { key: 'Thank you for installing %s.', text: ['%s yüklediğiniz için teşekkürler.'], fuzzy: true },
      { key: 'Form entries', text: ['Form kayıtları'], fuzzy: false },
    ])
    await file.save()
    const text = await readFile(path, 'utf8')
    expect(text).toContain('msgstr[0] "Bir gönderim silindi."\nmsgstr[1] "%d gönderim silindi."')
    expect(text).toMatch(/#, (fuzzy, php-format|php-format, fuzzy)\nmsgid "Thank you for installing %s\."/)
    expect(text).toContain('#: includes/admin/class-settings.php:73\nmsgid "Form entries"\nmsgstr "Form kayıtları"')
    const reloaded = await loadPo(path)
    expect(reloaded.units('pending').map((u) => u.key).sort()).toEqual(
      [
        'Save Changes',
        `post type singular name${CTX}Form`,
        'Thank you for installing %s.',
        'Drag fields from the left panel onto the canvas to build your form. You can reorder fields at any time.',
        'You have %1$s new entries. <a href="%2$s">View them</a>.',
      ].sort(),
    )
  })

  it('saves to an explicit path without touching the source', async () => {
    const file = await loadPo(path)
    const out = join(dir, 'out.po')
    file.apply([{ key: 'Save Changes', text: ['Kaydet'], fuzzy: false }])
    await file.save(out)
    expect(await readFile(path, 'utf8')).toBe(await readFile(fixture, 'utf8'))
    expect(gettextPo.parse(await readFile(out)).translations['']['Save Changes'].msgstr).toEqual(['Kaydet'])
    expect((await readdir(dir)).sort()).toEqual(['out.po', 'sample.po'])
  })
})

describe('PoFile.save filesystem behaviour', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'polyglots-po-'))
    path = join(dir, 'sample.po')
    await copyFile(fixture, path)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes through a symlink into the real target and keeps the link', async () => {
    const real = join(dir, 'real.po')
    await copyFile(fixture, real)
    await mkdir(join(dir, 'links'))
    const link = join(dir, 'links', 'link.po')
    await symlink(real, link)

    const file = await loadPo(link)
    file.apply([{ key: 'Save Changes', text: ['Kaydet'], fuzzy: false }])
    await file.save()

    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(gettextPo.parse(await readFile(real)).translations['']['Save Changes'].msgstr).toEqual(['Kaydet'])
    expect(await readdir(join(dir, 'links'))).toEqual(['link.po'])
    expect((await readdir(dir)).sort()).toEqual(['links', 'real.po', 'sample.po'])
  })

  it('preserves the file mode of the target', async () => {
    await chmod(path, 0o600)
    const file = await loadPo(path)
    await file.save()
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('removes the temp file and rethrows when the rename fails', async () => {
    const blocker = join(dir, 'blocker')
    await mkdir(blocker)
    await writeFile(join(blocker, 'keep'), '')
    const file = await loadPo(path)
    await expect(file.save(blocker)).rejects.toThrow()
    expect((await readdir(dir)).sort()).toEqual(['blocker', 'sample.po'])
  })

  it('does not stamp in-memory headers when the save fails', async () => {
    const blocker = join(dir, 'blocker')
    await mkdir(blocker)
    await writeFile(join(blocker, 'keep'), '')
    const file = await loadPo(path)
    await expect(file.save(blocker)).rejects.toThrow()
    expect(file.headers['PO-Revision-Date']).toBe('2026-09-01 12:00+0000')
    expect(file.headers['X-Generator']).toBe('GlotPress/4.0.1')
  })

  it('does not stamp in-memory headers on save-as, but does after saving its own path', async () => {
    const file = await loadPo(path)
    await file.save(join(dir, 'out.po'))
    expect(file.headers['PO-Revision-Date']).toBe('2026-09-01 12:00+0000')
    expect(file.headers['X-Generator']).toBe('GlotPress/4.0.1')
    expect(gettextPo.parse(await readFile(join(dir, 'out.po'))).headers['X-Generator']).toBe('polyglots')

    await file.save(undefined, new Date('2026-09-07T10:30:00Z'))
    expect(file.headers['PO-Revision-Date']).toBe('2026-09-07 10:30+0000')
    expect(file.headers['X-Generator']).toBe('polyglots')
  })
})

describe('PoFile edge cases', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'polyglots-po-'))
    path = join(dir, 'edge.po')
    await copyFile(edgeFixture, path)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('preserves source entry order, including integer-like msgids and interleaved msgctxt', async () => {
    const file = await loadPo(path)
    await file.save()
    const saved = await readFile(path, 'utf8')
    const originalOrder = entryOrder(await readFile(edgeFixture, 'utf8'))
    expect(originalOrder).toHaveLength(8)
    expect(entryOrder(saved)).toEqual(originalOrder)
    expect(saved.indexOf('#~ msgid "Old string"')).toBeLessThan(saved.indexOf('#~ msgctxt "legacy"'))
    expect(file.units('all').map((u) => u.key)).toEqual([
      'Zebra',
      `pagination${CTX}10`,
      '10',
      'Apple',
      '1',
      'Line one\nLine two\t"quoted" \\ backslash',
      '%d item',
      `verb${CTX}Post`,
    ])
  })

  it('keeps obsolete entries across save', async () => {
    const file = await loadPo(path)
    expect(file.units('all').map((u) => u.msgid)).not.toContain('Old string')
    file.apply([{ key: 'Zebra', text: ['Zebra'], fuzzy: false }])
    await file.save()
    const saved = await readFile(path, 'utf8')
    expect(saved).toContain('#~ msgid "Old string"\n#~ msgstr "Eski dize"')
    expect(saved).toContain('#~ msgctxt "legacy"\n#~ msgid "Old context"\n#~ msgstr ""')
    const reparsed = gettextPo.parse(await readFile(path))
    expect(reparsed.obsolete?.['']['Old string'].msgstr).toEqual(['Eski dize'])
    expect(reparsed.obsolete?.['legacy']['Old context']).toBeDefined()
  })

  it('round-trips escape sequences in msgid and msgstr', async () => {
    const key = 'Line one\nLine two\t"quoted" \\ backslash'
    const file = await loadPo(path)
    expect(file.units('pending').map((u) => u.msgid)).toContain(key)
    file.apply([{ key, text: ['Satır bir\nSatır iki\t"alıntı" \\ ters bölü'], fuzzy: false }])
    await file.save()
    const saved = await readFile(path, 'utf8')
    expect(saved).toContain('msgid ""\n"Line one\\n"\n"Line two\\t\\"quoted\\" \\\\ backslash"')
    expect(saved).toContain('msgstr ""\n"Satır bir\\n"\n"Satır iki\\t\\"alıntı\\" \\\\ ters bölü"')
    const reloaded = await loadPo(path)
    expect(reloaded.raw.translations[''][key].msgstr).toEqual(['Satır bir\nSatır iki\t"alıntı" \\ ters bölü'])
  })

  it('treats a plural entry with a bare msgstr as pending and applies every form', async () => {
    const file = await loadPo(path)
    const unit = file.units('pending').find((u) => u.key === '%d item')
    expect(unit?.msgidPlural).toBe('%d items')
    file.apply([{ key: '%d item', text: ['%d öğe', '%d öğe'], fuzzy: false }])
    await file.save()
    const saved = await readFile(path, 'utf8')
    expect(saved).toContain('msgid "%d item"\nmsgid_plural "%d items"\nmsgstr[0] "%d öğe"\nmsgstr[1] "%d öğe"')
    expect((await loadPo(path)).units('pending').map((u) => u.key)).not.toContain('%d item')
  })

  it('splits a single-line multi-reference on whitespace', async () => {
    const src = (await readFile(path, 'utf8')).replace('#: includes/pager.php:10', '#: includes/a.php:1 includes/b.php:2')
    await writeFile(path, src)
    const file = await loadPo(path)
    expect(file.units('all').find((u) => u.key === 'Zebra')?.references).toEqual(['includes/a.php:1', 'includes/b.php:2'])
  })

  it('normalises comment layout the way gettext-parser emits it', async () => {
    const file = await loadPo(join(dirname(edgeFixture), 'sample.po'))
    await file.save(path)
    const saved = await readFile(path, 'utf8')
    expect(saved).toContain('#: includes/admin/notices.php:18\n#. translators: %s: plugin name\n#, php-format\nmsgid "Thank you for installing %s."')
    expect(saved).toContain('# Keep the brand name untranslated.\n#: includes/admin/notices.php:31')
  })
})

describe('PoFile with a non-UTF-8 charset', () => {
  it('keeps source order for non-ASCII msgids in an ISO-8859-9 file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'polyglots-po-'))
    const path = join(dir, 'latin5.po')
    const src =
      'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=ISO-8859-9\\n"\n"Plural-Forms: nplurals=2; plural=(n > 1);\\n"\n\n' +
      '#: a.php:1\nmsgid "Über"\nmsgstr ""\n\n#: a.php:2\nmsgid "7"\nmsgstr ""\n\n#: a.php:3\nmsgid "Ende"\nmsgstr ""\n'
    await writeFile(path, Buffer.from(src, 'latin1'))
    const file = await loadPo(path)
    expect(file.raw.charset).toBe('iso-8859-9')
    expect(file.units('all').map((u) => u.msgid)).toEqual(['Über', '7', 'Ende'])
    file.apply([{ key: 'Über', text: ['Üzerinde'], fuzzy: false }])
    await file.save()
    const saved = (await readFile(path)).toString('latin1')
    expect(entryOrder(saved)).toEqual(['a.php:1', 'a.php:2', 'a.php:3'])
    expect(saved).toContain('msgid "Über"\nmsgstr "Üzerinde"')
    await rm(dir, { recursive: true, force: true })
  })
})
