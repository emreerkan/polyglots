# Reply templates

The message for the requester is one sentence about what a review fixed. The
comment you post back on a PTE request says more: a greeting, the verdict,
whether you approved the request, and where your team and its guidelines are.
A reply template holds that text once per locale, and polyglots fills it in
after every review.

## Managing them

polyglots keeps the template files itself, so you never need to find their
folder.

**In the app:** **Configuration › Reply templates** lists your locale's
templates. `e` edits the highlighted one, `n` creates one from a starter, `d`
deletes the highlighted one after asking, and `v` switches the preview between
a clean review and one with problems, filled with a sample requester and
message.

A new template opens in the editor straight away. In the editor, the arrow
keys move the cursor anywhere in the text and `enter` starts a new line.
`ctrl+x` clears the whole text, to paste your own wording over a starter.
`ctrl+s` saves, and `ctrl+z` and `ctrl+y` undo and redo. `esc` closes the
editor, and asks first when there are changes you have not saved, so `esc`
then `n` also brings back the text you cleared.

**On the command line:**

```
polyglots template edit tr            # create approved from its starter, or open it
polyglots template edit tr declined   # the same for another template
polyglots template list [tr]          # what exists
polyglots template delete tr declined # asks first; --yes skips the question
```

`template edit` opens the template in your `$VISUAL` or `$EDITOR`.

`approved` and `declined` have starters, one for each way a PTE request ends.
Any other name starts from the approved text. Creating a template never
overwrites one that exists.

Every character of a template is part of the reply, so there are no comments
in it. The text is pasted as you wrote it, HTML included: o2 comments accept
links, so `<a href="…">our Slack</a>` works.

## Placeholders

| Placeholder | Becomes |
|---|---|
| `{username}` | The requester's wp.org username. Left as `{username}` when you did not give one, so you can fill it in. |
| `{results}` | The message for the requester, unchanged. Empty when the review repaired nothing; a line holding only this placeholder is then removed. `{results_copy}` works the same way. |
| `{no problems text\|some problems text}` | The first text when the review repaired nothing and flagged nothing for you, the second otherwise. |

The choice is braces with exactly one `|` inside. Any other text in braces,
such as `{this}` or `{a|b|c}`, is left as written, so literal braces need no
escaping. The one thing you cannot write literally is a pair of braces with a
single `|` between them. Placeholders do not nest.

Either text of a choice can be empty. A clean review has no message for the
requester, so a sentence that points at it, such as "Please see below:", would
point at nothing. Put that sentence in a choice with an empty first text, and
it only appears when there is something below it:

```
I have granted you PTE rights.{| Please see below:}
```

The neutral starters already do this. The tr_TR approved starter is the locale
manager's own text, kept word for word, so make that edit yourself if you want
it.

## After a review

On the command line, a review prints the filled reply instead of the message for
the requester, headed with the template it used. Give the requester's username, and
choose a template other than `approved`, with:

```
polyglots review plugin-tr.po --requester ayse --template declined
```

A leading `@` on the username is dropped, since templates write `@{username}`.
Without `--template`, the reply uses `approved`, or the locale's first template
if there is no `approved`. A `--template` that does not exist stops the command
before anything is reviewed.

In the app, the review options have a **Requester** field when your locale has
a template. The results screen shows the reply instead of the message; `c`
copies it and `t` switches to the locale's next template.

When the review flagged entries for you to check, the reply takes the
some-problems text even if nothing was repaired, since a flagged entry may
still be one you fix by hand. A yellow line above the reply, in the app and on
the command line, says how many entries are flagged: read the verdict sentence
and change it if they all turned out fine.

In a batch of several files, every file gets its own reply, filled with the
one requester given for the batch, or with `{username}` left in when none was.
The app shows one reply at a time: `↑↓` moves between them and `c` copies the
one shown.

There is no reply for a locale with no templates, or for a run that stopped
before it reached every entry. The message for the requester is shown then.
