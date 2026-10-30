import { describe, expect, it } from 'vitest'
import { fingerprintReview } from '../../src/audit/resume.js'
import {
  auditSrcHash,
  engineId,
  configHash,
  draftConfigHash,
  draftHash,
  draftSrcHash,
  srcHash,
  translateConfigHash,
} from '../../src/jobs/hash.js'
import { glossaryKey } from '../../src/audit/rules/index.js'
import type { AuditEntry, GlossaryEntry } from '../../src/types.js'

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  key: 'Save',
  msgid: 'Save',
  msgstr: ['Kaydet'],
  comments: [],
  references: [],
  fuzzy: false,
  ...over,
})

const term = (sourceTerm: string, translation: string): GlossaryEntry => ({
  sourceTerm,
  translation,
  locale: 'tr',
})

const config = (glossary: GlossaryEntry[], properNouns: string[] = []) => ({
  locale: 'tr' as const,
  glossary,
  properNouns,
})

describe('srcHash', () => {
  it('is stable for the same entry', () => {
    expect(srcHash(entry())).toBe(srcHash(entry()))
  })

  it('is 16 hex characters, matching the existing fingerprint format', () => {
    expect(srcHash(entry())).toMatch(/^[0-9a-f]{16}$/)
  })

  it('changes when the translation changes', () => {
    expect(srcHash(entry({ msgstr: ['Kaydet'] }))).not.toBe(srcHash(entry({ msgstr: ['Sakla'] })))
  })

  it('changes when the source changes', () => {
    expect(srcHash(entry({ msgid: 'Save' }))).not.toBe(srcHash(entry({ msgid: 'Store' })))
  })

  it('separates context from source, so concatenation cannot collide', () => {
    const a = entry({ msgid: 'ab', msgctxt: 'c' })
    const b = entry({ msgid: 'a', msgctxt: 'bc' })
    expect(srcHash(a)).not.toBe(srcHash(b))
  })

  it('covers every plural form, not just the first', () => {
    const a = entry({ msgidPlural: '%d items', msgstr: ['%d oge', '%d oge'] })
    const b = entry({ msgidPlural: '%d items', msgstr: ['%d oge', '%d ogeler'] })
    expect(srcHash(a)).not.toBe(srcHash(b))
  })

  it('covers the text alone: everything the prompt adds belongs to its own hash', () => {
    // Narrow on purpose. A caller that needs the comments or the references in
    // the key asks auditSrcHash or draftSrcHash for them, and says so in the
    // call. Passing a whole entry here hashes four fields and no more.
    expect(srcHash(entry({ comments: [] }))).toBe(srcHash(entry({ comments: ['translators: a note'] })))
  })
})

const context = (over: Partial<Parameters<typeof auditSrcHash>[1]> = {}) => ({
  references: ['admin/menu.php:12'],
  comments: [],
  hints: [],
  nplurals: 2,
  repaired: false,
  ...over,
})

