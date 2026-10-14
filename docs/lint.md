# Linting plugin and theme strings

`polyglots lint` is for the people who write plugins and themes. It reads
your translatable strings and lists the ones translators cannot get right,
whatever language they work in: a placeholder nobody explained, a sentence
glued together in code, a word that is a noun in one place and a verb in
another. Fix a string once and every locale gains.

```
polyglots lint ./my-plugin
polyglots lint ./my-plugin/languages/my-plugin.pot
```

It needs no account, no API key and no AI, and costs nothing to run.

## What it reads

A folder is turned into a temporary `.pot` with `wp i18n make-pot`, the same
command WordPress.org uses, then linted. The temporary file is removed
afterwards. If the `.pot` cannot be made, nothing is checked and the command
exits 2 with make-pot's own message.

make-pot keeps only the strings whose text domain matches the `Text Domain`
header of your main plugin file or `style.css`. Without that header it uses
the folder's name, which in CI is usually the repository's name. When the
`.pot` has nothing in it beyond the header, polyglots says so. Add the
header, or name the domain:

```
polyglots lint . --domain my-plugin
```

Strings make-pot takes from the header itself (the name, description and
URIs) are not checked: you cannot give them a context or a placeholder.

A `.pot` file is linted as it is. To read `polyglots-ignore` markers,
polyglots needs the source files the `.pot` points to. It looks in the
`.pot`'s folder, then one folder up, which is where they are when the
`.pot` is in `languages/`. Anywhere else, name the folder:

```
polyglots lint build/my-plugin.pot --source .
```

## Where make-pot comes from

In this order:

1. The `wp` executable named in `POLYGLOTS_WP_BIN`.
2. `wp` on your `PATH`.
3. WP-CLI downloaded by polyglots and run with `php`.

The download happens once, says so before it starts, gives up after five
minutes, and is kept in
polyglots' data folder (`~/.local/share/polyglots/wp-cli/`). The version and
its SHA-512 hash are fixed in polyglots' source; a download that does not
match is refused and not kept, and the kept file is checked again before
each use. This needs PHP on your `PATH`.

Without PHP, make the `.pot` another way and lint that. With Docker, for
example:

```
npx wp-env run cli wp i18n make-pot . languages/my-plugin.pot
polyglots lint languages/my-plugin.pot
```

## The rules

Errors are strings translators cannot get right. Warnings are likely
problems that need your judgement.

| Rule | Level | Finds |
|---|---|---|
| `translators-comment` | error | A placeholder with no `translators:` comment |
| `unordered-placeholders` | error | Two or more placeholders, not all numbered |
| `plural-placeholders` | error | Singular and plural with different placeholders |
| `plural-without-count` | error | A plural form with no number in it |
| `concatenation` | warning | A fragment meant to be glued to other text |
| `ambiguous-word` | warning | A word that is both noun and verb, with no context |
| `same-text-different-use` | warning | A short string used in several files, with no context |
| `markup-in-string` | warning | HTML or a URL inside the string |
| `typography` | warning | Three full stops for an ellipsis, or a double space |

### `translators-comment`

```php
// Bad: a translator sees "%s" and has to guess.
printf( __( 'Hello %s', 'my-plugin' ), $name );

// Good
/* translators: %s: the customer's first name */
printf( __( 'Hello %s', 'my-plugin' ), $name );
```

The comment must be directly above the call, with nothing between, or
make-pot does not carry it into the `.pot`.

### `unordered-placeholders`

```php
// Bad: a language that names the site first cannot reorder these.
__( '%s commented on %s', 'my-plugin' );

// Good
/* translators: 1: a person's name, 2: a post title */
__( '%1$s commented on %2$s', 'my-plugin' );
```

### `plural-placeholders`

```php
// Bad: many languages use the singular form for 21, 31 and so on, which
// would then say "One item".
_n( 'One item', '%d items', $count, 'my-plugin' );

// Good
/* translators: %d: number of items */
_n( '%d item', '%d items', $count, 'my-plugin' );
```

