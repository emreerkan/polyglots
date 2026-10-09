import { describe, expect, it } from 'vitest'
import type { AuditEntry, GlossaryEntry } from '../../src/types.js'
import { buildRuleContext, runRules, tmKey } from '../../src/audit/rules/index.js'
import { profileFor } from '../../src/audit/rules/profiles.js'

const GLOSSARY: GlossaryEntry[] = [
  { locale: 'tr', sourceTerm: 'sidebar', translation: 'kenar çubuğu', partOfSpeech: 'noun' },
  { locale: 'tr', sourceTerm: 'author', translation: 'yazar', partOfSpeech: 'noun' },
  { locale: 'tr', sourceTerm: 'author', translation: 'geliştirici', partOfSpeech: 'noun' },
  { locale: 'tr', sourceTerm: 'book', translation: 'kitap', partOfSpeech: 'noun' },
]

function entry(msgid: string, msgstr: string | string[], extra: Partial<AuditEntry> = {}): AuditEntry {
  return {
    key: msgid,
    msgid,
    msgstr: Array.isArray(msgstr) ? msgstr : [msgstr],
    comments: [],
    references: [],
    fuzzy: false,
    ...extra,
  }
}

function check(e: AuditEntry, all: AuditEntry[] = [e]) {
  const ctx = buildRuleContext({ locale: 'tr', glossary: GLOSSARY, nplurals: 2, entries: all })
  return runRules(e, ctx)
}

const rules = (e: AuditEntry, all?: AuditEntry[]) => check(e, all).map((f) => f.rule)
const severityOf = (e: AuditEntry, rule: string) => check(e).find((f) => f.rule === rule)?.severity

describe('rule profiles', () => {
  function forLocale(locale: string, msgid: string, msgstr: string) {
    const e = { key: msgid, msgid, msgstr: [msgstr], comments: [], references: [], fuzzy: false }
    const ctx = buildRuleContext({ locale, glossary: [], nplurals: 2, entries: [e] })
    return runRules(e, ctx).map((f) => f.rule)
  }

  it('runs the Turkish-specific rules for tr', () => {
    expect(profileFor('tr').rules.has('title-case')).toBe(true)
    expect(profileFor('tr').rules.has('apostrophe')).toBe(true)
  })

  // German capitalizes every noun by rule, so title-case would flag correct
  // translations wholesale. A locale with no profile gets the universal subset.
  it('leaves title-case and apostrophe out for a locale with no profile', () => {
    expect(profileFor('de').rules.has('title-case')).toBe(false)
    expect(profileFor('de').rules.has('apostrophe')).toBe(false)
  })

  it('does not flag German noun capitalization', () => {
    expect(forLocale('de', 'Save All Changes', 'Alle Änderungen Speichern')).not.toContain('title-case')
  })

  it('still runs the language-agnostic rules for a locale with no profile', () => {
    expect(forLocale('de', '%s comments', 'Kommentare')).toContain('placeholder')
    expect(forLocale('de', 'Read <a>more</a>', 'Mehr lesen')).toContain('html')
  })

  it('resolves a regional locale through its language subtag', () => {
    expect(profileFor('tr-TR').rules.has('title-case')).toBe(true)
    expect(profileFor('pt-br').rules.has('title-case')).toBe(false)
  })

  it('carries a glossary stem tolerance the profile can tune', () => {
    expect(profileFor('tr').glossaryStemRatio).toBeGreaterThan(0)
    expect(profileFor('de').glossaryStemRatio).toBeGreaterThan(0)
  })
})

describe('placeholder rule', () => {
  it('flags a dropped placeholder as an error', () => {
    expect(rules(entry('%s comments', 'yorumlar'))).toContain('placeholder')
    expect(severityOf(entry('%s comments', 'yorumlar'), 'placeholder')).toBe('error')
  })

  it('flags an added placeholder the source never had', () => {
    expect(rules(entry('Comments', '%s yorum'))).toContain('placeholder')
  })

  it('accepts placeholders that survive, including positional ones', () => {
    expect(rules(entry('%1$s of %2$s', '%2$s içinde %1$s'))).not.toContain('placeholder')
  })
})

describe('html rule', () => {
  it('flags a dropped tag', () => {
    expect(rules(entry('Read <a href="%s">more</a>', 'Daha fazlasını oku'))).toContain('html')
  })

  it('accepts tags that survive in a different order', () => {
    expect(rules(entry('<strong>Save</strong> now', 'Şimdi <strong>kaydet</strong>'))).not.toContain('html')
  })
})

describe('plural-count rule', () => {
  it('flags a plural entry missing a form', () => {
    const e = entry('%s comment', ['%s yorum'], { msgidPlural: '%s comments' })
    expect(rules(e)).toContain('plural-count')
    expect(severityOf(e, 'plural-count')).toBe('error')
  })

  it('accepts a plural entry with both forms', () => {
    const e = entry('%s comment', ['%s yorum', '%s yorum'], { msgidPlural: '%s comments' })
    expect(rules(e)).not.toContain('plural-count')
  })
})

