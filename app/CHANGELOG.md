# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a minor bump could
carry a breaking change.

Entries say what changed. For why and how, read the commit.

## [Unreleased]

## [1.6.0] - 2026-10-30

### Added

- The glossary editor sorts by term or translation from the column headers, and has a Settings dialog: sort, the filter it opens with, row height, wrapping, hidden columns, search scope, and what Enter and Tab do.
- `glossary edit` keeps those settings in `glossary-editor.json` in the config directory; the website keeps them in the browser.

### Changed

- The glossary rule finds a term in its other English forms: plural or singular of the last word, and a hyphenated term written closed or open (`add-on`, `addon`, `add on`).
- `review` no longer settles a translation from the memory when it misses a glossary term, nor repairs an untranslated entry with a memory wording that does.

## [1.5.0] - 2026-10-30

### Added

- `glossary edit` opens the glossary in the browser as a table, from the command or the menu's Edit glossary, and `glossary import` loads a reviewed CSV; both keep local edits that survive `glossary sync`.
- A glossary editor on the website, for CSV files.

### Changed

- Review prompts, also in translate's review pass, carry each glossary row's part of speech and note.
- The first review after updating, and the first after any glossary edit, starts without cached verdicts.

## [1.4.0] - 2026-10-30

### Added

- Fetch lists every project while it checks the list and downloads the exports, with a count and a spinner on the one in progress; the CLI shows the same on stderr.

### Changed

- In the TUI, q and esc while fetch checks or downloads ask first, then cancel the requests and go back to the menu. Leaving the screen cancels them too.

### Security

- Upgraded @hono/node-server to 2.1.5.

## [1.3.0] - 2026-10-28

### Fixed

- A rules mistake or text pattern written without a nukta or an accent no longer matches the letter that has one.
- Review's placeholder check reads plural forms by the catalogue's Plural-Forms formula: every form is checked against the plural, and a form for a single number may say that number in words, as a suspect where translate.wordpress.org still warns.

## [1.2.1] - 2026-10-28

### Fixed

- Glossary terms are found in a capitalized source in every locale; in Turkish and Azerbaijani a term with an `i` was missed when the source wrote it `I`.
- A review verdict is keyed on the glossary terms its prompt listed, so entries with glossary terms are asked again once after the update.

## [1.2.0] - 2026-10-28

### Added

- The `date-format` rule checks PHP date formats for letters PHP does not know, a lost date or time part, 12-hour time without am/pm and a space after a time colon.
- A rules file's `dateTime` section (`clock`, `order`, `formats`, schema 3) adds hints for the locale's date style and a line in the prompts.
- The rules builder and the app's Locale rules screen edit `dateTime` (clock, date order, usual formats) and `names`; the template and the agent prompt describe both.
- The `name-order` rule, with a rules file's `names` section (`order: given-first | family-first`, schema 3): in a family-first locale, a full name such as `%1$s %2$s` left in English order is a hint, and the prompts get a line.

### Changed

- Every locale is re-reviewed once: the new universal rules move the review configuration hash.
- `rules fetch` takes the newest rules entry this polyglots can read when polyglots-data lists one per schema.
- The rules builder declares the lowest schema a file needs instead of the newest.
- Each agent call runs in an empty temporary folder, removed afterwards, so files an agent writes never reach the folder under review.
- antigravity runs with `--sandbox`.
- The translate draft review tells agents there is no shell and no filesystem, so cached agent draft reviews are asked again once.
- `doctor` warns when antigravity's `toolPermission` is `always-proceed` without a deny rule for commands.

### Fixed

- `glossary sync`, and the app after a sync from its menu, no longer end by asking for the sync just done.
- The review and draft review prompts let a numbered placeholder move (`%2$s %1$s`), so a reviewer no longer undoes a family-name-first order. Every locale is re-reviewed, and agent draft reviews asked again, once.
- The placeholder check accepts a translation that numbers unnumbered placeholders to reorder them (`%s by %s` as `%2$s tarafından %1$s`), and so does the warning about a draft that lost a placeholder.
- The placeholder check reports unnumbered placeholders of different kinds moved out of order (`%s of %d` as `%d içinden %s`), and says to number them.

### Security

- Dependencies updated past high advisories in `undici`, `follow-redirects`, `zod` and `body-parser`.

## [1.1.0] - 2026-10-19

### Added

