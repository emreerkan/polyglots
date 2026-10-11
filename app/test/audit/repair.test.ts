import { describe, expect, it } from 'vitest'
import { judgeFix, REPAIRABLE_RULES, repairMechanically } from '../../src/audit/repair.js'
import { buildRuleContext } from '../../src/audit/rules/index.js'
import type { AuditEntry, GlossaryEntry } from '../../src/types.js'

function entry(msgid: string, msgstr: string[]): AuditEntry {
  return { key: msgid, msgid, msgstr, comments: [], references: [], fuzzy: false }
}

describe('repairMechanically', () => {
  it('restores a trailing space the contributor dropped', () => {
    expect(repairMechanically(entry('Save changes ', ['Değişiklikleri kaydet']))).toEqual([
      'Değişiklikleri kaydet ',
    ])
  })

  it('restores leading whitespace', () => {
    expect(repairMechanically(entry('  Indented', ['Girintili']))).toEqual(['  Girintili'])
  })

  it('removes whitespace the contributor added that the source does not have', () => {
    expect(repairMechanically(entry('Save', ['Kaydet  ']))).toEqual(['Kaydet'])
  })

  it('keeps tabs and newlines exactly as the source has them', () => {
    expect(repairMechanically(entry('\tLine\n', ['Satır']))).toEqual(['\tSatır\n'])
  })

  it('leaves an entry whose whitespace already matches alone', () => {
    expect(repairMechanically(entry('Save changes', ['Değişiklikleri kaydet']))).toBeUndefined()
  })

  // Every plural form is a translation of the same source, so they all get the
  // same treatment. A form left empty stays empty: there is nothing to repair.
  it('repairs every plural form and leaves empty ones empty', () => {
    const plural = { ...entry('%s item ', ['%s öğe', '%s öğe', '']), msgidPlural: '%s items ' }
    expect(repairMechanically(plural)).toEqual(['%s öğe ', '%s öğe ', ''])
  })

  // A msgstr of nothing but spaces is not a translation to repair. Trimming it to
  // empty would be counted as a repair, which claims a correction that blanked
  // the entry instead.
  it('leaves a whitespace-only translation alone rather than blanking it', () => {
    expect(repairMechanically(entry('Save ', ['   ']))).toBeUndefined()
  })

  it('leaves an untranslated entry alone', () => {
    expect(repairMechanically(entry('Save ', ['']))).toBeUndefined()
  })

  // Only rules whose correct output is computable qualify. punctuation is a
  // suspect the model is supposed to judge, so it is deliberately not here.
  it('names only the rules it can actually invert', () => {
    expect([...REPAIRABLE_RULES]).toEqual(['whitespace', 'escaping'])
  })
})

const GLOSSARY: GlossaryEntry[] = [
  { locale: 'tr', sourceTerm: 'sidebar', translation: 'kenar çubuğu', partOfSpeech: 'noun' },
]

function ctxFor(entries: AuditEntry[]) {
  return buildRuleContext({ locale: 'tr', glossary: GLOSSARY, nplurals: 2, entries })
}

