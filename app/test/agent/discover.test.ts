import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  discoverAgents,
  findOnPath,
  usableProviders,
  type AgentStatus,
  type ProbeExec,
  type ProbeResult,
} from '../../src/agent/discover.js'
import { configuredModel, MCP_TOOLS, resolveAgentBin } from '../../src/agent/providers.js'

// Everything here runs against a temp directory of fake executables and an env
// whose PATH is only that directory, plus a temp home. The real PATH, the real
// home and process.env are never read: a test that found the developer's own
// claude would pass or fail on what happens to be installed.

const RULES = MCP_TOOLS.map((t) => `mcp(${t.replace(/^mcp__/, '').replace('__', '/')})`)

let root: string
let binDir: string
let home: string
let env: NodeJS.ProcessEnv

function script(dir: string, name: string, body = 'echo fake', mode = 0o755): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, mode)
  return path
}

function agySettings(content: unknown): void {
  const dir = join(home, '.gemini', 'antigravity-cli')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), typeof content === 'string' ? content : JSON.stringify(content))
}

// Where `agy mcp add` registers servers: ~/.gemini/config, beside the CLI's
// own folder rather than inside it.
function agyMcp(content: unknown): void {
  const dir = join(home, '.gemini', 'config')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'mcp_config.json'), typeof content === 'string' ? content : JSON.stringify(content))
}

function agyServer(args: string[], extra: Record<string, unknown> = {}): unknown {
  return { mcpServers: { polyglots: { command: process.execPath, args, env: { POLYGLOTS_LOCALE: 'tr' }, ...extra } } }
}

function agyToken(): void {
  const dir = join(home, '.gemini', 'antigravity-cli')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'antigravity-oauth-token'), '{}')
}

interface Call {
  cmd: string
  args: string[]
  input?: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
}

type Handler = (args: string[], input: string | undefined) => Partial<ProbeResult> | undefined

// An exec that never spawns. It answers by the binary's basename and records
// every call, so a test can say what was and was not asked.
function fakeExec(handlers: Record<string, Handler> = {}): ProbeExec & { calls: Call[] } {
  const calls: Call[] = []
  const exec = (async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env, timeoutMs: opts.timeoutMs, ...(opts.input === undefined ? {} : { input: opts.input }) })
    const name = basename(cmd)
    const custom = handlers[name]?.(args, opts.input)
    const base: ProbeResult = { code: 0, stdout: '', stderr: '', timedOut: false }
    if (custom) return { ...base, ...custom }
    if (args[0] === '--version') return { ...base, stdout: `\n${name} 2.1.292 (fake)\nsecond line\n` }
    if (name === 'claude' && args[0] === 'auth') {
      return { ...base, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) }
    }
    return base
  }) as ProbeExec & { calls: Call[] }
  exec.calls = calls
  return exec
}

function statusOf(statuses: AgentStatus[], provider: string): AgentStatus {
  const found = statuses.find((s) => s.provider === provider)
  if (!found) throw new Error(`no status for ${provider}`)
  return found
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'polyglots-discover-'))
  binDir = join(root, 'bin')
  home = join(root, 'home')
  mkdirSync(binDir)
  mkdirSync(home)
  env = { PATH: binDir }
  script(binDir, 'claude')
  script(binDir, 'agy')
  agySettings({ model: 'Gemini 3.8 Flash (Medium)', permissions: { allow: RULES } })
  agyMcp(agyServer([script(root, 'server.js')]))
  agyToken()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const discover = (exec: ProbeExec, extra: Record<string, unknown> = {}) =>
  discoverAgents({ env, home, platform: 'darwin', exec, refresh: true, ...extra })

