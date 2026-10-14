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

## 3. Check it

```
polyglots doctor
```

`doctor` reads the settings file and the tool registration, without sending
a prompt. It names any rule that is missing, and a registered path to Node or
to polyglots that no longer exists. Then review a small file:

```
polyglots config set reviewProvider antigravity
polyglots review small-file.po
```

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