describe('whitespace rule', () => {
  it('flags a lost trailing space', () => {
    expect(rules(entry('Posted by ', 'Yazan'))).toContain('whitespace')
  })

  it('accepts matching whitespace', () => {
    expect(rules(entry('Posted by ', 'Yazan '))).not.toContain('whitespace')
  })
})

describe('untranslated rule', () => {
  it('flags a translation identical to the source as a suspect', () => {
    expect(rules(entry('Settings', 'Settings'))).toContain('untranslated')
    expect(severityOf(entry('Settings', 'Settings'), 'untranslated')).toBe('suspect')
  })

  it('ignores an empty translation, which is simply unsubmitted', () => {
    expect(rules(entry('Settings', ''))).not.toContain('untranslated')
  })
})

describe('punctuation rule', () => {
  it('flags a lost trailing colon', () => {
    expect(rules(entry('Name:', 'Ad'))).toContain('punctuation')
  })

  it('accepts a preserved ellipsis', () => {
    expect(rules(entry('Loading…', 'Yükleniyor…'))).not.toContain('punctuation')
  })
})

describe('title-case rule', () => {
  it('flags a translation mirroring English title case', () => {
    expect(rules(entry('Save All Changes', 'Tüm Değişiklikleri Kaydet'))).toContain('title-case')
  })

  it('flags a translation that title-cases a sentence-case source', () => {
    expect(rules(entry('Save changes', 'Değişiklikleri Kaydet'))).toContain('title-case')
  })

  it('accepts normal Turkish sentence case', () => {
    expect(rules(entry('Save All Changes', 'Tüm değişiklikleri kaydet'))).not.toContain('title-case')
  })

  it('does not count allowlisted brands as title case', () => {
    expect(rules(entry('WordPress Themes', 'WordPress temaları'))).not.toContain('title-case')
  })

  it('does not count acronyms', () => {
    expect(rules(entry('Export CSV', 'CSV dışa aktar'))).not.toContain('title-case')
  })

  it('treats a mid-sentence capital in a sentence-case source as a proper noun', () => {
    expect(rules(entry('Connect your Google Analytics account', 'Google Analytics hesabınızı bağlayın'))).not.toContain(
      'title-case',
    )
  })

  it('does not flag a single-word translation', () => {
    expect(rules(entry('Settings', 'Ayarlar'))).not.toContain('title-case')
  })
})

describe('title-case rule, Turkish capitalization categories', () => {
  it('does not flag a word starting a new sentence', () => {
    expect(rules(entry('It failed. Contact support.', 'Bir şey oldu. Ayrıntılar için destek ile görüşün.'))).not.toContain(
      'title-case',
    )
  })

  it('does not flag a word after a colon or question mark', () => {
    expect(rules(entry('Note: check your settings', 'Not: Ayarlarınızı kontrol edin'))).not.toContain('title-case')
    expect(rules(entry('Ready? Start now', 'Hazır mısınız? Şimdi başlayın'))).not.toContain('title-case')
  })

  it('does not flag an acronym carrying a Turkish suffix', () => {
    expect(rules(entry('Download the PDF now', "Şimdi PDF'yi indir"))).not.toContain('title-case')
    expect(rules(entry('Copy the URL', "Bağlantı URL'sini kopyala"))).not.toContain('title-case')
  })

  it('does not flag language and nationality names, which Turkish capitalizes', () => {
    expect(rules(entry('Set the language to English', 'Uygulama dilini İngilizce yap'))).not.toContain('title-case')
    expect(rules(entry('Turkish users', 'Türk kullanıcılar'))).not.toContain('title-case')
  })

  it('does not flag a day or month name in a specific date', () => {
    expect(rules(entry('Expires on 12 May', '12 Mayıs tarihinde sona erer'))).not.toContain('title-case')
    expect(rules(entry('Conquest of Istanbul', '29 Mayıs 1453 Salı günü fetih'))).not.toContain('title-case')
    expect(rules(entry('Starts on 25 June', 'Festival 25 Haziran\'da başlayacak'))).not.toContain('title-case')
  })

  // TDK madde Ç capitalizes a day or month name only in a specific date and keeps
  // it lowercase in generic use, so a capital without a date is a real error.
  it('flags a capitalized day or month name outside a specific date', () => {
    expect(rules(entry('Every Monday', 'Her Pazartesi'))).toContain('title-case')
    expect(rules(entry('We meet on Thursdays', 'Toplantıları Perşembe günleri yaparız'))).toContain('title-case')
    expect(rules(entry('Schools open in September', 'Okullar Eylülde açılır'))).toContain('title-case')
  })

  it('treats a placeholder next to a month name as the date number', () => {
    expect(rules(entry('Expires on %s May', '%s Mayıs tarihinde sona erer'))).not.toContain('title-case')
    expect(rules(entry('Expires %1$s %2$s', 'Mayıs %1$s tarihinde'))).not.toContain('title-case')
  })

  // A placeholder used to vanish before tokenizing, which made the word after it
  // look sentence-initial and hid a real mid-string capital.
  it('does not let a leading placeholder hide a capitalized word', () => {
    expect(rules(entry('Save %s', '%s Kaydet'))).toContain('title-case')
    expect(rules(entry('%s comments', '%s Yorum'))).toContain('title-case')
  })

  it('keeps language and nation names exempt regardless of any date context', () => {
    expect(rules(entry('Turkish users', 'Her gün Türk kullanıcılar'))).not.toContain('title-case')
  })

  it('still flags a genuine calque of English title case', () => {
    expect(rules(entry('Save All Changes', 'Tüm Değişiklikleri Kaydet'))).toContain('title-case')
  })

  it('still flags a capitalized ordinary word mid-sentence', () => {
    expect(rules(entry('Save changes', 'Değişiklikleri Kaydet'))).toContain('title-case')
  })
})

