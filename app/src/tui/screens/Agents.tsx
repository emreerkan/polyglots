import { useState } from 'react'
import { Box, Text } from 'ink'
import type { AgentStatus } from '../../agent/discover.js'
import { agentModel, codexChoiceText } from '../../agent/providers.js'
import { CODEX_EFFORTS, DEFAULT_CONFIG } from '../../config.js'
import type { PolyglotsConfig } from '../../types.js'
import { errorMessage, useCommands } from '../commands.js'
import { Hint } from '../components/Hint.js'
import { useBackKeys } from '../hooks/useBackKeys.js'
import { useKeys } from '../hooks/useKeys.js'

export interface AgentsProps {
  agents?: AgentStatus[]
  checking: boolean
  error?: string
  // Re-runs discovery with refresh. Held by the caller, so the menu sees the
  // same answer this screen does.
  onRecheck: () => void
  onBack: () => void
}

function signIn(status: AgentStatus): string {
  const { state, detail } = status.auth
  if (state === 'signed-in') return detail ? `signed in (${detail})` : 'signed in'
  if (state === 'signed-out') return 'signed out'
  return detail ? `unknown (${detail})` : 'unknown'
}

function setup(status: AgentStatus): string {
  const { state, detail } = status.setup
  if (state === 'ok') return 'ok'
  return detail ? `${state} (${detail})` : state
}

/**
 * What discovery found, one block per provider.
 *
 * No live probe here, deliberately. A key press in a menu must never be able
 * to spend a request; that check is `polyglots doctor --live`, typed on
 * purpose.
 */
export function Agents({ agents, checking, error, onRecheck, onBack }: AgentsProps) {
  const commands = useCommands()
  // Here rather than in Interface settings, which hold what only the app
  // reads: the CLI reads this key too, and this is the screen about what the
  // agents do. Read fresh, so a config set debug typed since is what shows.
  const [debug, setDebug] = useState(() => {
    try {
      return commands.loadConfig().debug === true
    } catch {
      return false
    }
  })
  const [saveError, setSaveError] = useState<string>()
  // Held in state so the line re-renders after a save; the config on disk is
  // still the one place it is read from.
  const [config, setConfig] = useState<PolyglotsConfig>(() => {
    try {
      return commands.loadConfig()
    } catch {
      return DEFAULT_CONFIG
    }
  })
  useBackKeys(onBack)
  useKeys({
    agents: {
      recheck: checking ? undefined : onRecheck,
      debug: () => {
        try {
          setDebug(commands.saveConfig({ debug: !debug }).debug === true)
          setSaveError(undefined)
        } catch (err) {
          setSaveError(errorMessage(err))
        }
      },
      effort: () => {
        // The five values in order, then the key is removed, which hands the
        // choice back to codex's own config. Cycled from what polyglots config
        // holds, not from what resolved: a press must move this setting, and
        // an effort codex's config.toml supplies is not ours to step from.
        const own = config.codex ?? {}
        const at = own.effort === undefined ? -1 : CODEX_EFFORTS.indexOf(own.effort)
        const next = CODEX_EFFORTS[at + 1]
        const { effort: _previous, ...rest } = own
        try {
          setConfig(commands.saveConfig({ codex: next === undefined ? rest : { ...rest, effort: next } }))
          setSaveError(undefined)
        } catch (err) {
          setSaveError(errorMessage(err))
        }
      },
    },
  })
  const codexText = codexChoiceText(agentModel('codex', config))
  return (
    <Box flexDirection="column">
      <Text bold>AI agents</Text>
      {checking && <Text dimColor>Checking agents…</Text>}
      {error && <Text color="red">Could not check agents: {error}</Text>}
      {(agents ?? []).map((a) => (
        <Box key={a.provider} flexDirection="column" marginTop={1}>
          <Text>
            <Text bold>{a.provider}</Text> <Text color={a.usable ? 'green' : 'yellow'}>{a.usable ? 'ready' : 'unavailable'}</Text>
          </Text>
          {!a.usable && a.reason && <Text color="yellow">  {a.reason}</Text>}
          <Text>
            {'  '}Binary: {a.path ?? a.bin}
            {a.binSource === 'default' ? '' : ` (from ${a.binSource})`}
          </Text>
          {a.version && <Text>  Version: {a.version}</Text>}
          <Text>  Sign-in: {signIn(a)}</Text>
          <Text>  Setup: {setup(a)}</Text>
          <Text>  Model: {a.model ?? (a.provider === 'claude' ? 'not exposed' : 'not set')}</Text>
          {a.notes.map((note) => (
            <Text key={note} dimColor>
              {'  '}note: {note}
            </Text>
          ))}
        </Box>
      ))}
      <Box marginTop={1} flexDirection="column">
        <Text>
          Debug mode: <Text color={debug ? 'yellow' : undefined}>{debug ? 'on' : 'off'}</Text>
        </Text>
        <Text dimColor>
          {debug
            ? '  Each batch\'s prompt and agent output are saved beside each run log, catalogue text included.'
            : '  When on, each batch\'s prompt and agent output are saved beside the run log, to find out why a batch failed.'}
        </Text>
        <Text>
          Codex: {codexText.model}, effort {codexText.effort}
        </Text>
        {saveError && <Text color="red">Could not save that: {saveError}</Text>}
      </Box>
      <Box marginTop={1}>
        <Hint>r re-check · d debug mode · e codex effort · esc/q back to menu</Hint>
      </Box>
    </Box>
  )
}
