import { describe, expect, it } from 'vitest'
import type { AuditEntry } from '../../src/types.js'
import { decideFromMemory } from '../../src/audit/memory.js'

function entry(msgid: string, msgstr: string, extra: Partial<AuditEntry> = {}): AuditEntry {
  return { key: msgid, msgid, msgstr: [msgstr], comments: [], references: [], fuzzy: false, ...extra }
}

/**
 * Measured on wp-themes-business-roy-tr.po against a 94,435-row memory: 71 of
 * 1,359 submissions were identical to an approved translation of the same
 * source, and 173 had been left in English where the memory held the
 * approved Turkish. Neither needs a model to decide. The model was being
 * asked anyway, because every entry went to it whatever the memory said.
 */
describe('decideFromMemory', () => {
  it('approves a submission identical to the approved translation', () => {
    expect(decideFromMemory(entry('Font Size', 'Yazı Tipi Boyutu'), ['Yazı Tipi Boyutu'], true, 'tr')).toEqual({ kind: 'approve' })
  })

  it('repairs a submission left in English with the approved translation', () => {
    expect(decideFromMemory(entry('Large', 'Large'), ['Geniş'], true, 'tr')).toEqual({ kind: 'repair', text: ['Geniş'] })
  })

  /**
   * The locale manager's call: capitalisation that differs from the memory is
   * acceptable either way, since labels keep their capitals by the team's own
   * rule and the memory cannot tell a label from prose. The wording is the
   * approved wording, so it is approved as written, capitals and all, rather
   * than rewritten to the memory's casing or sent to be argued over.
   */
  it('approves a submission that differs from the memory only in case', () => {
    expect(decideFromMemory(entry('Hide Details', 'Ayrıntıları Gizle'), ['Ayrıntıları gizle'], true, 'tr')).toEqual({ kind: 'approve' })
  })

  // Turkish has two i's, and a case comparison that ignores that would call
  // "Işık" and "Isik" the same word, or fail to match "İleri" to "ileri".
  it('compares case the Turkish way', () => {
    expect(decideFromMemory(entry('Next', 'İleri'), ['ileri'], true, 'tr')).toEqual({ kind: 'approve' })
    expect(decideFromMemory(entry('Light', 'IŞIK'), ['ışık'], true, 'tr')).toEqual({ kind: 'approve' })
    expect(decideFromMemory(entry('Light', 'ISIK'), ['ışık'], true, 'tr')).toBeUndefined()
  })

  // Different wording is a judgement, and judgement is what the model is for.
  it('leaves different wording to the model', () => {
    expect(decideFromMemory(entry('Posts navigation', 'Gönderi navigasyonu'), ['Yazı gezinmesi'], true, 'tr')).toBeUndefined()
  })

  /**
   * A msgctxt exists exactly where a string is ambiguous, and the lookup falls
   * back to a row without context when the scoped one is missing. That is a
   * fair hint for a prompt and no basis for deciding without one.
   */
  it('decides nothing from a match found only by dropping the context', () => {
    expect(decideFromMemory(entry('Large', 'Large', { msgctxt: 'font size' }), ['Geniş'], false, 'tr')).toBeUndefined()
    expect(decideFromMemory(entry('Font Size', 'Yazı Tipi Boyutu'), ['Yazı Tipi Boyutu'], false, 'tr')).toBeUndefined()
  })

  it('decides nothing without a memory', () => {
    expect(decideFromMemory(entry('Large', 'Large'), [], true, 'tr')).toBeUndefined()
  })

  // The memory holds one string per source. A plural entry has several forms
  // and nothing here says which one it would be.
  it('leaves plural entries alone', () => {
    const plural = entry('%d item', '%d öğe', { msgidPlural: '%d items', msgstr: ['%d öğe', '%d öğe'] })
    expect(decideFromMemory(plural, ['%d öğe'], true, 'tr')).toBeUndefined()
  })
})

/**
 * The memory holds every wording the locale approved for a source, so a
 * submission matching any of them is approved. On a real export 6,480 sources
 * had more than one, nearly all synonyms: "Tepeye kaydır" and "Yukarı kaydır"
 * are both right, and which one a contributor picked is not a finding.
 */