describe('findOnPath', () => {
  it('finds an executable on PATH', () => {
    expect(findOnPath('claude', env, 'darwin')).toBe(join(binDir, 'claude'))
  })

  it('skips a non-executable file of the same name', () => {
    const other = join(root, 'other')
    mkdirSync(other)
    script(other, 'tool', 'echo no', 0o644)
    script(binDir, 'tool')
    expect(findOnPath('tool', { PATH: `${other}:${binDir}` }, 'darwin')).toBe(join(binDir, 'tool'))
    expect(findOnPath('tool', { PATH: other }, 'darwin')).toBeUndefined()
  })

  it('honours an absolute bin without looking at PATH', () => {
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    const path = script(elsewhere, 'my-claude')
    expect(findOnPath(path, { PATH: '' }, 'darwin')).toBe(path)
    expect(findOnPath(join(elsewhere, 'missing'), env, 'darwin')).toBeUndefined()
  })

  // npm puts claude, a sh shim, beside claude.cmd, and Composer does the same
  // with wp and wp.bat. Only the PATHEXT file can be run on Windows.
  it('takes the PATHEXT file on Windows over the one with no extension', () => {
    writeFileSync(join(binDir, 'claude.cmd'), '@echo off')
    expect(findOnPath('claude', { PATH: binDir, PATHEXT: '.com;.exe;.bat;.cmd' }, 'win32')).toBe(join(binDir, 'claude.cmd'))
    expect(findOnPath(join(binDir, 'claude'), { PATHEXT: '.cmd' }, 'win32')).toBe(join(binDir, 'claude.cmd'))
    expect(findOnPath('claude.cmd', { PATH: binDir }, 'win32')).toBe(join(binDir, 'claude.cmd'))
  })

  it('returns undefined on a miss', () => {
    expect(findOnPath('gemini', env, 'darwin')).toBeUndefined()
    expect(findOnPath('claude', {}, 'darwin')).toBeUndefined()
  })
})

describe('resolveAgentBin', () => {
  it('applies POLYGLOTS_AGENT_BIN to both providers', () => {
    const e = { POLYGLOTS_AGENT_BIN: '/x/agent' }
    expect(resolveAgentBin('claude', e)).toEqual({ bin: '/x/agent', source: 'POLYGLOTS_AGENT_BIN' })
    expect(resolveAgentBin('antigravity', e)).toEqual({ bin: '/x/agent', source: 'POLYGLOTS_AGENT_BIN' })
  })

  // It used to win for antigravity too, which drove the claude binary with
  // antigravity's argv.
  it('applies POLYGLOTS_CLAUDE_BIN to claude only', () => {
    const e = { POLYGLOTS_CLAUDE_BIN: '/x/claude' }
    expect(resolveAgentBin('claude', e)).toEqual({ bin: '/x/claude', source: 'POLYGLOTS_CLAUDE_BIN' })
    expect(resolveAgentBin('antigravity', e)).toEqual({ bin: 'agy', source: 'default' })
  })

  it('prefers POLYGLOTS_AGENT_BIN over POLYGLOTS_CLAUDE_BIN', () => {
    const e = { POLYGLOTS_AGENT_BIN: '/x/agent', POLYGLOTS_CLAUDE_BIN: '/x/claude' }
    expect(resolveAgentBin('claude', e)).toEqual({ bin: '/x/agent', source: 'POLYGLOTS_AGENT_BIN' })
  })

  it('reports the default when neither is set, or either is empty', () => {
    expect(resolveAgentBin('claude', {})).toEqual({ bin: 'claude', source: 'default' })
    expect(resolveAgentBin('antigravity', { POLYGLOTS_AGENT_BIN: '' })).toEqual({ bin: 'agy', source: 'default' })
  })
})

describe('a binary that is not on PATH', () => {
  it('is unusable, says so, and is never spawned', async () => {
    rmSync(join(binDir, 'agy'))
    const exec = fakeExec()
    const agy = statusOf(await discover(exec), 'antigravity')
    expect(agy.usable).toBe(false)
    expect(agy.reason).toBe('agy not on PATH')
    expect(agy.path).toBeUndefined()
    expect(exec.calls.filter((c) => basename(c.cmd) === 'agy')).toEqual([])
  })

  it('names an override that points nowhere', async () => {
    env.POLYGLOTS_AGENT_BIN = '/x/y'
    const statuses = await discover(fakeExec())
    expect(statusOf(statuses, 'claude').reason).toBe('POLYGLOTS_AGENT_BIN=/x/y does not exist or is not executable')
    expect(statusOf(statuses, 'claude').binSource).toBe('POLYGLOTS_AGENT_BIN')
  })
})