describe('judgeFix', () => {
  const broken = entry('%s comments', ['yorumlar'])
  const ctx = ctxFor([broken])

  it('accepts a fix that clears the finding', () => {
    expect(judgeFix({ entry: broken, fix: ['%s yorum'], nplurals: 2, ctx })).toEqual({ accepted: ['%s yorum'] })
  })

  // The case the whole guard exists for: a model asked to restore one
  // placeholder can drop another, and the comment would claim it was repaired.
  it('rejects a fix that trades one error for another', () => {
    const twoHoles = entry('%1$s of %2$s', ['%1$s'])
    const verdict = judgeFix({ entry: twoHoles, fix: ['%1$s tanesi'], nplurals: 2, ctx: ctxFor([twoHoles]) })
    expect(verdict).toEqual({ rejected: expect.stringMatching(/placeholder/i) })
  })

  /**
   * The model writes the fix as if it were writing the .po line, escaping a
   * quote the source leaves plain, and the backslash ends up in the catalogue.
   * Repaired here rather than rejected: the wording is right and one stray
   * character is no reason to throw the work away.
   */
  it('takes the escaping of the source rather than the model own', () => {
    const link = entry('See <a href="%s">docs</a>', ['Bkz <a href="%s">belgeler</a>'])
    const verdict = judgeFix({
      entry: link,
      fix: ['Belgelere bakın: <a href=\\"%s\\">belgeler</a>'],
      nplurals: 2,
      ctx: ctxFor([link]),
    })
    expect(verdict).toEqual({ accepted: ['Belgelere bakın: <a href="%s">belgeler</a>'] })
  })

  it('rejects a fix identical to what was submitted, since that repairs nothing', () => {
    expect(judgeFix({ entry: broken, fix: ['yorumlar'], nplurals: 2, ctx })).toEqual({
      rejected: expect.stringMatching(/unchanged/i),
    })
  })

  it('rejects a fix with the wrong number of plural forms', () => {
    const plural = { ...entry('%s item', ['%s öğe', '%s öğe']), msgidPlural: '%s items' }
    const verdict = judgeFix({ entry: plural, fix: ['%s öğe'], nplurals: 2, ctx: ctxFor([plural]) })
    expect(verdict).toEqual({ rejected: expect.stringMatching(/plural/i) })
  })

  it('rejects an empty fix', () => {
    expect(judgeFix({ entry: broken, fix: [''], nplurals: 2, ctx })).toEqual({
      rejected: expect.stringMatching(/empty/i),
    })
  })

  // A soft finding is the model's to weigh, and it just did. Only mechanical
  // facts reject a fix, or nothing the model writes could ever be accepted.
  it('accepts a fix that trips only a suspect rule', () => {
    const wordy = entry('Open the sidebar', ['Yan menüyü aç'])
    const verdict = judgeFix({ entry: wordy, fix: ['Yan menüyü açın'], nplurals: 2, ctx: ctxFor([wordy]) })
    expect(verdict).toEqual({ accepted: ['Yan menüyü açın'] })
  })
})

/**
 * Stripping a backslash the source does not have needs no judgment: the source
 * says what the spelling should be. The other direction cannot be computed,
 * since nothing here knows where a lost backslash belonged, so that one is left
 * for the model.
 */
describe('repairMechanically and escaping', () => {
  const entry = (msgid: string, msgstr: string[]) => ({
    key: msgid, msgid, msgstr, comments: [], references: [], fuzzy: false,
  })

  it('strips a backslash the source spells plainly', () => {
    expect(repairMechanically(entry('See <a href="%s">docs</a>', ['Bkz <a href=\\"%s\\">belgeler</a>']))).toEqual([
      'Bkz <a href="%s">belgeler</a>',
    ])
  })

  it('repairs the whitespace and the escaping together', () => {
    expect(repairMechanically(entry('  say "hi" ', ['de \\"merhaba\\"']))).toEqual(['  de "merhaba" '])
  })

  it('leaves a translation that lost an escape for the model', () => {
    expect(repairMechanically(entry('the character "\\".', ['the "" character.']))).toBeUndefined()
  })

  it('still reports nothing to do when both agree', () => {
    expect(repairMechanically(entry('a "b"', ['c "d"']))).toBeUndefined()
  })
})

/**
 * A fix judgeFix accepts can still be wrong in a softer way: the rules only
 * reject on an error. What it got wrong is reported beside the fix, as one
 * `fix-suspect` finding naming only what the submitted text did not already
 * have, so the reviewer sees what the model broke on the way to what it fixed.
 * The three cases are the ones notes/ideas.md was written from.
 */
