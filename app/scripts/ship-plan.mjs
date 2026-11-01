// What is left of shipping a release, kept apart from ship.mjs so the
// decisions can be tested without git, npm or the network.
//
// Shipping is a row of steps that each change something other people see:
// main on GitHub, a tag, a version on npm, the website. Any of them can fail
// part way, on a red CI run, a network drop or a deploy that cannot reach the
// server. So the plan is worked out from what has already happened, and a
// second run after a failure picks up where the first stopped rather than
// pushing, tagging or publishing twice.

/**
 * @typedef {object} ShipState
 * @property {string} branch
 * @property {boolean} clean
 * @property {string} version the version in package.json
 * @property {string} headSubject the subject line of HEAD
 * @property {string} head HEAD's sha
 * @property {boolean} remoteHasHead origin/main already contains HEAD
 * @property {boolean} remoteIsAncestor origin/main is HEAD or behind it
 * @property {'none' | 'pending' | 'success' | 'failure'} ci the CI run on HEAD
 * @property {string | null} localTag the sha the local tag points at
 * @property {string | null} remoteTag the sha the tag on origin points at
 * @property {boolean} npmHasVersion
 * @property {boolean} githubRelease
 */

/** @typedef {'push-main' | 'wait-ci' | 'tag' | 'push-tag' | 'wait-release' | 'deploy'} ShipStep */

/**
 * @param {ShipState} s
 * @returns {{ steps: ShipStep[], refusal?: undefined } | { steps?: undefined, refusal: string }}
 */
export function planShip(s) {
  const tag = `v${s.version}`
  if (s.branch !== 'main') return { refusal: `Ship only from main; this is ${s.branch}.` }
  if (!s.clean) return { refusal: 'The working tree has uncommitted changes. Commit them or put them away first.' }
  // The tag goes on the release commit and nowhere else: the package npm
  // gets is built from the tag, and a commit made after the release would
  // ship without a changelog entry or a version bump.
  if (s.headSubject !== `Release ${s.version}`) {
    return { refusal: `HEAD is not the release commit for ${s.version} ("${s.headSubject}"). Run npm run release first.` }
  }
  if (!s.remoteIsAncestor) return { refusal: 'origin/main has commits this branch does not. Pull them, release again, then ship.' }
  if (s.ci === 'failure') return { refusal: `CI failed on ${s.head.slice(0, 7)}. Fix it, release again, then ship.` }
  if (s.localTag !== null && s.localTag !== s.head) return { refusal: `${tag} already exists on another commit (${s.localTag.slice(0, 7)}).` }
  if (s.remoteTag !== null && s.remoteTag !== s.head) return { refusal: `${tag} on origin points at another commit (${s.remoteTag.slice(0, 7)}).` }

  /** @type {ShipStep[]} */
  const steps = []
  if (!s.remoteHasHead) steps.push('push-main')
  if (s.ci !== 'success') steps.push('wait-ci')
  if (s.localTag === null) steps.push('tag')
  if (s.remoteTag === null) steps.push('push-tag')
  if (!s.npmHasVersion || !s.githubRelease) steps.push('wait-release')
  // Always: a deploy is a sync, so running it again costs a few seconds and
  // repairs a site that a failed run left behind.
  steps.push('deploy')
  return { steps }
}

/**
 * Waits for a workflow run to finish, by reading its state until it says so.
 *
 * Only a finished run's conclusion decides anything. This used to hand the
 * wait to `gh run watch --exit-status` and read any non-zero exit as a failed
 * run, but that command also exits non-zero when the GitHub API does: shipping
 * 1.6.1 stopped three times on a 502 saying "CI failed" while the runs were
 * queued, and all of them went on to pass. An error here is a read that did
 * not work, so it is read again, and after enough of them in a row the answer
 * is that the state is unknown, which is not the same as red.
 *
 * A pending run has no limit: a queue that takes an hour is GitHub's to clear,
 * and giving up on it would only mean starting this again.
 *
 * @param {object} options
 * @param {() => import('./ship-plan.d.mts').RunState} options.poll reads the run; throws when it cannot
 * @param {() => Promise<void>} options.wait the pause between reads
 * @param {number} [options.neverAppeared] reads with no run before giving up
 * @param {number} [options.unreadable] failed reads in a row before giving up
 * @returns {Promise<import('./ship-plan.d.mts').RunResult>}
 */
export async function waitForRun({ poll, wait, neverAppeared = 12, unreadable = 40 }) {
  let absent = 0
  let errors = 0
  for (;;) {
    let run
    try {
      run = poll()
      errors = 0
    } catch (error) {
      if (++errors >= unreadable) return { state: 'unreadable', error: error instanceof Error ? error.message : String(error) }
      await wait()
      continue
    }
    if (run.state === 'success' || run.state === 'failure') return { state: run.state, id: run.id }
    // A run takes a few seconds to be registered after the push that starts it.
    if (run.state === 'none' && ++absent >= neverAppeared) return { state: 'absent' }
    await wait()
  }
}
