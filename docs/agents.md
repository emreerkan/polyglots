# polyglots for AI agents

Instructions for an AI agent asked to review or translate WordPress `.po`
files with polyglots. A person can follow them too. The same text is served as
plain text at https://ada.tools/polyglots/ai.txt, followed by the full command
reference.

polyglots is a command-line tool for the people who look after a WordPress
locale on translate.wordpress.org. `review` checks a contributor's submitted
strings and writes out only the entries that need work, already repaired.
`translate` fills in untranslated strings with a machine draft that an AI
agent then reviews. Results are `.po` files for a person to read in their own
`.po` editor.
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
   reviews (claude or antigravity) is installed, signed in and set up. It
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

## Ask the person before

- **Any run that uses a model**: `review` without `--no-ai`, `translate`
  (with or without `--dry-run`), `fetch`. They spend the person's agent quota, and `translate` also spends
  DeepL or OpenAI credit. A large file is hours of it.
- **`translate` on a file with fuzzy entries.** Fuzzy entries are overwritten
  unconditionally. If a person marked one fuzzy on purpose, it is lost.
- **`translate --all`**, which re-translates entries that are already done.
- **`--fresh`**, which throws away cached work and pays for it again.
- **`doctor --live`**, which sends a real prompt.
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
- A **reply** follows it when the locale has a reply template: the whole
  comment for the contributor, headed with the template's name. Pass it on
  unchanged too, and leave a `{username}` in it for the person to fill.

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
  key, memory or rules file
  was changed (or exactly what was, if they asked for it).

## More

- [Getting started](getting-started.md)
- [Reviewing submissions](review.md)
- [Translating](translate.md)
- [Configuration](configuration.md)
- [Command reference](https://ada.tools/polyglots/docs/commands/)