describe('title-case rule, user-supplied proper nouns', () => {
  function withNouns(msgid: string, msgstr: string, properNouns: string[]) {
    const e = entry(msgid, msgstr)
    const ctx = buildRuleContext({ locale: 'tr', glossary: GLOSSARY, nplurals: 2, entries: [e], properNouns })
    return runRules(e, ctx).map((f) => f.rule)
  }

  it('exempts a single-word name the user supplied', () => {
    expect(withNouns('Server in Izmir', 'Sunucu İzmir konumunda', ['İzmir'])).not.toContain('title-case')
  })

  // TDK capitalizes every word of an institution name, so a correct one looks
  // exactly like an English title-case calque unless it is matched as a phrase.
  it('exempts every word of a multi-word institution name', () => {
    expect(withNouns('Approved by TDK', 'Türk Dil Kurumu tarafından onaylandı', ['Türk Dil Kurumu'])).not.toContain(
      'title-case',
    )
  })

  it('exempts a phrase whose last word carries a Turkish suffix', () => {
    expect(withNouns('TDK decision', 'Türk Dil Kurumu\'nun kararı', ['Türk Dil Kurumu'])).not.toContain('title-case')
  })

  it('does not exempt a phrase word used on its own', () => {
    expect(withNouns('Language settings', 'Dil Ayarları', ['Türk Dil Kurumu'])).toContain('title-case')
  })

  it('matches the phrase case-insensitively in Turkish', () => {
    expect(withNouns('Historic event', 'Bu Kurtuluş Savaşı dönemidir', ['kurtuluş savaşı'])).not.toContain('title-case')
  })

  it('still flags an ordinary calque when a name list is present', () => {
    expect(withNouns('Save All Changes', 'Tüm Değişiklikleri Kaydet', ['İzmir'])).toContain('title-case')
  })
})

describe('glossary rule', () => {
  it('flags a translation ignoring the approved term', () => {
    const e = entry('Sidebar', 'Yan menü')
    expect(rules(e)).toContain('glossary')
    expect(severityOf(e, 'glossary')).toBe('suspect')
  })

  it('accepts the approved term carrying a Turkish suffix', () => {
    expect(rules(entry('Open the sidebar', 'Kenar çubuğunu aç'))).not.toContain('glossary')
  })

  it('accepts any of several approved alternatives', () => {
    expect(rules(entry('Author', 'Geliştirici'))).not.toContain('glossary')
    expect(rules(entry('Author', 'Yazar'))).not.toContain('glossary')
  })

  it('only fires when the source actually contains the term', () => {
    expect(rules(entry('Settings', 'Ayarlar'))).not.toContain('glossary')
  })

  it('matches the term on a word boundary, not inside another word', () => {
    expect(rules(entry('Bookmark this', 'Bunu işaretle'))).not.toContain('glossary')
  })
})

describe('apostrophe rule', () => {
  it('flags a suffix attached to a brand without an apostrophe', () => {
    expect(rules(entry('Update WordPress', 'WordPressi güncelle'))).toContain('apostrophe')
  })

  it('accepts the apostrophe form', () => {
    expect(rules(entry('Update WordPress', "WordPress'i güncelle"))).not.toContain('apostrophe')
  })

  it('accepts a brand with no suffix at all', () => {
    expect(rules(entry('Update WordPress', 'WordPress güncelle'))).not.toContain('apostrophe')
  })

  /**
   * Measured on a real 1,278-entry submission, this rule produced 65 findings
   * and almost none of them were about a proper noun. A single capital
   * mid-sentence anywhere in the file taught the word as a brand, and the rule
   * then matched any translation word merely starting with it: `and` made
   * `anda` an offender, `list` made `Liste` one, `sun` made `sunt` one.
   */
  it('does not learn a word the same file also writes in lower case', () => {
    const all = [
      // One source capitalises it mid-sentence, as UI copy often does.
      entry('Choose a List to import', 'İçe aktarmak için bir liste seçin'),
      entry('Delete the list', 'Listeyi sil'),
    ]
    expect(rules(all[1]!, all)).not.toContain('apostrophe')
  })

  // A suffixed proper noun in the translation should answer to one in the
  // source. Without that, every brand the file ever mentioned was matched
  // against every translation in it.
  it('only considers a brand this entry own source mentions', () => {
    const all = [
      entry('Share on Facebook', 'Facebook üzerinde paylaş'),
      entry('Nothing to do with it', 'Facebookta bir şey yok'),
    ]
    expect(rules(all[0]!, all)).not.toContain('apostrophe')
    // The second names no brand in its source, so the rule has nothing to say.
    expect(rules(all[1]!, all)).not.toContain('apostrophe')
  })

  it('still flags a real brand from this entry own source', () => {
    expect(rules(entry('Download from GitHub', 'GitHubdan indirin'))).toContain('apostrophe')
  })

  // A curated brand is authoritative: a source that happens to write it in
  // lower case somewhere must not disarm the check.
  it('keeps a curated brand even when the corpus lower-cases it', () => {
    const all = [
      entry('the wordpress way', 'wordpress yolu'),
      entry('Update WordPress now', 'WordPressi şimdi güncelle'),
    ]
    expect(rules(all[1]!, all)).toContain('apostrophe')
  })
})

