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

## The glossary

`polyglots glossary sync` downloads your locale's glossary from
translate.wordpress.org. Both commands use it, and review refuses to run
without it. `polyglots glossary export glossary.csv` writes it as a CSV with
Term, Translation and Notes columns, the layout Poedit imports.

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
