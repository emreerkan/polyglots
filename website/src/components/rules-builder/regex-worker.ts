import type { RegexJob } from './match.js';

// Runs one regex job at a time for the tester. It lives in a worker for the
// same reason the app's sandbox does: a JavaScript regex cannot be stopped in
// the thread that runs it, so ^(a+)+$ over thirty a's and a b would freeze the
// page. The page terminates this worker when a job runs past the budget and
// starts a fresh one. evaluate() mirrors the app's (app/src/rules/sandbox.ts).

export type JobResult = { match: string | null } | { text: string };

function evaluate(job: RegexJob): JobResult {
  if (job.replace === undefined) {
    const text = job.normalise ? job.text.normalize('NFC') : job.text;
    const source = job.normalise ? job.source.normalize('NFC') : job.source;
    const m = new RegExp(source, job.flags).exec(text);
    return { match: m ? m[0] : null };
  }
  const re = new RegExp(job.source, job.flags);
  const tag = job.capitaliseTag;
  const replacement = job.replace;
  const text =
    tag === undefined
      ? job.text.replace(re, replacement)
      : job.text.replace(re, (m: string) => {
          const first = [...m][0];
          if (!first || first === first.toLocaleLowerCase(tag)) return replacement;
          const [head = '', ...rest] = [...replacement];
          return head.toLocaleUpperCase(tag) + rest.join('');
        });
  return { text };
}

const scope = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<{ id: number; job: RegexJob }>) => void) | null;
};

scope.onmessage = (event) => {
  const { id, job } = event.data;
  try {
    scope.postMessage({ id, result: evaluate(job) });
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};

// Said once the module has loaded, so a slow start is not charged to the
// first pattern's budget.
scope.postMessage({ ready: true });
