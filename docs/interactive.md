# The interactive app

Run `polyglots` with nothing after it and it opens a full-screen app in your
terminal window. Everything polyglots does is there: reviewing a submission,
translating a file, fetching from translate.wordpress.org, statistics, and all
of the settings. You move with the arrow keys and enter, and every screen
lists its own keys at the bottom. If you would rather type commands, or want
to script the work, see [Getting started](getting-started.md): every screen
has a command behind it.

The window needs to be at least 60 columns wide and 20 rows tall. At 80 by 24
or larger the home screen shows its cards in a grid; smaller, it shows a list.
A window that is too small says so until you make it bigger, and a run in
progress carries on underneath.

## The first run

On a fresh install the app opens on the setup wizard rather than on home. It
has five steps:

1. **Locale**: the language you translate into. Type a few letters (`de`,
   `pt_BR`, `nl_NL_formal`) and choose from the matches.
2. **Review provider**: the AI agent that reviews: Claude Code or
   Antigravity, whichever is installed and signed in on this machine, or a
   model on your own computer (experimental), or **No AI**, which runs the
   rules alone ([what that means](getting-started.md#using-polyglots-without-ai)).
   Each option says what it costs.
3. **Draft engine and API keys**: what fills in untranslated strings: DeepL,
   OpenAI, a local model, or translation memory only, and the key it needs.
   Skip this if you only review.
4. **Glossary sync**: downloads your locale's glossary from
   translate.wordpress.org. A review will not start without it.
5. **Locale rules**: the checks for your language's conventions. Some
   locales ship a pack; for the rest this is where you start one. See
   [Locale rules](locale-rules.md).

Last, it asks once whether to share a few anonymous totals for the website.
The answer is No unless you choose Yes; see
[Usage statistics](usage-statistics.md).

`enter` chooses and moves on, `esc` skips a step. You can stop part way:
the wizard opens again next time at the first step still missing, and once
you have been through it to the end it stays under **Configuration › Setup
wizard** for whenever you want it.

## Home

The top of the screen shows:

- the version, and beside it the newer one when npm has a newer release. The
  same notice, with the command to update, is printed when you quit,
- `review` and the agent that reviews (`p` on home switches it),
- `setup` and how many of the five steps are done, with a tick or a cross for
  each. Press `tab` to move onto them, arrows to choose one, and `enter` to
  open the wizard at that step.
- `stats` and an address, while the statistics page is being served.

Below are the cards. Press a card's letter to open it, or move with the arrows
and press `enter`.

| Key | Card | What it does |
|---|---|---|
| `r` | Review a submitted .po | Checks a submission with your locale's rules and the review agent, repairs what it can, and writes the problems to a file. See [Reviewing submissions](review.md). |
| `t` | Translate a .po file | Fills untranslated entries from your translation memory first, then machine drafts, and marks drafts fuzzy for you to check. See [Translating](translate.md). |
| `f` | Fetch from translate.wordpress.org | Downloads the waiting or untranslated strings for a list of projects, and can review or translate each file as it arrives. |
| `s` | Review statistics | Serves your statistics page from this machine while the app runs, and can write a copy to keep. |
| `o` | Tools | Split a large `.po` into parts, import translation memory, export it. |
| `c` | Configuration | Glossary, locale rules, agents, local models, API keys, the setup wizard and interface settings. |
| `h` | Help | Every screen and every key, on one page. |
| `a` | About | The version, where polyglots keeps its files, and links. |

`q` on home quits.

## Keys that work everywhere

| Key | What it does |
|---|---|
| `?` | Help for the screen you are on: what it is for and all of its keys. |
| `ctrl+k` or `:` | Go to any screen. Type to filter, arrows to choose, `enter` to go. |
| `esc` | Back. |
| `q` | Back one level; quits from home; stops a run. |
| `ctrl+c` | Quit. If a run is going it asks first; a second `ctrl+c` quits. |
| `x` | Stops the statistics server while it serves, from any screen. |
| `page up` / `page down` | Scroll a screen taller than the window. |

The bottom line of every screen shows the keys that matter at that moment, so
during a run it shows pause and stop, and once the run is done it shows how to
open the result. When you type into a field, letters go into the field;
`ctrl+k` still opens the go-to list.

## Running a review or a translation

Review and Translate work the same way, in four stages.

1. **Pick a file.** The list shows the `.po` files in the folder you started
   polyglots from, newest first, with how many entries each holds. `..` goes
   up a folder, `s` changes the order.
2. **Options.** The locale (filled in from your settings, or from the file
   itself when you have none), how many entries go to the agent at a time,
   and for a review, whether to skip the AI and use the rules alone, and
   whether to start over instead of carrying on where an earlier run stopped.
   Move with `↑` `↓` or `tab`, change a choice with `←` `→` or `space`, and
   choose **Start** with `enter`.
3. **Running.** A progress bar, the batch being worked on, the time left and
   when it should finish, and a panel of the most recent entries with what
   happened to each: approved, flagged, repaired or unreviewed. `p` pauses,
   `r` resumes and `q` stops. Each takes effect once the batch in progress
   finishes, so nothing already paid for is thrown away.
4. **Done.** A summary. A review shows the message to send the contributor,
   which `c` copies, and `o` opens the repaired file in your `.po` editor.
   `enter` goes back to the menu.

A stopped run is never wasted. Start the same file again and only the entries
that were not reached are sent; the rest come from the cache.

Fetch adds two stages at the front: type the projects, one per line, as
slugs or translate.wordpress.org addresses (`enter` on an empty line, or
`ctrl+d`, when the list is done), then choose waiting or untranslated strings
and let it check the list. It shows which projects have work and which have
none before anything is downloaded.

While a run is going, the go-to list will not leave its screen, and quitting
asks first. Once you quit, the path of the last file a run wrote is printed in
your terminal, where it stays after the app has closed. Turn that off under
**Configuration › Interface settings**.

## Statistics

The statistics screen serves your review history as a page on this machine;
`o` opens it in your browser. It keeps serving after you
leave the screen, and the address stays in the header until you stop it with
`x`. `w` writes a standalone copy you can keep or share, and `s` serves it
again once stopped.

## Configuration

| Key | Screen | What it does |
|---|---|---|
| `g` | Sync WordPress.org glossary | Downloads your locale's glossary. Run it again when your team changes it. |
| `r` | Locale rules | Edits your locale's rules: which built-in checks run, proper nouns, common mistakes, patterns, and guidance for the reviewer. `s` saves. |
| `a` | Check AI agents | Shows whether each review agent is installed, signed in and set up for polyglots. `r` checks again. |
| `m` | Local models | Finds model servers on this machine, such as Ollama or LM Studio, and chooses the drafting model. See [Local models](local-models.md). |
| `k` | Configure API keys | Stores your DeepL and OpenAI keys. A key set in your environment wins over a saved one. |
| `w` | Setup wizard | The five setup steps, from wherever you left them. |
| `i` | Interface settings | Settings for the app only, such as printing the last output path after you quit. |
| `u` | Usage statistics | Shows exactly what would be shared for the website's totals, and turns it on or off. See [Usage statistics](usage-statistics.md). |

Everything set here is the same configuration the commands read; see
[Configuration](configuration.md).

## Terminals without Unicode

Where the terminal cannot draw Unicode (`LANG=C`, `TERM=dumb`, or
`POLYGLOTS_ASCII=1`), the app uses plain ASCII: `+` for a tick, `>` for the
pointer, and simple boxes.
