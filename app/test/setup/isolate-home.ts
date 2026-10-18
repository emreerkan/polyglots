import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'

// Every test gets its own POLYGLOTS_HOME, because everything that resolves a
// path reads the variable fresh on each call.
//
// Two things go wrong without this, and only one of them is about tests. A
// test that never sets the variable reads and writes the developer's own
// config and databases, including a translation memory built up over months.
// And because the job store is keyed by content rather than by run, two tests
// sharing a fixture share a cache entry: the second one is served the first
// one's verdict and never calls its own adjudicator, so it passes while
// testing nothing.
//
// A test that wants a specific home still sets it in its own hook, which runs
// after this one.
//
// HOME goes to the same folder, and USERPROFILE with it, which is what
// os.homedir() reads on Windows. Not everything goes through POLYGLOTS_HOME:
// the antigravity provider reads its model from agy's own settings under the
// home folder, so a test that runs as antigravity was handed whatever model
// the developer had configured, and passed or failed on that machine's setup
// rather than on its own fixtures.
let home: string | undefined
let previous: string | undefined
const HOME_VARS = ['HOME', 'USERPROFILE'] as const
let previousHome: Partial<Record<(typeof HOME_VARS)[number], string>> = {}
// codex reads CODEX_HOME before the home folder, so swapping HOME alone left a
// developer's exported CODEX_HOME, and the model in its config.toml, in every
// codex test. It goes to the .codex folder codex would use under the new home.
let previousCodexHome: string | undefined

// Where an opted-in usage send goes. Port 9 on loopback is the discard port,
// which nothing listens on, so a test that turns usage statistics on by
// accident gets a refused connection in a millisecond instead of reaching
// ada.tools. A test that wants a real endpoint starts one and passes its URL.
process.env.POLYGLOTS_USAGE_URL = 'http://127.0.0.1:9/polyglots/api/usage'
// And the update check, for a test that runs a command on a terminal
// without faking it: npm's registry is never asked from the suite.
process.env.POLYGLOTS_UPDATE_URL = 'http://127.0.0.1:9/polyglots/latest'

beforeEach(() => {
  previous = process.env.POLYGLOTS_HOME
  home = mkdtempSync(join(tmpdir(), 'polyglots-test-'))
  process.env.POLYGLOTS_HOME = home
  previousHome = {}
  for (const name of HOME_VARS) {
    const value = process.env[name]
    if (value !== undefined) previousHome[name] = value
    process.env[name] = home
  }
  previousCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = join(home, '.codex')
  // A swap that stopped working, on a platform whose homedir() reads
  // something else or after a refactor of the list above, would let every
  // antigravity test write the developer's own ~/.gemini settings;
  // isolate-home.test.ts would say so, but only after the suite had run.
  // This stops the first test that would. It compares with the folder just
  // made, not with userInfo(): a developer whose HOME is not the account
  // database's home would pass that check with the swap broken, and in a
  // container whose uid has no passwd entry userInfo() throws.
  if (homedir() !== home) throw new Error('HOME is not isolated')
})

afterEach(() => {
  // Never fail a passing test over cleanup: a spawned child may still hold the
  // directory, and the temp dir is the OS's problem after the run either way.
  if (home) {
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // ignored
    }
  }
  home = undefined
  if (previous === undefined) delete process.env.POLYGLOTS_HOME
  else process.env.POLYGLOTS_HOME = previous
  for (const name of HOME_VARS) {
    const value = previousHome[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = previousCodexHome
})
