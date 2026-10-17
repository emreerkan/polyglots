import { renderDefaultRules, rulesHeader } from '../../../app/src/rules/defaults.js';

// The file rules edit writes for a new locale, made generic for the agent
// prompt to point at. It is the app's own template, rendered at build time,
// so it lists every section the version on this page reads and never falls
// behind the schema. Nothing in it depends on the locale today (there are no
// built-in packs), so one locale renders it and the two lines that name that
// locale are made generic; the test holds the rendering to leaving no trace
// of the locale used.
const ANY = 'tr';

export function rulesTemplate(): string {
  return renderDefaultRules(ANY)
    .replace(rulesHeader(ANY), '# polyglots rules for <wp_code>')
    .replace(`polyglots rules check ${ANY}`, 'polyglots rules check <wp_code>');
}
