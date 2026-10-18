import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentSpawnPlan, childEnv } from '../../src/agent/run.js'

describe('childEnv', () => {
  // The values a Claude Code session exported into this shell, as observed on
  // 2.1.x. Each one describes the parent session, so a nested claude that
  // inherits them believes it is part of that session.
  const markers = {
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SSE_PORT: '12345',
    CLAUDE_CODE_SESSION_ID: 'parent-session',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ATTENDED: '1',
    CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_x',
    CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/1.sock',
    CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
    CLAUDE_CODE_EXECPATH: '/opt/claude/versions/2.1.0',
    // Unprefixed, but set by the same code that sets CLAUDE_CODE_CHILD_SESSION
    // when claude builds a child's environment: its pid, that the caller is an
    // agent, and the effort level the parent turn ran at.
    CLAUDE_PID: '4242',
    AI_AGENT: 'claude-code_2-1-0_agent',
    CLAUDE_EFFORT: 'medium',
  }

  it('strips the markers that identify a parent Claude Code session', () => {
    const env = childEnv({ ...markers, PATH: '/p' })
    expect(env).toEqual({ PATH: '/p' })
  })

  it('passes through configuration that shares the CLAUDE_CODE_ prefix', () => {
    const config = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    }
    const env = childEnv({ ...markers, ...config, HOME: '/h' })
    expect(env).toEqual({ ...config, HOME: '/h' })
  })
})

// An npm-installed claude on Windows is claude.cmd, beside an extensionless sh
// shim of the same name. Spawned by its bare name, Node looks only for .com
// and .exe, and finds neither.
describe('agentSpawnPlan', () => {
  let bin: string
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'polyglots-agent-bin-'))
    writeFileSync(join(bin, 'claude'), '#!/bin/sh')
    writeFileSync(join(bin, 'claude.cmd'), '@echo off')
  })
  afterEach(() => rmSync(bin, { recursive: true, force: true }))

  it('runs claude.cmd through the shell on Windows', () => {
    const env = { PATH: bin, PATHEXT: '.com;.exe;.bat;.cmd' }
    expect(agentSpawnPlan('claude', ['-p', '--json-schema', '{"a":1}'], env, 'win32')).toEqual({
      file: `"${join(bin, 'claude.cmd')}" "-p" "--json-schema" "{""a"":1}"`,
      args: [],
      shell: true,
    })
  })
  // npm installs codex as codex.cmd too, so it takes the same shell path,
  // and is killed with taskkill /F the same way.
  it('runs codex.cmd through the shell on Windows', () => {
    writeFileSync(join(bin, 'codex.cmd'), '@echo off')
    const env = { PATH: bin, PATHEXT: '.com;.exe;.bat;.cmd' }
    const plan = agentSpawnPlan('codex', ['exec', '-c', 'web_search="disabled"', '-'], env, 'win32')
    expect(plan.shell).toBe(true)
    expect(plan.file.startsWith(`"${join(bin, 'codex.cmd')}" "exec"`)).toBe(true)
  })
  it('runs the bin as named elsewhere', () => {
    expect(agentSpawnPlan('claude', ['-p'], { PATH: bin }, 'darwin')).toEqual({ file: 'claude', args: ['-p'], shell: false })
  })
})
