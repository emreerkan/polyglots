import { describe, expect, it } from 'vitest'
import { notesFor } from '../../scripts/release-notes.mjs'
import { planShip, type ShipState } from '../../scripts/ship-plan.mjs'

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
