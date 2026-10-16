import { isNewer } from '../update/index.js'

// What the home screen tells someone the first time they open a new version.
// Written for a person using the app, not for the changelog's reader: one to
// three short lines a version, naming keys rather than flags, and only for a
// version that changed something they would notice. Most patches have none.
//
// Lines go under `unreleased` when the work is merged, beside its changelog
// line, and the release files them under the version it cuts
// (scripts/release-whats-new.mjs). That way nobody has to guess whether the
// next release is a patch or a minor to write one. Kept apart from
// CHANGELOG.md on purpose: that file is terse for maintainers and names CLI
// flags, and a patch like "the entry table is no longer written" is right
// there and noise here.
export const WHATS_NEW: Readonly<Record<string, readonly string[]>> = {
  unreleased: [
    'Fetch rules and memory from polyglots-data',
    'Build your rules file in the browser',
    'Translate notes drafts a locale rule fixed',
  ],
  '0.33.0': ['Home shows what is new once, after an update.'],
}

export interface WhatsNew {
  version: string
  items: readonly string[]
}

// A pre-release counts as its release, as the update check reads it.
const release = (version: string): string => version.replace(/[-+].*$/, '')

/**
 * The entries to show, newest first: every version after `seen`, up to and
 * including `current`.
 *
 * `seen` is undefined for a tui.json written before this existed. Its owner
 * used the app already, so they are told about the current version, but not
 * about the ones before it, which they used without being told anything.
 * `unreleased` is never shown: a development build carries it, but it is not
 * a version yet.
 */
export function whatsNewFor(
  seen: string | undefined,
  current: string,
  list: Readonly<Record<string, readonly string[]>> = WHATS_NEW,
): WhatsNew[] {
  const now = release(current)
  return Object.keys(list)
    .filter((v) => v !== 'unreleased' && !isNewer(v, now))
    .filter((v) => (seen === undefined ? v === now : isNewer(v, release(seen))))
    .sort((a, b) => (isNewer(a, b) ? -1 : 1))
    .map((version) => ({ version, items: list[version]! }))
}

/** What to record as seen: never lower than before, so a downgrade and back does not repeat it. */
export function laterVersion(seen: string | undefined, current: string): string {
  return seen !== undefined && isNewer(release(seen), release(current)) ? seen : current
}
