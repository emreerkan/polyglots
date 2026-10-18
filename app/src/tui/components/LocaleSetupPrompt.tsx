import { Box, Text } from 'ink'
import { TOKENS } from '../../ui/tokens.js'
import { useKeys } from '../hooks/useKeys.js'
import type { SetupStep } from '../state.js'

// Named as the person knows them from the wizard's titles, not by the short
// header labels: "rules" alone reads as polyglots' own rules, which every
// locale has, when what is missing is this locale's file of them.
const NAMES: Partial<Record<SetupStep, string>> = {
  glossary: 'glossary',
  memory: 'memory',
  rules: 'locale rules',
}

// What a review goes without while each step is missing. Named per step,
// because a blanket "only the mechanical checks" was untrue as soon as one of
// the two was there: with the glossary synced and no rules, the glossary
// checks still run.
const LOSSES: Partial<Record<SetupStep, string>> = {
  glossary: 'glossary term checks',
  memory: "the memory's earlier wordings",
  rules: "this locale's own checks",
}

/** "a", "a or b", "a, b or c"; with "and" for the things lost. */
function join(names: readonly string[], word: 'or' | 'and'): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} ${word} ${names.at(-1)}`
}

export interface LocaleSetupPromptProps {
  locale: string
  missing: readonly SetupStep[]
  onYes: () => void
  onNo: () => void
}

/**
 * Asked once per locale, the first time the app changes to one missing its
 * glossary or its locale rules. Drawn over the screen like the quit prompt:
 * the screen changed from is where the person goes back to, whichever the
 * answer.
 */
export function LocaleSetupPrompt({ locale, missing, onYes, onNo }: LocaleSetupPromptProps) {
  useKeys({ localeSetup: { yes: onYes, no: onNo } })
  const names = join(missing.map((s) => NAMES[s] ?? s), 'or')
  const losses = join(missing.flatMap((s) => LOSSES[s] ?? []), 'and')
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} flexShrink={0}>
      <Text>
        {locale} has no {names} yet.{losses === '' ? '' : ` Until then, reviews go without ${losses}.`}
      </Text>
      <Text>
        {missing.length === 1 ? 'Set it up now?' : 'Set them up now?'}
        {'  '}
        <Text {...TOKENS.accent.ink}>y</Text> set up <Text {...TOKENS.muted.ink}>·</Text> <Text {...TOKENS.accent.ink}>n</Text> not now
      </Text>
    </Box>
  )
}
