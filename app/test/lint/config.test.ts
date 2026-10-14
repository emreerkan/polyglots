import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_FILE, EMPTY_CONFIG, findConfig, parseConfig } from '../../src/lint/config.js'
import { LintNotStarted } from '../../src/lint/errors.js'

const parseError = (text: string): LintNotStarted => {
  try {
    parseConfig(text, 'x.json')
  } catch (err) {
    if (err instanceof LintNotStarted) return err
    throw err
  }
  throw new Error('parseConfig did not throw')
}

describe('parseConfig', () => {
  it('reads rules and ignore entries', () => {
    const config = parseConfig(
      JSON.stringify({ rules: { 'ambiguous-word': 'off', typography: 'error' }, ignore: [{ rule: 'concatenation', msgid: 'of the' }, { msgid: 'Post', msgctxt: 'noun' }] }),
      'x.json',
    )
    expect(config).toEqual({
      rules: { 'ambiguous-word': 'off', typography: 'error' },
      ignore: [{ rule: 'concatenation', msgid: 'of the' }, { msgid: 'Post', msgctxt: 'noun' }],
    })
  })
  it('fills what the file leaves out', () => {
    expect(parseConfig('{}', 'x.json')).toEqual(EMPTY_CONFIG)
  })
  it('refuses malformed JSON, naming the file', () => {
    expect(parseError('{ rules: ').message).toMatch(/^x\.json is not valid JSON/)
  })
  it('refuses an unknown rule id, so a typo cannot switch nothing off', () => {
    expect(parseError('{"rules":{"concatnation":"off"}}').message).toMatch(/unknown rule "concatnation"/)
    expect(parseError('{"ignore":[{"rule":"concatnation","msgid":"x"}]}').message).toMatch(/unknown rule "concatnation"/)
  })
  it('refuses a setting other than off, warning or error', () => {
    expect(parseError('{"rules":{"typography":"silent"}}').message).toMatch(/rules\.typography must be "off", "warning" or "error"/)
  })
  it('refuses unknown keys at the top and in an ignore entry', () => {
    expect(parseError('{"ignores":[]}').message).toMatch(/unknown key "ignores"/)
    expect(parseError('{"ignore":[{"msgid":"x","context":"y"}]}').message).toMatch(/unknown key "context"/)
  })
  it('refuses an ignore entry without a msgid', () => {
    expect(parseError('{"ignore":[{"rule":"typography"}]}').message).toMatch(/ignore\[0\]\.msgid must be a string/)
  })
  it('refuses a file that is not an object', () => {
    expect(parseError('[]').message).toMatch(/must be a JSON object/)
  })
})

describe('findConfig', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lint-config-'))
    await mkdir(join(dir, 'a'))
    await mkdir(join(dir, 'b'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is empty, with no file, when no folder has one', async () => {
    expect(await findConfig([join(dir, 'a'), join(dir, 'b')])).toEqual({ config: EMPTY_CONFIG })
  })
  it('takes the first folder that has one', async () => {
    await writeFile(join(dir, 'b', CONFIG_FILE), '{"rules":{"typography":"off"}}')
    const found = await findConfig([join(dir, 'a'), join(dir, 'b')])
    expect(found.file).toBe(join(dir, 'b', CONFIG_FILE))
    expect(found.config.rules).toEqual({ typography: 'off' })
  })
  it('reads an explicit file instead of searching', async () => {
    await writeFile(join(dir, 'a', CONFIG_FILE), '{"rules":{"typography":"off"}}')
    await writeFile(join(dir, 'mine.json'), '{"rules":{"typography":"error"}}')
    const found = await findConfig([join(dir, 'a')], join(dir, 'mine.json'))
    expect(found.config.rules).toEqual({ typography: 'error' })
  })
  it('refuses an explicit file that does not exist', async () => {
    await expect(findConfig([], join(dir, 'missing.json'))).rejects.toThrow(LintNotStarted)
  })
})
