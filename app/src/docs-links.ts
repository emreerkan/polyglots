// The website and its documentation pages. A message that tells someone to
// read more must name a place an installed copy can reach, and a docs/ path
// only exists in a checkout of the repo.
export const SITE_URL = 'https://ada.tools/polyglots/'
const DOCS_BASE = `${SITE_URL}docs`

export const docsUrl = (page: 'antigravity' | 'local-models'): string => `${DOCS_BASE}/${page}/`

// Every release's notes, for what the home screen's "What's new" has no room
// for. Shown without the scheme: it is read, not clicked, in most terminals.
export const RELEASES_URL = 'github.com/emreerkan/polyglots/releases'
