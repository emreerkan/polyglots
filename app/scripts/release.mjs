#!/usr/bin/env node
// npm run release -- <patch|minor|major> [--no-ship]
//
// Verify, bump, cut the changelog and "What's new", build and commit, in that order. Each step
// can stop the release, and the order is the point: a version bumped onto a
// red tree has to be withdrawn, and a build under a running review can hand a
// half-written dist/ to the MCP server its next batch spawns.
//
// Two decisions stay with people. The size is passed in, because whether a
// change is minor or major is a judgement about what it does to someone already using
// the tool. The changelog lines are written under Unreleased when the work is
// merged; this only moves them.
//
// Then it ships, through ship.mjs: push, CI, tag, publish from GitHub, deploy.
// ship.mjs asks before the first step anyone else sees, and --no-ship stops
// at the commit, for a release to look over first; npm run ship carries on
// from there.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cutRelease } from './release-changelog.mjs'
import { cutWhatsNew } from './release-whats-new.mjs'
import { auditRefusal } from './release-audit.mjs'
import { releaseArgs } from './release-size.mjs'

const app = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(app, '..')
const changelogPath = join(app, 'CHANGELOG.md')
const whatsNewPath = join(app, 'src', 'tui', 'whats-new.ts')

const run = (cmd, args, cwd = app) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })
const read = (cmd, args, cwd = app) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim()

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

let args
try {
  args = releaseArgs(process.argv.slice(2))
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
const { size, noShip } = args

// A release commit carries only the release. Anything else uncommitted would
// either ride along unexplained or be left out of the build that is tagged.
if (read('git', ['status', '--porcelain'], repo) !== '') fail('The working tree has uncommitted changes. Commit or stash them first.')

console.log('==> Checking for a running review or translate')
run('node', ['scripts/no-live-run.mjs'])

// Before the slow steps, so a new advisory is heard about in seconds; the
// reasons it reads the report rather than the exit code are in
// release-audit.mjs.
console.log('==> Auditing production dependencies')
let auditJson
try {
  auditJson = read('npm', ['audit', '--omit=dev', '--audit-level=high', '--json'])
} catch (error) {
  // Non-zero on a finding, with the report still on stdout.
  auditJson = typeof error?.stdout === 'string' ? error.stdout : ''
}
const refusal = auditRefusal(auditJson)
if (refusal) fail(refusal)

console.log('==> Typecheck and tests')
run('npm', ['run', 'typecheck'])
run('npm', ['test'])

// The website renders its terminal demos from src/cli/summaries.ts. Running
// that step here makes a change to the summaries fail at release, not at the
// next deploy.
const site = join(repo, 'website')
const sitePkg = join(site, 'package.json')
if (existsSync(sitePkg) && JSON.parse(readFileSync(sitePkg, 'utf8')).scripts?.snapshot) {
  console.log('==> Website demo snapshot')
  run('npm', ['run', 'snapshot'], site)
}

// Checked before the bump so an empty Unreleased stops the release with
// nothing to undo.
const before = readFileSync(changelogPath, 'utf8')
cutRelease(before, '0.0.0', '1970-01-01')

// Said, not refused: a minor can be a CLI flag no TUI user will meet. But a
// minor or a major is where a line is most often forgotten, so it is said
// before the slow part, while stopping costs nothing.
const whatsNewBefore = readFileSync(whatsNewPath, 'utf8')
if (!cutWhatsNew(whatsNewBefore, '0.0.0').cut) {
  console.log(`› No "What's new" lines under unreleased in src/tui/whats-new.ts${size === 'patch' ? '.' : `: the home screen will say nothing about this ${size}.`}`)
}

const files = ['package.json', 'package-lock.json', 'CHANGELOG.md', 'src/tui/whats-new.ts']
try {
  console.log(`==> Bumping (${size})`)
  const version = read('npm', ['version', size, '--no-git-tag-version']).replace(/^v/, '')
  const date = new Date().toISOString().slice(0, 10)
  const { changelog, notes } = cutRelease(before, version, date)
  writeFileSync(changelogPath, changelog)
  const whatsNew = cutWhatsNew(whatsNewBefore, version)
  if (whatsNew.cut) writeFileSync(whatsNewPath, whatsNew.text)

  // Again, on the tree the commit will hold. The run above saw the version
  // and "What's new" before the cut, so a test pinning the lines under
  // `unreleased` passed here and failed CI on the pushed 1.1.0 commit, which
  // then had to be amended and force-pushed. A failure here restores the
  // files like any other, before anything is committed or pushed.
  console.log('==> Typecheck and tests on the cut')
  run('npm', ['run', 'typecheck'])
  run('npm', ['test'])

  console.log('==> Building')
  run('npm', ['run', 'build'])

  console.log('==> Committing')
  run('git', ['add', ...files])
  run('git', ['commit', '-q', '-m', `Release ${version}`, '-m', notes])
  console.log(`✓ Released ${version}: ${read('git', ['log', '--oneline', '-1'])}`)
} catch (error) {
  // Leaves the tree as it was, so a failed build cannot leave a bumped
  // version or a cut changelog behind to be committed by accident later.
  execFileSync('git', ['checkout', '--', ...files], { cwd: app })
  fail(`Release stopped, version and changelog restored: ${error instanceof Error ? error.message : String(error)}`)
}

if (noShip) {
  console.log('› Not shipped. Ship with: npm run ship')
} else {
  // A separate process, so a ship that stops part way is the same thing to
  // resume as one started by hand: npm run ship.
  const shipped = spawnSync('node', ['scripts/ship.mjs'], { cwd: app, stdio: 'inherit' })
  if (shipped.status !== 0) {
    console.error('› The release commit is made. Ship it, or carry on after a failure, with: npm run ship')
    process.exit(shipped.status ?? 1)
  }
}
