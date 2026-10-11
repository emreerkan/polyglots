#!/usr/bin/env node
// npm run ship [-- --yes | --dry-run]
//
// Ships the release commit that `npm run release` made: pushes main, waits for
// CI on it, tags it, pushes the tag, waits for the publish workflow to put the
// version on npm and make the GitHub Release, then deploys the website.
//
// npm is published to from GitHub, not from here. The tag push starts
// .github/workflows/release.yml, which runs CI again on the tag and publishes
// with npm's trusted publishing: no token on this machine or in the repo, and
// a provenance record tying the package to the commit it was built from.
//
// The website is deployed from here, because deploy.sh reaches the web server
// over SSH and that access stays on the maintainer's machine.
//
// Every step is worked out from what has already happened (ship-plan.mjs), so
// running this again after a failure carries on rather than starting over.
// It asks once before the first step anyone else can see.

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { planShip } from './ship-plan.mjs'

const app = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(app, '..')
const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'))
const version = pkg.version
const tag = `v${version}`

const read = (cmd, args) => execFileSync(cmd, args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const run = (cmd, args, cwd = repo) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })
const succeeds = (cmd, args) => spawnSync(cmd, args, { cwd: repo, stdio: 'ignore' }).status === 0

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const assumeYes = args.has('--yes')

/** The CI run on a commit, by the conclusion GitHub reports. */
function ciOn(sha, workflow) {
  const runs = JSON.parse(read('gh', ['run', 'list', '--workflow', workflow, '--commit', sha, '--limit', '5', '--json', 'databaseId,status,conclusion,event']))
  const pushed = runs.filter((r) => r.event === 'push')
  const latest = pushed[0]
  if (!latest) return { state: 'none' }
  if (latest.status !== 'completed') return { state: 'pending', id: latest.databaseId }
  return { state: latest.conclusion === 'success' ? 'success' : 'failure', id: latest.databaseId }
}

function remoteTagSha() {
  // An annotated tag lists twice: the tag object, and with ^{} the commit it
  // points at. The commit is the one to compare with HEAD.
  const lines = read('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]).split('\n').filter(Boolean)
  const peeled = lines.find((l) => l.endsWith('^{}')) ?? lines[0]
  return peeled ? peeled.split(/\s+/)[0] : null
}

function state() {
  run('git', ['fetch', '-q', '--no-tags', 'origin', 'main'])
  const head = read('git', ['rev-parse', 'HEAD'])
  return {
    branch: read('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    clean: read('git', ['status', '--porcelain']) === '',
    version,
    headSubject: read('git', ['log', '-1', '--format=%s']),
    head,
    remoteHasHead: succeeds('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']),
    remoteIsAncestor: succeeds('git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD']),
    ci: ciOn(head, 'ci.yml').state,
    localTag: succeeds('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]) ? read('git', ['rev-parse', `${tag}^{commit}`]) : null,
    remoteTag: remoteTagSha(),
    npmHasVersion: succeeds('npm', ['view', `${pkg.name}@${version}`, 'version']),
    githubRelease: succeeds('gh', ['release', 'view', tag]),
  }
}

/** Waits for a workflow run on a commit to appear, then for it to finish. */
async function watch(sha, workflow, what) {
  let found = ciOn(sha, workflow)
  // A run takes a few seconds to be registered after the push that starts it.
  for (let i = 0; found.state === 'none' && i < 36; i++) {
    await sleep(5000)
    found = ciOn(sha, workflow)
  }
  if (found.state === 'none') fail(`No ${what} run appeared for ${sha.slice(0, 7)} after three minutes. Check GitHub Actions, then run npm run ship again.`)
  if (found.state !== 'success') {
    const watched = spawnSync('gh', ['run', 'watch', String(found.id), '--exit-status'], { cwd: repo, stdio: 'inherit' })
    if (watched.status !== 0) fail(`${what} failed: gh run view ${found.id} --log-failed`)
  }
  console.log(`✓ ${what} passed`)
}

async function waitForNpm() {
  // The registry can take a while to answer for a version it has just
  // accepted ("may take a few minutes to become available"), so a missing
  // version right after the workflow is not yet a fault. Two minutes was not
  // enough for 0.28.0; ten is generous, and a rerun resumes here anyway.
  for (let i = 0; i < 60; i++) {
    if (succeeds('npm', ['view', `${pkg.name}@${version}`, 'version'])) return
    await sleep(10000)
  }
  fail(`The publish workflow passed but npm does not list ${pkg.name}@${version} after ten minutes. Run npm run ship again once it does.`)
}

const DESCRIBE = {
  'push-main': 'push main to origin',
  'wait-ci': 'wait for CI on the release commit',
  tag: `tag the release commit ${tag}`,
  'push-tag': `push ${tag}, which publishes to npm from GitHub`,
  'wait-release': 'wait for the npm package and the GitHub Release',
  deploy: 'deploy the website',
}

const s = state()
const plan = planShip(s)
if (plan.refusal) fail(plan.refusal)

console.log(`Shipping ${pkg.name} ${version} (${s.head.slice(0, 7)}):`)
for (const step of plan.steps) console.log(`  · ${DESCRIBE[step]}`)
if (dryRun) process.exit(0)

const visible = plan.steps.some((step) => step !== 'wait-ci' && step !== 'wait-release')
if (visible && !assumeYes) {
  if (!process.stdin.isTTY) fail('Not a terminal, so there is no one to ask. Run with --yes to ship.')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`Ship ${version}? [y/N] `)
  rl.close()
  if (!/^y(es)?$/i.test(answer.trim())) fail('Not shipped.')
}

for (const step of plan.steps) {
  console.log(`==> ${DESCRIBE[step]}`)
  if (step === 'push-main') run('git', ['push', '--no-follow-tags', 'origin', 'HEAD:main'])
  else if (step === 'wait-ci') await watch(s.head, 'ci.yml', 'CI')
  else if (step === 'tag') run('git', ['tag', '-a', tag, '-m', `Release ${version}`])
  else if (step === 'push-tag') run('git', ['push', 'origin', `refs/tags/${tag}`])
  else if (step === 'wait-release') {
    await watch(s.head, 'release.yml', 'The publish workflow')
    await waitForNpm()
  } else if (step === 'deploy') run(join(repo, 'deploy.sh'), [], repo)
}

console.log(`✓ Shipped ${version}: https://www.npmjs.com/package/${pkg.name}/v/${version}`)