describe('--version', () => {
  it('records the first non-empty line on exit 0', async () => {
    const claude = statusOf(await discover(fakeExec()), 'claude')
    expect(claude.version).toBe('claude 2.1.292 (fake)')
    expect(claude.path).toBe(join(binDir, 'claude'))
    expect(claude.usable).toBe(true)
  })

  it('is unusable on a non-zero exit', async () => {
    const exec = fakeExec({ claude: (args) => (args[0] === '--version' ? { code: 127 } : undefined) })
    const claude = statusOf(await discover(exec), 'claude')
    expect(claude.usable).toBe(false)
    expect(claude.reason).toBe('claude --version failed: exit 127')
  })

  it('is unusable when it hangs, without the test sleeping', async () => {
    const exec = fakeExec({ agy: (args) => (args[0] === '--version' ? { code: null, timedOut: true } : undefined) })
    const agy = statusOf(await discover(exec), 'antigravity')
    expect(agy.usable).toBe(false)
    expect(agy.reason).toBe('agy --version timed out after 5s')
    expect(exec.calls.find((c) => basename(c.cmd) === 'agy')?.timeoutMs).toBe(5000)
  })
})

describe('claude sign-in', () => {
  const auth = (result: Partial<ProbeResult>) =>
    fakeExec({ claude: (args) => (args[0] === 'auth' ? result : undefined) })

  it('reads loggedIn: true as signed in, with the method', async () => {
    const exec = fakeExec()
    const claude = statusOf(await discover(exec), 'claude')
    expect(claude.auth).toEqual({ state: 'signed-in', detail: 'claude.ai' })
    expect(exec.calls.some((c) => c.args.join(' ') === 'auth status --json')).toBe(true)
  })

  it('reads loggedIn: false as unusable, with the login hint', async () => {
    const claude = statusOf(await discover(auth({ stdout: '{"loggedIn":false}' })), 'claude')
    expect(claude.auth.state).toBe('signed-out')
    expect(claude.usable).toBe(false)
    expect(claude.reason).toBe('claude not logged in (run: claude auth login)')
  })

  // An older build without the subcommand prints usage, not JSON. That says
  // nothing about whether it is signed in, so it must not hide the provider.
  it('reads garbage as unknown, still usable, with a note', async () => {
    const claude = statusOf(await discover(auth({ code: 1, stdout: 'error: unknown command auth' })), 'claude')
    expect(claude.auth.state).toBe('unknown')
    expect(claude.usable).toBe(true)
    expect(claude.notes.join(' ')).toMatch(/sign-in/i)
  })

  it('reads loggedIn: false from stdout whatever the exit code', async () => {
    const claude = statusOf(await discover(auth({ code: 1, stdout: '{"loggedIn":false}' })), 'claude')
    expect(claude.auth.state).toBe('signed-out')
    expect(claude.usable).toBe(false)
  })
})

