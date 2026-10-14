import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LintNotStarted } from './errors.js'
import { RULE_IDS, type Level, type RuleId } from './rules.js'

export type RuleSetting = 'off' | Level

export interface IgnoreEntry {
  // Omitted: every warning on the string.
  rule?: RuleId
  msgid: string
  // Omitted: the string in any context.
  msgctxt?: string
}

export interface LintConfig {
  rules: Partial<Record<RuleId, RuleSetting>>
  ignore: IgnoreEntry[]
}

export const EMPTY_CONFIG: LintConfig = { rules: {}, ignore: [] }
export const CONFIG_FILE = '.polyglots-lint.json'

const SETTINGS: readonly string[] = ['off', 'warning', 'error']
const isRuleId = (value: unknown): value is RuleId => typeof value === 'string' && (RULE_IDS as readonly string[]).includes(value)
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Strict on purpose. A misspelt rule id or key would otherwise switch nothing
// off and say nothing, and the developer would believe the warning silenced.
export function parseConfig(text: string, file: string): LintConfig {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new LintNotStarted(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const fail = (problem: string): never => {
    throw new LintNotStarted(`${file}: ${problem}`)
  }
  if (!isObject(data)) return fail('must be a JSON object')
  for (const key of Object.keys(data)) {
    if (key !== 'rules' && key !== 'ignore') fail(`unknown key "${key}"; the keys are rules and ignore`)
  }
  const rules: LintConfig['rules'] = {}
  if (data.rules !== undefined) {
    if (!isObject(data.rules)) fail('rules must be an object')
    for (const [id, setting] of Object.entries(data.rules as Record<string, unknown>)) {
      if (!isRuleId(id)) fail(`unknown rule "${id}" in rules`)
      if (typeof setting !== 'string' || !SETTINGS.includes(setting)) fail(`rules.${id} must be "off", "warning" or "error"`)
      rules[id as RuleId] = setting as RuleSetting
    }
  }
  const ignore: IgnoreEntry[] = []
  if (data.ignore !== undefined) {
    if (!Array.isArray(data.ignore)) fail('ignore must be an array')
    ;(data.ignore as unknown[]).forEach((entry, i) => {
      if (!isObject(entry)) return fail(`ignore[${i}] must be an object`)
      for (const key of Object.keys(entry)) {
        if (key !== 'rule' && key !== 'msgid' && key !== 'msgctxt') fail(`unknown key "${key}" in ignore[${i}]; the keys are rule, msgid and msgctxt`)
      }
      if (typeof entry.msgid !== 'string') fail(`ignore[${i}].msgid must be a string`)
      if (entry.rule !== undefined && !isRuleId(entry.rule)) fail(`unknown rule "${String(entry.rule)}" in ignore[${i}]`)
      if (entry.msgctxt !== undefined && typeof entry.msgctxt !== 'string') fail(`ignore[${i}].msgctxt must be a string`)
      ignore.push({
        msgid: entry.msgid as string,
        ...(entry.rule === undefined ? {} : { rule: entry.rule as RuleId }),
        ...(entry.msgctxt === undefined ? {} : { msgctxt: entry.msgctxt as string }),
      })
    })
  }
  return { rules, ignore }
}

// An explicit --config must exist. Searched folders without the file are
// fine: no settings file is the ordinary case.
export async function findConfig(dirs: readonly string[], explicit?: string): Promise<{ file?: string; config: LintConfig }> {
  if (explicit !== undefined) {
    let text: string
    try {
      text = await readFile(explicit, 'utf8')
    } catch (err) {
      throw new LintNotStarted(`Could not read --config ${explicit}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return { file: explicit, config: parseConfig(text, explicit) }
  }
  for (const dir of dirs) {
    const file = join(dir, CONFIG_FILE)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    return { file, config: parseConfig(text, file) }
  }
  return { config: EMPTY_CONFIG }
}
