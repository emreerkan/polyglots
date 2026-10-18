import { createContext, useContext, useState } from 'react'
import { defaultExec, discoverAgents } from '../agent/discover.js'
import { checkConfigured, type ProviderCheck } from '../agent/agy-check.js'
import { checkLocalModel, discoverModels } from '../draft/discover.js'
import { fetchProjects, resolveProjects } from '../commands/fetch.js'
import { syncGlossary } from '../commands/glossary-sync.js'
import { exportTm } from '../commands/tm-export.js'
import { importTmx } from '../commands/tm-import.js'
import { reviewFile } from '../commands/review.js'
import { planRulesFetch, writeRulesFetch } from '../commands/rules-fetch.js'
import { planTmFetch, runTmFetch } from '../commands/tm-fetch.js'
import { dataClient, type DataClient } from '../data/download.js'
import { splitPo } from '../commands/split.js'
import { writeStats } from '../commands/stats.js'
import { translateFile } from '../commands/translate.js'
import { openJobsDb } from '../jobs/db.js'
import { stopOwnRuns } from '../jobs/runs.js'
import { sendReport, type SendResult } from '../report/send.js'
import { DEFAULT_CONFIG, loadConfig, saveConfig, loadSecrets, saveSecret } from '../config.js'
import type { Locale, PolyglotsConfig, ReviewEvent, ReviewSummary } from '../types.js'
import { glossaryCount, hasLocaleRules, localeConfigured, memoryCount } from './setup.js'
import { loadTuiState, saveTuiState } from './state.js'
import { openInBrowser, startStatsServer, type StartStatsServer } from './stats-server.js'

export type ReviewFile = typeof reviewFile
export type ReviewFileOptions = Parameters<ReviewFile>[0]

export interface TuiCommands {
  translateFile: typeof translateFile
  importTmx: typeof importTmx
  exportTm: typeof exportTm
  syncGlossary: typeof syncGlossary
  reviewFile: typeof reviewFile
  splitPo: typeof splitPo
  writeStats: typeof writeStats
  resolveProjects: typeof resolveProjects
  fetchProjects: typeof fetchProjects
  loadConfig: typeof loadConfig
  saveConfig: typeof saveConfig
  loadSecrets: typeof loadSecrets
  saveSecret: typeof saveSecret
  discoverAgents: typeof discoverAgents
  discoverModels: typeof discoverModels
  checkLocalModel: typeof checkLocalModel
  loadTuiState: typeof loadTuiState
  saveTuiState: typeof saveTuiState
  glossaryCount: (locale: Locale) => number | undefined
  hasLocaleRules: typeof hasLocaleRules
  localeConfigured: typeof localeConfigured
  memoryCount: (locale: Locale) => number | undefined
  // polyglots-data: the manifest and verified downloads, and the two fetches
  // built on them. Handed in like every other command so the screens can be
  // driven without a socket, and so the website's TUI demos must fake them.
  dataClient: DataClient
  planRulesFetch: typeof planRulesFetch
  writeRulesFetch: typeof writeRulesFetch
  planTmFetch: typeof planTmFetch
  runTmFetch: typeof runTmFetch
  startStatsServer: StartStatsServer
  openInBrowser: typeof openInBrowser
  // Ends this process's in-flight runs as stopped; returns how many.
  stopOwnRuns: () => number
  // Asks the configured provider whether it can take a batch: antigravity's
  // sign-in and quota, codex's sign-in and model. The app calls it only while
  // one of the two is the provider, and reads the config fresh each time,
  // since the provider and codex's model can change while the app is open.
  checkProvider: () => Promise<ProviderCheck>
  // Posts an encoded problem report. Handed in so no test, and no website
  // demo, reaches the reports endpoint.
  sendReport: (body: Buffer) => Promise<SendResult>
}

export const defaultCommands: TuiCommands = {
  translateFile,
  importTmx,
  exportTm,
  syncGlossary,
  reviewFile,
  splitPo,
  writeStats,
  resolveProjects,
  fetchProjects,
  loadConfig,
  saveConfig,
  loadSecrets,
  saveSecret,
  discoverAgents,
  discoverModels,
  checkLocalModel,
  loadTuiState,
  saveTuiState,
  glossaryCount: (locale) => glossaryCount(locale),
  hasLocaleRules,
  localeConfigured,
  memoryCount: (locale) => memoryCount(locale),
  dataClient,
  planRulesFetch,
  writeRulesFetch,
  planTmFetch,
  runTmFetch,
  startStatsServer,
  openInBrowser,
  stopOwnRuns: () => {
    const db = openJobsDb()
    try {
      return stopOwnRuns(db)
    } finally {
      db.close()
    }
  },
  checkProvider: () => checkConfigured(defaultExec),
  sendReport: (body) => sendReport(fetch, body),
}

const CommandsContext = createContext<TuiCommands>(defaultCommands)

export const CommandsProvider = CommandsContext.Provider

export function useCommands(): TuiCommands {
  return useContext(CommandsContext)
}

export interface LoadedConfig {
  config: PolyglotsConfig
  error?: string
}

export function useConfig(): LoadedConfig {
  const commands = useCommands()
  const [loaded] = useState<LoadedConfig>(() => {
    try {
      return { config: commands.loadConfig() }
    } catch (err) {
      return { config: DEFAULT_CONFIG, error: errorMessage(err) }
    }
  })
  return loaded
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