describe('auditSrcHash', () => {
  it('separates an entry that was mechanically repaired from one submitted clean', () => {
    // The hash is taken after the repair and the `repaired` hint is excluded,
    // so without this the two would key the same while the prompt told the
    // model different things about them.
    expect(auditSrcHash(entry(), context({ repaired: true }))).not.toBe(
      auditSrcHash(entry(), context({ repaired: false })),
    )
  })

  it('is stable for the same entry in the same context', () => {
    expect(auditSrcHash(entry(), context())).toBe(auditSrcHash(entry(), context()))
  })

  it('changes when the references change, which is what says what the string is for', () => {
    expect(auditSrcHash(entry(), context())).not.toBe(
      auditSrcHash(entry(), context({ references: ['help/intro.php:3'] })),
    )
  })

  it('changes when the comments change, gettext\'s own disambiguation', () => {
    expect(auditSrcHash(entry(), context())).not.toBe(
      auditSrcHash(entry(), context({ comments: ['translators: a verb'] })),
    )
  })

  it('changes when a rule fires that did not fire before', () => {
    // The rule findings are file-dependent: the rule context learns brands and
    // prior translations from every other entry in the same file.
    expect(auditSrcHash(entry(), context())).not.toBe(
      auditSrcHash(entry(), context({ hints: ['title-case: capitalizes Widgetly mid-string'] })),
    )
  })

  it('changes when a hint says something else, not just when a new rule fires', () => {
    // `inconsistent` counts how many ways the file translates the same source,
    // so its message moves when another entry is edited while this entry's own
    // text and firing rules stay put. The prompt changed, so the key must.
    expect(
      auditSrcHash(entry(), context({ hints: ['inconsistent: the same source is translated 2 different ways'] })),
    ).not.toBe(
      auditSrcHash(entry(), context({ hints: ['inconsistent: the same source is translated 3 different ways'] })),
    )
  })

  it('does not change when the same hints arrive in another order', () => {
    // Hint order is an implementation detail of the rule list. A spurious miss
    // here would re-ask the model for nothing.
    expect(auditSrcHash(entry(), context({ hints: ['glossary: x', 'title-case: y'] }))).toBe(
      auditSrcHash(entry(), context({ hints: ['title-case: y', 'glossary: x'] })),
    )
  })

  it('changes when the glossary terms the prompt lists change', () => {
    // The terms come from the matcher, not the glossary alone: a change to how
    // a source is matched changes the prompt without touching configHash.
    expect(auditSrcHash(entry(), context())).not.toBe(
      auditSrcHash(entry(), context({ glossary: ['image=görsel'] })),
    )
  })

  // The prompt renders each row's part of speech and note, so the key does too.
  it('changes when a glossary row\'s note changes, and not for identical rows', () => {
    const post = (note: string) => ({
      term: 'post',
      translations: ['gönderi'],
      rows: [{ translation: 'gönderi', pos: 'noun', note }],
    })
    const keyed = (note: string) => auditSrcHash(entry(), context({ glossary: [glossaryKey(post(note))] }))
    expect(glossaryKey(post('a'))).toBe('post=[["gönderi","noun","a"]]')
    expect(keyed('a')).toBe(keyed('a'))
    expect(keyed('a')).not.toBe(keyed('b'))
  })

  // Translations hold "/" (nl's "waarschuwing/waarschuwingen") and notes are
  // free text, so fields joined with "/" and rows with "|" could spell two
  // different glossaries the same way, and the draft review key, which
  // configHash does not cover, would serve one's verdicts for the other.
  it('keeps row sets apart that a slash-and-bar join would merge', () => {
    const key = (rows: { translation: string; pos?: string; note?: string }[]) =>
      glossaryKey({ term: 'post', translations: rows.map((r) => r.translation), rows })
    expect(key([{ translation: 'a/b', pos: '', note: '' }])).not.toBe(key([{ translation: 'a', pos: 'b', note: '/' }]))
    expect(key([{ translation: 'a', pos: 'noun', note: 'x|y' }])).not.toBe(
      key([{ translation: 'a', pos: 'noun', note: 'x' }, { translation: 'y' }]),
    )
  })

  it('changes when nplurals changes, which the prompt states outright', () => {
    expect(auditSrcHash(entry(), context())).not.toBe(auditSrcHash(entry(), context({ nplurals: 6 })))
  })

  it('still changes when the entry itself changes', () => {
    expect(auditSrcHash(entry(), context())).not.toBe(auditSrcHash(entry({ msgstr: ['Sakla'] }), context()))
  })
})

describe('draftSrcHash', () => {
  const source = { msgid: 'Save', msgstr: [] as string[] }

  it('changes when the comments change, which the draft prompt is told to use', () => {
    expect(draftSrcHash(source, { comments: [], nplurals: 2 })).not.toBe(
      draftSrcHash(source, { comments: ['translators: a verb'], nplurals: 2 }),
    )
  })

  it('changes when nplurals changes, which decides how many drafts are asked for', () => {
    expect(draftSrcHash(source, { comments: [], nplurals: 2 })).not.toBe(
      draftSrcHash(source, { comments: [], nplurals: 6 }),
    )
  })
})

