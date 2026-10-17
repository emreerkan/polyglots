import { stateFromRules, type BuilderState } from '../../../../app/src/rules/emit.js';
import { RulesFileError, parseRulesText } from '../../../../app/src/rules/parse.js';

// A rules file pasted into the builder: an agent's answer, a colleague's file,
// one's own from disk. It goes through the parser rules check uses, so what
// loads is what polyglots would read, and a file it refuses loads nothing.
//
// Agents answer in a fenced code block, often with a sentence before it, and
// asking people to trim that off by hand is asking for a half-pasted file. The
// first fenced block is taken when there is one; otherwise the text is read
// as it is.
const FENCE = /```[^\n]*\n([\s\S]*?)```/;

export function stateFromPasted(text: string, wp: string): { state: BuilderState } | { error: string } {
  const body = FENCE.exec(text)?.[1] ?? text;
  if (body.trim() === '') return { error: 'The pasted text is empty.' };
  try {
    return { state: stateFromRules(parseRulesText(body, 'the pasted file'), wp) };
  } catch (err) {
    return { error: err instanceof RulesFileError || err instanceof Error ? err.message : String(err) };
  }
}