- The header shows the current locale, and `l` changes it from any screen.
- The first change to a locale without a glossary or rules offers setup for it.
- `codex` as a review provider (`codex exec`, ChatGPT sign-in), with `codex.model` and `codex.effort` settings.
- Review and translate keep every failed batch attempt, with its reason and duration, in `jobs.db` (`batch_failure`).
- Review and translate write a run log in `~/.local/share/polyglots/logs`, kept 14 days, holding counts and failure reasons but not the entries.
- The MCP server logs each tool call (tool, sizes, timing, result count, error) to a daily `mcp-<date>.jsonl` in the same folder, without its arguments or results.
- `--debug`, `POLYGLOTS_DEBUG=1` or the Debug mode setting saves each batch's prompt and agent output beside the run log.
- When a run has problems, the CLI and the app offer to send a problem report to the maintainer; `--send-report` sends without asking, `problemReports: never` stops the offers.
- The batch screen shows elapsed time, an estimate and failed batches, and `enter` opens any file's own progress.
- A batch on the command line prints a line each time a file finishes a batch, with the file's time, the files done, running and queued, the estimate and failed batches.
- Translate falls back to a memory match that differs only in capitals when it uses the glossary term, written fuzzy.

### Changed

- Locale rules opens on the current locale and lists maintained polyglots-data rules first.
- Review, translate, their batches and glossary sync use the header's locale and drop their locale field when one is set; a file whose `Language` header names another language is pointed out.
- With antigravity, a run checks sign-in and quota beside its rules pass, and stops before its first agent call when signed out or out of quota, ending a batch of files there too and saying it stopped, not failed; `doctor` shows both.
- Translate prefers a memory match that uses the glossary term, and marks one that does not fuzzy.
- Translate's AI review gets each entry's glossary terms in the prompt and calls the lookup tools less.
- Translate's cached AI draft reviews are reviewed again once on the next run.

### Fixed

- A wizard skip no longer counts for every locale.
- Quitting the app or stopping a run with Ctrl+C or a kill no longer leaves a running agent (such as a hung `agy`) behind.
- An antigravity batch that answered but never exited is read at once instead of lost to the 20-minute limit and marked unreviewed.
- A file with a batch given up counts the entries in its failed batches on its batch table line.
- `fetch --help` lists the environment variables, as `review` and `translate` do.
- Glossary rows listing several translations (`a/b`, `a, b`) accept any of them.

## [1.0.1] - 2026-10-17

### Fixed

- `rules fetch` and `tm fetch` name a locale the manifest lacks by its WordPress code (`tr_TR (tr)`), not the bare slug.

## [1.0.0] - 2026-10-17

### Added

- `polyglots rules fetch` downloads a locale's rules file from polyglots-data after showing what it changes.
- `polyglots tm fetch` imports a locale's published translation memory; the setup wizard offers it.
- The app's Locale rules and Import TM screens fetch from polyglots-data too.
- Rules files take `schema`, `capitalization`, `register`, `formality` and `sentenceEnd`.
- A rules pattern's `when.notSource` makes it fire only when the source lacks a text.
- `rules check --file <path> --json` checks any rules file.
- The rules builder at ada.tools/polyglots/rules-builder writes a locale's rules file in the browser.
- `polyglots rules builder` and the app's Locale rules screen open the rules builder for a locale.
- The app's Locale rules screen edits formality, register, capitalization and sentence ends, in the rules builder's order.
- Translate notes each draft a locale rule changed, and counts them.
- Memory from long-text projects (readmes, release notes) ranks below the rest and alone raises no conflict.

### Changed

- polyglots ships no locale data: Turkish, Swedish, Greek, Tibetan, Dzongkha and Thai now need a rules file for their sentence-end and wording rules; run `polyglots rules fetch <locale>`.
- Every rules regex has a limit of about 100 ms per translation; a pattern over it is skipped and reported.
- Locales without `register` get a neutral register line; their cached verdicts are reviewed again once.
- A locale that adds `formality` has its cached drafts made again once.
- The app asks polyglots-data once at launch while your locale has no memory and the setup step is not skipped.

### Removed

- The Turkish reply starters; existing templates are kept.
- The no-locale refusal no longer suggests tr to people with earlier Turkish work; set a locale with `polyglots config set defaultLocale`.

### Fixed

- `tm import --locale` stores memory under the wp.org slug, so `tr_TR` no longer files it where nothing reads it.
- The app reads a `defaultLocale` written as a wp code (`tr_TR`) as its slug for the memory, glossary and rules steps, Export TM, Fetch and reply templates, as the CLI does.
- The app's Locale rules screen opens a rules file that does not parse, offering the fetch and the rules builder.
- `tm export` writes each row's context, project and long-text weight, so importing the file back keeps them.

## [0.33.0] - 2026-10-15

### Added

- Home lists what is new in the version you updated to, once, under the cards.

## [0.32.1] - 2026-10-15

### Removed

- Runs no longer write the unused `entry` table in `jobs.db`; an existing one is left in place for older versions still running.

## [0.32.0] - 2026-10-15

### Added

- `polyglots fetch` and the Fetch screen also download a plugin's readme strings, as a file of their own; `--no-readme` or `r` turns it off.

### Fixed

