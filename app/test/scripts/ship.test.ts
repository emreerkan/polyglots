import { describe, expect, it } from 'vitest'
import { notesFor } from '../../scripts/release-notes.mjs'
import { planShip, waitForRun, type RunState, type ShipState } from '../../scripts/ship-plan.mjs'

const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

// The state right after `npm run release`: the release commit exists locally
// and nothing has left the machine.
const fresh = {
  branch: 'main',
  clean: true,
  version: '0.28.0',
  headSubject: 'Release 0.28.0',
  head: HEAD,
  remoteHasHead: false,
  remoteIsAncestor: true,
  ci: 'none',
  localTag: null,
  remoteTag: null,
  npmHasVersion: false,
  githubRelease: false,
} as const

describe('planShip', () => {
  it('runs every step for a release that has not left the machine', () => {
    expect(planShip(fresh)).toEqual({ steps: ['push-main', 'wait-ci', 'tag', 'push-tag', 'wait-release', 'deploy'] })
  })

  // A second run after the deploy failed must not push, tag or publish again.
  it('only deploys when the version is already published and released', () => {
    const done = { ...fresh, remoteHasHead: true, ci: 'success', localTag: HEAD, remoteTag: HEAD, npmHasVersion: true, githubRelease: true } as const
    expect(planShip(done)).toEqual({ steps: ['deploy'] })
  })

  it('resumes at the tag when main is pushed and green', () => {
    expect(planShip({ ...fresh, remoteHasHead: true, ci: 'success' })).toEqual({ steps: ['tag', 'push-tag', 'wait-release', 'deploy'] })
  })

  it('waits for a CI run that is still going', () => {
    expect(planShip({ ...fresh, remoteHasHead: true, ci: 'pending' }).steps?.slice(0, 1)).toEqual(['wait-ci'])
  })

  it('waits for the publish when the tag is pushed but npm does not have the version yet', () => {
    const tagged = { ...fresh, remoteHasHead: true, ci: 'success', localTag: HEAD, remoteTag: HEAD } as const
    expect(planShip(tagged)).toEqual({ steps: ['wait-release', 'deploy'] })
  })

  it.each<[Partial<ShipState>, RegExp]>([
    [{ branch: 'feat/x' }, /only from main/],
    [{ clean: false }, /uncommitted changes/],
    [{ headSubject: 'Fix a thing' }, /not the release commit for 0\.28\.0/],
    [{ remoteIsAncestor: false }, /origin\/main has commits/],
    [{ ci: 'failure' }, /CI failed/],
    [{ localTag: OTHER }, /v0\.28\.0 already exists on another commit/],
    [{ remoteTag: OTHER }, /v0\.28\.0 on origin points at another commit/],
  ])('refuses %o', (change, message) => {
    const plan = planShip({ ...fresh, ...change })
    expect(plan.steps).toBeUndefined()
    expect(plan.refusal).toMatch(message)
  })
})

describe('waitForRun', () => {
  // Answers in order, an Error thrown as the failed read it stands for.
  const answers = (...list: Array<RunState | Error>) => {
    let at = 0
    return {
      poll: () => {
        const next = list[Math.min(at++, list.length - 1)]!
        if (next instanceof Error) throw next
        return next
      },
      reads: () => at,
    }
  }
  const wait = async () => {}
  const run = (id: number, state: 'pending' | 'success' | 'failure'): RunState => ({ state, id })

  it('reports the conclusion of a run that finishes', async () => {
    expect(await waitForRun({ ...answers(run(1, 'pending'), run(1, 'success')), wait })).toEqual({ state: 'success', id: 1 })
    expect(await waitForRun({ ...answers(run(1, 'pending'), run(1, 'failure')), wait })).toEqual({ state: 'failure', id: 1 })
  })

  // On 1.6.1 a 502 from the GitHub API read as "CI failed" three times, with
  // the run still queued and later green.
  it('reads again after an API error, which says nothing about the run', async () => {
    const result = await waitForRun({ ...answers(run(1, 'pending'), new Error('HTTP 502'), new Error('HTTP 502'), run(1, 'success')), wait })
    expect(result).toEqual({ state: 'success', id: 1 })
  })

  it('never calls a run failed because it cannot be read', async () => {
    const result = await waitForRun({ ...answers(new Error('HTTP 502')), wait, unreadable: 3 })
    expect(result).toEqual({ state: 'unreadable', error: 'HTTP 502' })
  })

  it('counts only errors in a row', async () => {
    const result = await waitForRun({
      ...answers(new Error('a'), new Error('b'), run(1, 'pending'), new Error('c'), new Error('d'), run(1, 'success')),
      wait,
      unreadable: 3,
    })
    expect(result).toEqual({ state: 'success', id: 1 })
  })

  it('gives up on a run that never appears', async () => {
    expect(await waitForRun({ ...answers({ state: 'none' }), wait, neverAppeared: 3 })).toEqual({ state: 'absent' })
  })

  it('waits as long as a queued run takes', async () => {
    const queued = Array.from({ length: 500 }, () => run(1, 'pending'))
    const result = await waitForRun({ ...answers(...queued, run(1, 'success')), wait, neverAppeared: 3, unreadable: 3 })
    expect(result).toEqual({ state: 'success', id: 1 })
  })
})

describe('notesFor', () => {
  const changelog = '# Changelog\n\n## [Unreleased]\n\n## [0.28.0] - 2026-10-12\n\n### Added\n\n- New.\n\n## [0.27.0] - 2026-10-09\n\n- Old.\n'

  it('returns one version\'s section without its heading', () => {
    expect(notesFor(changelog, '0.28.0')).toBe('### Added\n\n- New.')
    expect(notesFor(changelog, '0.27.0')).toBe('- Old.')
  })

  it('refuses a version the changelog does not have', () => {
    expect(() => notesFor(changelog, '0.29.0')).toThrow(/no section for 0\.29\.0/)
  })
})
