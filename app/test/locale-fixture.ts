import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach } from 'vitest'
import { configDir } from '../src/paths.js'

/**
 * Puts locale rules files from test/fixtures/locale into the home each test
 * runs in, before every test of the calling file.
 *
 * polyglots ships no locale data, so a test of what Turkish reports or how a
 * Turkish prompt reads needs the Turkish rules file, as a reviewer does. It
 * has to be a beforeEach: test/setup/isolate-home.ts gives every test a fresh
 * POLYGLOTS_HOME, so a file put there once in a beforeAll is gone, with the
 * home it was written to, by the first test. A hook registered here runs after
 * that one, so it writes into the home the test will read.
 */
export function useLocaleFixture(...files: string[]): void {
  beforeEach(() => installLocaleFixture(...files))
}

/** The same, once, for a test that needs the file only for itself. */
export function installLocaleFixture(...files: string[]): void {
  const dir = join(configDir(), 'locales')
  mkdirSync(dir, { recursive: true })
  for (const file of files) copyFileSync(new URL(`fixtures/locale/${file}`, import.meta.url), join(dir, file))
}