describe('draftConfigHash', () => {
  it('is stable for a locale', () => {
    expect(draftConfigHash('tr')).toBe(draftConfigHash('tr'))
  })

  it('differs per locale, since the prompt names the target language', () => {
    expect(draftConfigHash('tr')).not.toBe(draftConfigHash('de'))
  })

  it('differs from the draft review prompt, which is why the two tables prune separately', () => {
    expect(draftConfigHash('tr')).not.toBe(translateConfigHash('tr'))
  })
})

describe('configHash', () => {
  it('is stable for the same configuration', () => {
    const g = [term('Settings', 'Ayarlar')]
    expect(configHash(config(g))).toBe(configHash(config(g)))
  })

  it('changes when a glossary term changes', () => {
    expect(configHash(config([term('ID', 'kimlik')]))).not.toBe(configHash(config([term('ID', 'ID')])))
  })

  // Deliberately coarse, as the rest of the glossary is: a note edited locally
  // is a glossary change, and a full re-review after one is what is wanted.
  it('changes when a glossary row\'s note changes, and not for identical rows', () => {
    const noted = (notes: string): GlossaryEntry => ({ ...term('post', 'gönderi'), partOfSpeech: 'noun', notes })
    expect(configHash(config([noted('a')]))).toBe(configHash(config([noted('a')])))
    expect(configHash(config([noted('a')]))).not.toBe(configHash(config([noted('b')])))
  })

  it('changes when the proper noun list changes', () => {
    expect(configHash(config([], []))).not.toBe(configHash(config([], ['WooCommerce'])))
  })

  it('ignores the source and batch size fingerprintReview also computes', () => {
    // configHash reuses fingerprintReview and takes only its glossary and rules
    // components. Nothing enforces that those stay independent of the source
    // and batch size it also hashes, so this pins it: if fingerprintReview ever
    // folds batchSize into `rules`, a resumed run would start missing its cache
    // for a reason nobody would think to look for.
    const g = [term('Settings', 'Ayarlar')]
    const viaShortSource = fingerprintReview({ source: 'a', locale: 'tr', batchSize: 1, noAi: false, glossary: g, properNouns: [] })
    const viaLongSource = fingerprintReview({ source: 'b'.repeat(5000), locale: 'tr', batchSize: 999, noAi: true, glossary: g, properNouns: [] })
    expect(viaShortSource.glossary).toBe(viaLongSource.glossary)
    expect(viaShortSource.rules).toBe(viaLongSource.rules)
    expect(configHash(config(g))).toBe(configHash(config(g)))
  })
})

describe('translateConfigHash', () => {
  it('is stable, and does not depend on the glossary the audit prompt uses', () => {
    expect(translateConfigHash('tr')).toBe(translateConfigHash('tr'))
  })

  it('differs from the audit configuration hash, which is why they prune separately', () => {
    expect(translateConfigHash('tr')).not.toBe(configHash(config([term('ID', 'kimlik')])))
  })
})

describe('draftHash', () => {
  it('changes with the draft text', () => {
    expect(draftHash(['Kaydet'])).not.toBe(draftHash(['Sakla']))
  })

  it('covers every plural form', () => {
    expect(draftHash(['a', 'b'])).not.toBe(draftHash(['a', 'c']))
  })
})

describe('auditSrcHash and the memory', () => {
  const entry = { msgid: 'Post', msgstr: ['Gönderi'] }
  const ctx = { references: [], comments: [], hints: [], nplurals: 2, repaired: false }

  /**
   * The prompt states what the memory holds for a source, and the memory is
   * not part of configHash, so nothing else in the key would notice a TMX
   * import changing what the model was told.
   */
  it('separates two entries the memory answers differently', () => {
    expect(auditSrcHash(entry, { ...ctx, memory: ['Yazı'] })).not.toBe(
      auditSrcHash(entry, { ...ctx, memory: ['Gönderi'] }),
    )
  })

  it('separates an entry the memory knows from one it does not', () => {
    expect(auditSrcHash(entry, { ...ctx, memory: ['Yazı'] })).not.toBe(auditSrcHash(entry, ctx))
  })

  it('is stable when the memory says the same thing', () => {
    expect(auditSrcHash(entry, { ...ctx, memory: ['Yazı'] })).toBe(auditSrcHash(entry, { ...ctx, memory: ['Yazı'] }))
  })
})

