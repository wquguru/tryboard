// Voice server feed (F-09b-2): session pushes the worker's [xz] increments; the voice tab and dock read it.
import { useSyncExternalStore } from 'react';

const LOG_CAP = 1000;

export interface XzSnap {
  /** Server switched on in this power-up */
  on: boolean;
  script: string;
  sessions: number;
  turns: number;
  up: number;
  down: number;
  /** [sim µs, line], same text as the CLI `[xz]` lines */
  log: [number, string][];
}

/** Conversation bubbles parsed from the log: what the recognizer heard (stt) and each spoken sentence (tts) */
export interface XzBubble {
  us: number;
  who: 'user' | 'bot';
  text: string;
}

const EMPTY: XzSnap = { on: false, script: '', sessions: 0, turns: 0, up: 0, down: 0, log: [] };

function createXzFeed() {
  let snap = EMPTY;
  const subs = new Set<() => void>();
  return {
    get: () => snap,
    update(m: { json: string; reset?: boolean }) {
      const prev = m.reset ? EMPTY : snap;
      if (!m.json) {
        if (snap === EMPTY) return;
        snap = EMPTY;
      } else {
        const j = JSON.parse(m.json) as Omit<XzSnap, 'on'>;
        let log = prev.log.concat(j.log);
        if (log.length > LOG_CAP) log = log.slice(log.length - LOG_CAP);
        snap = { ...j, on: true, log };
      }
      for (const f of subs) f();
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}
export const xzFeed = createXzFeed();
export const useXz = () => useSyncExternalStore(xzFeed.subscribe, xzFeed.get);

/** stt "…" -> user bubble, tts sentence_start "…" -> assistant bubble (core xiaozhi.rs log text) */
export function bubbles(log: [number, string][]): XzBubble[] {
  const out: XzBubble[] = [];
  for (const [us, l] of log) {
    const m = /^(stt|tts sentence_start) "(.*)"$/.exec(l);
    if (m && m[2]) out.push({ us, who: m[1] === 'stt' ? 'user' : 'bot', text: m[2] });
  }
  return out;
}

/** say text as a script action payload: the CLI splits scripts on `;`, trims actions and treats `#` lines as comments */
export function sayText(t: string): string {
  return t.replace(/[;#\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Built-in scripts of the virtual server (core xiaozhi.rs SCRIPTS) */
export const XZ_SCRIPTS = ['hello', 'weather', 'silent'] as const;
