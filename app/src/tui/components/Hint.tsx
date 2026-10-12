import { Text } from 'ink'

export function Hint({ children }: { children: string }) {
  return <Text dimColor>{children}</Text>
}

export const BACK_HINT = 'esc/q back to menu'
export const DONE_HINT = 'enter/q back to menu'
// The done line of a review or translation, which can go on to the next file
// with the same choices as well as back to the menu.
export const RUN_DONE_HINT = 'a another file · enter/q back to menu'