- `polyglots fetch` reads `wp-plugins/<slug>[/<sub-project>]` and `wp-themes/<slug>` as projects instead of reporting them as not found.

## [0.31.0] - 2026-10-15

### Added

- The end of a command says when a synced glossary has changed on translate.wordpress.org since, is over a month old when wp.org cannot say, or is over three months old.

### Changed

- `polyglots glossary sync` downloads the glossary's CSV export instead of reading its web pages.

## [0.30.0] - 2026-10-14

### Added

- `polyglots lint` checks a plugin's or theme's source strings for problems translators cannot fix, with exit codes and GitHub annotations for CI.

### Fixed

- On Windows, an npm-installed `claude` (`claude.cmd`) is found and started instead of failing every batch, and a timed-out agent is stopped with the process it started.
- `polyglots doctor` reports antigravity as unavailable when its registered polyglots tool server, or the Node it runs with, no longer exists.
- The app's Translate screen has a Start over field, so a file can be drafted and reviewed again instead of taken from the cache.

## [0.29.2] - 2026-10-12

### Fixed

- Typing in a batch review's Requester field no longer types into the Locale field too.

## [0.29.1] - 2026-10-12

### Fixed

- Windows consoles other than Windows Terminal, VS Code, JetBrains and Cmder get ASCII symbols instead of empty boxes; `POLYGLOTS_ASCII=0` keeps Unicode.

## [0.29.0] - 2026-10-12

### Added

- `config list-names` prints a locale's proper nouns numbered; `config remove-name` takes the numbers or the names.
- `a` on a finished or stopped review or translation picks another file from the same folder, with the last run's settings filled in.
- Mark several files with `space` or `*` in the app's Review and Translate pickers and run them as one batch with Fetch's options, progress and summary; `review` takes several files and `--parallel` on the command line.
- A batch review fills a reply per file, with one optional requester for all; the app shows one reply or message at a time, `↑↓` moves, `c` copies the one shown. Fetch's summary does the same.
- The Turkish rules template carries two example patterns to turn on: a suffix glued to a placeholder (`%s'de`) and a plural noun after a count (`%d dosyalar`).

### Changed

- Proper nouns are one list per locale: `config add-name` writes the rules file's `properNouns.always`, the Always capitalized list in Locale rules, where a name of several words now works too. Names in `config.json` move there on the first command, and those locales re-review once.
- After a review with a reply template, the reply is shown instead of the requester message, and `c` copies it; `y` is gone. The CLI prints the reply alone too.

### Fixed

- `{results}` in a reply template is filled with the requester message, as the template editor says; `{results_copy}` still works.

## [0.28.0] - 2026-10-11

### Added

- A model fix is checked with the rules once accepted; what it brought in that the submission did not have is noted beside it as `fix-suspect`, and is not counted in the requester message.
- Reply templates per locale, created, edited and deleted in Configuration › Reply templates or with `polyglots template edit|list|delete|path`, filled after a review with the requester (`--requester`), a choice on whether the review found anything and the requester message; printed by `review` (`--template`) and shown in the app, where `y` copies and `t` switches it.
- Every pull request and push to main is tested on GitHub: typecheck, tests on Node 24 and 26, the built CLI and the website build. Dependabot proposes grouped weekly dependency updates.
- Releases are published to npm from GitHub Actions with provenance, and each version gets a GitHub Release with its changelog section.

### Changed

- The guidance editor in Locale rules moves the cursor anywhere in the text, clears it with ctrl+x and undoes with ctrl+z; it used to only add at the end. ctrl+k there now only opens the palette.
- Dependencies updated, among them dotenv 18, openai 7.27, react 19.3, zod 4.6 and vitest 5.0.3.

### Fixed

- The translation memory check ignores a trailing `।`, `۔`, `。`, Tibetan shad or other script full stop, and a space before it, as it did for `.`.
- The test suite passes off a Mac: it no longer assumes the Apple silicon default local model, or file times fine enough to order files written in a row.

## [0.27.0] - 2026-10-09

### Added

- A daily check for a newer version on npm, shown in the app's header and as a yellow line saying how to update at the end of a command or on quitting the app. Off with `config set updateCheck off` or `NO_UPDATE_NOTIFIER=1`.

### Fixed

- The punctuation check recognises sentence marks beyond `.!?`, such as the danda `।`, `。`, `؟` and `۔`, so correct Hindi, Bengali, Japanese, Chinese, Arabic and Urdu translations are no longer reported as missing their final stop.
- Text that looks the same but is encoded differently, as Hindi ड़, Bengali য় and Punjabi ਸ਼ often are, now counts as the same text in the glossary, translation memory and consistency checks.
- Greek questions ending in `;`, Tibetan and Dzongkha sentences ending in a shad or in ཀ or ག, and Thai sentences with no final mark are no longer reported as missing their final stop, and Thai abbreviations such as `ธ.ค.` are no longer read as sentences.
- Locale rule patterns and mistakes find text in either Unicode encoding, and a glossary translation stored in both encodings is listed once.
- Dotted abbreviations such as `a.m.`, `π.μ.` or the Lao month `ທ.ວ.` are no longer read as sentences, and a Tibetan or Dzongkha ཀ or ག followed by a tsheg still ends one.

