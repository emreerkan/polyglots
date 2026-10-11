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

In the background when a working command starts (`review`, `translate`,
`fetch`, `stats`, `tm`, `glossary`, `split`) or when the interactive app
opens, with a five-second timeout. `config`, `usage-stats` and `--help` never
send. The send runs alongside the command and never holds it up: if the
command finishes first, the send is simply abandoned, so short commands
often send nothing. Failures are dropped, nothing is queued, and after a failure it
does not try again for a day.

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
  or `enter` to toggle.
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
