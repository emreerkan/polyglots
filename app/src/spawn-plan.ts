import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * Where a binary would be run from, by scanning PATH the way the shell does.
 *
 * Not a `which` spawn: that would cost a process, behave differently from
 * shell to shell, and need a fake of its own. A bin naming a path is checked
 * as it stands. On win32 a name without an extension is tried only with the
 * PATHEXT suffixes, because `claude` is `claude.cmd` there, and npm puts an
 * extensionless sh shim of the same name beside it (Composer does the same
 * with wp and wp.bat). Windows cannot run the shim, and trying the bare name
 * first used to find it.
 */
export function findOnPath(bin: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | undefined {
  const exts =
    platform === 'win32' && !/\.[^\\/.]+$/.test(bin) ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  const sep = platform === 'win32' ? ';' : delimiter
  const executable = (path: string): boolean => {
    try {
      // X_OK alone is true for a directory that can be traversed.
      if (!statSync(path).isFile()) return false
      accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  if (bin.includes('/') || (platform === 'win32' && bin.includes('\\'))) {
    return exts.map((ext) => bin + ext).find(executable)
  }
  for (const dir of (env.PATH ?? '').split(sep)) {
    if (!dir) continue
    const found = exts.map((ext) => join(dir, bin + ext)).find(executable)
    if (found) return found
  }
  return undefined
}

// Node refuses to spawn a .bat or .cmd directly since the fix for
// CVE-2024-27980. wp on Windows is wp.bat, and an npm-installed claude is
// claude.cmd. Through the shell, every part is quoted, because a path can hold
// spaces, and the whole line is one string: Node 24 deprecates an args array
// beside shell: true (DEP0190), and would print a warning on every run.
//
// A quote inside a part is doubled. The program's own argument parser reads a
// doubled quote inside a quoted part as one quote, and cmd.exe, which toggles
// at every quote, sees each doubled pair as leaving and re-entering a quoted
// stretch with nothing between, so every character of the value stays quoted
// and & | < > in it are never acted on. That matters for claude's inline
// --json-schema.
//
// cmd.exe still expands %NAME% inside quotes when such a variable exists, and
// nothing escapes it in a command line. So a part a person names freely can go
// through a variable of its own: cmd.exe expands it once and does not expand
// what it held. A value carrying a quote must not go that way, since the quote
// would end the quoted stretch; a Windows path cannot hold one.
export interface SpawnPlan {
  file: string
  args: string[]
  shell: boolean
  env?: Record<string, string>
}

export function spawnPlan(
  cmd: string,
  args: readonly string[],
  platform: NodeJS.Platform,
  viaEnv?: { name: string; value: string },
): SpawnPlan {
  if (platform !== 'win32' || !/\.(bat|cmd)$/i.test(cmd)) return { file: cmd, args: [...args], shell: false }
  const quote = (s: string): string => `"${s.replace(/"/g, '""')}"`
  const parts = [cmd, ...args].map((part) => (viaEnv !== undefined && part === viaEnv.value ? `"%${viaEnv.name}%"` : quote(part)))
  return { file: parts.join(' '), args: [], shell: true, ...(viaEnv === undefined ? {} : { env: { [viaEnv.name]: viaEnv.value } }) }
}

// Through the shell, the child is cmd.exe and the program is its child.
// Killing cmd.exe leaves the program running and holding the pipes, so an
// agent given a batch would go on spending after polyglots gave up on it.
// taskkill /T ends the whole tree.
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  killer.on('error', () => {})
}