### `plural-without-count`

```php
// Bad: _n() with no number in it.
_n( 'Item', 'Items', $count, 'my-plugin' );

// Good: put the number in, or use __() if the text does not depend on it.
_n( '%d item', '%d items', $count, 'my-plugin' );
```

### `concatenation`

```php
// Bad: word order differs between languages.
echo __( 'Posted by', 'my-plugin' ) . ' ' . $author;

// Good
/* translators: %s: author name */
printf( __( 'Posted by %s', 'my-plugin' ), $author );
```

Also found: strings with spaces at either end, and strings of punctuation
only, such as `':'`.

### `ambiguous-word`

```php
// Bad: "Post" the noun and "Post" the verb are different words in most
// languages.
__( 'Post', 'my-plugin' );

// Good
_x( 'Post', 'verb: publish the post', 'my-plugin' );
```

### `same-text-different-use`

A short string, one to three words, used in more than one file with no
context. If it means the same everywhere, leave it. If it does not, give
each use its own context with `_x()`.

### `markup-in-string`

```php
// Bad: a translation can break the link.
__( 'Read the <a href="https://example.com/docs">documentation</a>.', 'my-plugin' );

// Good
/* translators: %s: link to the documentation */
sprintf( __( 'Read the %s.', 'my-plugin' ), '<a href="https://example.com/docs">' . esc_html__( 'documentation', 'my-plugin' ) . '</a>' );
```

With `createInterpolateElement()` in JavaScript the tags are meant to be in
the string, and translators keep them. Silence the warning there with a
marker, or for the whole plugin in the settings file.

### `typography`

Use `…` instead of `...`, and one space between words.

## Silencing a warning

Errors cannot be silenced except by turning their rule off in the settings
file, where the whole team sees it.

### In the code

Put `polyglots-ignore` in a comment on the line of the call, or in the
comment block directly above it:

```php
echo __( 'Post', 'my-plugin' ); // polyglots-ignore

/* polyglots-ignore concatenation -- glued to a number on purpose */
echo __( 'of', 'my-plugin' );
```

Rule ids after the marker silence only those rules. With no rule id, every
warning on the string is silenced. Text after the ids is ignored, so a `--`
and a reason is a good habit.

With a `translators:` comment, put the marker **above** it, or on the call's
line. A comment between the translators comment and the call stops make-pot
from carrying the translators comment, and `translators-comment` then fires.

```php
/* polyglots-ignore typography */
/* translators: %s: a place name */
printf( __( 'Welcome to %s...', 'my-plugin' ), $place );
```

When the same string is used in several places, every place needs the
marker; one marked call does not hide another.

### In `.polyglots-lint.json`

In the plugin or theme folder (or name another file with `--config`):

```json
{
  "rules": {
    "same-text-different-use": "off",
    "markup-in-string": "error"
  },
  "ignore": [
    { "rule": "concatenation", "msgid": "of" },
    { "msgid": "Post", "msgctxt": "admin menu" }
  ]
}
```

- `rules` sets a rule to `off`, `warning` or `error`. Raising a warning to
  an error makes it fail CI.
- `ignore` silences warnings on one string. `rule` is optional (all
  warnings); `msgctxt` is optional (any context).
- An unknown rule id or key stops the lint with exit 2, so a typo never
  silences nothing quietly.

## Output and exit codes

`--format text` (the default) groups findings by rule, errors first.
`--format json` is for tools. `--format github` writes annotations that
GitHub Actions draws on the pull request; their paths are written from
`GITHUB_WORKSPACE`, so they point at the right files when the plugin is in a
subfolder of the repository.

| Exit | Means |
|---|---|
| 0 | No errors (warnings are allowed) |
| 1 | Errors, or warnings with `--strict` |
| 2 | Nothing was checked: bad path or settings, or no `.pot` could be made |

## In GitHub Actions

```yaml
name: Strings
on: [pull_request]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: shivammathur/setup-php@v2
        with:
          php-version: '8.3'
          tools: wp-cli
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npx polyglots lint . --format github
```
