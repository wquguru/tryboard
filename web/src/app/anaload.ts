// Lazy logic analyzer (R-12): the module loads on first open or idle prefetch; samples live in session.io anyway.
// Callers that only need the open state read body.ana-open instead of loading it.
import type { Analyzer } from './analyzer';
import type { StepCtx } from './types';

let p: Promise<Analyzer> | null = null;
let ready: Analyzer | null = null;
const listeners: ((a: Analyzer) => void)[] = [];

/** Load (once) and create the page's analyzer; a failed fetch is retried on the next call. */
export function loadAnalyzer(ctx: StepCtx): Promise<Analyzer> {
  if (ready) return Promise.resolve(ready);
  return (p ??= import('./analyzer').then(
    (m) => {
      const a = m.getAnalyzer(ctx);
      ready = a;
      for (const f of listeners.splice(0)) f(a);
      return a;
    },
    (e) => {
      p = null;
      throw e;
    },
  ));
}

/** The analyzer if it already exists (no load) */
export const analyzerIfLoaded = () => ready;

/** Run f once the analyzer exists (now if it already does) */
export function onAnalyzer(f: (a: Analyzer) => void) {
  if (ready) f(ready);
  else listeners.push(f);
}

/** Whether the analyzer is open, without loading it */
export const analyzerOpen = () => document.body.classList.contains('ana-open');
