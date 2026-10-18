# polyglots for AI agents

Instructions for an AI agent asked to review or translate WordPress `.po`
files with polyglots, or to check a plugin's or theme's translatable strings. A person can follow them too. The same text is served as
plain text at https://ada.tools/polyglots/ai.txt, followed by the full command
reference.

polyglots is a command-line tool for the people who look after a WordPress
locale on translate.wordpress.org. `review` checks a contributor's submitted
strings and writes out only the entries that need work, already repaired.
`translate` fills in untranslated strings with a machine draft that an AI
agent then reviews. Results are `.po` files for a person to read in their own
`.po` editor. `lint` is for the people who write plugins and themes: it
checks their source strings for what translators cannot fix.
polyglots never uploads anything to translate.wordpress.org. It does send
text off the machine: a review sends each batch of strings to the agent's
model provider, a translation sends source strings to DeepL or OpenAI, and
lookups query translate.wordpress.org.

## Give this to your agent

> Fetch https://ada.tools/polyglots/ai and use polyglots to review this .po
> file. Run the rules-only pass first and report what it found. Ask me before
> running the AI review.

## Start here

Work in this order. Steps 1 to 5 spend nothing; step 6 is the first that does.

1. **Check the install.** `polyglots --version`. It needs Node.js 24 or later.
   If it is missing, `npm install -g polyglots`.
2. **Check the reviewer.** `polyglots doctor` reports whether the agent that
   reviews (claude, antigravity or codex) is installed, signed in and set up. It
   sends no prompt. Add `--json` to parse it.
3. **Know the locale.** `polyglots config get defaultLocale` prints it, or an
   empty line when none is set. polyglots has no default. If none is set, or
   the file is for another locale, pass `--locale` on every command rather
   than changing the setting. Ask the person which locale when the file name
   or its `Language` header does not make it plain.
4. **Make sure the glossary is there.** A review refuses to run without it.
   `polyglots glossary sync --locale <locale>` downloads it; it is free.
5. **Run the rules first.** `polyglots review <file> --no-ai` runs only the
   deterministic checks. It costs nothing and sends nothing to a model.
   Report the counts it prints.
6. **Ask, then run the full review.** `polyglots review <file>`. Tell the
   person how many entries will be reviewed before you start (the rules pass
   printed it). Entries go 25 to a batch, about half a minute each.

For a translation there is no free first pass. Check the install and the
reviewer, then ask before running `polyglots translate <file>`.
`--dry-run` is not a preview: it skips only writing the file, and still sends
every batch to DeepL or OpenAI and to the agent, at the full cost of a real
run. Ask before a dry run exactly as before a real one. A dry run caches both
the drafts and the review verdicts, so a real run right after it, with the
same draft engine, review model and settings, does not pay for them again;
changing any of those, or passing `--fresh`, pays again.

## Checking a plugin's or theme's strings

`polyglots lint <folder>` or `polyglots lint <file>.pot`. It uses no model,
no account and no key, and costs nothing, so it needs no permission to run.
Details are in [Linting plugin and theme strings](lint.md).

- **A folder needs WP-CLI's make-pot.** polyglots uses `wp` when it is on
  `PATH`. Without it, the first run downloads WP-CLI (about 7 MB) from
  GitHub, checks its hash, keeps it, and runs it with `php`. Tell the person
  before that first run. Without PHP, ask them for a `.pot` and lint that.
- **No strings checked** usually means the main plugin file or `style.css`
  has no `Text Domain` header and the folder is not named after the slug.
  Ask for the slug and pass `--domain <slug>`.
- **Its exit codes are its own:** `0` no errors (warnings allowed), `1`
  errors, or warnings with `--strict`, `2` nothing was checked. The table
  under Running unattended is for the other commands.
- **Parse `--format json`**, not the text output. Report errors first, each
  with its file and line and the fix the finding names.
- **Fix the strings, not the report.** Change source code only when the
  person asked you to. Never add a `polyglots-ignore` marker or turn a rule
  off in `.polyglots-lint.json` to make the lint pass without asking.

