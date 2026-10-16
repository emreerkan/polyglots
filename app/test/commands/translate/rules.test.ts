import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { po } from 'gettext-parser'
import { translateFile } from '../../../src/commands/translate.js'
import { buildReviewPrompt } from '../../../src/review/prompt.js'
import { localeRulesFile } from '../../../src/rules/load.js'
import type { DraftEngine, ReviewInput, ReviewResult } from '../../../src/types.js'
import { makeWorkspace, type Workspace } from './helpers.js'

const CATALOGUE = `msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"
"Language: tr\\n"
"Plural-Forms: nplurals=2; plural=n > 1;\\n"

msgid "Preview"
msgstr ""

msgid "Hello %s"
msgstr ""

msgid "Settings"
msgstr ""

#. translators: If there are characters in your language that are not supported
#. by Open Sans, translate this to 'off'. Do not translate into your own
#. language.
msgctxt "Open Sans font: on or off"
msgid "on"
msgstr ""
`

// Drafts as a careless engine writes them: a common mistake, a lost
// placeholder, and one clean entry.
const DRAFTS: Record<string, string> = {
  Preview: 'Önizleme',
  'Hello %s': 'Merhaba',
  Settings: 'Ayarlar',
}

const engineSaw: string[] = []
const engine: DraftEngine = {
  name: 'deepl',
  async translate(units) {
    engineSaw.push(...units.map((u) => u.msgid))
    return units.map((u) => ({ key: u.key, drafts: [DRAFTS[u.msgid] ?? u.msgid] }))
  },
}

// An AI pass that returns what it was given, or what `answers` says, and
// records its inputs.
function fakeReview(answers: Record<string, string> = {}) {
  const calls: ReviewInput[][] = []
  const fn = async (inputs: ReviewInput[]): Promise<ReviewResult[]> => {
    calls.push(inputs)
    return inputs.map((i) => ({ key: i.key, text: [answers[i.msgid] ?? i.drafts[0]!], fuzzy: false, reason: 'checked' }))
  }
  return Object.assign(fn, { calls })
}

let ws: Workspace
let tick = 0

async function writeRules(text: string) {
  const file = localeRulesFile('tr')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text, 'utf8')
  const t = new Date(Date.now() + ++tick * 1000)
  await utimes(file, t, t)
}

const RULES = `patterns:
  - text: önizleme
    replace: ön izleme
    level: fix
    note: TDK writes it as two words
mistakes:
  - wrong: ayar
    right: seçenek
    note: house style
`

beforeEach(async () => {
  ws = await makeWorkspace()
  await writeFile(ws.file, CATALOGUE, 'utf8')
})

afterEach(async () => {
  await ws.cleanup()
})

const run = (review: ReturnType<typeof fakeReview>) =>
  translateFile({
    file: ws.file,
    locale: 'tr',
    mode: 'pending',
    draftEngine: 'deepl',
    engine,
    review,
    mcpConfigPath: join(ws.home, 'mcp.json'),
    batchSize: 25,
  })

async function written(): Promise<Record<string, { text: string; fuzzy: boolean }>> {
  const parsed = po.parse(await readFile(ws.file))
  const out: Record<string, { text: string; fuzzy: boolean }> = {}
  for (const ctx of Object.values(parsed.translations)) {
    for (const [id, e] of Object.entries(ctx)) {
      if (id) out[id] = { text: e.msgstr[0] ?? '', fuzzy: /fuzzy/.test(e.comments?.flag ?? '') }
    }
  }
  return out
}

const inputFor = (review: ReturnType<typeof fakeReview>, msgid: string) =>
  review.calls.flat().find((i) => i.msgid === msgid)

