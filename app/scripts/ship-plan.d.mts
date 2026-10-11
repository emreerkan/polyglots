// Types for ship-plan.mjs, so its test is checked like the rest.
export interface ShipState {
  branch: string
  clean: boolean
  version: string
  headSubject: string
  head: string
  remoteHasHead: boolean
  remoteIsAncestor: boolean
  ci: 'none' | 'pending' | 'success' | 'failure'
  localTag: string | null
  remoteTag: string | null
  npmHasVersion: boolean
  githubRelease: boolean
}
export type ShipStep = 'push-main' | 'wait-ci' | 'tag' | 'push-tag' | 'wait-release' | 'deploy'
export function planShip(s: ShipState): { steps: ShipStep[]; refusal?: undefined } | { steps?: undefined; refusal: string }