## [0.26.2] - 2026-10-08

### Changed

- The app's home screen lists Review first, so it has focus when the app opens.

## [0.26.1] - 2026-10-08

### Fixed

- Usage statistics count the AI reviewer's title-case findings inside `locale-rule`, since that count hints at the locale.

## [0.26.0] - 2026-10-08

### Added

- Full-screen interactive mode: a home screen of cards, a header with setup status x/5, a keys footer, and a minimum size of 60×20.
- Setup wizard for locale, review provider, draft engine and keys, glossary and locale rules; each step can be skipped and the wizard rerun from Configuration.
- `?` help on every screen, a Ctrl+K / `:` command palette, and Help and About pages in the interactive mode.
- Review statistics in the interactive mode serves the stats page locally; `w` still writes a standalone copy.
- The interactive mode prints the last run's output path after quitting; switch it off under Configuration › Interface settings.
- Locale Rules shows the plain name and description of the rule under the cursor.
- In the interactive mode, `x` stops the stats server from any screen; its address sits in the header as a link.
- Locale Rules can save the built-in rules as the locale's file with `s`, which completes the setup step.
- The stats share image names ada.tools/polyglots.
- The stats page remembers its language, range, theme and view across reloads and restarts.
- A second polyglots serving stats uses the page another one already serves.
- `polyglots stats --no-open` serves the dashboard without opening a browser.
- Review and translate run screens list the most recent entries as each batch lands, with their outcome and rule hits.
- TUI screens taller than the window scroll to keep the cursor and a run's keys in view; page up and page down scroll a screen with no cursor.
- `review` and `translate` take the locale from the file's Language header when nothing else names one, except when Antigravity reviews.
- `config set defaultLocale ""` unsets the locale.
- No AI: `reviewProvider none` makes review rules-only and counts as done in setup; `doctor` reports it as a mode.
- `--draft-engine none` fills from translation memory only and reports how many entries it left untranslated.
- Opt-in anonymous usage statistics, off by default and asked at the end of setup; `DO_NOT_TRACK=1` always turns them off.
- `usage-stats show` and `usage-stats reset`, the `usageStats` setting, and Configuration › Usage statistics in the app.
- `localIdleTimeout`: a local server silent this many seconds is given up on as a cut-off reply (default 180).

### Changed

- With no model set, the local engine uses `qwen3.8:27b` off Apple silicon, where the MLX build does not run.
- With no review provider, drafts from an engine are written fuzzy and not reviewed.
- Rules-only and memory-only runs no longer prune cached AI verdicts or drafts.
- Antigravity's setup check accepts allow-rules written as patterns.
- A .pot is refused naming its Plural-Forms placeholder, not a missing header.
- The package ships only dist/, i18n/, README, LICENSE and CHANGELOG; building no longer fetches the locale table.
- polyglots no longer assumes tr when no locale is set; set one with `config set defaultLocale` or `--locale`.
- The setup wizard and Locale Rules no longer prefill tr; Fetch and the memory screens ask for setup without a locale.
- The interactive mode is never wider than the home grid, and is centred on a wide terminal.
- The stats server listens on port 29117, and warns and takes another port when that one is in use.
- Interactive menu keys: Tools is `o`, API keys is `k`. Ctrl+C asks before stopping a run in progress.
- A run stopped by Ctrl+C, SIGINT or SIGTERM, or by quitting the interactive mode, is recorded as stopped, not abandoned, so stats no longer counts it as a failure.
- `polyglots stats` serves a live dashboard on localhost and opens it; `--out`, or running off a terminal, writes a standalone HTML copy.
- The stats page has Overview, Reviews, Translation, Projects and Method views, a year of activity, time ranges, a share image, and human names for every flag.
- Messages that pointed at `docs/` in the repo link to the documentation at ada.tools/polyglots.
- Messages name "your .po editor" rather than Poedit; the TMX export names OmegaT beside Poedit.
- TUI letter keys ignore ctrl and meta, so ctrl+c no longer also copies a finished review's report.
- Aborted, Cancelled and Stopped lines carry the warning glyph; a zero approvable count is no longer green.

### Fixed

