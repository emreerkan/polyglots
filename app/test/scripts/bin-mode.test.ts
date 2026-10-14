import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markBinsExecutable } from '../../scripts/bin-mode.mjs'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bin-mode-'))
  await mkdir(join(dir, 'dist'))
  await writeFile(join(dir, 'dist', 'cli.js'), '#!/usr/bin/env node\n', { mode: 0o644 })
  await writeFile(join(dir, 'dist', 'other.js'), '', { mode: 0o644 })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const modeOf = async (file: string) => (await stat(join(dir, file))).mode & 0o777

// clean-dist empties dist/ and tsc writes cli.js anew at 644, so a binary
// linked with npm link stopped running after every build.
describe('markBinsExecutable', () => {
  it('makes every bin in package.json executable, and leaves other files alone', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ bin: { polyglots: 'dist/cli.js' } }))
    await markBinsExecutable(dir)
    expect(await modeOf('dist/cli.js')).toBe(0o755)
    expect(await modeOf('dist/other.js')).toBe(0o644)
  })

  it('reads a bin given as a single path', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x', bin: 'dist/cli.js' }))
    await markBinsExecutable(dir)
    expect(await modeOf('dist/cli.js')).toBe(0o755)
  })
})
