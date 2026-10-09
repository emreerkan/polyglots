# Getting started

polyglots reviews and translates WordPress `.po` files. It is written for the
people who look after a locale on translate.wordpress.org: it checks the
strings contributors submit, repairs what it can, and drafts the strings
nobody has translated yet. Every result is a `.po` file you read in whatever
editor you use for them (Poedit, Lokalize, Virtaal, a text editor) before
anything goes back to GlotPress. polyglots never uploads anything
to translate.wordpress.org; see [what leaves your machine](#what-leaves-your-machine).

## Install

You need Node.js 24 or later.

```
npm install -g polyglots
```

Or run it without installing:

```
npx polyglots
```

Then run `polyglots` with nothing after it. That opens the interactive app,
which walks you through the setup below in a wizard and does everything else
with the arrow keys and enter: see [The interactive app](interactive.md).

The rest of this page does the same with commands, which suit scripts and
scheduled jobs. Every screen in the app has a command behind it, so anything
you do there can also be scripted.

## Choose a reviewer

A review or a translation is judged by an AI agent that runs on your machine:
the [Claude Code](https://claude.com/claude-code) CLI (`claude`, the default)
or the Antigravity CLI (`agy`). polyglots runs the agent for you. It does not
call a model API itself, so the agent uses whichever account it is already
signed in to.

Check which agents are installed and ready:

```
polyglots doctor
```

`doctor` sends no prompt. `polyglots doctor --live` also sends one short
prompt to each agent, which counts as a request on a metered plan.

To use antigravity, follow [its setup](antigravity.md) first. To review or
draft with a model on your own machine, see [local models](local-models.md).

## Set your locale

polyglots has no default locale. Set yours once (`de` here stands for
yours):

```
polyglots config set defaultLocale de
```

Any WordPress locale works: `de`, `de_DE`, `pt-br`, `nl_NL_formal`. `review`,
`translate`, `fetch`, the `glossary` and `tm` commands and `config add-name`
also take `--locale` for a single run; the `rules` commands take the locale as
an argument. A command that needs a locale and has none stops and says so.

`review` and `translate` can also go without one: a file exported from
GlotPress names its language in its header, and when every file given names
the same one, and translate.wordpress.org has a single translation set for it,
that is the locale used, and the run says so. A language with several sets,
such as German with its formal variant, needs the locale named.

## Download the glossary

A review checks every string against your locale's glossary from
translate.wordpress.org, and refuses to start without one. Download it once,
and again whenever your team changes it:

```
polyglots glossary sync
```

## Review a submission

In GlotPress, filter the project by Waiting and export "only matching the
filter" as `.po`. The file itself carries no review status, so the filter is
what makes it the submission. Then:

```
polyglots review wp-plugins-example-stable-de.po
```

polyglots writes `wp-plugins-example-stable-de-repaired.po` beside it. It
holds only the entries that needed work, with the repairs already made, and
each one carries a note saying what was wrong. Everything else is approvable
as it stands. The run also prints a message you can post to the contributor.
See [Reviewing submissions](review.md).

## Translate untranslated strings

Export the untranslated strings, then:

```
polyglots translate wp-plugins-example-stable-de.po
```

The file is filled in place. Entries polyglots is unsure of are marked fuzzy
for you to check. Drafting needs a DeepL or OpenAI key, or a local model. See
[Translating](translate.md).

## Or let it fetch for you

`fetch` downloads the exports from translate.wordpress.org itself, then
reviews or translates each one:

```
polyglots fetch --get waiting example-plugin another-theme
polyglots fetch --get untranslated example-plugin
```

Names are slugs or translate.wordpress.org URLs. A list can also be piped in,
one per line. The files land in `~/Downloads/polyglots` unless you pass
`--out-dir`.

## Stop, pause, resume

A long run can be paused with `p`, resumed with `r`, and stopped with `q`.
Each takes effect after the batch in progress, so nothing already paid for is
lost. Running the same command again carries on where it stopped: every
verdict and draft is cached, so only the entries that were not reached are
sent again. `--fresh` ignores the cache.

## Where your data lives

| What | Where |
|---|---|
| Settings | `~/.config/polyglots/config.json` |
| API keys | `~/.config/polyglots/.env` |
| Translation memory and glossary | `~/.local/share/polyglots/polyglots.db` |
| Run history and caches | `~/.local/share/polyglots/jobs.db` |

Set `POLYGLOTS_HOME` to keep all of it under one folder instead. These files
are never uploaded. The translation memory is built from your own imports and
is the one file worth backing up: `jobs.db` can be deleted, at the cost of
re-reviewing.

## What leaves your machine

polyglots uploads nothing to translate.wordpress.org. Text does leave the
machine in three ways:

- **Reviewing** sends each batch of strings, with its glossary terms and
  memory matches, to the agent you review with, and so to its model provider
  (Anthropic for Claude, Google for Antigravity).
- **Drafting** sends source strings to DeepL or OpenAI.
- **Lookups** query translate.wordpress.org for the glossary, the exports and
  consistency data.
- **Usage totals**, only if you turn them on: a weekly count of strings
  reviewed, drafted and repaired, with no names, strings or locale. See
  [Usage statistics](usage-statistics.md).

With a [local model](local-models.md) for both drafting and reviewing, or
with [No AI](#using-polyglots-without-ai), the strings stay on your machine;
only the translate.wordpress.org lookups remain.

Claude is limited to polyglots' three lookups on every run, and cannot open
files or run commands. Antigravity's limits come from its own settings and
from whatever other tool servers you registered with it; see
[its setup](antigravity.md).

## Using polyglots without AI

polyglots works without any AI model or third-party service. Choose **No AI**
in the setup wizard, or run:

```
polyglots config set reviewProvider none
polyglots config set defaultDraftEngine none
```

With no review provider, `polyglots review` runs the rules only, exactly as
`--no-ai` does, and says so when it starts. The app's Review screen holds
"Skip AI checks" on, and `polyglots doctor` reports the mode rather than a
missing agent. The only network calls left are to translate.wordpress.org,
for the glossary and the consistency lookups, the daily check for a newer
version on npm (off with `polyglots config set updateCheck off`), and the
weekly usage totals if you turned those on.

**What the rules check.** Placeholders (printf and `{brace}` forms), HTML
tags, the number of plural forms, leading and trailing whitespace and line
breaks, escaping, ampersands and apostrophes, punctuation at the end of a
string, number formats, title case, untranslated strings, glossary terms,
your locale's own rules and proper nouns, consistency within the file, and
consistency with your translation memory. Mechanical faults the rules can
fix, such as whitespace, are repaired and written to the `-problems.po` file
beside the submission. Everything else is noted there for you.

**What they cannot judge.** Whether a translation means what the source
means, reads naturally, suits the context a string appears in, or keeps the
right tone and register. A wrong word that is spelled correctly, a sentence
that drops a clause, or a term that is right in general and wrong for this
string all pass the rules. Findings the rules can only suspect, rather than
prove, are listed as "guesses" for you to decide; with AI review they would
be adjudicated for you.

**Translating without a draft engine.** `polyglots translate --draft-engine
none` fills every entry your translation memory already holds and leaves the
rest exactly as they were, telling you how many it left untranslated. No
machine translation is asked for and no AI review runs. If you keep a draft
engine such as DeepL but set no review provider, its drafts are written as
fuzzy entries for you to check, since nothing reviewed them.

## Next

- [The interactive app](interactive.md): the screens and every key.
- [Using polyglots without AI](#using-polyglots-without-ai): the rules alone.
- [Configuration](configuration.md): every setting and key.
- [Locale rules](locale-rules.md): teach the checks your team's conventions.
- [Command reference](https://ada.tools/polyglots/docs/commands/): every
  command and option, also in `polyglots --help`.
