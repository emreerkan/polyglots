import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDeepLEngine, type DeepLClientLike } from '../../src/draft/deepl.js'
import { draftSystemPrompt, formalityOf } from '../../src/draft/prompt.js'
import { draftConfigHash } from '../../src/jobs/hash.js'
import { localeRulesFile } from '../../src/rules/load.js'
import type { TranslationUnit } from '../../src/types.js'

// test/setup/isolate-home.ts gives every test its own empty POLYGLOTS_HOME, so
// each test starts with no rules file and writes the one it needs.
async function writeRules(locale: string, text: string) {
  const file = localeRulesFile(locale)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text, 'utf8')
}

const unit = (msgid: string): TranslationUnit => ({ key: msgid, msgid, comments: [], references: [] })

// The prompt for es as draftSystemPrompt wrote it before formality existed,
// pinned as a literal rather than captured in a beforeAll. A capture would run
// before the isolated home exists, so it could read a real rules file from the
// developer's config, and it would compare the new function with itself.
// Byte identity is the point: draftConfigHash hashes this text, so any drift
// prunes every cached draft for a locale that never set formality.
const BEFORE = [
  'You are a professional WordPress UI translator. Translate each item from English (en) into Spanish (es).',
  'These are gettext strings from WordPress core, plugins and themes: UI labels, messages, settings.',
  'Rules:',
  '- Keep every placeholder exactly as written (%s, %d, %1$s, %2$d, %.2f, {name}, ###TOKEN###) and in a natural position.',
  '- Keep HTML tags, attributes, entities, Markdown, whitespace, leading/trailing spaces and newlines intact.',
  '- Do not translate code, URLs, shortcodes, or option/CSS/PHP identifiers.',
  '- Use the msgctxt and comments as disambiguation hints; produce natural, concise UI wording.',
  '- The target locale has 2 plural form(s). For an item WITHOUT "msgidPlural", return exactly 1 draft. For an item WITH "msgidPlural", return exactly 2 drafts: index 0 translates "msgid" (singular), the remaining indexes translate "msgidPlural" for the locale\'s other plural forms, in order.',
  '- Return every input item, echoing its numeric "id" unchanged.',
  'Return ONLY a JSON object of the shape {"items":[{"id":1,"drafts":["..."]}]} with no prose.',
].join('\n')

function fakeClient() {
  return { translateText: vi.fn<DeepLClientLike['translateText']>(async (texts) => texts.map((t) => ({ text: t }))) }
}

describe('draftSystemPrompt and formality', () => {
  it('adds no line and keeps the prompt byte-identical without formality', () => {
    expect(draftSystemPrompt('es', 2)).toBe(BEFORE)
  })

  it('keeps the prompt byte-identical for a rules file that sets no formality', async () => {
    await writeRules('es', 'schema: 2\nregister: "- Be brief."')
    expect(draftSystemPrompt('es', 2)).toBe(BEFORE)
  })

  it('adds one line for a file formality', async () => {
    await writeRules('es', 'schema: 2\nformality: informal')
    const lines = draftSystemPrompt('es', 2).split('\n')
    expect(lines).toContain('- Address the reader informally.')
    expect(lines.length).toBe(BEFORE.split('\n').length + 1)
  })

  it('places the line after the msgctxt hint, and says formally for formal', async () => {
    await writeRules('es', 'schema: 2\nformality: formal')
    const lines = draftSystemPrompt('es', 2).split('\n')
    const hint = lines.indexOf('- Use the msgctxt and comments as disambiguation hints; produce natural, concise UI wording.')
    expect(lines[hint + 1]).toBe('- Address the reader formally.')
  })

  it('moves the draft cache key only when formality is set', async () => {
    const plain = draftConfigHash('es')
    await writeRules('es', 'schema: 2\nformality: formal')
    expect(draftConfigHash('es')).not.toBe(plain)
  })

  // A set does not change the prompt: it already reaches the model through
  // the locale's name, and adding a line for it would prune every nl/formal
  // draft the moment this shipped.
  it('leaves the prompt alone for a formal set without a file', () => {
    expect(draftSystemPrompt('nl/formal', 2)).not.toContain('Address the reader')
  })
})

describe('formalityOf', () => {
  it('reads the set when there is no file', () => {
    expect(formalityOf('nl/formal')).toBe('formal')
    expect(formalityOf('de/informal')).toBe('informal')
    expect(formalityOf('es')).toBeUndefined()
  })

  it('prefers the file over the set', async () => {
    await writeRules('nl/formal', 'schema: 2\nformality: informal')
    expect(formalityOf('nl/formal')).toBe('informal')
  })
})

describe('DeepL formality', () => {
  it('maps to DeepL, file over set', async () => {
    const client = fakeClient()
    await writeRules('nl/formal', 'schema: 2\nformality: informal')
    await createDeepLEngine({ apiKey: 'x', client }).translate([unit('Hi')], 'nl/formal', 2)
    expect(client.translateText.mock.calls[0]![3]).toMatchObject({ formality: 'prefer_less' })
  })

  it('maps a file formality on a locale with no set', async () => {
    const client = fakeClient()
    await writeRules('es', 'schema: 2\nformality: formal')
    await createDeepLEngine({ apiKey: 'x', client }).translate([unit('Hi')], 'es', 2)
    expect(client.translateText.mock.calls[0]![3]).toMatchObject({ formality: 'prefer_more' })
  })

  it('keeps the set mapping without a file', async () => {
    const formal = fakeClient()
    await createDeepLEngine({ apiKey: 'x', client: formal }).translate([unit('Hi')], 'nl/formal', 2)
    expect(formal.translateText.mock.calls[0]![3]).toMatchObject({ formality: 'prefer_more' })

    const none = fakeClient()
    await createDeepLEngine({ apiKey: 'x', client: none }).translate([unit('Hi')], 'es', 2)
    expect(none.translateText.mock.calls[0]![3]).not.toHaveProperty('formality')
  })
})
