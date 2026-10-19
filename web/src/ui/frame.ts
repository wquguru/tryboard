// The page's only requestAnimationFrame loop (R-11). Everything per-frame subscribes here with onFrame(),
// one-off "next frame" work uses nextFrame() / afterFrame(); lint_size.py rejects rAF anywhere else.

/** t: frame timestamp (ms, rAF timebase); dt: ms since this subscriber last ran (0 on its first frame). */
export type FrameFn = (t: number, dt: number) => void;

export interface FrameOpts {
  /** Lower runs first; see PRIO. Ties keep subscription order. */
  priority?: number;
  /** Checked every frame: false skips this subscriber (panel closed, canvas off screen) without unsubscribing. */
  visible?: () => boolean;
  /** Run on the next frame only, then unsubscribe. */
  once?: boolean;
  /** Also run once right away (dt 0), for loops that used to call their tick before the first rAF. */
  immediate?: boolean;
}

/** Page-level options: `el` skips the subscriber while that element is off screen or display:none. */
export interface PageFrameOpts extends FrameOpts {
  el?: Element;
}

/** Frame phases: simulation-driven state first, then 3D rendering, then DOM overlays and UI animation. */
export const PRIO = { sim: 0, render: 10, warm: 11, ui: 20 } as const;

/** What the loop needs from the browser; tests inject fakes. */
export interface FrameEnv {
  raf: (cb: (t: number) => void) => unknown;
  doc?: { hidden: boolean; addEventListener(type: 'visibilitychange', fn: () => void): void } | null;
  error?: (...a: unknown[]) => void;
  now?: () => number;
}

interface Sub {
  fn: FrameFn;
  priority: number;
  visible?: () => boolean;
  once: boolean;
  seq: number;
  live: boolean;
  last: number;
  failed: boolean;
}

export interface FrameLoop {
  onFrame(fn: FrameFn, opts?: FrameOpts): () => void;
  nextFrame(): Promise<number>;
  afterFrame(fn: (t: number) => void): () => void;
  /** Subscriber count and whether a frame is queued (tests, debugging). */
  stats(): { subs: number; scheduled: boolean; frames: number };
}

export function createFrameLoop(env: FrameEnv): FrameLoop {
  const subs: Sub[] = [];
  let sorted = true;
  let seq = 0;
  let scheduled = false;
  let frames = 0;
  const hidden = () => !!env.doc?.hidden;
  const err = env.error ?? ((...a: unknown[]) => console.error(...a));

  function schedule() {
    if (scheduled || !subs.length || hidden()) return;
    scheduled = true;
    env.raf(tick);
  }
  // A frame that still arrives while hidden (some browsers deliver one) is dropped; visibilitychange restarts the loop
  function tick(t: number) {
    scheduled = false;
    if (hidden()) return;
    frames++;
    if (!sorted) {
      subs.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      sorted = true;
    }
    // Snapshot: subscribers added during this frame start on the next one, removed ones are skipped right away
    for (const s of subs.slice()) {
      if (!s.live) continue;
      if (s.visible && !safe(s, s.visible)) continue;
      if (s.once) remove(s);
      // rAF stamps the frame start, so an immediate call's performance.now() can be slightly later
      const dt = s.last < 0 ? 0 : Math.max(0, t - s.last);
      s.last = t;
      safe(s, () => s.fn(t, dt));
    }
    schedule();
  }
  function safe<T>(s: Sub, f: () => T): T | false {
    try {
      return f();
    } catch (e) {
      // One bad subscriber must not stop rendering for everyone; log once so a per-frame throw doesn't flood
      if (!s.failed) err('[frame] subscriber threw', e);
      s.failed = true;
      return false;
    }
  }
  function remove(s: Sub) {
    if (!s.live) return;
    s.live = false;
    const i = subs.indexOf(s);
    if (i >= 0) subs.splice(i, 1);
  }
  env.doc?.addEventListener('visibilitychange', schedule);

  const loop: FrameLoop = {
    onFrame(fn, opts = {}) {
      const s: Sub = { fn, priority: opts.priority ?? PRIO.ui, visible: opts.visible, once: !!opts.once, seq: seq++, live: true, last: -1, failed: false };
      subs.push(s);
      sorted = false;
      schedule();
      if (opts.immediate) {
        s.last = (env.now ?? (() => performance.now()))();
        safe(s, () => fn(s.last, 0));
      }
      return () => remove(s);
    },
    nextFrame: () => new Promise<number>((r) => loop.onFrame((t) => r(t), { once: true })),
    afterFrame: (fn) => loop.onFrame((t) => fn(t), { once: true }),
    stats: () => ({ subs: subs.length, scheduled, frames }),
  };
  return loop;
}

let shared: FrameLoop | null = null;
function page(): FrameLoop {
  return (shared ??= createFrameLoop({
    raf: (cb) => globalThis.requestAnimationFrame(cb),
    doc: typeof document === 'undefined' ? null : document,
  }));
}

/** Subscribe to every frame; returns the unsubscribe function. */
export function onFrame(fn: FrameFn, opts: PageFrameOpts = {}): () => void {
  if (!opts.el) return page().onFrame(fn, opts);
  const seen = inView(opts.el);
  const own = opts.visible;
  const off = page().onFrame(fn, { ...opts, visible: own ? () => seen.visible() && own() : seen.visible });
  return () => {
    off();
    seen.dispose();
  };
}
/** Resolves with the timestamp of the next frame (replaces `await new Promise(requestAnimationFrame)`). */
export const nextFrame = (): Promise<number> => page().nextFrame();
/** Run fn once on the next frame (layout measuring, focusing after render); returns a cancel function. */
export const afterFrame = (fn: (t: number) => void): (() => void) => page().afterFrame(fn);

/**
 * Tracks whether an element is on screen (IntersectionObserver, no per-frame layout reads) for onFrame's `visible`.
 * Starts as visible so the first frames render before the observer's first report.
 */
export function inView(el: Element): { visible: () => boolean; dispose: () => void } {
  if (typeof IntersectionObserver === 'undefined') return { visible: () => true, dispose: () => {} };
  let on = true;
  const io = new IntersectionObserver((es) => {
    for (const e of es) on = e.isIntersecting;
  });
  io.observe(el);
  return { visible: () => on, dispose: () => io.disconnect() };
}
