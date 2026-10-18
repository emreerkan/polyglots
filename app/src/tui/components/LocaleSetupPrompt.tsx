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

/** "a", "a or b", "a, b or c". */
function joinOr(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
}

export interface LocaleSetupPromptProps {
  locale: string
  missing: readonly SetupStep[]
  onYes: () => void
  onNo: () => void
}

/**
 * Asked once per locale, the first time the app changes to one with nothing
 * set up. Drawn over the screen like the quit prompt: the screen changed from
 * is where the person goes back to, whichever the answer.
 */
export function LocaleSetupPrompt({ locale, missing, onYes, onNo }: LocaleSetupPromptProps) {
  useKeys({ localeSetup: { yes: onYes, no: onNo } })
  const names = joinOr(missing.map((s) => NAMES[s] ?? s))
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} flexShrink={0}>
      <Text>
        {locale} has no {names} yet. Without them polyglots runs only the mechanical checks.
      </Text>
      <Text>
        Set them up now?{'  '}
        <Text {...TOKENS.accent.ink}>y</Text> set up <Text {...TOKENS.muted.ink}>·</Text> <Text {...TOKENS.accent.ink}>n</Text> not now
      </Text>
    </Box>
  )
}