describe('antigravity sign-in and setup', () => {
  it('reads a present token file as signed in', async () => {
    const agy = statusOf(await discover(fakeExec()), 'antigravity')
    expect(agy.auth.state).toBe('signed-in')
    expect(agy.usable).toBe(true)
  })

  it('reads an absent token file as unknown, and stays usable', async () => {
    rmSync(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'))
    const agy = statusOf(await discover(fakeExec()), 'antigravity')
    expect(agy.auth.state).toBe('unknown')
    expect(agy.usable).toBe(true)
    expect(agy.notes.join(' ')).toMatch(/sign-in/i)
  })

  it('reports setup ok with all three rules', async () => {
    const agy = statusOf(await discover(fakeExec()), 'antigravity')
    expect(agy.setup.state).toBe('ok')
  })

  it('is unusable with a rule missing, and names it', async () => {
    agySettings({ permissions: { allow: [RULES[0], RULES[2]] } })
    const agy = statusOf(await discover(fakeExec()), 'antigravity')
    expect(agy.setup.state).toBe('missing')
    expect(agy.usable).toBe(false)
    expect(agy.reason).toContain(RULES[1])
    expect(agy.reason).not.toContain(RULES[0])
    expect(agy.reason).toContain('https://ada.tools/polyglots/docs/antigravity/')
  })

  // antigravity matches each token of a rule's target as an anchored regular
  // expression (notes/antigravity.md), so these all permit the three tools.
  // Whitespace inside a rule is deliberately not here: nothing says antigravity
  // trims it, and a check that passes a rule the CLI then ignores is the silent
  // failure this check exists to catch.
  it.each([
    ['one alternation', ['mcp(polyglots/(glossary|consistency|tm)_lookup)']],
    ['a wildcard tool', ['mcp(polyglots/.*_lookup)']],
    ['split across rules', ['mcp(polyglots/glossary_lookup)', 'mcp(polyglots/(consistency|tm)_lookup)']],
  ])('accepts an equivalent spelling: %s', async (_name, allow) => {
    agySettings({ permissions: { allow } })
    expect(statusOf(await discover(fakeExec()), 'antigravity').setup.state).toBe('ok')
  })

  it.each([
    ['server-wide, which antigravity does not honour', ['mcp(polyglots)']],
    ['a partial match, since tokens are anchored', ['mcp(polyglots/tm)', 'mcp(poly/.*)']],
    ['a pattern that covers only one', ['mcp(polyglots/tm_.*)']],
    ['a pattern that is not a valid expression', ['mcp(polyglots/(tm_lookup)']],
    ['another kind of rule', ['command(polyglots/tm_lookup)']],
  ])('still reports missing for %s', async (_name, allow) => {
    agySettings({ permissions: { allow } })
    expect(statusOf(await discover(fakeExec()), 'antigravity').setup.state).toBe('missing')
  })

  it('reads an unreadable settings file as setup unknown, and stays usable', async () => {
    agySettings('{ not json')
    const agy = statusOf(await discover(fakeExec()), 'antigravity')
    expect(agy.setup.state).toBe('unknown')
    expect(agy.usable).toBe(true)
  })

  // A moved or deleted checkout leaves the registration pointing at nothing.
  // agy starts without the tools and says nothing, every batch runs without
  // a glossary or memory lookup, and a model with nothing to call sometimes
  // reaches for a shell command, is denied, and returns no answer.
  it('is unusable when the registered server file does not exist, and names it', async () => {
    const gone = join(root, 'moved', 'dist', 'mcp', 'server.js')
    agyMcp(agyServer([gone]))
    const agy = statusOf(await discover(fakeExec()), 'antigravity')
    expect(agy.setup.state).toBe('missing')
    expect(agy.usable).toBe(false)
    expect(agy.reason).toContain(gone)
    expect(agy.reason).toContain('https://ada.tools/polyglots/docs/antigravity/')
  })

  it('is unusable when the registered command does not exist', async () => {
    agyMcp({ mcpServers: { polyglots: { command: join(root, 'old-node'), args: [script(root, 'server.js')] } } })
    const agy = statusOf(await discover(fakeExec()), 'antigravity')
    expect(agy.setup.state).toBe('missing')
    expect(agy.reason).toContain(join(root, 'old-node'))
  })

  it('is unusable when no polyglots server is registered, or it is disabled', async () => {
    agyMcp({ mcpServers: {} })
    expect(statusOf(await discover(fakeExec()), 'antigravity').reason).toMatch(/not registered/)
    agyMcp(agyServer([script(root, 'server.js')], { disabled: true }))
    expect(statusOf(await discover(fakeExec()), 'antigravity').reason).toMatch(/disabled/)
  })

  it('reads an unreadable MCP config as setup unknown, and stays usable', async () => {
    agyMcp('{ not json')
    const agy = statusOf(await discover(fakeExec()), 'antigravity')
    expect(agy.setup.state).toBe('unknown')
    expect(agy.usable).toBe(true)
  })

  it('names a missing rule and a missing server file together', async () => {
    agySettings({ permissions: { allow: [RULES[0]] } })
    agyMcp(agyServer([join(root, 'gone.js')]))
    const agy = statusOf(await discover(fakeExec()), 'antigravity')
    expect(agy.reason).toContain(join(root, 'gone.js'))
    expect(agy.reason).toContain(RULES[1])
  })

  it('has nothing to set up for claude', async () => {
    expect(statusOf(await discover(fakeExec()), 'claude').setup.state).toBe('ok')
  })
})

describe('the model shown', () => {
  it('is what configuredModel reads, so it matches the engine id', async () => {
    const statuses = await discover(fakeExec())
    expect(statusOf(statuses, 'antigravity').model).toBe(configuredModel('antigravity', home))
    expect(statusOf(statuses, 'antigravity').model).toBe('Gemini 3.8 Flash (Medium)')
    expect(statusOf(statuses, 'claude').model).toBeUndefined()
  })
})

describe('memoisation', () => {
  it('spawns once for two calls, again on refresh, and never caches a live run', async () => {
    const first = fakeExec()
    await discoverAgents({ env, home, platform: 'darwin', exec: first, refresh: true })
    const spawned = first.calls.length
    expect(spawned).toBeGreaterThan(0)

    const second = fakeExec()
    await discoverAgents({ env, home, platform: 'darwin', exec: second })
    expect(second.calls).toHaveLength(0)

    const refreshed = fakeExec()
    await discoverAgents({ env, home, platform: 'darwin', exec: refreshed, refresh: true })
    expect(refreshed.calls).toHaveLength(spawned)

    // Live neither reads the cache (it spawns) nor fills it (the next plain
    // call still sees the refreshed, non-live result).
    const live = fakeExec({ claude: (_a, input) => (input ? { stdout: '{"is_error":false,"result":"OK"}' } : undefined), agy: (_a, input) => (input ? { stdout: '{"status":"SUCCESS"}' } : undefined) })
    const liveResult = await discoverAgents({ env, home, platform: 'darwin', exec: live, live: true })
    expect(live.calls.length).toBeGreaterThan(spawned)
    // Only a usable provider is probed live; codex has no binary on this PATH.
    const usable = liveResult.filter((s) => s.usable)
    expect(usable.map((s) => s.provider)).toEqual(['claude', 'antigravity'])
    expect(usable.every((s) => s.live !== undefined)).toBe(true)

    const after = fakeExec()
    const cached = await discoverAgents({ env, home, platform: 'darwin', exec: after })
    expect(after.calls).toHaveLength(0)
    expect(cached.every((s) => s.live === undefined)).toBe(true)
  })
})

describe('no prompt by default', () => {
  it('never passes -p, --print or stdin across a full discovery', async () => {
    const exec = fakeExec()
    await discover(exec)
    expect(exec.calls.length).toBeGreaterThan(0)
    for (const call of exec.calls) {
      expect(call.args).not.toContain('-p')
      expect(call.args).not.toContain('--print')
      expect(call.input ?? '').toBe('')
    }
  })
})

describe('live probe', () => {
  const live = (claude: string, agy: string) =>
    fakeExec({
      claude: (_a, input) => (input ? { stdout: claude } : undefined),
      agy: (_a, input) => (input ? { stdout: agy } : undefined),
    })

  it('is ok when claude answers without is_error', async () => {
    const statuses = await discover(live('{"is_error":false,"result":"OK"}', '{"status":"SUCCESS"}'), { live: true })
    expect(statusOf(statuses, 'claude').live).toMatchObject({ ok: true })
    expect(statusOf(statuses, 'antigravity').live).toMatchObject({ ok: true })
  })

  it('is not ok when claude reports an error, and carries the message', async () => {
    const statuses = await discover(live('{"is_error":true,"result":"Credit balance is too low"}', '{"status":"SUCCESS"}'), { live: true })
    const claude = statusOf(statuses, 'claude').live
    expect(claude?.ok).toBe(false)
    expect(claude?.error).toContain('Credit balance is too low')
  })

  it('is not ok when antigravity reports a status other than SUCCESS', async () => {
    const statuses = await discover(live('{"is_error":false,"result":"OK"}', '{"status":"QUOTA","error":"out of quota"}'), { live: true })
    const agy = statusOf(statuses, 'antigravity').live
    expect(agy?.ok).toBe(false)
    expect(agy?.error).toContain('QUOTA')
  })

  it('measures the time with the injected clock', async () => {
    // Only one provider prompted, since the probes run in parallel and would
    // otherwise interleave their reads of the one clock.
    rmSync(join(binDir, 'agy'))
    let t = 1000
    const statuses = await discover(live('{"is_error":false,"result":"OK"}', '{"status":"SUCCESS"}'), {
      live: true,
      now: () => (t += 2100),
    })
    expect(statusOf(statuses, 'claude').live?.ms).toBe(2100)
  })

  it('never prompts an unusable provider', async () => {
    rmSync(join(binDir, 'agy'))
    const exec = live('{"is_error":false,"result":"OK"}', '{"status":"SUCCESS"}')
    const statuses = await discover(exec, { live: true })
    expect(statusOf(statuses, 'antigravity').live).toBeUndefined()
    expect(exec.calls.filter((c) => c.input !== undefined).map((c) => basename(c.cmd))).toEqual(['claude'])
  })
})

describe('the environment probes run in', () => {
  // A probe started from inside a Claude Code session must behave like the run
  // would, and the run strips these markers.
  it('passes childEnv, so CLAUDECODE never reaches a probe', async () => {
    env.CLAUDECODE = '1'
    const exec = fakeExec()
    await discover(exec)
    expect(exec.calls.length).toBeGreaterThan(0)
    for (const call of exec.calls) {
      expect(call.env.CLAUDECODE).toBeUndefined()
      expect(call.env.PATH).toBe(binDir)
    }
  })

  it('runs a real fake binary through the default exec', async () => {
    script(binDir, 'claude', 'if [ "$1" = "--version" ]; then echo "9.9.9 (Script)"; else echo \'{"loggedIn":true,"authMethod":"apiKey"}\'; fi')
    script(binDir, 'agy', 'echo "agy 1.0.0"')
    const statuses = await discoverAgents({ env, home, platform: 'darwin', refresh: true })
    expect(statusOf(statuses, 'claude').version).toBe('9.9.9 (Script)')
    expect(statusOf(statuses, 'claude').auth).toEqual({ state: 'signed-in', detail: 'apiKey' })
    expect(statusOf(statuses, 'antigravity').version).toBe('agy 1.0.0')
  })
})

describe('usableProviders and shared binaries', () => {
  it('lists only the usable providers, in PROVIDERS order', async () => {
    rmSync(join(binDir, 'agy'))
    expect(usableProviders(await discover(fakeExec()))).toEqual(['claude'])
  })

  // POLYGLOTS_AGENT_BIN is one variable for both, so one file ends up behind
  // two providers. Saying so beats letting both look independently ready.
  it('notes when one file stands behind both providers', async () => {
    env.POLYGLOTS_AGENT_BIN = join(binDir, 'claude')
    const statuses = await discover(fakeExec())
    expect(statusOf(statuses, 'antigravity').notes.join(' ')).toMatch(/same binary as claude/)
  })
})

// doctor asks agy itself, in the same two steps a run's check takes; the
// token file stays the quick answer for launch and the fallback when agy
// models cannot say.
describe('antigravity sign-in and quota, asked of agy', () => {
  const USAGE = 'Gemini Models\tGemini Weekly Limit\t90%\t2026-10-24T17:13:13Z'
  const agyCalls = (exec: ReturnType<typeof fakeExec>) => exec.calls.filter((c) => basename(c.cmd) === 'agy').map((c) => c.args)

  it('reads signed in from agy models, then the quota from /usage', async () => {
    const exec = fakeExec({ agy: (args) => (args[0] === '-p' ? { stdout: USAGE } : undefined) })
    const agy = statusOf(await discover(exec, { account: true }), 'antigravity')
    expect(agy.auth.state).toBe('signed-in')
    expect(agy.quota?.lines).toEqual([{ group: 'Gemini Models', limit: 'Gemini Weekly Limit', remaining: 90, resetsAt: '2026-10-24T17:13:13Z' }])
    expect(agyCalls(exec)).toContainEqual(['models'])
    expect(agyCalls(exec)).toContainEqual(['-p', '/usage'])
  })

  it('reads signed out from agy models, says how to sign in, and never runs /usage', async () => {
    const exec = fakeExec({
      agy: (args) => (args[0] === 'models' ? { code: 1, stderr: 'Error: Please sign in to view available models.' } : undefined),
    })
    const agy = statusOf(await discover(exec, { account: true }), 'antigravity')
    expect(agy.auth.state).toBe('signed-out')
    expect(agy.usable).toBe(false)
    expect(agy.reason).toContain('run agy once to sign in')
    expect(agyCalls(exec)).not.toContainEqual(['-p', '/usage'])
  })

  it('falls back to the token file when agy models cannot say', async () => {
    const exec = fakeExec({ agy: (args) => (args[0] === 'models' ? { code: 2, stderr: 'network down' } : undefined) })
    const agy = statusOf(await discover(exec, { account: true }), 'antigravity')
    expect(agy.auth.state).toBe('signed-in')
    expect(agy.quota).toBeUndefined()
  })

  it('never runs agy models without being asked to', async () => {
    const exec = fakeExec()
    await discover(exec)
    expect(agyCalls(exec)).not.toContainEqual(['models'])
  })
})