- `review` printed the problems file's path twice.
- The TUI's key hints match the keys every screen binds; Export TM's footer showed keys it does not have.
- The review, translate and fetch footers list the keys of the stage they are in, not the options form's during a run.
- Emoji and other wide characters no longer shift box borders, and truncated cells keep their colour.
- Boxes and the live progress line never run wider than the terminal; a piped summary keeps at least 80 columns, so a saved log loses nothing.
- The TUI file picker keeps its cursor in view on a short terminal.
- The TUI no longer waits more than a second on a stalled stream when it exits.
- The stats page keeps focus, sort, filter and open lists on the right table after a refresh.
- The Locale Rules trial reads the glossary without writing to polyglots.db.
- The User-Agent sent to translate.wordpress.org points at the real repository.
- `fetch` says when only universal checks run, and checks local models before downloading.
- `rules copy` rewrites the pack and check lines for the target locale.

### Security

- Upgraded @modelcontextprotocol/sdk, adm-zip, proxy-addr, source-map-js, fast-uri and ip-address.

## [0.25.0] - 2026-10-07

### Added

- `stats` prints a terminal summary: totals, a 12-week sparkline and the top five projects.
- `POLYGLOTS_ASCII=1` draws plain ASCII glyphs and boxes; `NO_COLOR` and `FORCE_COLOR` are honoured.

### Changed

- Node 24 or later is required.
- CLI output is coloured on a terminal, per stream. Errors, warnings and confirmations lead
  with `✗`, `!` and `✓` in place of `Error:` and `Warning:`.
- translate, review and fetch print a header on stderr and end with a framed summary and a next
  step; doctor and models print aligned tables ending in a status line.
- A stopped review that wrote a problems file also says to re-run.

## [0.24.0] - 2026-10-07

### Fixed

- Translate's draft review runs the configured `reviewProvider`; it always ran claude unless one
  was passed explicitly.
- Translate's review cache tells antigravity models apart, as review's already did.
- Bedrock, Vertex and `CLAUDE_CODE_OAUTH_TOKEN` settings reach the spawned `claude`; only Claude
  Code session markers are stripped.

### Changed

- Translate's antigravity review verdicts miss once and are re-reviewed on the next run.

## [0.23.0] - 2026-10-07

### Added

- The local draft engine runs on OpenAI-compatible servers (LM Studio, llama.cpp server, vLLM) as
  well as Ollama, chosen with `localServerKind` and `openaiCompatible.{baseUrl,model}`.
- `polyglots models` and the Local models screen can pick an OpenAI-compatible server's model.
- `translate --local-model <name>` drafts with another local model for one run.
- Experimental local review, opted into only with `config set reviewProvider local`.
- `ollama.contextLength` and `openaiCompatible.contextLength`, sent to Ollama as `num_ctx`, and a
  warning before a local review whose batch will not fit.
- `docs/local-models.md`: server setup, context windows and batch sizes.

### Changed

- The stats page strings are translatable: an English template at `i18n/stats/stats.pot`, with each
  `<locale>.po` beside it embedded at build time. Turkish moved into `tr_TR.po`.
- The `qwen` draft engine is now called `local`. `qwen` is still accepted, Ollama draft caches are
  kept, and a saved config is rewritten with `local`, which 0.22 and older cannot read.
- A local model's reply that is cut off by the server reports that, rather than invalid JSON.

## [0.22.0] - 2026-10-07

### Added

- `polyglots doctor` reports which agent CLIs are installed, signed in and set up, with an opt-in
  `--live` prompt.
- A "Check AI agents" menu screen.
- `polyglots models` lists local model servers (Ollama, LM Studio, llama.cpp) and their models.
- A "Local models" menu screen that sets the Ollama draft model.
- `config set` and `config get` take `ollama.model`, `ollama.baseUrl` and `localModelServers`.
- Built-in Swedish rules, marked as defaults for the sv locale team to confirm.
- `rules check` and the Locale rules screen say which built-in pack a locale has.

### Changed

- `p` on the menu switches only between usable agents, and says why the others are missing.
- Translate with the qwen engine warns before starting when Ollama is down or the model is not
  pulled, on the CLI and the Translate screen.
- Review and translate prompts say when only the universal checks run, and carry the
  catalogue's `Plural-Forms` header above two forms.
- `review` and `translate` print a note before running a locale with only the universal checks.
- The `rules edit` template's examples follow the locale.
- Cached verdicts for de, and for catalogues with more than two plural forms, run again once on
  the next run.

### Fixed

- `POLYGLOTS_CLAUDE_BIN` no longer replaces the antigravity binary.
- TUI review, translate and fetch runs honour `POLYGLOTS_AGENT_BIN` and `POLYGLOTS_CLAUDE_BIN`.
- Memory matching folds case by the locale, not as Turkish.
- The Turkish capitalization paragraph no longer reaches other locales that enable `title-case`.
- Review and translate refuse a catalogue with plural entries but no `Plural-Forms` header.
- `tm import` stores plural rows only for two-form catalogues.
- `nl/formal` and other sets pick up the language's proper nouns from `config.json`.
- `ampersand` and `number-format` name the locale's language instead of Turkish.

