# Usage statistics

polyglots can share a few anonymous totals, so the website can say how much
it has been used. It is off unless you turn it on.

## What is asked

The last step of the setup wizard asks once: "Share anonymous totals (strings
reviewed, number of projects) to show on the website? You can change this any
time." The default answer is No. Leaving the step with `esc` also counts as
No.

## What is sent

At most once a week, one small JSON payload:

- `installId`: a random id made when you turn this on. It lets a weekly
  resend replace last week's numbers instead of adding to them. It is not
  derived from anything about you or your machine.
- `version`: the polyglots version.
- `reviewed`, `drafted`, `repaired`: all-time counts of strings reviewed,
  machine-drafted and repaired by finished runs.
- `projects`: how many different projects those runs covered. A number only.
- `findings`: how often each built-in check fired, for example
  `{"glossary": 12, "placeholder": 3}`. Only the fixed list of check names
  polyglots ships; custom rules are never named. Checks that run only for
  some locales (apostrophes, title case, ampersands, number formats) are sent
  as one `locale-rule` count, since their names would hint at the locale. So
are the AI reviewer's title-case findings, for the same reason. The checks
on the AI reviewer's own fixes (`fix-rejected`, `fix-suspect`) run for every
locale and are sent under their own names.

Never sent: your locale, project names or slugs, file names, source strings,
translations, your WordPress.org username, the review provider or the model.

To see exactly what the next send would contain:

```
polyglots usage-stats show
```

The interactive app shows the same preview under **Configuration › Usage
statistics**.

## How it is sent

In the background when a working command starts (`review`, `translate`, `fetch`,
`stats`, `tm`, `glossary`, `split`) or when the interactive app opens, with a
five-second timeout. `config`, `usage-stats` and `--help` never send. The send
runs alongside the command and never holds it up: if the command finishes first,
the send is simply abandoned, so short commands often send nothing. Failures are
dropped, nothing is queued, and after a failure it does not try again for a day.

## What is kept

The endpoint keeps only the latest payload per install id and when it
arrived. It does not store or log IP addresses. What is sent is decided by
`app/src/usage/payload.ts` in the polyglots repository, so you can read exactly
what leaves your machine.

The website shows all-time totals across installs, rounded down and described
as approximate. An install is counted only from its second report, a week
after its first, so a newly opted-in install appears on the site after about
a week. Nothing identifies who sends a report, which is what keeps it
anonymous, and it also means the totals cannot be verified.

## Turning it off

Any of these:

```
polyglots config set usageStats off
```

- In the interactive app: **Configuration › Usage statistics**, then `space`
  or `enter` on the sharing setting to toggle it.
- Set `DO_NOT_TRACK=1` in your environment. It turns sending off whatever the
  setting says.

Turning it off stops sending; the last totals already sent stay counted.
`polyglots usage-stats reset`, or `r` on the app's Usage statistics screen,
forgets the install id; if the setting is on, a
new id is made at the next send. The server cannot link the old id to the new
one, so your earlier totals stay counted under the old id.

Your install id and when it last sent are kept in `usage.json` in the
polyglots data directory (`~/.local/share/polyglots/` by default). It is
created only when the setting is on.

## Turning it on

```
polyglots config set usageStats on
```

## Problem reports

Separate from the totals above, and never sent without your choice. When a
review or translate run ends with a problem you can see in its output,
polyglots offers to send a report about it to the polyglots maintainer, who
gets an email and reads it. Neither the usage statistics setting nor
`DO_NOT_TRACK` changes this, in either direction: a report is never sent on
its own, so there is nothing for them to stop.

### When it is offered

Only after a run that had one of these:

- a batch given up after its retry: entries left unreviewed in a review, or
  skipped in a translate;
- a run that ended on an error;
- a run stopped because several batches in a row failed.

Not after a run you stopped yourself, not when the retry rescued a batch, and
not when antigravity's sign-in or quota check stopped a run before its first
batch. A batch of files gets one offer at the end, covering every file that
had a problem.

In the app, the offer is on the finished screen under the summary:

```
2 batches failed. Send a problem report to the polyglots maintainer?
s send · v see what is sent · esc no
```

On the command line, in a terminal, after the summary:

```
Send a problem report to the polyglots maintainer? [y/N/v]
```

`v` lists what the report holds, item by item with sizes, before anything leaves
your machine. Sending asks one optional line, "How can the maintainer reach
you?", filled in with your `wporgUsername` when it is set. To send without one,
clear the line in the app, or answer `-` on the command line. The answer is then
"Sent. Report 1a2b3c." with the id the maintainer sees, or the reason it was not
sent.

Without a terminal (CI, a pipe) nothing is asked and nothing is sent.
`--send-report` on `review`, `translate` or `fetch` is the choice made in
advance: when the run has a problem, the report is sent without asking and
without a contact line. Without a problem, nothing is sent.

### What a report holds

- the polyglots version, Node version and platform; the review provider, its
  version and model, the batch size and, for a batch of files, how many ran at
  once;
- for each run with a problem: its record from the run history (command, file
  path, project, locale, engine, start and end, counts), the reason for each
  failed batch attempt, its [run log](review.md#run-logs-and-debug-mode), and
  the lines of the tool-call log from the same time;
- when the run was in [debug mode](review.md#run-logs-and-debug-mode), its
  debug folder: the prompts, which hold the entries, and what the agent
  printed, but not the copies of agy's own log, which stay on your machine;
- the contact line, if you gave one.

Nothing else from your settings file is in it, and never your API keys or your
`.env` file. A key that appears anywhere in the report, such as quoted in a
prompt, is replaced with `[redacted]`: the DeepL and OpenAI keys of six
characters or more, and any other `.env` value of eight characters or more. Your
home folder in any path is written as `~`.

Outside debug mode, the one catalogue text a report can hold is in the
reasons for failed batches. A reason can quote the first few hundred
characters of what the agent printed, and when the agent's answer was cut
short or malformed, that is often the start of its verdicts, with source
strings and translations in them. Nothing else from the catalogue is in the
report, though the file path names the file. Press `v` at the offer to see
every part before it is sent.

A report is at most 1 MB compressed. When debug files make it larger, the
largest debug files are shortened from the end, and the report lists what was
shortened. A report that still does not fit is not sent: by then every debug
file is cut to nothing, and the run logs and MCP lines alone are over the limit.

### When it cannot be sent

Offline, a server error, or more reports than the server takes in an hour or
holds in all: the report is saved as `report-<start time>-run<id>.json.gz` in
the logs folder (`~/.local/share/polyglots/logs/` by default), named after the
first run it holds, and the message names the file. It is kept 14 days, like the
logs, and nothing sends it later by itself.

### What the maintainer keeps

The report as sent, when it arrived, the polyglots version, the platform, the
provider, a one-line summary of the problem and your contact line. No IP
address and no user agent. Reports are deleted after 90 days.

### Turning the offers off

```
polyglots config set problemReports never
```

- In the interactive app: **Configuration › Usage statistics**, then `↓` to
  **Offer problem reports** and `space` or `enter`.

`never` also stops `--send-report`. `polyglots config set problemReports ask`
brings the offers back. The first offer says how to turn them off.
