# Reviewing with antigravity

polyglots can use either Claude Code (`claude`) or the Antigravity CLI (`agy`)
as the agent that judges translations. Claude is the default and needs no
setup. Antigravity needs two things done once, described here, before it can
review.

When it is set up, switch to it from the menu, or:

```
polyglots config set reviewProvider antigravity
```

## Why antigravity needs setup

During a review the agent may look things up through three tools polyglots
provides: the glossary, your translation memory, and translate.wordpress.org's
consistency data. It may use nothing else: no shell, no files, no web.

Claude is told this on every run, so it needs nothing from you. Antigravity
reads its tools and its permissions from its own configuration, which
polyglots does not write for you. So you register the tools with it, and
allow them.

**Without this, a review still starts and fails every batch.** Each tool call
is denied, and the error polyglots reports quotes antigravity's message about
the missing permission.

## 1. Register the polyglots tools

Antigravity starts the tools from polyglots' installed files, so polyglots
must be installed (`npm install -g polyglots`) rather than run with npx.
Then:

```
agy mcp add --env POLYGLOTS_LOCALE=de polyglots \
  "$(command -v node)" \
  "$(npm root -g)/polyglots/dist/mcp/server.js"
```

- The options come before the name `polyglots`; `agy` rejects them after it.
- `POLYGLOTS_LOCALE` is the locale the lookups use. Antigravity has no way to
  pass it per run, so run the command again if you change locale. For the
  same reason, a review with Antigravity never takes its locale from the
  file's `Language` header: set `defaultLocale` or pass `--locale`.
- If you use a Node version manager (nvm, fnm, asdf), `command -v node` may
  print a path that only exists while that shell is open. Use the stable
  path of the Node installation instead; with fnm it is
  `~/.local/share/fnm/node-versions/<version>/installation/bin/node`.
- The registration keeps both paths as they were. If either stops existing,
  because Node was upgraded or removed, or polyglots was moved or installed
  somewhere else, run the command again. Antigravity says nothing when it
  cannot start the tools: every review runs without the glossary, the
  translation memory or the wordpress.org lookups, and some batches fail
  when the model tries a shell command in their place.

Check it with `agy mcp list`.

## 2. Allow the three tools

Antigravity refuses any tool it cannot ask you about, and a review runs
headless, where it can never ask. Add these rules to
`~/.gemini/antigravity-cli/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp(polyglots/glossary_lookup)",
      "mcp(polyglots/consistency_lookup)",
      "mcp(polyglots/tm_lookup)"
    ]
  }
}
```

Each tool must be named; a server-wide `mcp(polyglots)` does not work. A pattern such as
`mcp(polyglots/(glossary|consistency|tm)_lookup)` also works; each part is
matched as a whole regular expression.

**Allow these three and nothing more.** The text a review reads comes from
contributors, so the agent reading it must not be able to run commands or
write files. Antigravity occasionally asks for a shell anyway, to count the
entries it was given or to look around a directory. Being refused is the
right outcome, and a refused batch is retried. Do not add `command(...)`
rules to stop the refusals, and do not run antigravity with
`--dangerously-skip-permissions`: either hands a shell to a process reading
untrusted text.

### If you use `always-proceed`

The allow rules above only matter while antigravity asks before other tools.
With `"toolPermission": "always-proceed"` in the same file, it runs commands
and writes files without asking, during a review too, and a string in the
file under review can tell it to run one. `polyglots doctor` says so when
this is the case.

polyglots limits what that can do, but cannot stop it:

- Each call starts in an empty folder of its own, which is removed when the
  call ends. Files the agent writes there never reach the folder you
  reviewed in.
- Antigravity runs in its terminal sandbox (`--sandbox`). A command the
  sandbox refuses can still be run outside it on the model's request, and
  `always-proceed` grants that request without asking.

To block it, add deny rules. Deny rules apply in every mode:

```json
{
  "permissions": {
    "allow": [
      "mcp(polyglots/glossary_lookup)",
      "mcp(polyglots/consistency_lookup)",
      "mcp(polyglots/tm_lookup)"
    ],
    "deny": ["command(*)", "write_file(*)"]
  }
}
```

The file is antigravity's own, not one for polyglots alone, so these rules
also block commands and file writes in your own antigravity sessions. If
that is not what you want, set `toolPermission` back to `request-review`,
the default. A review needs nothing from it beyond the three allow rules.

## 3. Check it

```
polyglots doctor
```

`doctor` reads the settings file and the tool registration, without sending
a prompt. It names any rule that is missing, and a registered path to Node or
to polyglots that no longer exists. It also asks agy whether you are signed in
and prints the quota left in each group, as
`quota: <group> <n>% left (<limit>, resets <time>)`; see
[sign-in and quota](#sign-in-and-quota). Then review a small file:

```
polyglots config set reviewProvider antigravity
polyglots review small-file.po
```

## Sign-in and quota

A signed-out agy does not fail. Asked to review, it prints a Google sign-in
link and waits a minute for a code nobody types, and a review would do that
once for every attempt at every batch. A quota that has run out fails batches
with nothing on screen to say why. So before the first batch, polyglots asks
agy two things:

1. `agy models`, which never prompts, says whether you are signed in.
2. Only when it said yes, `agy -p /usage` gives the quota left in each group
   of models. It is never run otherwise, because signed out it is the command
   that starts the sign-in.

The quota is reported by group, not by model, so the model chosen in agy's
settings is matched to its groups: a Claude or GPT model to "Claude and GPT
models", a Gemini model to "Gemini Models" and to any group that names its
family, such as "Gemini 4 Argon". The lowest of those counts.

On the command line the check starts with `review`, `translate` or `fetch`,
beside reading the file, and the run waits for it at most 10 seconds before
the first batch. In the app it runs in the background when the app opens and
when you switch to antigravity, and the header shows the result, for example
`antigravity · Gemini 4 Argon · 90% weekly`, or
`signed out: run agy once to sign in`. A run started within 5 minutes of the
last check uses that result. After a batch is given up the quota is read
again, so the [run log](review.md#run-logs-and-debug-mode) says whether it
ran out part way.

What the messages mean:

- **`antigravity is signed out. Run agy once to sign in, then start again.`**
  Run `agy` with no arguments in a terminal and sign in. The run stopped
  before its first batch, so nothing was spent, and in a batch of files no
  further file was started. The exit code is 1.
- **`antigravity has no quota left for <model> (<group>: 0%, resets <time>).`**
  The run stopped before its first batch. Start it again after the reset
  time, or choose a model from another group in agy's settings.
- **`antigravity quota is low for <model>: <group> <n>% left.`** Below 10%.
  A warning only; the run goes on, and may still run out part way.
- **No message.** Either agy answered and all is well, or its answer could not
  be read: agy is missing, took longer than its time limit, or printed
  something this version of polyglots does not recognise. An answer that
  cannot be read never stops a run.

A run stopped by this check ends as stopped, not failed, so it is not counted
as a fault and offers no [problem report](usage-statistics.md#problem-reports).

## Good to know

- **The model is antigravity's.** Choose it in antigravity's own
  `settings.json`; polyglots reads that choice and records it with each
  verdict, so changing model or effort reviews again rather than reusing the
  previous model's verdicts.
- **Verdicts are kept per agent.** Switching between claude and antigravity
  reviews a file again. The two do not always agree, and each one's verdicts
  are kept separate.
- **Other tools you registered are visible to it.** Antigravity cannot be
  limited to one tool server per run, so any other server registered with it
  is also reachable during a review. Keep its list short.
- **Batch size.** Antigravity calls its tools one at a time, so small batches
  cost more round trips per entry. polyglots warns below 25.
