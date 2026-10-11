# Reviewing submissions

`polyglots review` reads a `.po` export of the strings waiting for approval,
checks every one, repairs what it can, and writes out only the entries that
still matter. Everything it leaves out is approvable as it stands.

```
polyglots review wp-plugins-example-stable-de.po
```

## Getting the right file

A `.po` file carries no review status. GlotPress only marks entries as fuzzy;
"waiting" is a fact about the server, not the file. So the export has to be
made with the filter set: in GlotPress, filter by Waiting and export "only
matching the filter". `polyglots fetch --get waiting <project>` does this for
you.

Entries with no translation are skipped and counted as "not submitted".

## What happens to each entry

1. **The rules.** Deterministic checks run first, and decide the hard
   failures on their own: a dropped placeholder, broken HTML, the wrong number
   of plural forms. Whitespace that differs from the source is put back before
   anything else looks at the entry.
2. **The memory.** An entry your translation memory holds word for word is
   settled there and never sent to the model.
3. **The model.** Everything else goes to the reviewer in batches, with the
   rule findings as hints and the glossary, your memory and
   translate.wordpress.org's consistency data available as lookups. It decides
   each entry and writes a fix for the ones it rejects.
4. **The fix is checked.** Every proposed fix is run through the rules again.
   One that introduces an error is rejected, and the rejection is written into
   the file instead of the fix. One that passes is kept, and any softer finding
   it has that the submitted text did not is noted beside it as `fix-suspect`.

## What the checks look for

| Rule | Catches |
|---|---|
| `placeholder` | a `%s`, `%1$d` or `{name}` the translation drops or invents |
| `html` | tags that differ from the source |
| `plural-count` | the wrong number of plural forms for the locale |
| `whitespace` | leading or trailing spaces that differ from the source (repaired) |
| `untranslated` | a translation identical to the English |
| `escaping` | an escaped quote the source does not escape, or the reverse |
| `punctuation` | sentence-ending punctuation that does not match the source |
| `line-breaks` | a different number of line breaks |
| `glossary` | a glossary term the translation does not use |
| `inconsistent` | one source translated several ways in the same file |
| `tm-conflict` | a wording that differs from the one your memory approved |
| `control` | a setting the code reads, such as `on` or `ltr`, that was translated |
| `fix-suspect` | a finding in the model's own fix that the submitted text did not have |

`fix-suspect` checks the model, not the contributor. The fix stays in the file,
and the note names the rule and what it found there, such as a glossary term
the fix dropped. The message to the requester does not count it.

Those run for every language. Some checks only make sense for some languages,
and run only where a locale's rules turn them on: `title-case`, `apostrophe`,
`ampersand` and `number-format`. Turkish has all four. See
[Locale rules](locale-rules.md) to turn them on for yours, and to add your
team's own common mistakes.

## The output

A run that reaches the end writes `<name>-repaired.po` beside the input
(`--out-dir` puts it elsewhere). It holds the flagged entries only, each with
a note saying what was wrong and what was changed. Open it in your `.po`
editor, read the repairs, and approve the rest of the submission in GlotPress.

The summary counts what happened:

- **reviewed**: entries looked at.
- **flagged**: entries that needed work.
- **approvable**: entries nothing was found in.
- **repaired**: flagged entries that now carry a fix, and how many are left
  for you to write.
- **unreviewed**: entries in a batch that failed twice. They are flagged, so
  nothing unread can look approvable.

It also prints a **message for the requester**, a sentence summarising what
was fixed, ready to post on the contributor's submission. Set your
translate.wordpress.org username and the message links straight to their
strings:

```
polyglots config set wporgUsername your-name
```

To post a whole reply rather than the sentence alone, with a greeting, the PTE
verdict and your team's links around it, write a
[reply template](reply-templates.md). The review then prints the filled reply
under the message.

## Rules only

`--no-ai` runs the deterministic checks and nothing else: no agent, no model,
no cost. It writes `<name>-problems.po` with the entries the rules found, and
the soft findings no one has judged are counted as "guesses". It is a quick
first pass, and the honest way to see what the rules alone catch. To work this way all the time, choose No AI
in setup; see [Using polyglots without AI](getting-started.md#using-polyglots-without-ai).

## Batches, time and cost

Entries go to the reviewer 25 at a time (`--batch-size`, or
`config set batchSize`). A batch is one agent call of half a minute or more,
so a three-hundred-entry submission takes a few minutes. Every verdict is
cached: run the same command again after a stop and only the entries not yet
judged are sent. Editing three strings in a file and reviewing it again sends
three.

What a review costs depends on the agent's account. polyglots makes one call
per batch and nothing else. On a plan with usage limits, a large file uses a
noticeable part of them. When the agent reports a quota or rate limit, the run
stops cleanly and exits with code 3; run it again later to carry on.

Verdicts are cached per reviewer and per model, so switching reviewers
reviews again rather than serving one's opinions as another's.
