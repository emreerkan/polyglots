import { BUILT_IN_RULES, UNIVERSAL_RULES } from '../../../../app/src/rules/names.js';
import { CAPITALIZATION_LIMIT, GUIDANCE_LIMIT, REGISTER_LIMIT, localeRulesSchema } from '../../../../app/src/rules/schema.js';

// The prompt a person hands to their own AI agent to draft the rules file.
// Everything that a schema change could make wrong is read from the app's
// schema and rule list rather than written here: the keys, the rule names and
// the limits. A hand-written list would go stale the first time the schema
// moved, and the agent would write files that rules check refuses. What the
// prompt cannot carry in a few lines, the comments and examples of every
// section, it leaves to the template it points at, which the website renders
// from the same code at build time.

export interface AgentPromptInput {
  // The WordPress code, empty when no locale is picked yet.
  wp: string;
  language: string;
  templateUrl: string;
  builderUrl: string;
}

const n = (value: number) => value.toLocaleString('en-US');
const code = (items: readonly string[]) => items.map((i) => `\`${i}\``).join(', ');

export function agentPrompt({ wp, language, templateUrl, builderUrl }: AgentPromptInput): string {
  const keys = Object.keys(localeRulesSchema.shape);
  const optIn = BUILT_IN_RULES.filter((r) => !UNIVERSAL_RULES.includes(r));
  const file = wp ? `${wp}.yaml` : '<wp_code>.yaml';
  const target = wp
    ? `The file is for ${language ? `${language} (${wp})` : wp}.`
    : 'Ask me which WordPress locale the file is for (a code such as de_DE or pt_BR) before anything else.';

  return [
    'Help me write a rules file for polyglots, a tool that reviews and drafts WordPress translations. The file is YAML. It tells polyglots how my locale team translates, so its checks and its AI prompts follow our conventions.',
    '',
    target,
    '',
    'Steps:',
    `1. Fetch the template: ${templateUrl}`,
    '   It lists every section, with a comment and an example. If you cannot open web addresses, stop and ask me to paste the template.',
    "2. Before you write anything, ask me for my team's style guide and glossary, or for the conventions we follow: form of address, capitalization, punctuation, words we reject. Do not invent conventions. Leave out every section I give you nothing for.",
    '3. Write the file.',
    '',
    'Rules for the file:',
    '- The first line is `schema: 2`.',
    `- Use only these top-level keys: ${code(keys)}.`,
    `- \`rules.enable\` and \`rules.disable\` take only these names: ${code(BUILT_IN_RULES)}. On by default: ${code(UNIVERSAL_RULES)}. Off unless enabled: ${code(optIn)}.`,
    `- \`guidance\` is at most ${n(GUIDANCE_LIMIT)} characters, \`capitalization\` at most ${n(CAPITALIZATION_LIMIT)}, and each of \`register.audit\` and \`register.translate\` at most ${n(REGISTER_LIMIT)}.`,
    '- `formality` is `formal` or `informal`.',
    '- A `mistakes` entry has `wrong` (required), `right` and `note`.',
    '- A `patterns` entry has exactly one of `text` (literal) or `find` (regular expression), and `level`: `hint`, `error` or `fix`. A `fix` needs `replace`. It can also have `ignoreCase`, `when.source`, `when.notSource` and `note`.',
    '- Write `guidance`, `capitalization`, `register` and every `note` in English: a model reads them.',
    '- Regular expressions are JavaScript, compiled with the `u` flag. Keep them simple: polyglots skips a pattern that takes more than about 100 ms on one translation, so avoid nested quantifiers such as `(a+)+`.',
    '- Use `sentenceEnd` only for a script whose sentences do not end with a full stop.',
    '',
    `Answer with the whole file in one yaml code block, and nothing after it. I will paste it into the rules builder at ${builderUrl}, which checks it, and save it as ${file}.`,
  ].join('\n');
}