describe('engineId', () => {
  it('is plain claude when no model was named', () => {
    expect(engineId()).toBe('claude')
    expect(engineId(undefined)).toBe('claude')
  })

  it('separates two models, so one is never served the other\'s verdict', () => {
    // The escalation project compares what two engines say. Recording both as
    // "claude" would make the second read the first one's rows and the whole
    // comparison would measure nothing.
    expect(engineId('opus')).not.toBe(engineId('sonnet'))
    expect(engineId('opus')).not.toBe(engineId())
  })

  it('names the model in the identity, so a stored row is readable', () => {
    expect(engineId('opus')).toContain('opus')
  })

  // Every row written before there was a choice of provider says `claude`, and
  // must still read back as the same identity now that there is one.
  it('is unchanged when no provider is named', () => {
    expect(engineId(undefined, 'claude')).toBe(engineId())
    expect(engineId('opus', 'claude')).toBe(engineId('opus'))
  })

  // Two providers disagree about the same translation, so one must never be
  // served the other's verdict.
  it('separates two providers, with or without a model', () => {
    expect(engineId(undefined, 'antigravity')).toBe('antigravity')
    expect(engineId(undefined, 'antigravity')).not.toBe(engineId())
    expect(engineId('opus', 'antigravity')).not.toBe(engineId('opus'))
  })
})

// Above two forms the prompts carry the catalogue's Plural-Forms header, so a
// verdict formed without it must not be served once it is there. Below that
// the part is absent and the joined string, so every existing key, is exactly
// what it was: the fixed values were captured before the header existed (#2).
describe('the plural expression in the per-entry keys', () => {
  const plural = { msgid: '%d file', msgidPlural: '%d files', msgstr: ['%d файл', '%d файла', '%d файлов'] }
  const RU = 'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);'
  const auditContext = { references: ['a.php:1'], comments: [], hints: [], nplurals: 3, repaired: false }
  const draftContext = { comments: [], nplurals: 3 }

  it('leaves both keys as they were without it', () => {
    expect(auditSrcHash(plural, auditContext)).toBe('eeea14f0c245f248')
    expect(draftSrcHash({ ...plural, msgstr: [] }, draftContext)).toBe('90aa6e5daf69f9c9')
  })

  it('moves both keys with it', () => {
    expect(auditSrcHash(plural, { ...auditContext, pluralForms: RU })).not.toBe(auditSrcHash(plural, auditContext))
    expect(draftSrcHash({ ...plural, msgstr: [] }, { ...draftContext, pluralForms: RU })).not.toBe(
      draftSrcHash({ ...plural, msgstr: [] }, draftContext),
    )
  })
})

// Local review asks a different prompt from the agents' one, and that prompt is
// deliberately not in the configuration hash, which would prune every agent
// verdict when a local run started. So the variant is per entry instead.
describe('auditSrcHash and the prompt variant', () => {
  it('keys exactly as before when there is no variant', () => {
    expect(auditSrcHash(entry(), context())).toBe(auditSrcHash(entry(), { ...context(), promptVariant: undefined }))
  })

  it('separates a verdict formed under another prompt', () => {
    expect(auditSrcHash(entry(), context({ promptVariant: 'a' }))).not.toBe(auditSrcHash(entry(), context()))
    expect(auditSrcHash(entry(), context({ promptVariant: 'a' }))).not.toBe(auditSrcHash(entry(), context({ promptVariant: 'b' })))
  })
})
