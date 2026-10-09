import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
let home: string | undefined
let previous: string | undefined

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
})
