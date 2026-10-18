import { formatBytes } from '../commands/tm-fetch.js'
import { openJobsDb } from '../jobs/db.js'
import { summarize, type Report } from '../report/build.js'
import { boundedVersion, buildFor, contactLine, cutLine, deliverReport, deliveryLine, type ReportFacts } from '../report/offer.js'
import { markOfferHintShown, offerHintDue, problemRuns, shouldOffer, type SendResult } from '../report/send.js'
import type { PolyglotsConfig } from '../types.js'
import { table } from '../ui/layout.js'
import { hintLine, okLine, warnLine } from '../ui/messages.js'
import type { Painter } from '../ui/paint.js'

export type { SendResult }

export const OFFER_QUESTION = 'Send a problem report to the polyglots maintainer? [y/N/v] '
export const OFFER_HINT = 'Turn these offers off with: polyglots config set problemReports never'

/** What the offer needs from the command line. */
export interface OfferCli {
  config: () => PolyglotsConfig
  sendReport: (body: Buffer) => Promise<SendResult>
  // The provider's --version line, or undefined; held to VERSION_WAIT_MS here.
  providerVersion: (provider: string) => Promise<string | undefined>
  // A question on stderr, answered on stdin; undefined when the input closed.
  ask: (question: string) => Promise<string | undefined>
  ui: { err: Painter }
  err(line: string): void
}

/** What the report says about the command that ran, beside the runs themselves. */
export interface ReportContext extends ReportFacts {
  // --send-report: the person's yes, given before the run.
  sendWithoutAsking: boolean
  // stdin and stderr both terminals: someone is there to answer.
  interactive: boolean
}

/**
 * After a run: when any of `runIds` had a problem, asks whether to send a
 * report (on a terminal), or sends it unasked (under --send-report), or does
 * nothing. Everything goes to stderr, beside the question, so stdout stays
 * the summary and the requester message a script may be reading.
 *
 * jobs.db is opened only once there is a run to look at and someone or
 * something to act on the answer: a pipe without --send-report, or a person
 * who said never, costs nothing at all.
 */
export async function offerProblemReport(cli: OfferCli, runIds: number[], ctx: ReportContext): Promise<void> {
  if (runIds.length === 0) return
  const config = cli.config()
  if (config.problemReports === 'never') return
  if (!ctx.interactive && !ctx.sendWithoutAsking) return
  const jobs = openJobsDb()
  try {
    const problems = problemRuns(jobs, runIds)
    if (!shouldOffer(config, problems)) return
    // Asked the first time a report is built (v, y or --send-report) and
    // reused after. It used to start beside the question, so the answer was
    // in hand by the time the person had typed theirs; but a no then left a
    // --version spawn running, and the process alive, for up to the bounded
    // wait after the person had said they wanted nothing. A yes now waits
    // for it instead, which is at most that same wait and usually well
    // under a second. A binary that hangs still costs only the bounded wait,
    // never the report.
    let version: Promise<string | undefined> | undefined
    const build = async (contact?: string): Promise<Report> => {
      const known = await (version ??= boundedVersion(Promise.resolve().then(() => cli.providerVersion(ctx.provider))))
      return buildFor(jobs, problems, { ...ctx, ...(known === undefined ? {} : { version: known }) }, contact)
    }
    // Asked for in advance, so asked for nothing now, the contact line
    // included: a scheduled run has nobody to type one.
    if (ctx.sendWithoutAsking) {
      await send(cli, await build())
      return
    }
    cli.err('')
    const hint = offerHintDue()
    try {
      const contact = await askToSend(cli, build)
      if (contact !== false) await send(cli, await build(contact))
    } finally {
      if (hint) {
        cli.err(hintLine(cli.ui.err, OFFER_HINT))
        markOfferHintShown()
      }
    }
  } finally {
    jobs.close()
  }
}

// false for no; otherwise the contact line to send, undefined for none.
async function askToSend(cli: OfferCli, build: () => Promise<Report>): Promise<string | undefined | false> {
  for (;;) {
    const answer = (await cli.ask(OFFER_QUESTION))?.trim()
    if (answer === undefined || !/^(y(es)?|v)$/i.test(answer)) return false
    if (/^v$/i.test(answer)) {
      // Built here, without the contact line, so the list is what leaves the
      // machine before anything does; the line typed next is added on top.
      const rows = summarize(await build()).map((item) => [item.name, formatBytes(item.bytes)])
      for (const line of table(rows, { indent: 2 })) cli.err(line)
      continue
    }
    const known = cli.config().wporgUsername.trim()
    const typed = await cli.ask(`How can the maintainer reach you? (optional) ${known ? `[${known}] ` : ''}`)
    // Ctrl-D at the second question is a change of mind, not an empty answer.
    if (typed === undefined) return false
    const line = typed.trim()
    if (line === '-') return undefined
    return contactLine(line === '' ? known : line)
  }
}

async function send(cli: OfferCli, report: Report): Promise<void> {
  const delivery = await deliverReport(report, cli.sendReport)
  const cut = cutLine(delivery)
  if (cut !== undefined) cli.err(hintLine(cli.ui.err, cut))
  const line = deliveryLine(delivery)
  cli.err(delivery.state === 'sent' ? okLine(cli.ui.err, line) : warnLine(cli.ui.err, line))
}
