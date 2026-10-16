# Translating

`polyglots translate` fills in the entries of a `.po` file that have no
translation, or only a fuzzy one, and writes them back into the same file.

```
polyglots translate wp-plugins-example-stable-de.po
```

Several files, or a glob, can be given at once.

`--dry-run` leaves the file untouched, and that is all it skips. Every batch
is still drafted by DeepL or OpenAI and reviewed by the agent, so it costs
exactly what a real run costs. There is no free preview of a translation. A
dry run does cache both the drafts and the review verdicts, so a real run
right after it, with the same draft engine, review model and settings, does
not pay for them again. Changing any of those, or passing `--fresh`, pays
again.

## How an entry gets its translation

1. **Translation memory first.** An entry whose source your memory holds
   word for word takes the approved wording, and nothing is sent anywhere.
2. **A draft.** The rest are drafted in batches by DeepL, OpenAI or a local
   model.
3. **A review of the draft.** The agent reviews each batch of drafts against
   the glossary, your memory and translate.wordpress.org's consistency data,
   corrects them, and marks fuzzy the ones it is unsure of.

The summary says how many came from memory, how many were drafted, and how
many are fuzzy. Read the fuzzy ones in your `.po` editor before you import
the file into GlotPress.

If your [locale rules](locale-rules.md) have `fix` patterns, translate applies
them to every draft. Each entry a fix changed carries a translator comment,
`polyglots: locale rule: <note>`, fuzzy or not, and the summary counts them as
"fixed by locale rules".

**A fuzzy entry is overwritten.** translate treats fuzzy as "not translated
yet", which is what GlotPress means by it. If you marked an entry fuzzy as a
note to yourself, or rejected a draft by hand and kept it fuzzy, the next run
replaces it. Keep such entries out of the file you translate.

`--all` translates every entry, including ones that already have a
translation. It asks before it starts; `--yes` skips the question.

## Draft engines

| Engine | Needs | Cost |
|---|---|---|
| `deepl` (default) | `DEEPL_API_KEY` | Free within DeepL API Free's allowance: 1,000,000 characters once for new accounts, 500,000 a month for accounts that already had the old plan (at the time of writing); metered on a paid plan. |
| `openai` | `OPENAI_API_KEY` | Metered per token by OpenAI. |
| `local` | a model server on your machine | Nothing; see [local models](local-models.md). |

Store a key once:

```
polyglots config set-key DEEPL_API_KEY
```

It is read from standard input when no value is given, so it stays out of
your shell history. Choose the engine per run with `--draft-engine`, or set
the default with `polyglots config set defaultDraftEngine openai`.

The review of the drafts uses the same agent as `polyglots review`, and costs
what a review of that many entries costs.

## Translation memory

The memory is your locale's approved translations, kept in a local database
and used by both translate and review. Fill it from TMX or `.po` exports, such
as a TMX from Poedit or another CAT tool, or GlotPress exports of finished
projects:

```
polyglots tm import exports/*.tmx
polyglots tm import --project woocommerce woocommerce-de.po
```

Importing adds and never removes. `polyglots tm export memory.tmx` writes it
back out, as TMX or `.po` by the file name.

The memory is built from your own work over time and cannot be downloaded
again, so it is worth backing up:
`~/.local/share/polyglots/polyglots.db`.

### Fetching a locale's memory

[polyglots-data](https://github.com/emreerkan/polyglots-data) publishes a
translation memory for some locales. Add it to your memory with:

```
polyglots tm fetch tr
```

Without a locale it uses your default one. Before downloading, it shows the
number of strings, the download size, the build date, the number of projects
and how many strings your memory already holds for the locale, then asks. Add
`--yes` to skip the question; it is required when stdin or stderr is not a
terminal.

The download is checked against the size and sha512 in the polyglots-data
manifest, and refused when it does not match. Strings land under the locale
slug (`tr`), the same as your own imports. Each string keeps the first project
polyglots-data tags it with, or `polyglots-data` when it has none.

The fetch only adds. A string your memory already holds, with the same
context and the same translation, is left as it is: its project and date do
not change. New strings carry the date of the polyglots-data build, so they do
not rank above your own alternatives only because they arrived later. So:

- A second fetch adds the strings that are new in polyglots-data. It does not
  refresh the strings you already have.
- A string that polyglots-data removes stays in your memory. Removals never
  reach a memory that already holds the string.

`POLYGLOTS_DATA_URL` points the command at another manifest, as for
`polyglots rules fetch`.

## The glossary

`polyglots glossary sync` downloads your locale's glossary from
translate.wordpress.org. Both commands use it, and review refuses to run
without it. `polyglots glossary export glossary.csv` writes it as a CSV with
Term, Translation and Notes columns, the layout Poedit imports.

Once a day polyglots asks translate.wordpress.org when each glossary you
synced last changed. If it changed after your copy, the end of the next
command says so and names the `polyglots glossary sync` command to run. When
wp.org cannot say, a copy older than a month gets the same reminder, and
any copy older than three months gets it whatever wp.org says. The
`updateCheck` setting turns this off together with the update check.

## Splitting a large file

A file of several thousand strings is easier to review, and to submit, in
parts:

```
polyglots split --size 500 wp-plugins-example-stable-de.po
```

The parts are numbered, and each can be translated or reviewed and uploaded
on its own.

## Resuming

Drafts and their reviews are cached. Running the same command again after a
stop, a crash or a quota limit sends only the entries not finished yet, and
does not pay for a draft twice. `--fresh` ignores the cache and asks again;
in the app, it is **Start over** on the Translate screen. The cache is keyed
by the source text, so `--all` without `--fresh` writes the cached drafts
back rather than drafting again.