## Ask the person before

- **Any run that uses a model**: `review` without `--no-ai`, `translate`
  (with or without `--dry-run`), `fetch`. They spend the person's agent quota, and `translate` also spends
  DeepL or OpenAI credit. A large file is hours of it.
- **`translate` on a file with fuzzy entries.** Fuzzy entries are overwritten
  unconditionally. If a person marked one fuzzy on purpose, it is lost.
- **`translate --all`**, which re-translates entries that are already done.
- **`--fresh`**, which throws away cached work and pays for it again.
- **`doctor --live`**, which sends a real prompt.
- **The first `lint` of a folder without `wp` installed**, which downloads
  WP-CLI from GitHub.
- **Changing settings or keys** (`config set`, `config set-key`), importing
  into the translation memory (`tm import`, which cannot be undone), or
  editing locale rules (which makes every file of that locale review again).

## Never

- Upload, approve or reject anything on translate.wordpress.org. polyglots
  does not, and the person decides what goes back.
- Open, edit or delete the files under `~/.local/share/polyglots/`.
  `polyglots.db` is the translation memory, built over months, and cannot be
  rebuilt. To experiment, set `POLYGLOTS_HOME` to an empty folder.
- Run `polyglots` with no arguments. That starts the interactive menu, which
  needs a terminal.
- Run antigravity with `--dangerously-skip-permissions` or add shell
  permissions to it. Review input is untrusted text from contributors.

## Running unattended

- Output is plain when it is not a terminal. Set `NO_COLOR=1` to be sure, and
  `POLYGLOTS_ASCII=1` for ASCII symbols and box lines.
- The `p`, `r` and `q` keys work only on a terminal. In a pipe a run goes to
  the end; interrupting it keeps every batch already finished.
- `translate --all` needs `--yes` when standard input is not a terminal.
- A stopped run resumes: run the same command again and only unfinished
  entries are sent.

| Exit code | Meaning | What to do |
|---|---|---|
| `0` | Success | Report the summary. |
| `1` | Error or aborted | Report the error line; do not retry blindly. |
| `2` | Usage error | Fix the command; see the reference below. |
| `3` | Stopped on a quota or rate limit | Tell the person. Run the same command later to carry on. |

## Reading the results

`review` prints a summary box and writes `<file>-repaired.po` (or
`<file>-problems.po` with `--no-ai`) beside the input. Only flagged entries
are in it, each with a note. Everything else in the submission is approvable.

- **flagged** entries needed work; **repaired** ones carry a fix, and the
  rest are left for the person.
- **unreviewed** entries were in a batch that failed. They are flagged, never
  approvable.
- The **message for the requester** is meant to be posted to the contributor
  as written. It contains an HTML link; pass it on unchanged.
- A **reply** takes its place when the locale has a reply template: the
  whole comment for the contributor, with the message inside it, headed with
  the template's name. Pass it on
  unchanged too. If the person told you the requester's WordPress.org
  username, pass `--requester <username>` to `review`; otherwise leave the
  `{username}` in the reply for the person to fill. A line above the reply
  saying entries are flagged means the verdict needs the person's check
  before it is posted: say so.

`translate` writes into the file it was given. Its summary counts the entries
taken from translation memory, drafted, and marked fuzzy for a person to
check.

## Report back

When you are done, tell the person:

- which commands ran, and whether the rules-only pass ran first;
- the summary counts, and the path of every file written;
- the requester message, if there was one, and the reply, if there was one;
- anything that stopped the run early, with the exit code;
- that nothing was uploaded to translate.wordpress.org, and that no setting,
  key, memory, rules file or reply template was changed (or exactly what
  was, if they asked for it).

## More

- [Getting started](getting-started.md)
- [Reviewing submissions](review.md)
- [Translating](translate.md)
- [Linting plugin and theme strings](lint.md)
- [Configuration](configuration.md)
- [Command reference](https://ada.tools/polyglots/docs/commands/)