describe('inconsistent rule', () => {
  it('flags the same source translated two different ways in one file', () => {
    const a = entry('Save', 'Kaydet')
    const b = { ...entry('Save', 'Sakla'), key: 'ctxSave', msgctxt: 'ctx' }
    expect(rules(a, [a, b])).toContain('inconsistent')
    expect(rules(b, [a, b])).toContain('inconsistent')
  })

  it('accepts consistent repeats', () => {
    const a = entry('Save', 'Kaydet')
    const b = { ...entry('Save', 'Kaydet'), key: 'ctxSave', msgctxt: 'ctx' }
    expect(rules(a, [a, b])).not.toContain('inconsistent')
  })
})

describe('runRules', () => {
  it('returns no findings for a clean translation', () => {
    expect(check(entry('Save all changes', 'Tüm değişiklikleri kaydet'))).toEqual([])
  })

  it('returns every finding that applies, each with a human-readable message', () => {
    const found = check(entry('Save All %s Changes', 'Tüm Değişiklikleri Kaydet'))
    expect(found.map((f) => f.rule).sort()).toEqual(['placeholder', 'title-case'])
    for (const f of found) expect(f.message.length).toBeGreaterThan(0)
  })
})

describe('tm-conflict rule', () => {
  const withTm = (e: AuditEntry, pairs: Array<[string, string]>) => {
    const tm = new Map<string, readonly string[]>(pairs.map(([msgid, target]) => [tmKey(msgid), [target]]))
    const ctx = buildRuleContext({ locale: 'tr', glossary: GLOSSARY, nplurals: 2, entries: [e], tm })
    return runRules(e, ctx)
  }

  /**
   * Real examples from a submission: the memory disagreeing is strong evidence
   * and not a verdict, because either side can be the wrong one.
   */
  it('reports a source the memory translates differently', () => {
    const e = entry('Post', 'Gönderi')
    const found = withTm(e, [['Post', 'Yazı']])
    expect(found.map((f) => f.rule)).toContain('tm-conflict')
    expect(found.find((f) => f.rule === 'tm-conflict')?.message).toContain('Yazı')
  })

  it('is only ever a suspicion, never proof', () => {
    const found = withTm(entry('Post', 'Gönderi'), [['Post', 'Yazı']])
    expect(found.find((f) => f.rule === 'tm-conflict')?.severity).toBe('suspect')
  })

  it('says nothing when the memory agrees', () => {
    expect(withTm(entry('Post', 'Yazı'), [['Post', 'Yazı']]).map((f) => f.rule)).not.toContain('tm-conflict')
  })

  // 138 of 474 differences on a real file were only these. Reporting them would
  // have buried the 336 that mattered.
  it('ignores a difference of case, spacing or a trailing stop', () => {
    for (const [submitted, approved] of [
      ['Değer girin', 'değer girin'],
      ['Değer  girin', 'Değer girin'],
      ['Değer girin.', 'Değer girin'],
      ['Değer girin:', 'Değer girin'],
    ]) {
      expect(withTm(entry('Enter value', submitted), [['Enter value', approved]]).map((f) => f.rule)).not.toContain(
        'tm-conflict',
      )
    }
  })

  it('says nothing about a source the memory has never seen', () => {
    expect(withTm(entry('Zzz qqq', 'Bir şey'), [['Other', 'Başka']]).map((f) => f.rule)).not.toContain('tm-conflict')
  })

  // A caller that never looked is not the same as an empty memory, and the rule
  // must not report on the difference.
  it('says nothing when no memory was resolved at all', () => {
    expect(rules(entry('Post', 'Gönderi'))).not.toContain('tm-conflict')
  })

  // gettext lets the same English mean two things, so context is part of the key.
  it('does not answer for a different context', () => {
    const e = { ...entry('Post', 'Gönderi'), msgctxt: 'verb', key: 'verbPost' }
    const tm = new Map([[tmKey('Post'), ['Yazı']]])
    const ctx = buildRuleContext({ locale: 'tr', glossary: GLOSSARY, nplurals: 2, entries: [e], tm })
    expect(runRules(e, ctx).map((f) => f.rule)).not.toContain('tm-conflict')
  })
})

