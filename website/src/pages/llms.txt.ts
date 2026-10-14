import type { APIRoute } from 'astro';
import { allDocs } from '../lib/docs';
import { SITE } from '../lib/agent-text';

// The llms.txt index (llmstxt.org): what polyglots is, and where the
// agent-readable material is. Served under /polyglots, which crawlers do not
// look for on their own; it is linked from /ai and the page heads.
export const GET: APIRoute = async () => {
  const base = `${SITE}/polyglots`;
  const docs = await allDocs();
  const lines = [
    '# polyglots',
    '',
    '> A command-line tool that reviews and translates WordPress .po files for translate.wordpress.org locale teams. Reviews check submitted strings with deterministic rules and an AI agent, and write out only the entries that need work, already repaired. Nothing is uploaded to translate.wordpress.org; review batches go to the chosen agent\'s model provider and drafts to DeepL or OpenAI, unless both run on a local model. For plugin and theme developers, polyglots lint checks source strings for what translators cannot fix, with no model and no account.',
    '',
    `Install: npm install -g polyglots (Node.js 24 or later). Agents should start with the runbook, which says what to run in which order and what to ask the person before running.`,
    '',
    '## For agents',
    '',
    `- [Agent runbook, plain text](${base}/ai.txt): the order of work, checkpoints, exit codes and the full command reference`,
    `- [Agent runbook, HTML](${base}/ai/): the same runbook for people`,
    '',
    '## Docs',
    '',
    ...docs.map((d) => `- [${d.title}](${base}/docs/${d.slug}/): ${d.description}`),
    `- [Command reference](${base}/docs/commands/): every command and option, from --help`,
    '',
  ];
  return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
