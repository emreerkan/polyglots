# Locale rules

The checks polyglots runs are not the same for every language. A dropped
placeholder is wrong everywhere, but whether a capital in the middle of a
sentence is a mistake depends on the language: German capitalises every noun,
Turkish only proper nouns. So each locale can have a rules file that says which
checks apply, and adds the conventions its own team enforces.

## Built-in packs

Some languages ship with a pack: the rules a reviewer of that language would
turn on, written down.

| Language | Status | Adds |
|---|---|---|
| Turkish | Maintained by the tr_TR locale team | `title-case`, `apostrophe`, `ampersand`, `number-format`, and Turkish proper nouns |
| Swedish | Defaults, waiting for the sv_SE team to confirm | `title-case` |

A locale with no pack runs the universal checks only, and every review says
so, so an absent finding is never mistaken for a passed check. A rules file
fills the gap.

## The rules file

```
polyglots rules edit de
```

opens `~/.config/polyglots/locales/de_DE.yaml` in your `$VISUAL` or `$EDITOR`,
creating it first if needed. The new file spells out what the code already
does for that locale, commented out, with an example of every section. A file
that sets nothing changes nothing.

```yaml
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
```

Every section is optional.

- **`rules`** turns built-in checks on or off by name. The names are in
  [Reviewing submissions](review.md#what-the-checks-look-for).
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

## Sharing a pack

A rules file that works for your team is worth sharing. Open an issue or a
pull request on [GitHub](https://github.com/emreerkan/polyglots) with it, and
say whether your locale team has agreed to it: a pack is marked maintained
only when the team behind it is.