/**
 * The memory can hold several approved wordings for one source. A submission
 * that matches any of them agrees with the memory, so only one that matches
 * none is a conflict worth reporting.
 */
describe('tm-conflict with alternatives', () => {
  const ctxWith = (tm: Map<string, string[]>) =>
    buildRuleContext({ locale: 'tr', glossary: [], nplurals: 2, entries: [], tm })
  const entry = (msgid: string, msgstr: string) => ({
    key: msgid, msgid, msgstr: [msgstr], comments: [], references: [], fuzzy: false,
  })
  const both = new Map([[tmKey('Scroll to Top'), ['Tepeye kaydır', 'Yukarı kaydır']]])

  it('says nothing when the submission matches one of the approved wordings', () => {
    const findings = runRules(entry('Scroll to Top', 'Yukarı kaydır'), ctxWith(both))
    expect(findings.map((f) => f.rule)).not.toContain('tm-conflict')
  })

  it('reports a submission that matches none of them, and names them', () => {
    const findings = runRules(entry('Scroll to Top', 'Başa dön'), ctxWith(both))
    const conflict = findings.find((f) => f.rule === 'tm-conflict')
    expect(conflict).toBeDefined()
    expect(conflict!.message).toContain('Tepeye kaydır')
    expect(conflict!.message).toContain('Yukarı kaydır')
  })
})

/**
 * Many letters in Indian scripts have two encodings that render identically:
 * Devanagari ड़ as one code point (U+095C) or ड plus a nukta, Bengali য় the
 * same way (U+09DF), Gurmukhi ਸ਼ (U+0A36). Approved WordPress core carries both
 * for the same word (कड़ी 19 and 23 times), so the rules that compare a
 * translation with other text have to see them as one. The texts below are
 * approved WordPress core and WooCommerce strings, except the last case, which
 * changes the wording on purpose to show a real difference is still reported.
 */
describe('canonically equivalent text', () => {
  const ctx = (locale: string, opts: { glossary?: GlossaryEntry[]; entries?: AuditEntry[]; tm?: Map<string, string[]> } = {}) =>
    buildRuleContext({ locale, glossary: opts.glossary ?? [], nplurals: 2, entries: opts.entries ?? [], ...(opts.tm ? { tm: opts.tm } : {}) })
  const unit = (msgid: string, msgstr: string, key = msgid) => ({ key, msgid, msgstr: [msgstr], comments: [], references: [], fuzzy: false })

  it('finds a glossary term written in the other encoding', () => {
    // The bn glossary writes য় as one code point (U+09DF); the translation as য plus a nukta (U+09BC).
    const glossary = [{ locale: 'bn', sourceTerm: 'media', translation: 'মিডি\u09DFা', partOfSpeech: 'noun' }]
    const e = unit('Failed to load media file.', 'মিডিয\u09BCা ফাইল লোড করতে ব্যর্থ হয\u09BCেছে।')
    expect(runRules(e, ctx('bn', { glossary })).map((f) => f.rule)).not.toContain('glossary')
  })

  it('does not report a memory conflict that is only an encoding', () => {
    const tm = new Map([[tmKey('No results found'), ['কোন ফলাফল পাও\u09DFা যা\u09DFনি']]])
    const e = unit('No results found', 'কোন ফলাফল পাওয\u09BCা যায\u09BCনি')
    expect(runRules(e, ctx('bn', { tm })).map((f) => f.rule)).not.toContain('tm-conflict')
  })

  it('does not count two encodings of one translation as inconsistent', () => {
    const a = unit('Link', 'क\u095Cी')
    const b = { ...unit('Link', 'कड\u093Cी', 'ctxLink'), msgctxt: 'ctx' }
    expect(runRules(a, ctx('hi', { entries: [a, b] })).map((f) => f.rule)).not.toContain('inconsistent')
  })

  // A term stored in both encodings is one approved translation, so a finding
  // that lists it lists it once.
  it('names a glossary translation stored in both encodings once', () => {
    const glossary = [
      { locale: 'bn', sourceTerm: 'media', translation: 'মিডি\u09DFা', partOfSpeech: 'noun' },
      { locale: 'bn', sourceTerm: 'media', translation: 'মিডিয\u09BCা', partOfSpeech: 'noun' },
    ]
    const e = unit('Failed to load media file.', 'ফাইল লোড করতে ব্যর্থ হয\u09BCেছে।')
    const finding = runRules(e, ctx('bn', { glossary })).find((f) => f.rule === 'glossary')
    expect(finding?.message).toBe(`glossary term not used: "media" -> "${'মিডি\u09DFা'.normalize('NFC')}"`)
  })

  it('still reports a translation that differs in more than the encoding', () => {
    const a = unit('Link', 'कड\u093Cी')
    const b = { ...unit('Link', 'लिंक', 'ctxLink'), msgctxt: 'ctx' }
    expect(runRules(a, ctx('hi', { entries: [a, b] })).map((f) => f.rule)).toContain('inconsistent')
  })
})

