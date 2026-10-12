# Contributing to polyglots

Thank you for helping. polyglots is used by translate.wordpress.org locale
teams, so its output is read by contributors as well as by the person running
it. Correctness and clear wording matter more than features.

## Ways to help without writing code

- **Report a wrong finding.** A rule that flags a correct translation, or misses
  a wrong one, is the most useful report there is. Include the source string,
  the translation, the locale and what polyglots said.
- **Locale rules.** Each locale can have its own rule pack: which checks run,
  common mistakes, patterns and guidance for the reviewer. If your locale has
  none, or its defaults need correcting, open an issue with what your team
  agrees on. `polyglots rules check <locale>` shows what applies today.
- **Translate the statistics page.** Its strings are in
  `app/i18n/stats/stats.pot`; add a `.po` for your language beside `tr_TR.po`.
- **Documentation.** The pages in `docs/` are the website's documentation. Fix
  what is unclear or wrong there.

## Layout

- `app/`: the CLI and interactive mode, the package published to npm.
- `website/`: the Astro site at ada.tools/polyglots, built from `docs/`.
- `docs/`: public documentation.

There is no `package.json` at the root. Run app commands inside `app/` and
site commands inside `website/`.

## Setting up

```
cd app
npm ci
npm test
npm run typecheck
```

Node.js 24 or newer, and a C++ compiler with `make`. `npm ci` compiles
better-sqlite3 from source, because the lockfile does not record that the
package ships ready-made binaries. On macOS that is the Xcode command line
tools (`xcode-select --install`), on Debian and Ubuntu `build-essential`, on
Windows the "Desktop development with C++" workload of Visual Studio Build
Tools. A user's `npm install -g polyglots` needs none of this.

Tests build their own temporary homes; they never touch
`~/.config/polyglots` or `~/.local/share/polyglots`.

`npm run dev -- <command>` runs the CLI from source. `npm run build` compiles
to `dist/`; it refuses while a review or translate is running on your machine,
because a run starts its lookup server from `dist/` for every batch.

For the website: `cd website && npm ci && npm run build`. Its terminal demos
run the real CLI with faked network and model calls, so a change to the CLI's
output shows up on the site.

## Making a change

- **Write the failing test first** and run it to see it fail. A test written
  after the code, that passes on its first run, has proved nothing. Tests use
  Vitest and mirror `src/` under `test/`.
- **Keep the cache honest.** Review verdicts and drafts are cached. If you add
  anything to a prompt, add it to the cache key in the same change
  (`src/jobs/hash.ts`).
- **Never write to `polyglots.db` from a path that only reads.** It holds a
  translation memory people built over months and cannot rebuild.
- **Comments explain why**, including the alternative that was rejected. A
  comment that repeats what the next line does is noise.
- **Typecheck covers the tests.** `npm run typecheck` must pass; there is no
  separate lint step.

## Commits and pull requests

- A commit message is an imperative sentence describing the change in
  behaviour, then a body saying why it was worth making. No
  conventional-commit prefixes, no bullet list of the diff.
- Add a line under `## [Unreleased]` in `app/CHANGELOG.md` for anything a
  user would notice: one line, saying what changed, not why.
- Open a pull request against `main`. Say how you tested it, and include
  before and after output when the change is visible.

## Licence

By contributing you agree that your contribution is released under the MIT
licence in [LICENSE](LICENSE).
