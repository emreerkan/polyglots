# Suffixes and plurals

Two Turkish mistakes only show once a placeholder is filled in: a suffix glued
to a placeholder, and a plural noun after a number. The tr_TR rules file in
[polyglots-data](https://github.com/emreerkan/polyglots-data) carries a
pattern for each, turned on. Each match reaches the AI review as a hint with
its note, and the model decides in context; the pattern alone never rejects a
translation.

They are patterns rather than built-in checks because what they look for is
Turkish spelling: the apostrophe before a suffix, and the `-lar`/`-ler`
endings. Another language with the same problem spells it differently, and can
write its own pattern the same way (see [Other languages](#other-languages)).

## Turning them on

```
polyglots rules fetch tr
```

downloads the tr_TR rules file with both patterns in it. To add them to a file
of your own instead, open it with `polyglots rules edit tr` and put them under
`patterns:`, keeping the two spaces of indentation:

```yaml
patterns:
  - find: '(?<![\p{L}\p{M}\p{N}])(?:%(?:\d+\$)?[-+0#]?\d*(?:\.\d+)?[sdfu]|\{[\w-]+\})[''’]\p{L}+'
    level: hint
    note: A suffix on a placeholder cannot agree with every value; rephrase so it lands on a word, as in "%s adlı eklentide"
  - find: '%(?:\d+\$)?[du](?:</[a-z]+>)?\s+(?!(?:dolar|lari|taler|popüler|modüler|seküler|moleküler|selüler|vasküler|regüler|tübüler|angüler|oküler|kapiler|skaler|polar|bipolar|solar|kiler|keler|çalar|galeri|ileri)\p{L}{0,4}(?![\p{L}\p{M}]))\p{L}+(?:lar(?:ı(?:mız|nız)?|ım|ın)?(?:n?a|ya|n?[dt]an?|n?ın|n?ı|y?la|dır|ca|[dt]aki)?|ler(?:i(?:miz|niz)?|im|in)?(?:n?e|ye|n?[dt]en?|n?in|n?i|y?le|dir|ce|[dt]eki)?)(?![\p{L}\p{M}])'
    level: hint
    note: Turkish keeps the noun singular after a number, as in "%d dosya"
```

`polyglots rules check tr` confirms the file reads.

Turning a pattern on changes the rules, so the next review of every Turkish
file starts over. To turn one off again, delete its lines or put a `#` before each.

## A suffix glued to a placeholder

```
msgid  "Saved in %s"
msgstr "%s'de kaydedildi"
```

In Turkish the suffix follows the sounds of the word before it: Ankara'da,
İzmir'de, Ordu'da. Whoever translated the string could not see what `%s` will
hold, so `'de` is right for some values and wrong for the rest. The same goes
for `%1$s'nin`, `{name}'i` and `%d'den`.

The fix is to rephrase so the suffix lands on a word the translator can see:

| Reported | Rephrased |
|---|---|
| `%s'de kaydedildi` | `%s konumuna kaydedildi` |
| `%s'ın kopyası` | `%s adlı öğenin kopyası` |
| `%d'den fazla` | `%d öğeden fazla` |

What the pattern leaves alone:

- A placeholder in quotes or in an attribute: `'%s' silindi`, `href='%s'`.
  Only an apostrophe followed straight by a letter counts.
- A placeholder that closes a link around a word: in `%1$sbu SSS%2$s'ye` the
  suffix agrees with `SSS`, which the translator could see.

Some placeholders only ever hold one known value, and the translator comment
says so. That is why this is a hint: the model reads the comment and decides.

A suffix that has the same form after every value, such as `ken` in
`%s'ken`, can be skipped by adding `(?!ken(?![\p{L}\p{M}]))` straight after
`[''’]`. Do not skip `de`, `da`, `ın`, `in`, `deki` or `daki`: they change
with the value, which is exactly what the pattern is for.

## A plural noun after a number

```
msgid        "%d file deleted"
msgid_plural "%d files deleted"
msgstr[1]    "%d dosyalar silindi"
```

Turkish keeps the noun singular after a number: 3 dosya, never 3 dosyalar.
`plural-count` does not catch this, because Turkish has two plural forms and
the entry has both. The fix is the singular: `%d dosya silindi`.

The pattern reads the word straight after `%d` or `%u` (and positional forms
such as `%1$d`), past a closing inline tag, so `<strong>%d</strong> dosyalar`
is caught. It reports the word when it ends in `-lar` or `-ler`, optionally
followed by a possessive and a case ending in the matching vowel: `dosyaları`,
`dosyalardan`, `öğelerine`. A word that only contains those letters without
following the vowels, such as `olarak` or `Cloudflare`, is not read as a
plural.

What it does not see:

- `%s`. A count formatted with `number_format_i18n()` is passed as `%s`, but
  elsewhere `%s` is usually a name, and a name followed by a plural noun is
  correct Turkish. A pattern cannot tell the two apart.
- A word in between: `%d farklı dosyalar` is not reported.

Both limits can miss a mistake; neither reports correct Turkish.

### Words it skips

Some words end like a plural and are not one. The pattern skips the words in
its `(?!(?:dolar|…|ileri)` part:

- Currencies: `dolar`, `lari`, `taler`.
- Adjectives: `popüler`, `modüler`, `seküler`, `moleküler`, `selüler`,
  `vasküler`, `regüler`, `tübüler`, `angüler`, `oküler`, `kapiler`, `skaler`,
  `polar`, `bipolar`, `solar`. `%d popüler yazı` is correct.
- Singular nouns: `kiler`, `keler`, `çalar`, and `galeri` and `ileri`, whose
  ending reads as `-ler` plus a case ending.

To skip another word, add it to the list with a `|`, as in `|ileri|spoiler)`.
The word is then skipped with up to four more letters, so `%d spoiler` and
`%d spoilere` pass. So does `%d spoilerlar`, which is a real plural: the
pattern cannot tell a case ending from the plural. Add only a word whose
plural you do not expect to see after a number.

## Other languages

The same two mistakes exist in other languages, spelled differently:

- A suffix that has to agree with an unknown value: Finnish writes it after a
  colon (`%s:ssa`), Hungarian after a hyphen (`%s-ban`), and Korean attaches
  the particle (`%s을`). For Finnish or Hungarian, change `[''’]` in the
  first pattern to `:` or `-`; Korean needs a pattern of its own.
- A singular noun after a number: Hungarian, Persian, Georgian, Armenian and
  the Turkic languages keep it; Finnish and Estonian use a singular case. The
  endings in the second pattern are Turkish, so write your own.

A pattern that matches too much costs the model a look at each match, so start
narrow. See [Locale rules](locale-rules.md) for the whole file.
