import { PROBES, probedRegexes, runawayReason } from '../../../../app/src/rules/probes.js';
import type { LocaleRules } from '../../../../app/src/rules/schema.js';
import type { RegexJob } from './match.js';
import { PATTERN_BUDGET_MS, RegexRunner, type Outcome } from './tester.js';

// rules check runs every regex in a file over PROBES and refuses one that
// runs past the budget. The page's install line tells the person to run rules
// check, so a page that called the file valid on the parser's word alone sent
// them to a refusal. The same strings run here, through the same kind of
// terminable worker the tester uses, before the page says Valid or lets the
// file be sent. The runner is passed in so this half is tested without a
// browser.

/**
 * Why rules check would refuse the file's regexes, or undefined when it would
 * not. `passed` remembers the regexes that already came through, so typing in
 * one row does not re-run every other row's probes on each refresh; a runaway
 * needs no such memory, since the runner remembers those itself.
 */
export async function probeProblem(
  rules: LocaleRules,
  run: (job: RegexJob) => Promise<Outcome>,
  passed: Set<string> = new Set(),
): Promise<string | undefined> {
  for (const regex of probedRegexes(rules)) {
    const key = RegexRunner.key(regex);
    if (passed.has(key)) continue;
    for (const text of PROBES) {
      // A run that throws, such as a Worker constructor refused by the
      // page's policy, has tested nothing, like a worker that never started.
      // Let through, it rejected the page's probe with nobody to catch it,
      // and the page sat on "Checking" with a Send that did nothing.
      let outcome: Outcome;
      try {
        outcome = await run({ source: regex.source, flags: regex.flags, text });
      } catch (err) {
        outcome = { error: err instanceof Error ? err.message : String(err) };
      }
      if ('runaway' in outcome) return `${runawayReason(regex.at, PATTERN_BUDGET_MS)}: “${regex.source}”`;
      // The worker would not start, so nothing was tested. Saying Valid here
      // is the claim this check exists to stop making.
      if ('error' in outcome) return `the regular expressions could not be tested in this browser (${outcome.error}); run polyglots rules check on the downloaded file`;
    }
    passed.add(key);
  }
  return undefined;
}