describe('judgeFix and what an accepted fix brought in', () => {
  const glossary: GlossaryEntry[] = [
    { locale: 'tr', sourceTerm: 'widget', translation: 'bileşen', partOfSpeech: 'noun' },
    { locale: 'tr', sourceTerm: 'sidebar', translation: 'kenar çubuğu', partOfSpeech: 'noun' },
  ]
  const judge = (e: AuditEntry, fix: string[]) =>
    judgeFix({ entry: e, fix, nplurals: 2, ctx: buildRuleContext({ locale: 'tr', glossary, nplurals: 2, entries: [e] }) })

  it('keeps a fix that dropped a glossary term, and says which term', () => {
    const verdict = judge(entry('Update the widget settings', ['Bileşen ayarlarını güncelle']), ['Widget ayarlarını güncelleyin'])
    expect(verdict).toMatchObject({ accepted: ['Widget ayarlarını güncelleyin'] })
    const suspect = 'accepted' in verdict ? verdict.suspect : undefined
    expect(suspect).toMatchObject({ rule: 'fix-suspect', severity: 'suspect' })
    expect(suspect?.message).toMatch(/glossary/)
    expect(suspect?.message).toContain('"widget" -> "bileşen"')
  })

  it('keeps a fix that brought in a title-case calque, and names the words', () => {
    const verdict = judge(entry('Add New Product', ['Yeni ürün ekle']), ['Yeni Ürün Ekleyin'])
    const suspect = 'accepted' in verdict ? verdict.suspect : undefined
    expect(suspect?.rule).toBe('fix-suspect')
    expect(suspect?.message).toMatch(/title-case/)
    expect(suspect?.message).toContain('Ürün')
    expect(suspect?.message).toContain('Ekleyin')
  })

  it('keeps a fix that lost the apostrophe on a proper noun, and names the word', () => {
    const verdict = judge(entry('Sync with WordPress', ['WordPress ile eşitle']), ['WordPressle eşitle'])
    const suspect = 'accepted' in verdict ? verdict.suspect : undefined
    expect(suspect?.rule).toBe('fix-suspect')
    expect(suspect?.message).toMatch(/apostrophe/)
    expect(suspect?.message).toContain('WordPressle')
  })

  // The glossary message lists every missed term, so comparing whole messages
  // would read a fix that kept one term missing and dropped another as all new.
  it('names only the glossary term the fix dropped, not one missing in both', () => {
    const verdict = judge(entry('Update the widget in the sidebar', ['Yan menüdeki bileşeni güncelle']), [
      "Yan menüdeki widget'ı güncelleyin",
    ])
    const suspect = 'accepted' in verdict ? verdict.suspect : undefined
    expect(suspect?.message).toContain('"widget"')
    expect(suspect?.message).not.toContain('"sidebar"')
  })

  // The title-case message changes wording when the whole string mirrors the
  // source, so the words are compared rather than the sentence around them.
  it('names only the capital the fix added, when the submission already had one', () => {
    const verdict = judge(entry('Add New Product', ['Yeni Ürün ekle']), ['Yeni Ürün Ekleyin'])
    const suspect = 'accepted' in verdict ? verdict.suspect : undefined
    expect(suspect?.message).toContain('Ekleyin')
    expect(suspect?.message).not.toContain('Ürün')
  })

  // inconsistent reads the whole file, not the entry: it fires on any non-empty
  // text whose source the file translates more than one way. An entry with no
  // submitted text is the one shape where it fires on the fix and not on the
  // submission, so it is the only way to see the guard work. Without it, the
  // file's own spread would be named as something the model brought in.
  it('never names a rule that reads the whole file, such as inconsistent', () => {
    const e = entry('Open the menu', [''])
    const others = [entry('Open the menu', ['Menüyü aç']), entry('Open the menu', ['Menüyü göster'])]
    const ctx = buildRuleContext({ locale: 'tr', glossary, nplurals: 2, entries: [e, ...others] })
    expect(ctx.translationsByMsgid.get('Open the menu')?.size).toBe(2)
    const verdict = judgeFix({ entry: e, fix: ['Menüyü açın'], nplurals: 2, ctx })
    expect(verdict).toEqual({ accepted: ['Menüyü açın'] })
  })

  it('adds nothing when the fix brings in nothing the submission did not have', () => {
    const verdict = judge(entry('Open the sidebar', ['Yan menüyü aç']), ['Yan menüyü açın'])
    expect(verdict).toEqual({ accepted: ['Yan menüyü açın'] })
  })
})