describe('translate with locale rules', () => {
  it('applies fix patterns to the drafts before the AI pass sees them', async () => {
    await writeRules(RULES)
    const review = fakeReview()
    await run(review)
    expect(inputFor(review, 'Preview')?.drafts).toEqual(['Ön izleme'])
  })

  // The AI pass weighs these the way review's does: fixes what is real.
  it('hands the AI pass the checks each draft failed', async () => {
    await writeRules(RULES)
    const review = fakeReview()
    await run(review)
    expect(inputFor(review, 'Hello %s')?.automatedChecks).toEqual([expect.stringMatching(/^placeholder: /)])
    expect(inputFor(review, 'Settings')?.automatedChecks).toEqual([expect.stringMatching(/^custom: "ayar" -> "seçenek"/)])
  })

  it('runs the built-in checks even without a rules file', async () => {
    const review = fakeReview()
    await run(review)
    expect(inputFor(review, 'Hello %s')?.automatedChecks?.[0]).toMatch(/^placeholder: /)
    expect(inputFor(review, 'Preview')?.automatedChecks).toBeUndefined()
  })

  // An error still failing after the AI pass means a human must look; a hint
  // was already weighed by the AI and does not.
  it('marks fuzzy what still fails an error-level check, and only that', async () => {
    await writeRules(RULES)
    await run(fakeReview())
    const out = await written()
    expect(out['Hello %s']).toMatchObject({ text: 'Merhaba', fuzzy: true })
    expect(out.Settings).toMatchObject({ text: 'Ayarlar', fuzzy: false })
    expect(out.Preview).toMatchObject({ text: 'Ön izleme', fuzzy: false })
  })

  it('does not mark fuzzy what the AI pass fixed', async () => {
    await run(fakeReview({ 'Hello %s': 'Merhaba %s' }))
    expect((await written())['Hello %s']).toMatchObject({ text: 'Merhaba %s', fuzzy: false })
  })

  // The AI pass can write the mistake back in; the last word is mechanical.
  it('applies fix patterns again to the final text', async () => {
    await writeRules(RULES)
    await run(fakeReview({ Preview: 'Önizleme' }))
    expect((await written()).Preview?.text).toBe('Ön izleme')
  })

  // Starts from a file that already enables a language check. Without one,
  // the first mistake also lifts the universal-only note from the review
  // prompt, which is a different question for every entry, not just this one.
  it('reaches the AI pass again for an entry whose checks changed, and only for it', async () => {
    await writeRules('rules:\n  enable: [title-case]\n')
    const first = fakeReview()
    await run(first)
    await writeFile(ws.file, CATALOGUE, 'utf8')
    await writeRules('rules:\n  enable: [title-case]\nmistakes:\n  - wrong: ayar\n')
    const second = fakeReview()
    await run(second)
    expect(second.calls.flat().map((i) => i.msgid)).toEqual(['Settings'])
  })
})

// A machine engine turns "on" into "açık", which breaks the font switch.
describe('translate with control strings', () => {
  it('never sends a control string to the draft engine, and drafts it as its source value', async () => {
    engineSaw.length = 0
    const review = fakeReview()
    await run(review)
    expect(engineSaw).not.toContain('on')
    expect(inputFor(review, 'on')).toMatchObject({ drafts: ['on'], control: true })
  })

  it('keeps an allowed value the AI pass chose', async () => {
    await run(fakeReview({ on: 'off' }))
    expect((await written()).on).toMatchObject({ text: 'off', fuzzy: false })
  })

  it('marks fuzzy a control string the AI pass translated into a word', async () => {
    await run(fakeReview({ on: 'açık' }))
    expect((await written()).on).toMatchObject({ text: 'açık', fuzzy: true })
  })
})

describe('the translate prompt', () => {
  it('carries an entry’s checks and says what to do with them', () => {
    const prompt = buildReviewPrompt(
      [{ key: 'k', msgid: 'Hello %s', comments: [], drafts: ['Merhaba'], automatedChecks: ['placeholder: missing %s'] }],
      'tr',
      2,
    )
    expect(prompt).toContain('"automatedChecks":["placeholder: missing %s"]')
    expect(prompt).toMatch(/automatedChecks/)
  })
})
