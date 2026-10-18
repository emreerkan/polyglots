# Reviewing with codex

polyglots can use OpenAI's Codex CLI (`codex`) as the agent that judges
translations, next to Claude Code and the Antigravity CLI. Codex needs no
setup beyond installing it and signing in. polyglots hands it the lookup tools
on every run, so there is nothing to register and no settings file to edit.

```
npm install -g @openai/codex
codex login
polyglots config set reviewProvider codex
```

Codex bills against your ChatGPT plan, so that plan's limits apply. Check
that it is ready with `polyglots doctor`. It sends no prompt.

## What polyglots passes to codex

During a review the agent may look things up through three tools polyglots
provides: the glossary, your translation memory, and translate.wordpress.org's
consistency data. It may use nothing else. Every run starts `codex exec` with
these flags, and each one has a reason:

- **`--ignore-user-config`.** Your own `~/.codex/config.toml` is not loaded.
  It may carry plugins and other tool servers, and the text a review reads
  comes from contributors, so the agent reading it must not reach them. This
  keeps your sign-in. polyglots reads two keys from that file itself; see
  [model and effort](#model-and-effort).
- **The polyglots tools, approved for that server only.** Codex refuses a tool
  it cannot ask you about, and a review runs headless. Without the approval
  every lookup is denied and the verdicts come back without the glossary.
- **No shell and no other tools.** The shell, multi-agent, plugin, browser and
  computer tools are switched off with `--disable`.
- **`--sandbox read-only`.** A second lock, in case a tool is left on.
- **No web search.**
- **`--ephemeral`.** Codex keeps no session files for the run.

Because the tools go in with each run, the locale reaches them as it does for
Claude, and a review with codex takes its locale from the file's `Language`
header when you do not pass `--locale`.

## Model and effort

polyglots has no default codex model and no default effort. Each is resolved
on its own, first match wins:

1. `--model` on `translate`. `review` has no `--model` flag.
2. polyglots' setting `codex.model` or `codex.effort`.
3. The top-level `model` and `model_reasoning_effort` in
   `$CODEX_HOME/config.toml` (`~/.codex/config.toml` by default). polyglots
   reads those two keys and nothing else in the file.
4. Codex's own built-in default.

Which models you can use depends on your ChatGPT plan. To set them for
polyglots only:

```
polyglots config set codex.model <name>
polyglots config set codex.effort medium
polyglots config set codex.effort ''
```

Effort is `minimal`, `low`, `medium`, `high` or `xhigh`. An empty value
removes the override, and codex's own choice applies again. On the AI agents
screen of the app, `e` cycles the effort through those five and then back to
codex's own.

When you switch to codex, polyglots says which model and effort it will use
and where each came from. `doctor` prints the same line.

### Quality varies; compare before you trust it

The model and the effort change what codex catches, and not by a little. On
one 50-entry file, measured on 2026-10-18 with codex-cli 0.155.1 and a
ChatGPT sign-in:

- At `medium` effort on the default model, the review took 8 seconds and came
  back with every entry clean, no flags at all.
- At `high` it took 17 seconds and flagged one entry.
- A `low` run on another model flagged three entries, none of them the one
  `high` flagged.

Three runs, three different answers on the same entries. One run on one file
shows no ranking. Before you rely on a model and effort, review a file that
already has a human review and compare what each one caught. polyglots does
not recommend one.

Each verdict is stored with the engine that gave it, written as
`codex:<model> (<effort>)`. Changing the model or the effort therefore reviews
again instead of reusing the earlier verdicts.

## Sign-in and the model check

A signed-out codex fails, and a model your plan lacks fails every batch. So
before the first batch, polyglots asks two things:

1. `codex login status`. It is free and local. If you are signed out, the run
   stops before its first batch, so nothing is spent.
2. Only when you are signed in, one tiny `codex exec` with the run's model and
   effort. It is one small request on your plan.

What the results mean:

- **`codex is signed out. Run codex login, then start again.`** Sign in and
  start again. In a batch of files no further file is started. The exit code
  is 1.
- **`codex cannot use the model <model>: ...`** Your plan does not have that
  model. The run stops before its first batch. Choose another with
  `polyglots config set codex.model <name>`.
- **A rate-limit warning.** Your plan's limit is reached. The run goes on and
  may fail batches until it resets.
- **No message.** Either all is well, or the answer could not be read. An
  answer that cannot be read never stops a run.

The app re-uses an answer for five minutes. A run stopped by this check ends
as stopped, not failed, so it is not counted as a fault and offers no
[problem report](usage-statistics.md#problem-reports).

## Windows

Codex works on Windows. npm installs it as `codex.cmd`, and polyglots starts
and stops it the same way as the Antigravity CLI.

## Good to know

- **Verdicts are kept per agent.** Switching between claude, antigravity and
  codex reviews a file again. They do not always agree, and each one's
  verdicts are kept separate.
- **Usage.** Codex prints no quota that polyglots can read, so the app shows
  none for it.
- **Debug mode** keeps each batch's prompt and codex's output, as the
  [run log](review.md#run-logs-and-debug-mode) describes.
