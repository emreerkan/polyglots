import type { BuiltInRule } from '../../../../app/src/rules/names.js';

// One example per built-in rule, for the Basics step. The name and the
// one-line description come from the app (findingLabel), the same words the
// stats page and the TUI use; only the example is the page's own. A Record
// over BuiltInRule, so a rule added to the app fails the site's check until
// it has an example here.
export const RULE_EXAMPLES: Record<BuiltInRule, string> = {
  placeholder: '“Deleted %s files” translated without the %s.',
  html: '“Read the <a href="…">guide</a>” translated with the link gone.',
  'plural-count': 'A language with three plural forms, and only two of them filled.',
  whitespace: '“Name: ” translated as “Nombre:”, losing the trailing space. Repaired automatically.',
  untranslated: '“Settings” left as “Settings”.',
  escaping: 'The source writes \\"Save\\" and the translation writes "Save", or the reverse.',
  punctuation: '“Loading…” translated as “Cargando”, without the ellipsis.',
  'line-breaks': 'A two-line source translated on one line.',
  ampersand: '“Posts & Pages” kept as “Yazılar & Sayfalar” where Turkish writes “ve”.',
  'number-format': '“25%” written “% 25”, the percent sign set apart from its number.',
  'title-case': '“Save All Changes” as “Tüm Değişiklikleri Kaydet” where Turkish writes “Tüm değişiklikleri kaydet”.',
  glossary: 'The glossary says plugin is “eklenti”, and the translation says “plugin”.',
  apostrophe: '“in WordPress” as “WordPressde” instead of “WordPress’te”.',
  inconsistent: '“Save” translated “Kaydet” in one entry and “Sakla” in another of the same file.',
  'tm-conflict': 'Your approved translations say “Ayarlar” for “Settings”; this file says “Seçenekler”.',
  control: '“ltr” (a text direction the code reads) translated as words.',
};
