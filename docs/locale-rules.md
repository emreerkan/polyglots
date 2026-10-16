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
  automatically with `replace`). `when: { source: ... }` applies a pattern
  only when the English source contains that text.

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