/**
 * A `.po` line quotes its string, so `\"` in the file is a plain quote in the
 * string. A contributor pasting from a tool that wrote the file's spelling
 * submits a backslash that renders in the UI. Nothing caught it: the four found
 * on a real review were only corrected because the model happened to rewrite
 * those entries for other reasons.
 */
describe('escaping', () => {
  const check = (msgid: string, msgstr: string) => {
    const e = { key: msgid, msgid, msgstr: [msgstr], comments: [], references: [], fuzzy: false }
    return runRules(e, buildRuleContext({ locale: 'tr', glossary: [], nplurals: 2, entries: [e] }))
  }

  it('reports a backslash before a quote that the source spells plainly', () => {
    const findings = check('See <a href="%s">docs</a>', 'Bkz <a href=\\"%s\\">belgeler</a>')
    const escaping = findings.find((f) => f.rule === 'escaping')
    expect(escaping?.severity).toBe('error')
  })

  // The other direction: the source is about the backslash character itself, so
  // dropping it loses the thing the string is describing.
  it('reports a translation that dropped an escape the source carries', () => {
    const findings = check('Passwords may not contain the character "\\".', 'Parola "" karakterini içermemeli.')
    expect(findings.map((f) => f.rule)).toContain('escaping')
  })

  it('says nothing when the two agree', () => {
    expect(check('See <a href="%s">docs</a>', 'Bkz <a href="%s">belgeler</a>').map((f) => f.rule)).not.toContain('escaping')
    expect(check('the character "\\".', 'the "\\" character.').map((f) => f.rule)).not.toContain('escaping')
  })

  it('says nothing about an entry with no quotes at all', () => {
    expect(check('Settings', 'Ayarlar').map((f) => f.rule)).not.toContain('escaping')
  })

  // Universal: it is about how a .po line spells its string, which has nothing
  // to do with a language's orthography.
  it('runs for a locale with no orthography rules of its own', () => {
    const e = { key: 'k', msgid: 'a "b"', msgstr: ['c \\"d\\"'], comments: [], references: [], fuzzy: false }
    const ctx = buildRuleContext({ locale: 'de', glossary: [], nplurals: 2, entries: [e] })
    expect(runRules(e, ctx).map((f) => f.rule)).toContain('escaping')
  })
})

/**
 * Measured over 69,229 approved strings from 66 wp.org projects, which is the
 * test a rule has to pass: firing on work the locale team approved is a false
 * positive by construction.
 */
