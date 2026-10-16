import { describe, expect, it } from 'vitest'
import { buildAuditPrompt, type AuditCandidate } from '../../src/audit/prompt.js'
import { buildRuleContext, runRules, tmKey } from '../../src/audit/rules/index.js'
import { draftSystemPrompt } from '../../src/draft/prompt.js'
import { buildReviewPrompt } from '../../src/review/prompt.js'
import { renderDefaultRules } from '../../src/rules/defaults.js'
import type { AuditEntry, GlossaryEntry, ReviewInput } from '../../src/types.js'
import { useLocaleFixture } from '../locale-fixture.js'

// Turkish was the one locale with a maintained pack, and its data has since
// moved out of the code altogether, into a rules file. Neither move may change
// a byte of what Turkish renders or reports. The prompt and findings fixtures
// were captured from the code as it stood before locale packs existed (#2);
// they now load every Turkish rule from test/fixtures/locale/tr_TR.yaml, which
// holds what the pack carried, so a pass proves the file says exactly what the
// pack did. A diff here means a Turkish prompt or finding moved,
// which re-reviews every Turkish file a reviewer has cached; regenerate them
// only when that is the intended change.

useLocaleFixture('tr_TR.yaml')

const fixture = (name: string) => `../fixtures/locale/${name}`

const candidates: AuditCandidate[] = [
  {
    id: 1,
    key: 'Save All Changes',
    msgid: 'Save All Changes',
    msgstr: ['Tüm Değişiklikleri Kaydet'],
    comments: ['Button label'],
    references: ['wp-admin/edit.php:12'],
    hints: [{ rule: 'title-case', severity: 'suspect', message: 'title case mirrors the English source (Değişiklikleri, Kaydet); Turkish capitalizes only the first word and proper nouns' }],
    glossary: [{ term: 'change', translations: ['değişiklik'] }],
  },
  {
    id: 2,
    key: 'ctx\u0004%s post',
    msgid: '%s post',
    msgctxt: 'ctx',
    msgidPlural: '%s posts',
    msgstr: ['%s yazı', '%s yazı'],
    comments: [],
    references: ['wp-includes/post.php:40', 'wp-includes/post.php:41'],
    hints: [{ rule: 'repaired', severity: 'suspect', message: 'whitespace restored to match the source' }],
    memory: ['%s yazı', '%s gönderi'],
    repaired: { text: ['%s yazı', '%s yazı'], repairedBy: 'rules' },
  },
  {
    id: 3,
    key: 'on',
    msgid: 'on',
    msgstr: ['açık'],
    comments: ['translators: If there are characters in your language that are not supported by Inter, translate this to "off". Do not translate into your own language.'],
    references: [],
    hints: [{ rule: 'control', severity: 'error', message: 'a control string must be one of: on, off' }],
    condemned: [{ rule: 'control', severity: 'error', message: 'a control string must be one of: on, off' }],
    control: true,
  },
]

const reviewInputs: ReviewInput[] = [
  { key: 'Settings', msgid: 'Settings', comments: [], drafts: ['Ayarlar'] },
  {
    key: '%d item',
    msgid: '%d item',
    msgidPlural: '%d items',
    msgctxt: 'cart',
    comments: ['Shown in the cart'],
    drafts: ['%d öğe', '%d öğe'],
    automatedChecks: ['glossary: uses "item" without the approved "öge"'],
    control: false,
  },
]

describe('Turkish prompts, byte for byte', () => {
  it('keeps the audit prompt', async () => {
    await expect(buildAuditPrompt(candidates, 'tr', 2)).toMatchFileSnapshot(fixture('tr-audit-prompt.txt'))
  })

  it('keeps the draft review prompt', async () => {
    await expect(buildReviewPrompt(reviewInputs, 'tr', 2)).toMatchFileSnapshot(fixture('tr-review-prompt.txt'))
  })

  it('keeps the draft engine prompt', async () => {
    await expect(draftSystemPrompt('tr', 2)).toMatchFileSnapshot(fixture('tr-draft-prompt.txt'))
  })
})

const GLOSSARY: GlossaryEntry[] = [
  { locale: 'tr', sourceTerm: 'sidebar', translation: 'kenar çubuğu', partOfSpeech: 'noun' },
  { locale: 'tr', sourceTerm: 'author', translation: 'yazar', partOfSpeech: 'noun' },
]

function entry(msgid: string, msgstr: string, extra: Partial<AuditEntry> = {}): AuditEntry {
  return { key: msgid, msgid, msgstr: [msgstr], comments: [], references: [], fuzzy: false, ...extra }
}

const ENTRIES: AuditEntry[] = [
  // title-case, mirrored from a Title Case source
  entry('Save All Changes', 'Tüm Değişiklikleri Kaydet'),
  // title-case, mid-string only
  entry('Show the sidebar widget', 'Kenar çubuğu Bileşenini göster'),
  // apostrophe: a brand the source names, suffixed without one
  entry('Connect to WordPress now', 'WordPressa şimdi bağlan'),
  // ampersand kept where Turkish writes the conjunction
  entry('Date & Time', 'Tarih & Saat'),
  // number-format: percent sign set apart from its number
  entry('Progress: 25%', 'İlerleme: % 25'),
  // glossary: the approved term is missing
  entry('Edit the author', 'Yaratıcıyı düzenle'),
  // date-only noun in a date: exempt
  entry('Published on %s May', '%s Mayıs tarihinde yayımlandı'),
  // date-only noun outside a date: flagged
  entry('Every month, in May', 'Her ay, Mayıs ayında'),
  // always noun: exempt
  entry('Translate into Turkish', 'Türkçeye çevir'),
  // tm-conflict against the memory
  entry('Post type', 'Yazı tipi'),
  // tm agreement, case aside
  entry('Categories', 'KATEGORILER'),
  // untranslated
  entry('Read more', 'Read more'),
  // placeholder dropped
  entry('%s comments', 'yorumlar'),
  // whitespace lost
  entry('Hello ', 'Merhaba'),
  // a clean entry, so an empty findings list is part of the fixture too
  entry('Settings', 'Ayarlar'),
]

describe('Turkish findings, byte for byte', () => {
  it('keeps what every rule reports', async () => {
    const tm = new Map<string, readonly string[]>([
      [tmKey('Post type'), ['Yazı türü']],
      [tmKey('Categories'), ['Kategoriler']],
    ])
    const ctx = buildRuleContext({ locale: 'tr', glossary: GLOSSARY, nplurals: 2, entries: ENTRIES, tm })
    const findings = ENTRIES.map((e) => ({ msgid: e.msgid, findings: runRules(e, ctx) }))
    await expect(JSON.stringify(findings, null, 2) + '\n').toMatchFileSnapshot(fixture('tr-findings.json'))
  })
})

// The template is no longer Turkish: since the packs went, every locale gets
// the same neutral examples and only the header names the locale. It is still
// pinned byte for byte, because a template change is what every new rules file
// is written from. Rendered for tr only because that is where the fixtures were.
describe('rules template, byte for byte', () => {
  it('keeps the commented template', async () => {
    await expect(renderDefaultRules('tr')).toMatchFileSnapshot(fixture('tr-rules-commented.yaml'))
  })

  it('keeps the live template', async () => {
    await expect(renderDefaultRules('tr', { commented: false })).toMatchFileSnapshot(fixture('tr-rules-live.yaml'))
  })
})
