import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyRootDocs } from '../../scripts/prepack.mjs'

const app = fileURLToPath(new URL('../..', import.meta.url))
const pkg = JSON.parse(await readFile(join(app, 'package.json'), 'utf8')) as {
  files?: string[]
  bin?: Record<string, string>
  scripts: Record<string, string>
  repository?: { url: string; directory?: string }
  homepage?: string
  bugs?: { url: string }
  keywords?: string[]
  description?: string
}

describe('package.json', () => {
  // Written the way npm stores it. With a leading ./ the 0.28.0 publish, on
  // npm 11.19, warned that the bin "was invalid and removed" while it was
  // only rewriting the path, which is the kind of warning that gets ignored
  // until the day it is true.
  it('names the CLI in bin without a leading ./', () => {
    expect(pkg.bin).toEqual({ polyglots: 'dist/cli.js' })
  })

  // Without it npm pack shipped src/, test/ and scripts/. README, LICENSE and
  // package.json itself are always included by npm and need no entry.
  it('publishes only the built code, the stats translations and the changelog', () => {
    expect(pkg.files).toEqual(['dist/', 'i18n/', 'CHANGELOG.md'])
  })

  // prepare runs on every install from git and before every pack and publish.
  // It used to fetch translate.wordpress.org/stats/, so a publish depended on
  // wp.org being up and could ship a table nobody had looked at. The table is
  // refreshed on purpose with npm run update-locales and committed.
  it('builds without the network', () => {
    for (const name of ['prepare', 'prebuild', 'build']) {
      expect(pkg.scripts[name] ?? '').not.toMatch(/update-locales/)
    }
    expect(pkg.scripts.prepare).toBe('npm run build')
    expect(pkg.scripts['update-locales']).toBe('node scripts/update-locales.mjs')
  })

  it('says where it comes from and where to report a problem', () => {
    expect(pkg.description).toBeTruthy()
    expect(pkg.repository).toEqual({ type: 'git', url: 'git+https://github.com/emreerkan/polyglots.git', directory: 'app' })
    expect(pkg.homepage).toBe('https://ada.tools/polyglots/')
    expect(pkg.bugs).toEqual({ url: 'https://github.com/emreerkan/polyglots/issues' })
    expect(pkg.keywords).toContain('wordpress')
  })
})

describe('copyRootDocs', () => {
  let root: string
  let appDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'polyglots-prepack-'))
    appDir = join(root, 'app')
    await mkdir(appDir)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('copies README.md and LICENSE from the repo root into app/', async () => {
    await writeFile(join(root, 'README.md'), '# polyglots\n')
    await writeFile(join(root, 'LICENSE'), 'MIT\n')
    copyRootDocs(appDir)
    expect(await readFile(join(appDir, 'README.md'), 'utf8')).toBe('# polyglots\n')
    expect(await readFile(join(appDir, 'LICENSE'), 'utf8')).toBe('MIT\n')
  })

  // It used to skip a missing file in silence, so a package could be published
  // with no licence text and a blank npm page.
  it('refuses, naming every missing file and where it was looked for', async () => {
    await writeFile(join(root, 'README.md'), '# polyglots\n')
    expect(() => copyRootDocs(appDir)).toThrow(`LICENSE is missing from ${root}`)
    await rm(join(root, 'README.md'))
    expect(() => copyRootDocs(appDir)).toThrow(`README.md, LICENSE are missing from ${root}`)
  })
})