describe('rules measured against approved work', () => {
  const check = (msgid: string, msgstr: string, locale = 'tr') => {
    const e = { key: msgid, msgid, msgstr: [msgstr], comments: [], references: [], fuzzy: false }
    return runRules(e, buildRuleContext({ locale, glossary: [], nplurals: 2, entries: [e] })).map((f) => f.rule)
  }

  // 326 of 69,229 (0.47%), and the samples are real losses: "Stock
  // availability class." became "Stok durumu".
  describe('punctuation, extended to the end of a sentence', () => {
    it('reports a final stop the translation dropped', () => {
      expect(check('Stock availability class.', 'Stok durumu')).toContain('punctuation')
    })

    it('reports one the translation invented', () => {
      expect(check('Bank account details', 'Banka hesabı ayrıntıları.')).toContain('punctuation')
    })

    /**
     * Presence, not which mark. 27 of the 353 raw hits were an exclamation
     * mark rendered as a full stop, which is the locale's own convention:
     * "deleted successfully!" is approved as "başarıyla silindi."
     */
    it('says nothing when Turkish trades an exclamation for a stop', () => {
      expect(check('Test email sent successfully!', 'Test e-postası başarıyla gönderildi.')).not.toContain('punctuation')
    })

    it('says nothing when neither ends with one', () => {
      expect(check('Save changes', 'Değişiklikleri kaydet')).not.toContain('punctuation')
    })

    /**
     * Many scripts end a sentence with their own mark rather than a Latin full
     * stop: the danda in Hindi, Nepali and Bengali, 。 in Japanese and Chinese,
     * ؟ in Arabic, ۔ in Urdu, ։ in Armenian, ។ in Khmer, ። in Amharic.
     * In a local measurement over approved WordPress core translations in those
     * ten locales, a check that only knew ".!?" reported 18,148 correct endings
     * as dropped stops. Each case below is an approved core string.
     */
    it.each([
      ['hi', 'Please contact your site administrator.', 'कृपया अपने साइट प्रशासक से संपर्क करें।'],
      ['ne', 'Please contact your site administrator.', 'कृपया आफ्नो साइट प्रशासकलाई सम्पर्क गर्नुहोस्।'],
      ['bn', 'Failed to load media file.', 'মিডিয়া ফাইল লোড করতে ব্যর্থ হয়েছে।'],
      ['ja', 'Please contact your site administrator.', 'サイト管理者にお問い合わせください。'],
      ['zh-cn', 'Please contact your site administrator.', '请联系您的站点管理员。'],
      ['ar', 'Use images attached to the post?', 'هل تريد استخدام الصور المرفقة بالمقالة؟'],
      ['ur', 'Protect your site from spam.', 'اپنی سائٹ کو اسپیم سے محفوظ رکھیں۔'],
      ['hy', 'Posts page updated.', 'Գրառումների էջը թարմացված է։'],
      ['km', 'There was an error installing fonts.', 'មានកំហុសមួយកើតឡើងនៅពេលកំពុងដំឡើងហ្វុងអក្សរ។'],
      ['am', 'Delete selection.', 'ምርጫ ሰርዝ።'],
    ])('accepts the %s sentence mark as the end of a sentence', (locale, msgid, msgstr) => {
      expect(check(msgid, msgstr, locale)).not.toContain('punctuation')
    })

    // The same marks count the other way: a danda on a label the source leaves
    // open is a sentence the translation invented, as with a Latin stop above.
    // 272 approved strings in those locales do this; this one is from core.
    it('reports a danda the source does not have', () => {
      expect(check('Term ID', 'टर्म आईडी।', 'hi')).toContain('punctuation')
    })

    /**
     * The scripts no Unicode property covers (#22). Measured over approved
     * wp/dev and wp/dev/admin, the check reported 246 Greek, 2,331 Tibetan,
     * 350 Dzongkha and 2,975 Thai translations as dropped stops, most of them
     * correct. Every case below is an approved core string.
     */
    describe('scripts with their own sentence ending', () => {
      // Greek asks with a semicolon, and 98 of the Greek hits were a source
      // question answered by one.
      it('accepts a Greek question mark answering a source question', () => {
        expect(check('Disconnect pattern?', 'Να αποσυνδεθεί το μοτίβο;', 'el')).not.toContain('punctuation')
      })

      // U+037E is what the mark is called; NFC folds it to U+003B, and a
      // translation may carry either.
      it('accepts the Greek question mark under either code point', () => {
        expect(check('Disconnect pattern?', 'Να αποσυνδεθεί το μοτίβο;', 'el')).not.toContain('punctuation')
      })

      // Paired with the source's question, not counted on its own: a final
      // semicolon is also an entity such as &#8217; or an untranslated line
      // of code, and neither ends a sentence.
      it('still reports a Greek semicolon closing a source statement', () => {
        expect(check('Pattern disconnected.', 'Το μοτίβο αποσυνδέθηκε &#8217;', 'el')).toContain('punctuation')
      })

      it.each([
        ['bo', 'Pattern category renamed.', 'དཔེ་རིས་སྡེ་ཚན་གྱི་མིང་བརྗེ་སྒྱུར།'],
        ['dzo', 'An error occurred.', 'ནོར་བ་ཅིག་འབྱུང་ཡི།'],
        ['bo', 'Section ended.', 'ལེའུ་རྫོགས་སོ༎'],
      ])('accepts the %s shad as the end of a sentence', (locale, msgid, msgstr) => {
        expect(check(msgid, msgstr, locale)).not.toContain('punctuation')
      })

      // After ཀ and ག the shad is implied and not written, per Unicode's
      // notes on Tibetan line breaking.
      it.each([
        ['bo', 'Block keywords.', 'རྡོག་པོའི་གནད་ཚིག'],
        ['bo', 'Invalid hex color.', 'བཅུ་དྲུག་གོང་འགྲིལ་ལུགས་ཀྱི་ཁ་དོག'],
        ['dzo', 'Settings saved.', 'སྒྲིག་སྟངས་བསྐྱར་ལྷག'],
      ])('accepts a %s sentence ending in a letter that implies the shad', (locale, msgid, msgstr) => {
        expect(check(msgid, msgstr, locale)).not.toContain('punctuation')
      })

      // Only as an answer to a source sentence. Counted the other way, every
      // label ending in ག would read as a sentence the translation invented.
      it('does not read a Tibetan label ending in ག as a sentence', () => {
        expect(check('Block keywords', 'རྡོག་པོའི་གནད་ཚིག', 'bo')).not.toContain('punctuation')
      })

      // Tibetan closes a phrase with the shad too, so a shad on a label is not
      // a sentence the translation invented: 2,357 approved Tibetan labels end
      // in one, weekday names among them.
      it('does not read a shad on a Tibetan label as a sentence', () => {
        expect(check('Saturday', 'གཟའ་སྤེན་པ།', 'bo')).not.toContain('punctuation')
      })

      it('still reports a Tibetan translation that drops the end of a sentence', () => {
        expect(check('Pattern category renamed.', 'དཔེ་རིས་སྡེ་ཚན་གྱི་མིང་བརྗེ་སྒྱུར', 'bo')).toContain('punctuation')
      })

      // Many Tibetan keyboards type a tsheg for the space bar, so a sentence
      // ending in ག can carry one after it. The shad is still implied.
      it.each([
        ['dzo', 'There are no widgets available.', 'བརྡ་སྒྲོམ་མིན་འདུག་'],
        ['dzo', 'The excerpt is hidden.', 'ཟུན་དོན་འདི་སྦ་བཞག་ནུག་'],
      ])('accepts a %s sentence ending in ག and a trailing tsheg', (locale, msgid, msgstr) => {
        expect(check(msgid, msgstr, locale)).not.toContain('punctuation')
      })

      // The tsheg excuses nothing after any other letter.
      it('still reports a Tibetan sentence ending in a tsheg after another letter', () => {
        expect(check('Pattern category renamed.', 'དཔེ་རིས་སྡེ་ཚན་གྱི་མིང་བརྗེ་སྒྱུར་', 'bo')).toContain('punctuation')
      })

      // Thai ends a sentence with a space, so a translation without a final
      // mark is the house style rather than a loss.
      it('accepts a Thai sentence with no final mark', () => {
        expect(check('No fonts activated.', 'ไม่มีแบบอักษรที่เปิดใช้งาน', 'th')).not.toContain('punctuation')
      })

      // Thai uses the full stop to abbreviate, never to end a sentence. All 23
      // approved translations the check reported as an invented stop were
      // abbreviations: months, weekdays, and น. after a time.
      it.each([
        ['Dec', 'ธ.ค.'],
        ['W', 'พ.'],
        ['g:i a', 'G:i น.'],
      ])('does not read the Thai abbreviation in %s as a sentence', (msgid, msgstr) => {
        expect(check(msgid, msgstr, 'th')).not.toContain('punctuation')
      })

      // A Latin stop after a Latin word is still a sentence end in a Thai file.
      it('still reports a Thai translation ending in a Latin sentence the source does not have', () => {
        expect(check('Learn more about WordPress', 'เรียนรู้เพิ่มเติมเกี่ยวกับ WordPress.', 'th')).toContain('punctuation')
      })

      // Lao keeps the full stop, so nothing above reaches it.
      it('still reports a Lao translation that drops the stop', () => {
        expect(check('No fonts activated.', 'ບໍ່ມີຟອນທີ່ເປີດໃຊ້ງານ', 'lo')).toContain('punctuation')
      })

      // Single letters each followed by a dot are an abbreviation in any
      // script: 12 Lao months, and German and Greek a.m. and p.m.
      it.each([
        ['lo', 'Dec', 'ທ.ວ.'],
        ['de', 'PM', 'p.m.'],
        ['el', 'Select AM or PM', 'Επιλέξτε π.μ. ή μ.μ.'],
      ])('does not read a %s dotted abbreviation as a sentence', (locale, msgid, msgstr) => {
        expect(check(msgid, msgstr, locale)).not.toContain('punctuation')
      })

      // A whole word before the stop is a sentence, as Lao writes one.
      it('still reports a Lao label given a stop the source does not have', () => {
        expect(check('Notes', 'ໝາຍເຫດ.', 'lo')).toContain('punctuation')
      })
    })
  })

  // 15 of 69,229 (0.02%). A dropped line in an email body is structure, not
  // whitespace, and cannot be put back by anything mechanical.
  describe('line-breaks', () => {
    it('reports a lost line', () => {
      expect(check('--\nThe Team\nhttps://example.org', 'Ekip\nhttps://example.org')).toContain('line-breaks')
    })

    it('says nothing when the count matches', () => {
      expect(check('Howdy,\n\nA request', 'Merhaba,\n\nBir istek')).not.toContain('line-breaks')
    })

    // Universal: an email body has the same shape in every language.
    it('runs outside Turkish too', () => {
      expect(check('a\nb', 'c', 'de')).toContain('line-breaks')
    })
  })

  // 89 of 69,229 (0.13%), nearly all of them labels the guide would write with
  // "ve": "Etkinleştir & Kaydet", "Tarih & Saat".
  describe('ampersand', () => {
    it('reports an ampersand carried into the translation', () => {
      expect(check('Activate & Save', 'Etkinleştir & Kaydet')).toContain('ampersand')
    })

    it('reports the encoded form too', () => {
      expect(check('Date &amp; Time', 'Tarih &amp; Saat')).toContain('ampersand')
    })

    it('says nothing once it is written as a word', () => {
      expect(check('Date & Time', 'Tarih ve Saat')).not.toContain('ampersand')
    })

    // Entities and query strings are not the conjunction.
    it('leaves entities and URLs alone', () => {
      expect(check('&hellip; and &#8220;quoted&#8221;', '&hellip; ve &#8220;alıntı&#8221;')).not.toContain('ampersand')
      expect(check('See <a href="?a=1&b=2">docs</a>', '<a href="?a=1&b=2">belgeler</a> bakın')).not.toContain('ampersand')
    })

    // Turkish only: the rule is a convention of this locale, not of gettext.
    it('does not run for a locale that has not asked for it', () => {
      expect(check('Date & Time', 'Datum & Zeit', 'de')).not.toContain('ampersand')
    })
  })

  // 3 of 69,229. Turkish writes the sign before the number, closed up.
  describe('number-format', () => {
    it('reports a space between the percent sign and its number', () => {
      expect(check('25% off', '% 25 indirim')).toContain('number-format')
    })

    it('says nothing about the closed-up form', () => {
      expect(check('25% off', '%25 indirim')).not.toContain('number-format')
    })

    // A placeholder is not a percentage.
    it('leaves placeholders alone', () => {
      expect(check('%s items and %d more', '%s öge ve %d tane daha')).not.toContain('number-format')
    })
  })
})
