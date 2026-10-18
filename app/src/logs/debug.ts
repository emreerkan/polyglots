import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Whether a run keeps its prompts and agent output beside the run log.
 *
 * Three ways on and one way off. The flag is for the one run being looked at,
 * the variable for a shell session spent chasing a problem, and the config key
 * for the app, which has no flags. Only the exact value 1 counts for the
 * variable, so POLYGLOTS_DEBUG=0 left in a profile reads as off rather than
 * as a set variable.
 */
export function debugEnabled(opts: { flag?: boolean; config: { debug?: boolean }; env?: NodeJS.ProcessEnv }): boolean {
  return opts.flag === true || opts.env?.POLYGLOTS_DEBUG === '1' || opts.config.debug === true
}

const AGY_LOG = /^cli-(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.log$/

/** The name agy gives a log it starts at `ms`: local time, to the second. */
export function agyLogName(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `cli-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.log`
}

/**
 * agy's own logs for one call: those whose name says they started between two
 * seconds before it and its end.
 *
 * Matched by the time in the name rather than by mtime, which moves for as
 * long as agy keeps writing, so a log from an earlier hung call would match
 * every call after it. The two seconds cover agy naming its log after its own
 * start, which can fall in the second before ours was read, rounded down to
 * the whole second the name holds. Two calls running at once each get both of
 * their logs; nothing in the name says which process wrote it, and a copy too
 * many is cheaper than a missing one.
 */
export function agyLogsBetween(from: number, to: number, home: string = homedir()): string[] {
  const dir = join(home, '.gemini', 'antigravity-cli', 'log')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const earliest = Math.floor((from - 2_000) / 1_000) * 1_000
  const found: string[] = []
  for (const name of names) {
    const m = AGY_LOG.exec(name)
    if (!m) continue
    const [, y, mo, d, h, mi, s] = m.map(Number) as [number, number, number, number, number, number, number]
    const at = new Date(y, mo - 1, d, h, mi, s).getTime()
    if (at >= earliest && at <= to) found.push(join(dir, name))
  }
  return found.sort()
}
