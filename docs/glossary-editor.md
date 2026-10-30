# Glossary editor

The glossary polyglots checks against comes from translate.wordpress.org, and
only your locale's glossary editors can change it there. The glossary editor
lets you keep your own corrections and additions beside it, as a table in your
browser: term, part of speech, translation and comment.

## Editing polyglots' glossary

```
polyglots glossary edit [--locale <locale>]
```

starts a small server on `127.0.0.1`, opens the glossary in your browser and
prints the address, so it works over SSH too. Without `--locale`, it uses
`defaultLocale`. The app's menu has the same screen as **Edit glossary**, beside
**Sync WordPress.org glossary**.

Add, change and delete rows in the table, then press **Save**. Save writes your
changes to `polyglots.db`. Review and translate use them from the next run.

Your changes are a layer on top of the synced glossary. They are not a copy of
it:

- `polyglots glossary sync` keeps your changes. If wp.org changed the same row
  since you edited it, wp.org wins, and the sync prints a `removed local edit:` line for each one it removed.
- **Discard all local edits** removes the layer and leaves the synced glossary.
- **Import CSV** loads a reviewed CSV into the table. Each term in the CSV
  replaces the same term in your glossary. The rows apply only when you press
  **Save**, unlike `polyglots glossary import`, which writes at once.

The server stops on Ctrl+C, on **Close**, and after 30 minutes with no browser
open on it. The page tells the server it is open every five minutes, so a tab
you leave open does not stop it.

## Editing a CSV file

```
polyglots glossary edit --csv glossary.csv [--locale <locale>]
```

opens or creates a GlotPress glossary CSV instead of polyglots' own glossary.
Save writes the file, and refuses to overwrite it when it changed on disk since
you opened it. This is the way to prepare a glossary change for your team before
it goes to wp.org.

The file is UTF-8 with commas, and its header is `en,<locale slug>,pos,description`.
A leading byte order mark is accepted, and is not written back. A part of speech
is one of `noun`, `verb`, `adjective`, `adverb`, `interjection`, `conjunction`,
`preposition`, `pronoun`, `expression` or `abbreviation`.

If a file named `glossary.analysis.json` is beside the CSV, the editor shows its
evidence for each row: how often each wording appears in existing translations,
and whether the choice is settled or contested.

## Importing a reviewed CSV

```
polyglots glossary import reviewed.csv [--locale <locale>]
```

loads a CSV as local edits without opening the editor. It refuses a CSV with
problems and names the rows. When `--locale` differs from the locale in the
CSV's header, it says so after it imports.

## In the browser, without polyglots

The [glossary editor on the website](https://ada.tools/polyglots/glossary-editor/)
edits a CSV the same way. It works on a CSV only: nothing is uploaded, and your
work stays in the browser until you export it. Use it when polyglots is not
installed, or to prepare a CSV you then give to `polyglots glossary import`.
When a CSV's header names no locale, or one wp.org does not list, the page asks
for the locale before it opens the file, so the export has a header GlotPress
accepts.

## What review and translate do with it

Review prompts, also in translate's review pass, carry each glossary row's part
of speech and comment with the term, so the model can tell `Post` the noun from `post` the verb. This
changes what a review asks, so the first review after you update, and the first
after any glossary edit, has no cached verdicts and starts over.
