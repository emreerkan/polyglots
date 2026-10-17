import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openRulesDraft, saveRulesDraft } from '../../src/rules/edit.js'
import { localeRulesFile, loadLocaleRules, RulesFileError } from '../../src/rules/load.js'

let home: string
let saved: string | undefined

beforeEach(async () => {
  saved = process.env.POLYGLOTS_HOME
  home = await mkdtemp(join(tmpdir(), 'polyglots-rules-edit-'))
  process.env.POLYGLOTS_HOME = home
})

afterEach(async () => {
  if (saved === undefined) delete process.env.POLYGLOTS_HOME
  else process.env.POLYGLOTS_HOME = saved
  await rm(home, { recursive: true, force: true })
})

async function writeRules(text: string) {
  const file = localeRulesFile('tr')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text, 'utf8')
  return file
}

const HAND_WRITTEN = `# polyglots rules for tr_TR (tr)
# My own notes about this file.

# Things contributors keep getting wrong.
mistakes:
  - wrong: önizleme   # TDK, madde 4
    right: ön izleme

guidance: |
  Button labels are imperative.
`

describe('openRulesDraft', () => {
  // The built-in defaults are the universal checks for every locale, Turkish
  // included: its language rules live in its rules file, not in the code.
  it('describes a locale without a file as the built-in defaults, with nothing set', () => {
    const draft = openRulesDraft('tr')
    expect(draft.exists).toBe(false)
    expect(draft.value).toEqual({ mistakes: [], patterns: [] })
    expect(draft.builtIn.rules).not.toContain('title-case')
    expect(draft.builtIn.properNouns).toEqual({ always: [], dateOnly: [] })
  })

  it('reads the file as written, mistakes and patterns kept apart', async () => {
    await writeRules(HAND_WRITTEN)
    const draft = openRulesDraft('tr')
    expect(draft.exists).toBe(true)
    expect(draft.value.mistakes).toEqual([{ wrong: 'önizleme', right: 'ön izleme' }])
    expect(draft.value.guidance).toBe('Button labels are imperative.\n')
  })

  it('refuses an invalid file, so the editor never starts from a wrong picture', async () => {
    await writeRules('rules:\n  enable: [nope]\n')
    expect(() => openRulesDraft('tr')).toThrow(RulesFileError)
  })
})

