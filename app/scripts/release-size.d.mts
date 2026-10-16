// Types for release-size.mjs, so its test is checked like the rest. The
// script stays plain ESM because release.mjs runs it with bare node, no tsx.
export function releaseArgs(argv: readonly string[]): { size: 'patch' | 'minor' | 'major'; noShip: boolean }
