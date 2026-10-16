# Locale rules

The checks polyglots runs are not the same for every language. A dropped
placeholder is wrong everywhere, but whether a capital in the middle of a
sentence is a mistake depends on the language: German capitalises every noun,
Turkish only proper nouns. So each locale can have a rules file that says which
checks apply, and adds the conventions its own team enforces.

## Where locale rules come from

polyglots ships no locale's rules. The rules for a language are written and
kept by its locale team, in
[polyglots-data](https://github.com/emreerkan/polyglots-data), one file per
locale. Get yours with:

```
polyglots rules fetch tr
```

A locale with no rules file runs the universal checks only, and every review
says so, so an absent finding is never mistaken for a passed check. If your
locale has no file in polyglots-data yet, write one (below).

## Fetching a locale's rules

```
polyglots rules fetch [locale] [--yes]
```

downloads the locale's file from the latest polyglots-data release and
writes it to `~/.config/polyglots/locales/` (`polyglots rules path` prints
the exact file). Without a locale, it uses `defaultLocale`.

Before it writes, it checks the file and shows what it changes:

- It refuses a file that needs a newer polyglots, a file whose sha512 does
  not match the one the release published, and a file that `rules check`
  would reject. Nothing is written, and the command exits 1.
- It prints, in full, any guidance, capitalization or register text that
  differs from your file, every note and suggested wording that is new, and
  every fix pattern added or removed. It says whether `sentenceEnd`
  changed, and gives one line for the switches, proper nouns and other
  patterns.
- It names the file's status (`maintained` or `draft`) and its maintainers,
  by their WordPress.org usernames.

When you have no file yet, it then writes one. When your file is already
the published one, it says so and writes nothing. When your file differs,
it asks before replacing it; without a terminal to ask on, pass `--yes`.
Your own changes to the file are lost when you accept, so keep anything
your team should have in polyglots-data itself.

The file is written exactly as downloaded, comments included. To fetch from
a fork or a test release, point `POLYGLOTS_DATA_URL` at its `index.json`.

## Building a rules file in the browser

The [rules builder](https://ada.tools/polyglots/rules-builder/) writes a
rules file for you, step by step, without YAML or regular expressions:
the locale, the built-in checks, formality and register, capitalization,
guidance and proper nouns, common mistakes, and, behind an advanced
section, patterns and sentence ends. Every step can be skipped.

```
polyglots rules builder [locale]
```

opens it in your browser with the locale chosen, and prints the address, so
it works over SSH too. The app's Locale rules screen has the same link.

- **Start from the published rules** loads your locale's file from
  polyglots-data, so you change your team's rules rather than start over.
  Its comments are not carried over.
- The file is checked as you type, with the same checks polyglots runs, and
  shown in full in the last step. Download it, or copy it.
- A tester runs your mistakes and patterns on a sample source and
  translation, and says which ones fire. Like a review, it stops a regular
  expression after about 100 ms and leaves it out.
- Nothing leaves your browser unless you share the file. Your work is kept
  in the browser, so a reload does not lose it.

Save the download as the file `polyglots rules path <locale>` prints, then
run `polyglots rules check <locale>`.

## The rules file

```
polyglots rules edit de
```

opens `~/.config/polyglots/locales/de_DE.yaml` in your `$VISUAL` or `$EDITOR`,
creating it first if needed. The new file spells out what the code already
does for that locale, commented out, with an example of every section. A file
that sets nothing changes nothing.

```yaml
# The rules format version. polyglots refuses a file newer than it reads.
schema: 2

# Rules that always run unless disabled: placeholder, html, plural-count, ...
rules:
  enable: [title-case]
  disable: []

# How much of a glossary term must match an inflected form, between 0 and 1.
glossaryStemRatio: 0.7

# Names capitalized everywhere (always), and only inside a specific date (dateOnly).
properNouns:
  always: []
  dateOnly: []

# Common mistakes: found anywhere in a translation, case-insensitive.
mistakes:
  - wrong: a wording your team rejects
    right: the wording it uses instead
    note: Why, for the reviewer

# Patterns: "text" (a literal) or "find" (a regular expression).
patterns:
  - find: ' {2,}'
    replace: ' '
    level: fix
    note: One space between words

# Guidance added to the AI review prompts, at most 1500 characters.
guidance: |
  Button labels are verbs in the imperative.

capitalization: |
  - {language} uses sentence case ...
register: '- Address the reader as ...'
formality: informal
sentenceEnd:
  unmarked: true
```

Every section is optional.

- **`schema`** is the version of the file format. Leave it out and the file
  is read as schema 1, which has every section here except the last four.
  Those need `schema: 2` at the top of the file. A file with a schema newer
  than your polyglots reads is refused with a request to update polyglots,
  rather than reviewed on half-understood rules.
- **`rules`** turns built-in checks on or off by name. The names are in
  [Reviewing submissions](review.md#what-the-checks-look-for).
- **`properNouns`** are names `title-case` leaves alone: `always` everywhere,
  `dateOnly` only beside a number, as a month in a date. A list you write
  replaces the built-in one. A name of several words is excused only as a
  whole. `polyglots config add-name`, `list-names` and `remove-name` edit the
  `always` list for you ([Configuration](configuration.md#names-the-checks-should-leave-alone)).
- **`mistakes`** are wordings your team rejects. Each match is a hint the
  reviewer weighs with your note.
- **`patterns`** match a literal `text` or a regular expression `find`. The
  `level` decides what a match means: `hint` (the reviewer judges it), `error`
  (always wrong, and the reviewer must fix it) or `fix` (replaced
  automatically with `replace`). `when` limits a pattern by the English
  source: with `source`, it runs only when the source contains that text;
  with `notSource`, only when the source does not. With both, both must hold.
  Both are plain text, not regular expressions, matched without regard to
  case. `notSource` needs `schema: 2`. In Spanish, "blog" is usually "sitio",
  unless the English says blog:

  ```yaml
  schema: 2
  patterns:
    - text: blog
      when: { notSource: blog }
      note: Use "sitio" unless the source says blog.
  ```

  A letter can be stored in two ways that look the same, such as Hindi ड़ as
  one character or as ड with a dot below. `mistakes` and `text` patterns find
  both, whichever one you typed. A `find` hint or error finds both too, but a
  `find` fix only replaces text stored the way the expression spells it; use
  `text` for a fix if the letters in it can be stored both ways.
- **`guidance`** is prose added to the reviewer's instructions: your style
  guide's few most important lines.
- **`capitalization`** tells the reviewer how your language capitalizes, at
  most 2500 characters, one `- ` line per point. It is used only where
  `title-case` runs; without it, those locales get a generic paragraph about
  sentence case. `{language}` is replaced with the language's name.
- **`register`** is the line both AI prompts use for tone and form of address,
  at most 500 characters. One string sets both; `{ audit: ..., translate: ... }`
  sets the review prompt and the draft review prompt apart. Without it, both
  ask for the register that is standard in WordPress for your language.
- **`formality`** is `formal` or `informal`: how a draft addresses the reader.
  DeepL is asked for more or less formal text, and the AI engines are told the
  same. It overrides the formality a locale's name implies, as in
  `de_DE_formal`.
- **`sentenceEnd`** says how a sentence ends in your script, for the
  punctuation check. `unmarked: true` is for a language that writes no final
  mark. `answers` lists regular expressions for a final mark that answers the
  source's (`text`, and optionally the `source` it answers). `notEnding` is a
  regular expression for a mark that looks like a full stop and is not one.

Check a file after editing it:

```
polyglots rules check de
```

It reports a mistake with the line it is on, and summarises what the file
sets. A review refuses to run on a file that does not parse, rather than run
on rules you believe are in force.

Each regular expression may take about 100 ms on one translation. Some
expressions, such as `^(a+)+$`, can take minutes on the wrong text. A review
stops such an expression after about 100 ms and does not use it again. The entry
where it stopped gets a finding that names the expression, and the summary
names it once. `rules check` runs each expression on a few test strings first,
and reports one that takes too long as an error on its line.

## Variants of a language

`polyglots rules copy nl_NL nl_BE` starts one locale's file from another's.
`polyglots rules path de` prints where a locale's file lives.

## Changing rules re-reviews

Any change to a locale's rules changes what the reviewer is told, so files of
that locale are reviewed again from scratch on their next run rather than
served verdicts formed under the old rules.

## Sharing your rules

A rules file that works for your team is worth sharing. Locale files live in
[polyglots-data](https://github.com/emreerkan/polyglots-data); its
contributing guide says how to propose one for your locale.

The rules builder can also send your file to the polyglots team. Give a
Slack or GitHub username, or an email, so the maintainer can reach you; a
WordPress.org username alone is not enough. What you send is saved by the
team and emailed to the maintainer, and is deleted on request on Slack.
