import type { CheckProgress, DownloadProgress } from '../commands/fetch.js'
import { describeChecked, describeDownload } from '../commands/fetch-report.js'
import type { FetchStatus } from '../wporg/projects.js'

/**
 * One line of the list while fetch checks it or downloads its export.
 *
 * Every line is on screen from the start, queued, so the length of the wait
 * is visible before it is spent, and the line being worked on is marked as
 * it starts. A single "Checking 30 projects..." over two minutes of requests,
 * or "Downloading..." over an export that takes several, read as a screen
 * that had hung.
 */
export interface ProgressRow {
  input: string
  state: 'queued' | 'working' | 'done'
  detail?: string
  // Ended without work: nothing in the chosen status, or no such project.
  dim?: true
  // Ended in a failure the person has to know about.
  warn?: true
}

export const queuedRows = (inputs: string[]): ProgressRow[] => inputs.map((input) => ({ input, state: 'queued' }))

// The first row for this input that has not ended. The same line given twice
// is two rows, and the engine works through them in order.
function update(rows: ProgressRow[], input: string, next: ProgressRow): ProgressRow[] {
  const at = rows.findIndex((r) => r.input === input && r.state !== 'done')
  return at === -1 ? rows : rows.map((r, i) => (i === at ? next : r))
}

export function checkRows(rows: ProgressRow[], e: CheckProgress, status: FetchStatus): ProgressRow[] {
  if (e.state === 'checking') return update(rows, e.input, { input: e.input, state: 'working' })
  // A plugin with nothing in its code can still bring a readme with work, and
  // that line is not one without work.
  const flag = e.results.some((r) => r.state === 'ready')
    ? {}
    : e.results.some((r) => r.state === 'unreachable')
      ? { warn: true as const }
      : { dim: true as const }
  return update(rows, e.input, { input: e.input, state: 'done', detail: describeChecked(e.results, status), ...flag })
}

export function downloadRows(rows: ProgressRow[], e: DownloadProgress): ProgressRow[] {
  if (e.state === 'downloading') return update(rows, e.input, { input: e.input, state: 'working' })
  const warn = e.result.state === 'failed' ? { warn: true as const } : {}
  return update(rows, e.input, { input: e.input, state: 'done', detail: describeDownload(e.result), ...warn })
}

export const progressCount = (rows: ProgressRow[]) => `${rows.filter((r) => r.state === 'done').length}/${rows.length}`
