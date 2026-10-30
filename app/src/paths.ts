import { homedir } from 'node:os'
import { join } from 'node:path'

function overrideRoot(): string | undefined {
  const value = process.env.POLYGLOTS_HOME
  return value && value.length > 0 ? value : undefined
}

export function configDir(): string {
  const root = overrideRoot()
  return root ? join(root, 'config') : join(homedir(), '.config', 'polyglots')
}

export function dataDir(): string {
  const root = overrideRoot()
  return root ? join(root, 'data') : join(homedir(), '.local', 'share', 'polyglots')
}

export function configFile(): string {
  return join(configDir(), 'config.json')
}

// The glossary editor's display preferences. Kept by the CLI rather than in
// the browser, because each run serves the page on a new port, and a new port
// is a new origin with empty storage.
export function glossaryEditorSettingsFile(): string {
  return join(configDir(), 'glossary-editor.json')
}

export function secretsFile(): string {
  return join(configDir(), '.env')
}

export function dbFile(): string {
  return join(dataDir(), 'polyglots.db')
}

// Where the stats server on the fixed port leaves its address, so a second
// polyglots can use that server instead of starting another.
export function statsServerFile(): string {
  return join(dataDir(), 'stats-server.json')
}

export function jobsDbFile(): string {
  return join(dataDir(), 'jobs.db')
}
