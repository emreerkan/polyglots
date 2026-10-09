# polyglots

Review a locale's submissions in minutes, not evenings.

polyglots checks and translates WordPress `.po` files for translate.wordpress.org
locale teams. It runs deterministic checks on every string, asks an AI agent to
judge what a rule cannot, writes the repairs into a file you open in your `.po`
editor, and drafts translations from your translation memory, your glossary and
a machine translation engine.

Documentation: https://ada.tools/polyglots/docs/

## What it does

- **Review a submission.** Every string is checked for placeholders, HTML,
  plural forms, whitespace, escaping, punctuation, glossary terms, your
  locale's rules and consistency with approved translations. An AI agent
  judges the findings a rule cannot settle. The entries that need work are
  written to a `-problems.po` file, already repaired where the fix is
  mechanical, with a short message you can post back to the contributor.
- **Translate.** Pending entries are filled from translation memory first,
  then drafted by DeepL, OpenAI or a local model, and reviewed by the agent
  before they are written.
- **Fetch from translate.wordpress.org.** Download waiting or untranslated
  strings for themes and plugins and review or translate each project.
- **See your work.** A statistics page served on your own machine: submissions
  reviewed, what was flagged, projects, and a share image.
- **Interactive mode.** Run `polyglots` with no arguments for a full-screen
  menu with a setup wizard, help on every screen and live progress. Everything
  it does is also a command, for scripts and automation.

Nothing is uploaded to translate.wordpress.org. You import the results
yourself.

## Requirements

- Node.js 24 or newer.
- For AI review, one of:
  - [Claude Code](https://claude.com/claude-code), signed in;
  - Antigravity's `agy` CLI, signed in;
  - a local model server (Ollama, LM Studio, llama.cpp or vLLM).
- For machine translation drafts, optionally a DeepL or OpenAI API key, or the
  same local model server.

None of these is required: choose No AI in setup and every mechanical check
still runs, with nothing sent to a model.

`polyglots doctor` reports which agents are installed and signed in, without
sending a prompt. `polyglots models` lists local model servers and the models
they hold.

## Install

```
npm install -g polyglots
```

From a checkout instead:

```
git clone https://github.com/emreerkan/polyglots.git
cd polyglots/app
npm ci
npm run build
npm link
```

## First run

```
polyglots
```

The setup wizard asks for your locale, your review agent (or No AI), a draft
engine and its key, then downloads your locale's glossary from
translate.wordpress.org. Its last question is whether to share anonymous usage
totals; the answer is no unless you say yes.
Every step can be skipped and run again later from Configuration.

The same from the command line:

```
polyglots config set defaultLocale de
polyglots glossary sync
polyglots review plugin-de.po
polyglots translate theme-de.po
```

There is no default locale. `review` and `translate` also accept `--locale`,
or read the file's `Language` header when nothing else names one.

## Where your data lives

- `~/.config/polyglots/`: settings (`config.json`), API keys (`.env`, readable
  by you only) and your locale rules.
- `~/.local/share/polyglots/polyglots.db`: translation memory and glossary.
  It is built from your imports and cannot be rebuilt from anything else, so
  back it up.
- `~/.local/share/polyglots/jobs.db`: run history and caches. Deleting it
  costs a re-review, nothing more.

Set `POLYGLOTS_HOME` to keep everything under one other directory.

## Network calls

polyglots talks to translate.wordpress.org (glossaries, project downloads and
approved translations for consistency checks) and to the services you choose:
your review agent, and DeepL, OpenAI or your local model server for drafts.
If you opt in to [usage statistics](https://ada.tools/polyglots/docs/usage-statistics/),
a weekly count of strings reviewed goes to ada.tools/polyglots; it is off
unless you turn it on. Once a day, polyglots asks registry.npmjs.org for its
latest version number, to say when an update is out; turn that off with
`polyglots config set updateCheck off` or `NO_UPDATE_NOTIFIER=1`. Nothing else.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributors

Thank you to everyone who has improved polyglots:

- [Kamran Abdul Aziz](https://github.com/ekamran):
  - sentence marks beyond `.!?` in the punctuation check, so Hindi, Japanese,
    Arabic and other scripts' correct endings are no longer reported
    ([#20](https://github.com/emreerkan/polyglots/issues/20),
    [#21](https://github.com/emreerkan/polyglots/pull/21));
  - text that differs only in Unicode encoding, such as Hindi ड़ or Bengali
    য়, compared as the same text in the glossary, memory and consistency
    checks ([#23](https://github.com/emreerkan/polyglots/issues/23),
    [#24](https://github.com/emreerkan/polyglots/pull/24)).

## License

MIT. See [LICENSE](LICENSE).