## [0.21.0] - 2026-10-07

### Added

- Per-locale rules file (`polyglots rules edit|check|copy|path`): switch built-in rules, proper
  nouns, common mistakes, patterns at hint, error or fix level, and guidance for the AI review.
- A "Locale rules" menu entry editing every section of a locale's rules, with a panel to try them
  on a sample before saving and a copy to another locale.
- Translation sets such as `nl/formal`, `pt/ao90` and `sr/latin`, in every wp.org lookup and file name.
- `--locale` accepts WordPress codes (`nl_NL_formal`, `tr_TR`), mapped by a wp.org locale table
  that every build refreshes.
- DeepL drafts for a formal or informal set ask for that register.
- A `control` rule for settings WordPress code reads (`on`/`off` font switches, `ltr`, word count
  type, number separators): checked against the values the translator comment allows.
- `translate` checks its drafts with the review rules: fix patterns applied, findings sent to
  the AI pass, and an entry still failing an error-level check marked fuzzy.

### Changed

- An invalid locale rules file stops `review`, `translate` and `fetch` before they start.
- A locale wp.org does not list is refused, with suggestions, instead of being used as typed.
- Control strings skip the draft engine and every other rule, so `on` is never translated as a word.
- Cached verdicts and draft reviews run again once on the next run.

### Fixed

- The requester link works for plugin readme sub-projects.

## [0.20.1] - 2026-10-03

### Changed

- `fetch` pauses longer between wp.org requests: 1.5 s between pages, 3 s between exports.

### Fixed

- `fetch` waits out a 429 or 503 from wp.org and retries up to 3 times, saying how long it waits.

## [0.20.0] - 2026-10-03

### Added

- An "Export Translation Memory" menu entry: TMX or `.po`, saved to Downloads.

### Fixed

- The menu's TM import picker lists `.po` files, not only `.tmx`.

## [0.19.0] - 2026-10-02

### Added

- `fetch` and a menu entry: take a list of theme and plugin slugs or URLs, download their
  waiting or untranslated strings, and review or translate all of them, up to 8 at once.

### Fixed

- Resuming a paused run released only one of the jobs waiting on it.

## [0.18.0] - 2026-09-30

### Added

- `tm import` reads `.po` exports as well as TMX, which is what translate.wordpress.org
  gives you. The format is chosen by what the file holds, not by its name. Fuzzy and
  untranslated entries are skipped, and a plural entry becomes one row per source form.
- `tm export [file]` writes the memory as TMX or `.po`, `--format` or the file name
  deciding. A `.po` holds one translation per source and context, so alternatives are
  collapsed to the most recent and the count dropped is reported.
- A `line-breaks` rule: the translation has a different number of line breaks than the
  source. Error severity, universal, and not repairable.
- An `ampersand` rule: the translation keeps `&` where Turkish writes the conjunction as a
  word. Entities and query strings are left alone.
- A `number-format` rule: a space between the percent sign and its number.

### Changed

- `punctuation` also reports a sentence-ending stop that one side has and the other does
  not. Presence only: trading `!` for `.` is the locale's own convention.
- Cached verdicts prune once on the next run.

## [0.17.1] - 2026-09-28

### Changed

- The repaired file marks fuzzy the entries no repair was found for, the ones the summary
  counts as "left for you". Repaired entries stay unflagged.

## [0.17.0] - 2026-09-28

### Added

- An `escaping` rule: the translation escapes a quote the source spells plainly, or drops one
  the source carries. Error severity, and universal rather than per locale.

### Changed

- A stray backslash before a quote is repaired mechanically, like whitespace. A lost one is
  left for the model, since nothing can compute where it belonged.
- Cached verdicts prune once on the next run.

## [0.16.3] - 2026-09-28

### Fixed

- Repairs and drafts no longer escape a quote the source leaves plain. Applies to the model's
  fixes, reviewed drafts and repairs written from the memory.

## [0.16.2] - 2026-09-27

### Changed

- The repaired file no longer marks its entries fuzzy. Flags an entry already carried are kept.

## [0.16.1] - 2026-09-26

### Changed

- The translate screen no longer asks for confirmation on any mode.

## [0.16.0] - 2026-09-26

### Added

- Batch size on the translate screen, the same ladder review offers, passed to the run.

### Changed

- A pending translation starts without a second confirmation. `all` still asks.

## [0.15.0] - 2026-09-25

### Changed

- The memory holds every wording the locale approved for a source, not just the last imported.
  A submission matching any of them is approved, and `tm-conflict` fires only when none match.
- A repair from the memory happens only where the alternatives agree.
- `translate` marks a fill from the memory fuzzy when more than one wording was on offer.
- Opening a database written before this rebuilds the `tm` table and its index. No row is dropped.

