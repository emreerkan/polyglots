import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../../src/cli.js'
import { RULES_BUILDER_URL, rulesBuilderUrl } from '../../src/rules/builder-url.js'

function sink() {
  return { isTTY: false, text: '', write(chunk: string) { this.text += chunk; return true } }
}

async function run(argv: string[], opened = true) {
  const stdout = sink()
  const stderr = sink()
  const stdin = new PassThrough()
  stdin.end()
  const openBrowser = vi.fn(async (_url: string) => opened)
  const code = await main(argv, { env: {}, streams: { stdin, stdout, stderr }, openBrowser })
  return { code, stdout: stdout.text, stderr: stderr.text, openBrowser }
}

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), 'polyglots-cli-rules-builder-'))
  vi.stubEnv('POLYGLOTS_HOME', home)
  await mkdir(join(home, 'config'), { recursive: true })
  await writeFile(join(home, 'config', 'config.json'), JSON.stringify({ defaultLocale: 'nl/formal' }))
})

describe('rules builder', () => {
  it('prints the builder with the WordPress code and opens it', async () => {
    const r = await run(['rules', 'builder', 'tr'])
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('https://ada.tools/polyglots/rules-builder/?locale=tr_TR')
    expect(r.openBrowser).toHaveBeenCalledWith('https://ada.tools/polyglots/rules-builder/?locale=tr_TR')
  })

  it('uses the default locale when none is given', async () => {
    const r = await run(['rules', 'builder'])
    expect(r.stdout.trim()).toBe(rulesBuilderUrl('nl_NL_formal'))
  })

  it('still prints the address when no browser opens, over SSH for one', async () => {
    const r = await run(['rules', 'builder', 'tr'], false)
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe(rulesBuilderUrl('tr_TR'))
    expect(r.stderr).toMatch(/open the address above/i)
  })

  it('refuses an unknown locale the way the other rules commands do', async () => {
    const builder = await run(['rules', 'builder', 'xx_YY'])
    const path = await run(['rules', 'path', 'xx_YY'])
    expect(builder.code).not.toBe(0)
    expect(builder.stderr).toBe(path.stderr)
    expect(builder.openBrowser).not.toHaveBeenCalled()
    expect(builder.stdout).toBe('')
  })

  it('names the one base address', () => {
    expect(rulesBuilderUrl('pt_PT_ao90')).toBe(`${RULES_BUILDER_URL}?locale=pt_PT_ao90`)
  })
})