describe('decideFromMemory with several approved alternatives', () => {
  const both = ['Tepeye kaydır', 'Yukarı kaydır']

  it('approves a submission matching any approved alternative', () => {
    expect(decideFromMemory(entry('Scroll to Top', 'Yukarı kaydır'), both, true, 'tr')).toEqual({ kind: 'approve' })
    expect(decideFromMemory(entry('Scroll to Top', 'Tepeye kaydır'), both, true, 'tr')).toEqual({ kind: 'approve' })
  })

  it('approves one that matches an alternative but for its capitals', () => {
    expect(decideFromMemory(entry('Scroll to Top', 'Yukarı Kaydır'), both, true, 'tr')).toEqual({ kind: 'approve' })
  })

  it('leaves a wording the memory does not hold to the model', () => {
    expect(decideFromMemory(entry('Scroll to Top', 'Başa dön'), both, true, 'tr')).toBeUndefined()
  })

  /**
   * Repairing means writing one wording into the file. With several approved
   * there is nothing to say which, so the model decides with all of them in
   * front of it rather than this picking one on a coin toss.
   */
  it('does not repair a left-in-English entry when the approved wordings differ', () => {
    expect(decideFromMemory(entry('Scroll to Top', 'Scroll to Top'), both, true, 'tr')).toBeUndefined()
    expect(decideFromMemory(entry('Scroll to Top', 'Scroll to Top'), ['Yukarı kaydır'], true, 'tr')).toEqual({
      kind: 'repair',
      text: ['Yukarı kaydır'],
    })
  })

  // Alternatives that differ only in case say the same thing, so they still
  // settle a repair.
  it('repairs when the alternatives differ only in case', () => {
    const decision = decideFromMemory(entry('Scroll to Top', 'Scroll to Top'), ['Yukarı kaydır', 'Yukarı Kaydır'], true, 'tr')
    expect(decision).toEqual({ kind: 'repair', text: ['Yukarı kaydır'] })
  })
})

/**
 * The memory holds English text for sources the locale keeps in English:
 * brands, icon slugs, place names, Lorem ipsum. It also holds a few leftovers
 * nobody ever translated. Approving a submission because it matches one of
 * those would approve a contributor for leaving the English exactly where the
 * memory is least trustworthy, so the model looks at it instead. On a real
 * theme this moved about 15 entries of 1,359 back into a batch.
 */
describe('decideFromMemory when the memory holds the English itself', () => {
  it('does not approve a submission left in English, even if the memory has it', () => {
    expect(decideFromMemory(entry('Elementor', 'Elementor'), ['Elementor'], true, 'tr')).toBeUndefined()
    expect(decideFromMemory(entry('Lorem ipsum', 'Lorem ipsum'), ['Lorem ipsum'], true, 'tr')).toBeUndefined()
  })

  // A real translation that happens to sit beside an untranslated copy is
  // still a real translation.
  it('still approves a translated submission when a copy is one of the alternatives', () => {
    expect(decideFromMemory(entry('Flip', 'Çevir'), ['Çevir', 'Flip'], true, 'tr')).toEqual({ kind: 'approve' })
  })

  // And a copy in the memory cannot be the text a repair writes in.
  it('does not repair with an alternative that is the English source', () => {
    expect(decideFromMemory(entry('Flip', 'Flip'), ['Flip'], true, 'tr')).toBeUndefined()
  })
})

// The memory carries the same slip in 7 of its rows, imported from work that
// had it. A repair written from one must not put it back in the catalogue.
describe('decideFromMemory and the source escaping', () => {
  it('repairs with the escaping the source uses', () => {
    const e = entry('See <a href="%s">docs</a>', 'See <a href="%s">docs</a>')
    expect(decideFromMemory(e, ['Bkz <a href=\\"%s\\">belgeler</a>'], true, 'tr')).toEqual({
      kind: 'repair',
      text: ['Bkz <a href="%s">belgeler</a>'],
    })
  })
})

// Folding the Turkish way for every locale made "Ix" and "ıx" one word in
// German, so a different wording was approved as the memory's own.
// ਸ਼ is one code point (U+0A36) or ਸ plus a nukta, and they render the same.
// Approved pa core and WooCommerce spell "Uncategorized" each way.
describe('decideFromMemory: canonically equivalent text', () => {
  it('approves a submission that differs from the memory only in encoding', () => {
    expect(decideFromMemory(entry('Uncategorized', 'ਸ\u0A3C੍ਰੇਣੀ-ਰਹਿਤ'), ['\u0A36੍ਰੇਣੀ-ਰਹਿਤ'], true, 'pa')).toEqual({ kind: 'approve' })
  })

  // One wording stored in two encodings is still one answer to the source.
  it('repairs English from a memory that holds one wording in two encodings', () => {
    const memory = ['\u0A36੍ਰੇਣੀ-ਰਹਿਤ', 'ਸ\u0A3C੍ਰੇਣੀ-ਰਹਿਤ']
    expect(decideFromMemory(entry('Uncategorized', 'Uncategorized'), memory, true, 'pa')).toEqual({ kind: 'repair', text: [memory[0]] })
  })
})

describe('decideFromMemory: case folding by locale', () => {
  it('does not fold a dotted and a dotless i together outside Turkish', () => {
    expect(decideFromMemory(entry('Example', 'Ix'), ['ıx'], true, 'de')).toBeUndefined()
  })

  it('still folds them for Turkish', () => {
    expect(decideFromMemory(entry('Example', 'Ix'), ['ıx'], true, 'tr')).toEqual({ kind: 'approve' })
  })

  it('folds ordinary case for German', () => {
    expect(decideFromMemory(entry('The file', 'DIE DATEI'), ['die datei'], true, 'de')).toEqual({ kind: 'approve' })
  })
})