### Fixed

- A submission left in English is no longer approved because the memory holds the same English.

## [0.14.0] - 2026-09-21

### Changed

- Entries the memory can settle no longer go to the model: an exact match is approved, a
  case-only difference is approved as written, and one left in English is repaired from it.
  On a 1,359-entry theme, 265 entries settled and the run sent 11 batches instead of 14.
- The progress line says how many entries the memory settled.

### Fixed

- The resume line counts down, says "1 batch" rather than "1 batches", and waits for a batch
  count before claiming one.

## [0.13.0] - 2026-09-20

### Added

- The requester message links to the reviewer's own translations. Set it up once with
  `polyglots config set wporgUsername <your wp.org login>`. Plugin, theme and patterns exports
  are understood; anything else keeps an empty `href`.

### Fixed

- A batch the agent refuses is attempted twice again, undoing the change made in 0.12.0.
- A refused batch reports that it produced no output, instead of blaming malformed JSON.
- `p` and `q` are acknowledged the moment they are pressed, on every surface.
- Translate's progress screen reports pause and resume at all.

## [0.12.0] - 2026-09-20

### Changed

- A review driven by antigravity records the model from its settings, as
  `antigravity:Gemini 3.8 Flash (Medium)`.
- Cached verdicts prune once on the next run.

### Fixed

- The prompt states how many entries a batch holds, and that there is no shell or filesystem.
- A refused batch is no longer attempted twice. (Reverted in 0.13.0.)

## [0.11.0] - 2026-09-20

### Changed

- An entry states how its exact source was translated and approved before, so the agent no
  longer looks it up. The memory joins the verdict key.
- Cached verdicts prune once on the next run.

## [0.10.0] - 2026-09-20

### Changed

- `/release` chooses the bump size when the caller does not name one.
- Corrects 0.9.9, which was cut as a patch and should have been a minor.

## [0.9.9] - 2026-09-20

### Added

- A `tm-conflict` rule: the memory holds a different translation of this exact source. Suspect
  severity, and differences of case, spacing or a trailing stop are not reported.

### Changed

- An entry states the glossary terms its source contains, so the agent no longer looks them up.
- Timeouts are per provider: five minutes for Claude, twenty for antigravity, which is given its
  own deadline just inside the caller's.
- The review screen and `polyglots review` warn when a batch is too small for antigravity.
- Cached verdicts prune once on the next run.

## [0.9.8] - 2026-09-20

### Changed

- Every screen that starts or reports a job names the provider it will use.

### Fixed

- A review that named `antigravity` spawned `claude`. Verdicts cached before this are Claude's,
  filed under antigravity.

## [0.9.7] - 2026-09-20

### Changed

- A resumed review says so, counting the inherited batches into the bar instead of starting
  from zero.

## [0.9.6] - 2026-09-19

### Added

- `docs/ideas.md`, and a backlog entry for moving to the next split part from the results screen.

### Changed

- Em dashes removed from the prose in comments, documents and messages.

## [0.9.5] - 2026-09-19

### Added

- `/release` for Claude Code sessions in this repository: verify, bump, changelog, build, commit.

## [0.9.4] - 2026-09-19

### Fixed

- Corrected the antigravity timings in `docs/antigravity.md` and in the 0.8.0 entry. The two
  providers are close rather than four times apart.

## [0.9.3] - 2026-09-19

### Added

- The statistics screen chooses where the page goes, with Tab, and `o` opens it.

### Changed

- The file picker can choose a folder as well as a file.

## [0.9.2] - 2026-09-19

### Fixed

- The apostrophe rule flagged ordinary words that began with an English one: 56 findings on a
  1,278-entry submission became 2.

## [0.9.1] - 2026-09-19

### Fixed

- The review screen said `0 flagged by rules` where the rules had flagged thousands. It now
  reads `rules: N wrong, N suspect`.
- A rules-only run reported no suspects at all.

## [0.9.0] - 2026-09-19

### Added

- `polyglots split <file> --size <n>` writes numbered parts into `<name>-split/`, and the menu
  has the same. Parts reuse whatever is already cached for the whole file.

## [0.8.0] - 2026-09-19

### Added

- `reviewProvider` chooses the agent that judges translations: `claude`, or `antigravity`
  through its `agy` command. Press `p` on the main screen to switch. Setup is in
  `docs/antigravity.md`, and antigravity needs it before it will work at all.
- The agent runner keeps stderr and folds it into the error it raises.

### Changed

- `engineId` names the provider as well as the model, so two agents' verdicts coexist.
- The Claude runner moved to `src/agent/`; `claude-review.ts` became `draft-review.ts`.

## [0.7.6] - 2026-09-19

### Fixed

- A local draft is cached under `ollama:<model>` rather than under `qwen`, so two models cannot
  serve each other's drafts. Rows written before this say `qwen`.

