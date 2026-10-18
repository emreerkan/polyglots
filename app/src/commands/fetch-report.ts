import { buildReport } from '../review/message.js'
import type { Locale, ReviewSummary } from '../types.js'
import type { FetchStatus } from '../wporg/projects.js'
import type { ProjectOutcome } from './batch.js'
import type { Resolution } from './fetch.js'
import type { TranslateSummary } from './translate.js'

export type BatchSummary = ReviewSummary | TranslateSummary

// How one line of input ended. Every line ends in exactly one of these, so the
// tally always adds up to the list that was given.
export interface ProjectEnd {
  tally: 'done' | 'failed' | 'skipped' | 'stopped'
  detail: string
  // The requester message of a finished review, when it repaired anything.
  message?: string
  // What a reply template needs from a finished review: the locale whose
  // templates fill it, and the counts its {zero|some} choice reads. Absent on
  // a stopped review, which gets no reply for the reason renderReply gives.
  review?: ReviewedEnd
  // Set when a provider refusal stopped this line: stopped, because no run
  // failed, but the command still did not do what was asked and needs the
  // person to sign in or wait, so the batch exits as an error does.
  refused?: true
}

export interface ReviewedEnd {
  locale: Locale
  repaired: number
  // needsReview plus unreviewed: what the run left for the reviewer.
  flagged: number
}

export type Tally = Record<ProjectEnd['tally'], number>

export function describeResolution(r: Resolution, status: FetchStatus): string {
  if (r.state === 'ready') {
    const where = r.type === 'wp-themes' ? 'theme' : `plugin ${r.branch ?? ''}`.trim()
    return `${where}, ${r.count} ${status}`
  }
  if (r.state === 'not-found') return 'not found'
  if (r.state === 'unreachable') return `could not check: ${r.reason}`
  return r.reason
}

/**
 * The end of a line that never reached a job: nothing to do, or no such project.
 * An outage is a failure to check rather than an absence, so it is never
 * skipped; the person has to know that line still has work behind it.
 */
export function endOfResolution(r: Resolution, status: FetchStatus): ProjectEnd | undefined {
  if (r.state === 'empty' || r.state === 'not-found') return { tally: 'skipped', detail: describeResolution(r, status) }
  if (r.state === 'unreachable') return { tally: 'failed', detail: describeResolution(r, status) }
  return undefined
}

export function endOfJob(outcome: ProjectOutcome<BatchSummary>, wporgUsername: string): ProjectEnd {
  if (outcome.state === 'failed') return { tally: 'failed', detail: outcome.reason }
  if (outcome.state === 'stopped') {
    return outcome.reason === undefined ? { tally: 'stopped', detail: 'not started' } : { tally: 'stopped', detail: outcome.reason, refused: true }
  }
  const s = outcome.summary
  if ('reviewed' in s) {
    const flagged = s.problems + s.needsReview
    const counts = `${s.reviewed} reviewed, ${flagged} flagged, ${s.repaired} repaired`
    // A review stopped part way returns normally with entries still pending.
    // Calling that done would read like a finished review in the table.
    if (s.pending > 0) return { tally: 'stopped', detail: `${counts}, ${s.pending} not reviewed yet` }
    const message = buildReport(s, wporgUsername)
    const written = s.problemsFile ? `, wrote ${s.problemsFile}` : ''
    return {
      tally: 'done',
      detail: `${counts}${written}`,
      ...(message ? { message } : {}),
      review: { locale: s.locale, repaired: s.repaired, flagged: s.needsReview + s.unreviewed },
    }
  }
  const fixed = s.fixedByRules === undefined ? '' : `, ${s.fixedByRules} fixed by locale rules`
  const counts = `${s.translated} translated, ${s.fuzzy} fuzzy, ${s.fromTm} from TM${fixed}`
  return s.stopped ? { tally: 'stopped', detail: `${counts}, stopped: ${s.stopped}` } : { tally: 'done', detail: counts }
}

// Said whenever wp.org refuses and the fetch backs off. A wait of up to two
// minutes with nothing on screen reads as a hang, and a hang gets killed.
export function waitNotice(ms: number): string {
  return `translate.wordpress.org asked to slow down; waiting ${Math.round(ms / 1000)}s before trying again.`
}

export function tallyOf(ends: ProjectEnd[]): Tally {
  const tally: Tally = { done: 0, failed: 0, skipped: 0, stopped: 0 }
  for (const end of ends) tally[end.tally] += 1
  return tally
}

export function tallyLine(t: Tally): string {
  return (
    `${t.done} done, ${t.failed} failed, ${t.skipped} skipped` +
    (t.stopped > 0 ? `, ${t.stopped} stopped. Run the same list again to carry on.` : '.')
  )
}
