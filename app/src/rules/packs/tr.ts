import type { LocalePack } from './types.js'

// Turkish, maintained by the tr_TR locale team. Everything here moved out of
// profiles.ts, proper-nouns.ts and the audit prompt unchanged (#2), and
// test/rules/tr-baseline.test.ts holds the prompts, findings and template it
// produces to fixtures captured before the move.

// Categories TDK capitalizes that a brand allowlist does not cover: day and
// month names, and the names of languages and peoples. Turkish keeps day and
// month names lowercase in generic use (okullar eylülde açılır) and capitalizes
// them only in a specific date, a distinction no pattern can make, so listing
// them trades the ability to flag a wrongly capitalized generic one for not
// flagging every legitimate date.
const DATE_ONLY: readonly string[] = [
  'Pazartesi',
  'Salı',
  'Çarşamba',
  'Perşembe',
  'Cuma',
  'Cumartesi',
  'Pazar',
  'Ocak',
  'Şubat',
  'Mart',
  'Nisan',
  'Mayıs',
  'Haziran',
  'Temmuz',
  'Ağustos',
  'Eylül',
  'Ekim',
  'Kasım',
  'Aralık',
]

const ALWAYS: readonly string[] = [
  'Türk',
  'Türkçe',
  'Türkiye',
  'İngiliz',
  'İngilizce',
  'Almanca',
  'Alman',
  'Fransızca',
  'Fransız',
  'İspanyolca',
  'İspanyol',
  'İtalyanca',
  'İtalyan',
  'Rusça',
  'Rus',
  'Arapça',
  'Arap',
  'Japonca',
  'Japon',
  'Çince',
  'Çin',
  'Korece',
  'Portekizce',
  'Hollandaca',
  'Lehçe',
  'İbranice',
  'Farsça',
  'Yunanca',
  'Yunan',
  'Kürtçe',
  'Kürt',
]

// Read as a template literal so the paragraph stays byte-identical to the one
// the audit prompt carried inline: every Turkish verdict in the cache was
// formed under it, and a reflowed line would re-review them all.
const CAPITALIZATION = `- {language} does NOT use English Title Case. Only the first word and proper nouns are capitalized. "Tüm Değişiklikleri Kaydet" is wrong; "Tüm değişiklikleri kaydet" is right. Brand names (WordPress, WooCommerce) and acronyms keep their own casing.
- A capital mid-string is legitimate when the word is a proper noun. In {language} that includes place and person names, names of languages and peoples, day and month names inside a specific date, titles of works, and institution names, where every word is capitalized (Türk Dil Kurumu). An automated check cannot recognize most of these, so when a title-case finding is really one of them, clear it.
- Menu labels, screen and section names, and section headings in help or documentation pages are a deliberate exception. TDK madde D capitalizes the words of sign-like labels, and the locale team does not reject a submission over capitalization in those places, so do NOT report title-case for them. This exception covers labels and headings only. Commands, buttons, confirmations, error messages and running prose keep sentence case, and an English calque there is still a problem worth reporting.
- The two kinds of title-case check are not equal evidence. A finding that says the translation "mirrors the English source" means the source itself was Title Case and the translation copied its shape word for word; that is close to proof of an English calque. A finding that only says a word is capitalized mid-string is much weaker: measured against approved WordPress {language} translations it is roughly four times as likely to be a false alarm, and the usual reason is that the capitalized words name a thing, most often a feature, widget, block or key ("Etiket Bulutu bileşeninde", "Hızlı Düzenleme'de göster", "Site Logosu bloğu", "Shift + Ok tuşları"). Check what the capitalized words refer to before confirming that kind.
`

export const tr: LocalePack = {
  language: 'tr',
  status: 'maintained',
  // `ampersand` and `number-format` are conventions of this locale rather
  // than of gettext, so they wait for someone who speaks the language to say
  // they apply, exactly as the orthography rules do.
  extraRules: ['title-case', 'apostrophe', 'ampersand', 'number-format'],
  glossaryStemRatio: 0.7,
  properNouns: { always: ALWAYS, dateOnly: DATE_ONLY },
  capitalization: CAPITALIZATION,
  examples: {
    mistakes: ['  - wrong: önizleme', '    right: ön izleme', '    note: TDK writes it as two words'],
    patterns: [
      "  - find: '\\.\\.\\.'",
      "    replace: '…'",
      '    level: fix',
      '    note: Use the ellipsis character',
      // A suffix glued to a placeholder, %s'de or {name}'i, has to agree in
      // vowel harmony with a value the translator never sees. Only an
      // apostrophe straight after the placeholder counts, so '%s' in quotes
      // and href='%s' stay quiet, and a placeholder glued to the end of a word
      // (%1$sbu SSS%2$s'ye, a link closing after SSS) is left alone.
      String.raw`  - find: '(?<![\p{L}\p{M}\p{N}])(?:%(?:\d+\$)?[-+0#]?\d*(?:\.\d+)?[sdfu]|\{[\w-]+\})[''’]\p{L}+'`,
      '    level: hint',
      '    note: A suffix on a placeholder cannot agree with every value; rephrase so it lands on a word, as in "%s adlı eklentide"',
      // A plural noun straight after a count: Turkish keeps it singular, 3
      // dosya. -lar takes back-vowel endings and -ler front ones, which is
      // what keeps Cloudflare and olarak out; the lookahead lists words that
      // only end like a plural (dolar, popüler, galeri).
      String.raw`  - find: '%(?:\d+\$)?[du](?:</[a-z]+>)?\s+(?!(?:dolar|lari|taler|popüler|modüler|seküler|moleküler|selüler|vasküler|regüler|tübüler|angüler|oküler|kapiler|skaler|polar|bipolar|solar|kiler|keler|çalar|galeri|ileri)\p{L}{0,4}(?![\p{L}\p{M}]))\p{L}+(?:lar(?:ı(?:mız|nız)?|ım|ın)?(?:n?a|ya|n?[dt]an?|n?ın|n?ı|y?la|dır|ca|[dt]aki)?|ler(?:i(?:miz|niz)?|im|in)?(?:n?e|ye|n?[dt]en?|n?in|n?i|y?le|dir|ce|[dt]eki)?)(?![\p{L}\p{M}])'`,
      '    level: hint',
      '    note: Turkish keeps the noun singular after a number, as in "%d dosya"',
    ],
  },
}