## [0.7.5] - 2026-09-19

### Added

- `o` on either results screen opens the file in PoEdit.

## [0.7.4] - 2026-09-19

### Added

- `CLAUDE.md` in the project root.

## [0.7.3] - 2026-09-19

### Added

- The review results screen offers a one-line message for the requester, and `c` copies it.
  `polyglots review` prints the same sentence.
- `byGroup` on the review summary, counted over repaired entries.

## [0.7.2] - 2026-09-19

### Added

- The file picker shows how many entries each catalogue holds, and `s` cycles the sort order.

### Changed

- The picker orders by modification time, newest first, and the selected row takes the
  pointer's blue.
- A run records how it ended: `stopped`, `failed` or `abandoned`.

### Fixed

- A literal percent sign is no longer read as a placeholder.
- A run row left at `running` by a hard kill is cleared at the start of the next run.

## [0.7.1] - 2026-09-19

### Added

- `npm run build` refuses while a review or translate is in flight, and says which.
  `POLYGLOTS_ALLOW_BUILD=1` overrides it.
- A run records the process that owns it.

### Changed

- The build guard fails open: no database, an unbuilt native module or an older schema all
  allow the build.

## [0.7.0] - 2026-09-19

### Added

- `--draft-engine qwen` drafts against a local Ollama, configured under `ollama` in
  `config.json`. It identifies itself as `ollama:<model>`.

### Fixed

- Draft engines identify items by number rather than by gettext key. Every cached draft is
  invalidated.

## [0.6.0] - 2026-09-19

### Added

- `polyglots stats` writes a self-contained HTML page from the run history, also available from
  the menu. No script, nothing off the machine, light and dark, English and Turkish.

### Changed

- `pruneStaleConfigs` checks its table name against an allow-list at runtime.
- The `X-Polyglots-Review` header no longer carries a fingerprint.
- A run row says `running`, `done` or `stopped`, and nothing else.

### Fixed

- A cached verdict records which model produced it.
- An entry whose whitespace was repaired no longer shares a cache key with one submitted clean.
- A `by_category` tally holding something that is not a number reads as absent.

## [0.5.0] - 2026-09-18

Run state moved out of the `.po` file and into a database.

### Added

- `translate` resumes, reusing the drafts and reviews it already has.
- An interrupted review picks up where it stopped.
- `translate --fresh` ignores both and asks again.
- Per-run totals are kept as history.

### Changed

- Resume is per entry rather than per file.
- A failed batch keeps the entries it did judge.
- Changing the glossary, the rules or the prompt discards cached verdicts for that locale only.

### Removed

- The `X-Polyglots-Review` marker is still written but never read back. One written by 0.2.0
  through 0.4.0 is ignored, and the review starts from the top.

## [0.4.0] - 2026-09-14

### Added

- `p` pauses a run, `r` resumes it, `q` stops it and keeps what is done, on both surfaces. It
  takes effect at a batch boundary.
- Both commands give up after three consecutive failed batches.
- The review summary reports `pending`, the entries a stopped run never looked at.

### Fixed

- A failing `claude` call reports whichever stream actually said something.
- A failed batch no longer advances the resume marker.
- `approvable` could go negative.
- A stopped run no longer claims the submission looks approvable while reporting entries it
  never reviewed.
- The CLI no longer puts a non-terminal stdin into raw mode.

## [0.3.0] - 2026-09-12

### Added

- Review returns corrected translations and writes `<name>-repaired.po`.
- Whitespace is repaired before the rules pass judgment.
- Entries the rules condemn go to the model for a fix, which is re-run through the rules and
  refused if it introduces a new error.
- `repaired` and `written` counts in the summary.

### Changed

- `<name>-problems.po` is written only by `--no-ai` runs.
- The resume marker format is at version 2; markers from earlier builds are rejected.

### Fixed

- A repaired translation could be silently reverted on resume.
- The TUI told the user to run `translate` over the repaired file, which would have undone
  every repair.
- `npm run typecheck` covers the tests as well as `src`.

## [0.2.0] - 2026-09-11

### Added

- An estimated finish time in the progress line, and an elapsed clock per batch.
- Review resumes an interrupted run from a marker in the output file's header. `--fresh`
  ignores it.
- Batch size is selectable per run in the TUI.

### Changed

- One progress bar across every surface.
- The review progress line shows one counter instead of two that contradicted each other.

### Fixed

- Review writes after every batch instead of only at the end.
- The progress bar drew as full before the first batch had started.

## [0.1.0] - 2026-09-10

First working version: `translate` drafts and reviews `.po` entries, `review` audits a
submission against the WordPress glossary and per-locale rules, with a TUI over both, an MCP
server for glossary, consistency and TM lookups, and a local SQLite memory fed from PoEdit TMX
exports.
