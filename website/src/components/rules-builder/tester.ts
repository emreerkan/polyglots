import type { RegexJob } from './match.js';
import type { JobResult } from './regex-worker.js';

// The app's budget per pattern per text (PATTERN_BUDGET_MS in
// app/src/rules/sandbox.ts). Repeated rather than imported: that module starts
// Node worker threads and cannot be bundled for a browser, and the number is
// part of the rules contract, not something either side tunes alone.
export const PATTERN_BUDGET_MS = 100;
// A worker that has not loaded yet has run nobody's pattern, so its start is
// given its own, generous allowance, as the app's sandbox does.
const START_BUDGET_MS = 10_000;

export type Outcome = JobResult | { runaway: true } | { error: string };

interface Pending {
  resolve: (outcome: Outcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Runs regex jobs one at a time in a Web Worker, each against the budget. A
 * job over it terminates the worker, is reported as a runaway, and its regex
 * is remembered so the tester leaves it out from then on; the next job starts
 * a fresh worker.
 */
export class RegexRunner {
  private worker: Worker | undefined;
  private ready: Promise<boolean> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private next = 0;
  private pending = new Map<number, Pending>();
  private readonly runaways = new Set<string>();

  static key(job: Pick<RegexJob, 'source' | 'flags'>): string {
    return `${job.flags}\u0000${job.source}`;
  }

  isRunaway(job: Pick<RegexJob, 'source' | 'flags'>): boolean {
    return this.runaways.has(RegexRunner.key(job));
  }

  run(job: RegexJob): Promise<Outcome> {
    const result = this.queue.then(() => this.runNow(job));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private start(): Promise<boolean> {
    if (this.worker && this.ready) return this.ready;
    const worker = new Worker(new URL('./regex-worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    this.ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), START_BUDGET_MS);
      worker.addEventListener('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      worker.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as { ready?: true; id?: number; result?: JobResult; error?: string };
        if (data.ready) {
          clearTimeout(timer);
          resolve(true);
          return;
        }
        const waiting = data.id === undefined ? undefined : this.pending.get(data.id);
        if (!waiting) return;
        clearTimeout(waiting.timer);
        this.pending.delete(data.id!);
        waiting.resolve(data.result ?? { error: data.error ?? 'the pattern could not run' });
      });
    });
    return this.ready;
  }

  private stop(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.ready = undefined;
  }

  private async runNow(job: RegexJob): Promise<Outcome> {
    if (this.isRunaway(job)) return { runaway: true };
    if (!(await this.start())) {
      this.stop();
      return { error: 'the tester could not start in this browser' };
    }
    const worker = this.worker!;
    const id = this.next++;
    return new Promise<Outcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.runaways.add(RegexRunner.key(job));
        this.stop();
        resolve({ runaway: true });
      }, PATTERN_BUDGET_MS);
      this.pending.set(id, { resolve, timer });
      worker.postMessage({ id, job });
    });
  }
}