describe('saveRulesDraft', () => {
  // The person's own comments are part of the file; a save from the menu must
  // not erase them.
  it('keeps hand-written comments and untouched sections exactly', async () => {
    await writeRules(HAND_WRITTEN)
    const draft = openRulesDraft('tr')
    await saveRulesDraft(draft, { ...draft.value, glossaryStemRatio: 0.8 })
    const text = await readFile(localeRulesFile('tr'), 'utf8')
    expect(text).toContain('# My own notes about this file.')
    expect(text).toContain('# Things contributors keep getting wrong.')
    expect(text).toContain('# TDK, madde 4')
    expect(text).toContain('glossaryStemRatio: 0.8')
    expect(loadLocaleRules('tr')?.glossaryStemRatio).toBe(0.8)
  })

  it('writes the changed section and leaves the others alone', async () => {
    await writeRules(HAND_WRITTEN)
    const draft = openRulesDraft('tr')
    await saveRulesDraft(draft, {
      ...draft.value,
      mistakes: [...draft.value.mistakes, { wrong: 'e-posta', right: 'e-posta adresi', note: 'when it means the address' }],
    })
    const rules = loadLocaleRules('tr')!
    expect(rules.patterns.filter((p) => p.kind === 'mistake').map((p) => p.text)).toEqual(['önizleme', 'e-posta'])
    expect(rules.guidance).toBe('Button labels are imperative.')
  })

  it('removes a section that was emptied, rather than writing an empty one', async () => {
    await writeRules(HAND_WRITTEN)
    const draft = openRulesDraft('tr')
    const { guidance: _, ...rest } = draft.value
    await saveRulesDraft(draft, rest)
    expect(await readFile(localeRulesFile('tr'), 'utf8')).not.toMatch(/^guidance:/m)
  })

  it('creates the file from the commented defaults when there was none', async () => {
    const draft = openRulesDraft('tr')
    await saveRulesDraft(draft, { ...draft.value, mistakes: [{ wrong: 'önizleme' }] })
    const text = await readFile(localeRulesFile('tr'), 'utf8')
    expect(text).toMatch(/^# polyglots rules for tr_TR/)
    expect(loadLocaleRules('tr')?.patterns).toHaveLength(1)
  })

  // Nothing invalid reaches the disk; the file on disk stays as it was.
  it('refuses to save rules that would not load, and writes nothing', async () => {
    await writeRules(HAND_WRITTEN)
    const draft = openRulesDraft('tr')
    await expect(
      saveRulesDraft(draft, { ...draft.value, patterns: [{ find: '(unclosed', level: 'hint' }] }),
    ).rejects.toThrow(/patterns\.0\.find/)
    expect(await readFile(localeRulesFile('tr'), 'utf8')).toBe(HAND_WRITTEN)
  })

  // The editor offers "When source lacks", which only a schema-2 file may
  // use, but has no field for the schema itself. Most hand-written files
  // predate the schema line, and refusing the save would send the person out
  // of the editor to add one line by hand.
  it('declares schema 2 at the top when a pattern needs it and the file has no schema line', async () => {
    await writeRules(HAND_WRITTEN)
    const draft = openRulesDraft('tr')
    await saveRulesDraft(draft, {
      ...draft.value,
      patterns: [{ text: 'blog', when: { notSource: 'blog' }, level: 'hint' }],
    })
    const text = await readFile(localeRulesFile('tr'), 'utf8')
    expect(text).toContain('# My own notes about this file.')
    expect(text.split('\n').find((l) => /^[a-z]/i.test(l))).toBe('schema: 2')
    // The file's own title stays its first line, and the comment that
    // described mistakes still sits right above it.
    expect(text.split('\n')[0]).toBe('# polyglots rules for tr_TR (tr)')
    expect(text).toMatch(/# Things contributors keep getting wrong\.\nmistakes:/)
    const rules = loadLocaleRules('tr')!
    expect(rules.schema).toBe(2)
    expect(rules.patterns.find((p) => p.text === 'blog')?.whenNotSource).toBe('blog')
  })

  it('raises an explicit schema: 1 to 2 in place when a pattern needs it', async () => {
    await writeRules('schema: 1\n' + HAND_WRITTEN)
    const draft = openRulesDraft('tr')
    await saveRulesDraft(draft, {
      ...draft.value,
      patterns: [{ text: 'blog', when: { notSource: 'blog' }, level: 'hint' }],
    })
    const text = await readFile(localeRulesFile('tr'), 'utf8')
    expect(text.match(/^schema:.*$/gm)).toEqual(['schema: 2'])
  })

  // A save that needs nothing from schema 2 leaves the file's schema alone:
  // declaring 2 would make an older polyglots refuse a file it can read.
  it('leaves the schema alone when nothing needs schema 2', async () => {
    await writeRules(HAND_WRITTEN)
    const draft = openRulesDraft('tr')
    await saveRulesDraft(draft, { ...draft.value, patterns: [{ text: 'blog', when: { source: 'blog' }, level: 'hint' }] })
    expect(await readFile(localeRulesFile('tr'), 'utf8')).not.toMatch(/^schema:/m)
  })

  // The four schema-2 sections the rules builder edits. The menu edits them
  // too, so the save has to write them, and to declare the schema they need.
  it('writes capitalization, formality, register and sentenceEnd, and declares schema 2', async () => {
    await writeRules(HAND_WRITTEN)
    const draft = openRulesDraft('tr')
    await saveRulesDraft(draft, {
      ...draft.value,
      capitalization: '- Sentence case.\n- Never title case.',
      formality: 'formal',
      register: { audit: '- Address the reader as siz.\n- No slang.', translate: '- Use siz.' },
      sentenceEnd: { unmarked: true, notEnding: 'X\\.$', answers: [{ text: '։', source: '\\.' }] },
    })
    const text = await readFile(localeRulesFile('tr'), 'utf8')
    expect(text.match(/^schema:.*$/gm)).toEqual(['schema: 2'])
    expect(text).toContain('# My own notes about this file.')
    // Written as a block, the way a person writes several prompt lines.
    expect(text).toMatch(/^capitalization: \|/m)
    const rules = loadLocaleRules('tr')!
    expect(rules.capitalization).toBe('- Sentence case.\n- Never title case.\n')
    expect(rules.formality).toBe('formal')
    expect(rules.register).toEqual({ audit: '- Address the reader as siz.\n- No slang.', translate: '- Use siz.' })
    expect(rules.sentenceEnd).toEqual({ unmarked: true, notEnding: 'X\\.$', answers: [{ text: '։', source: '\\.' }] })
    expect(openRulesDraft('tr').value.formality).toBe('formal')
  })

  it('removes a schema-2 section that was cleared', async () => {
    await writeRules('schema: 2\nformality: informal\nregister: Use sen.\n')
    const draft = openRulesDraft('tr')
    const { formality: _f, register: _r, ...rest } = draft.value
    await saveRulesDraft(draft, rest)
    const text = await readFile(localeRulesFile('tr'), 'utf8')
    expect(text).not.toMatch(/^(formality|register):/m)
  })

  // Edited elsewhere while the menu was open: saving would silently lose that.
  it('refuses to overwrite a file changed on disk since it was opened', async () => {
    await writeRules(HAND_WRITTEN)
    const draft = openRulesDraft('tr')
    await writeRules(HAND_WRITTEN + 'glossaryStemRatio: 0.6\n')
    await expect(saveRulesDraft(draft, { ...draft.value, glossaryStemRatio: 0.9 })).rejects.toThrow(/changed on disk/)
  })
})
