# Configuration

Settings live in `~/.config/polyglots/config.json` and API keys in
`~/.config/polyglots/.env`, kept apart so the settings file can be shared or
read without exposing a key. Change them with `polyglots config` or from the
menu rather than by hand: every value is checked before it is saved.

```
polyglots config get                     # every setting, keys masked
polyglots config get batchSize
polyglots config set batchSize 50
```

## Settings

| Setting | Default | What it does |
|---|---|---|
| `defaultLocale` | not set | The locale a command uses when `--locale` is not given. `review` and `translate` then fall back to the file's `Language` header; every other command that needs a locale stops and asks for one. `config set defaultLocale ""` unsets it. |
| `defaultDraftEngine` | `deepl` | The draft engine for `translate`: `deepl`, `openai` or `local`, or `none` for translation memory only; see [without AI](getting-started.md#using-polyglots-without-ai). |
| `reviewProvider` | `claude` | Which agent reviews: `claude` or `antigravity`. `local` is the experimental local reviewer; see [local models](local-models.md). `none` reviews with the rules alone; see [without AI](getting-started.md#using-polyglots-without-ai). |
| `wporgUsername` | empty | Your translate.wordpress.org login. Used only to link the requester message to the contributor's strings. |
| `batchSize` | `25` | Entries per batch sent to the reviewer or draft engine. `--batch-size` overrides it for one run. |
| `consistencyTtlDays` | `30` | How long a translate.wordpress.org consistency lookup is cached before it is asked again. |
| `localServerKind` | `ollama` | Which local server the `local` engine and reviewer use: `ollama` or `openai-compatible`. |
| `ollama.baseUrl` | `http://localhost:11434` | Where Ollama listens. |
| `ollama.model` | `qwen3.8:27b-mlx` | The Ollama model to load. |
| `ollama.contextLength` | unset | The context to ask Ollama for. Worth setting; see [local models](local-models.md). |
| `openaiCompatible.baseUrl` | `http://localhost:1234` | An LM Studio, llama.cpp or vLLM server. |
| `openaiCompatible.model` | empty | The model id, exactly as `polyglots models` shows it. |
| `openaiCompatible.contextLength` | unset | The context the server was started with. |
| `localModelServers` | none | Extra servers for `polyglots models` to list, comma-separated. Replaces the whole list. |
| `localIdleTimeout` | `180` | Seconds a local server may send nothing before polyglots gives up on the reply. Raise it on slow hardware: `polyglots config set localIdleTimeout 600`. |
| `usageStats` | off | Whether to share anonymous weekly totals for the website: `on` or `off`. See [usage statistics](usage-statistics.md). |
| `updateCheck` | on | Whether to ask npm once a day for a newer version, and say so at the end of a command and in the app's header: `on` or `off`. |

The two context lengths are cleared with an empty value:
`polyglots config set ollama.contextLength ""`.

## Names the checks should leave alone

Where the `title-case` check runs (in a language whose built-in pack turns it
on, and in any locale whose [rules](locale-rules.md) do), a capital in the
middle of a sentence is flagged. Places, people and institutions are the
exceptions no built-in list can cover, so add them per locale:

```
polyglots config add-name --locale tr "Kadıköy"
polyglots config add-name --locale sv "Riksdagen"
```

A name may be several words. Names that belong to the language rather than to
your projects, such as month or weekday names, go in the
[locale rules](locale-rules.md) instead.

## API keys

| Key | Used by |
|---|---|
| `DEEPL_API_KEY` | the `deepl` draft engine |
| `OPENAI_API_KEY` | the `openai` draft engine |

```
polyglots config set-key DEEPL_API_KEY
```

With no value given the key is read from standard input, so it never reaches
your shell history. An environment variable of the same name takes precedence
over the stored key. The `.env` file is written readable by you alone.

Reviewing needs no key: the agent uses its own sign-in.

## Environment variables

| Variable | Effect |
|---|---|
| `POLYGLOTS_HOME` | Keep settings and data under this folder (`config/` and `data/`) instead of `~/.config` and `~/.local/share`. |
| `POLYGLOTS_AGENT_BIN` | The agent executable to run, when it is not `claude` or `agy` on your `PATH`. |
| `POLYGLOTS_ASCII=1` | Plain ASCII instead of Unicode symbols and box lines. Also chosen automatically when the locale is not UTF-8. |
| `NO_COLOR` | No colour in the output. |
| `FORCE_COLOR` | Colour even when the output is not a terminal. |
| `NO_UPDATE_NOTIFIER=1` | Never check npm for a newer version. The check is also skipped when `CI` is set, or when the output is not a terminal. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | An error, or the run was aborted. |
| `2` | A usage error: a missing argument or an invalid option. |
| `3` | The run stopped early on an API quota or rate limit. Run it again later to carry on. |
