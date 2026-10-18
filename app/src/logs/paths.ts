import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../paths.js'

export const LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000
// Only these names are ever deleted: the folder is ours, but a person may keep
// a note in it, and a prune that matched loosely would take that too.
const OURS = /^(\d{4}-\d{2}-\d{2}T[\d-]+Z-run\d+(\.jsonl)?|mcp-\d{4}-\d{2}-\d{2}\.jsonl|report-.+\.json\.gz)$/

export function logsDir(): string {
  return join(dataDir(), 'logs')
}

// The start time leads the name, not the run id alone: jobs.db is disposable,
// and once it is deleted run ids start again from 1. Colons and dots go because
// Windows and some archivers refuse them in a file name.
export function runLogStem(startedAt: number, runId: number): string {
  return `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}-run${runId}`
}

// One file per local day rather than per run: antigravity starts the MCP server
// from its one-time registration, with a fixed environment, so the server never
// learns which run it serves. The report joins its lines to a run by time and
// by the agent pid instead.
export function mcpLogPath(now: number = Date.now()): string {
  const d = new Date(now)
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return join(logsDir(), `mcp-${day}.jsonl`)
}

export function pruneLogs(now: number = Date.now()): void {
  let names: string[]
  try {
    names = readdirSync(logsDir())
  } catch {
    return
  }
  for (const name of names) {
    if (!OURS.test(name)) continue
    const path = join(logsDir(), name)
    try {
      if (now - statSync(path).mtimeMs > LOG_RETENTION_MS) rmSync(path, { recursive: true, force: true })
    } catch {
      // Gone already, or not ours to delete after all: the prune is housekeeping.
    }
  }
}
