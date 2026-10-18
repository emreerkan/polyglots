# Local models

polyglots can draft translations with a model running on your own machine,
and, experimentally, review with one. Nothing is metered. Strings stay on the
machine only when both drafting and reviewing are local: drafting locally
while an agent reviews still sends the drafts to the agent's provider.

Two kinds of server work:

- **Ollama**, through its own API.
- **OpenAI-compatible servers**: LM Studio, the llama.cpp server and vLLM,
  through `/v1/chat/completions`.

`polyglots models` lists the servers that are running and the models each one
holds, without loading any. The **Local models** screen in the menu does the
same and lets you pick one.

## Drafting with a local model

```
polyglots translate plugin-de.po --draft-engine local
```

or make it the default:

```
polyglots config set defaultDraftEngine local
```

The drafts are still reviewed by your agent (claude, antigravity or codex) unless
you also choose local review, below.

## Choosing the server and model

The `local` engine and the local reviewer share one target: the server
`localServerKind` names, with that server's model.

```
polyglots config set localServerKind ollama              # or openai-compatible
polyglots config set ollama.model qwen3:8b
polyglots config set ollama.baseUrl http://localhost:11434
polyglots config set openaiCompatible.baseUrl http://localhost:1234
polyglots config set openaiCompatible.model qwen/qwen3-8b
```

Picking a model on the Local models screen sets the kind and the model in one
step. To try another model for a single run:

```
polyglots translate plugin-de.po --draft-engine local --local-model llama3.2
```

Drafts are cached per model and per server, so switching models never serves
one model's work as another's, and switching back finds the earlier drafts
again.

## Server setup

### Ollama

```
ollama serve
ollama pull qwen3:8b
polyglots config set ollama.model qwen3:8b
```

Pick a model your machine can hold; the tag above is only an example. With
no model set, polyglots uses `qwen3.8:27b-mlx` on Apple silicon, where Ollama
runs MLX builds, and `qwen3.8:27b` everywhere else. Both need about the
memory a 27B model does, so on a smaller machine set the model you pulled.

**Set the context length.** Ollama runs a model at its own default context
unless told otherwise, and on many installs that is about 4,096 tokens. A
longer prompt is cut **without an error**: the reply simply covers what was
left. Tell polyglots the context you want, and it sends it with every request:

```
polyglots config set ollama.contextLength 16384
```

A larger context needs more memory. `polyglots config set
ollama.contextLength ""` unsets it, and choosing another model on the Local
models screen clears it, since the number belonged to the old model.
`OLLAMA_CONTEXT_LENGTH` raises the default for the whole server instead.

### LM Studio

Start the server from the Developer tab, or with `lms server start`. It
listens on `http://localhost:1234`, which is polyglots' default. The context
is fixed when the model is loaded, so set it there, then tell polyglots the
same number:

```
lms load <model> --context-length 16384
polyglots config set localServerKind openai-compatible
polyglots config set openaiCompatible.contextLength 16384
```

### llama.cpp server

```
llama-server -m qwen3-8b-q4_k_m.gguf -c 16384 --port 8080
polyglots config set localServerKind openai-compatible
polyglots config set openaiCompatible.baseUrl http://localhost:8080
polyglots config set openaiCompatible.model <the id polyglots models shows>
```

`-c` is shared between parallel slots. With `--parallel 4` each request gets a
quarter of it, and that quarter is the number to give
`openaiCompatible.contextLength`.

### vLLM

```
vllm serve Qwen/Qwen3-8B --max-model-len 16384
polyglots config set localServerKind openai-compatible
polyglots config set openaiCompatible.baseUrl http://localhost:8000
polyglots config set openaiCompatible.model Qwen/Qwen3-8B
```

vLLM reports its context in its model list, and polyglots reads it.

`polyglots models` always looks at Ollama, LM Studio and llama.cpp on their
default ports. To have it list another server too, such as vLLM on port 8000
or a machine on your network, add it to `localModelServers`. The command
replaces the whole list, so give every server you want, comma-separated:

```
polyglots config set localModelServers http://localhost:8000,http://gpu-box:11434
```

### Models that think aloud

A reasoning model may write its thinking into the reply before the answer,
and those tokens count against the context too. polyglots turns thinking off
for Ollama. Other servers need it turned off in their own settings or chat
template.

## Context and batch size

Every batch is one request: the instructions, the entries and the model's
reply must fit in the context together. polyglots plans with about 95 tokens
of prompt and 40 of reply per entry, on top of roughly 2,000 for the review
instructions. On a review that means:

| Context | Largest batch that fits | Suggested |
|---|---|---|
| 4,096 | 15 | 12 |
| 8,192 | 46 | 35 |
| 16,384 | 106 | 75 |
| 32,768 | 228 | 100 |

The suggestion leaves room for long strings. Past about 100 entries the limit
is time rather than context: a local model gets slower per entry as a batch
grows.

What polyglots does about it:

- **Local review starts with batches of 12**, or your `batchSize` if that is
  smaller. `--batch-size` always wins.
- **Before a run it warns** when the batch is larger than the context it
  knows about, from your setting or from what the server reports. It never
  refuses to run.
- **A reply the server cut off** fails the batch with a message saying so. A
  failed batch is retried once and then marked unreviewed, and three failures
  in a row stop the run.

## Local review (experimental)

```
polyglots config set reviewProvider local
```

That command is the only way to turn it on. It is never the default, the menu
never selects it for you, and every run with it says it is experimental.

It is experimental because, measured against Claude on a real Turkish
submission with the same glossary and rules, a 27-billion-parameter local
model found none of the problems the rules missed and cleared twenty real
ones. It is here so that result can be checked again as local models
improve, not because it has changed.

How it differs from an agent:

- **No tools.** The glossary terms and memory wordings for each entry are
  written into the prompt instead of looked up.
- **The same checks.** Its answers are validated and repaired exactly like an
  agent's, so the output file, the requester message and the statistics work
  unchanged.
- **Its own cache.** Its verdicts are kept apart from claude's and
  antigravity's. To compare, review the same file once with each and compare
  the two `-repaired.po` files, counting only entries both runs judged.

`polyglots doctor` checks the local model in place of an agent, and exits 1
when the model is missing or the server is down.

## Troubleshooting

- **"openaiCompatible.model is not set"**: choose a model on the Local models
  screen, or `polyglots config set openaiCompatible.model <id>` with the id
  exactly as `polyglots models` shows it.
- **"The model is not installed" or "not served"**: pull it
  (`ollama pull …`) or load it in LM Studio. The run still starts, since the
  server's own error on the first batch is the one to trust.
- **A run fails at exactly five minutes**: something between polyglots and the
  server, such as a proxy, is buffering the response. polyglots streams every
  local request so this cannot happen on a direct connection.
