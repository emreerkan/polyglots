import { describe, expect, it } from 'vitest'
import { buildRuleContext, runRules } from '../../src/audit/rules/index.js'
import { useLocaleFixture } from '../locale-fixture.js'

// How Greek, Tibetan, Dzongkha and Thai end a sentence used to be a table in
// the rule itself. It is now each locale's rules file, so these cases run
// against copies of the polyglots-data files and must keep the results they
// had against the table.
const check = (msgid: string, msgstr: string, locale: string) => {
  const e = { key: msgid, msgid, msgstr: [msgstr], comments: [], references: [], fuzzy: false }
  return runRules(e, buildRuleContext({ locale, glossary: [], nplurals: 2, entries: [e] })).map((f) => f.rule)
}

describe('with the locale rules files', () => {
  useLocaleFixture('el.yaml', 'bo.yaml', 'dzo.yaml', 'th.yaml')

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

// polyglots carries no sentence style of its own any more: without the file,
// Thai is read like any other script, and its unmarked ending is reported.
it('has no sentence style without a rules file', () => {
  // empty home: Thai ending without a stop is reported again
  const ctx = buildRuleContext({ locale: 'th', glossary: [], nplurals: 1, entries: [] })
  expect(runRules({ key: 'a', msgid: 'Saved.', msgstr: ['บันทึกแล้ว'], comments: [], references: [], fuzzy: false }, ctx)
    .some((f) => f.rule === 'punctuation')).toBe(true)
})
