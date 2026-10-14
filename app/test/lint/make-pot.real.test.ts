import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { findOnPath } from '../../src/agent/discover.js'
import { main } from '../../src/cli.js'

// The one test that runs the real make-pot, so a WP-CLI release that changes
// what make-pot writes (references, comments, the marker's survival) fails
// here instead of on a developer's machine. Skipped where wp is not installed,
// which includes CI: downloading the phar there would make every CI run
// depend on GitHub's release hosting.
const wp = findOnPath('wp', process.env)
const fixture = fileURLToPath(new URL('../fixtures/lint/plugin', import.meta.url))

let home: string
let saved: string | undefined
beforeEach(async () => {
  saved = process.env.POLYGLOTS_HOME
  home = await mkdtemp(join(tmpdir(), 'polyglots-lint-real-'))
  process.env.POLYGLOTS_HOME = home
})
afterEach(async () => {
  if (saved === undefined) delete process.env.POLYGLOTS_HOME
  else process.env.POLYGLOTS_HOME = saved
  await rm(home, { recursive: true, force: true })
})

describe.skipIf(wp === undefined)('polyglots lint with the real make-pot', () => {
  it('reports what the fixture plugin gets wrong and honours its markers', async () => {
    const plugin = join(home, 'lint-fixture')
    await cp(fixture, plugin, { recursive: true })
    let out = ''
    const stdout = { isTTY: false, write: (c: string) => ((out += c), true) }
    const stderr = { isTTY: false, write: () => true }
    const stdin = new PassThrough()
    stdin.end()
    const code = await main(['lint', plugin, '--format', 'json'], { env: {}, streams: { stdin, stdout, stderr } })
    const data = JSON.parse(out)
    const found = data.findings.map((f: { rule: string; msgid: string }) => `${f.rule} ${f.msgid}`)
    expect(found).toEqual(['translators-comment Hello %s', 'ambiguous-word Order'])
    expect(code).toBe(1)
  }, 60_000)

  // WP-CLI runs the files a wp-cli.yml names in require:, from its working
  // folder upward. A plugin being linted is someone else's code.
  it("does not run the plugin's wp-cli.yml", async () => {
    const plugin = join(home, 'lint-fixture')
    await cp(fixture, plugin, { recursive: true })
    const marker = join(home, 'ran')
    await writeFile(join(plugin, 'wp-cli.yml'), 'require:\n  - evil.php\n')
    await writeFile(join(plugin, 'evil.php'), `<?php file_put_contents(${JSON.stringify(marker)}, 'x');\n`)
    const sink = { isTTY: false, write: () => true }
    const stdin = new PassThrough()
    stdin.end()
    await main(['lint', plugin], { env: {}, streams: { stdin, stdout: sink, stderr: sink } })
    expect(existsSync(marker)).toBe(false)
  }, 60_000)
})
