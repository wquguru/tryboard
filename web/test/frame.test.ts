import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrameLoop, PRIO } from '../src/ui/frame.ts';

// Fake browser: rAF callbacks queue up and run when the test calls flush(t)
function fake() {
  let queued: ((t: number) => void)[] = [];
  let listener: (() => void) | null = null;
  const errors: unknown[][] = [];
  const doc = {
    hidden: false,
    addEventListener: (_: 'visibilitychange', fn: () => void) => void (listener = fn),
  };
  const loop = createFrameLoop({ raf: (cb) => queued.push(cb), doc, error: (...a) => errors.push(a), now: () => 7 });
  return {
    loop,
    doc,
    errors,
    pending: () => queued.length,
    flush(t: number) {
      const q = queued;
      queued = [];
      for (const cb of q) cb(t);
    },
    setHidden(h: boolean) {
      doc.hidden = h;
      listener?.();
    },
  };
}

test('one rAF per frame however many subscribers', () => {
  const f = fake();
  let a = 0, b = 0;
  f.loop.onFrame(() => a++);
  f.loop.onFrame(() => b++);
  f.loop.onFrame(() => {}, { priority: PRIO.render });
  assert.equal(f.pending(), 1);
  f.flush(16);
  assert.equal(f.pending(), 1);
  f.flush(32);
  assert.deepEqual([a, b], [2, 2]);
});

test('runs in priority order, ties in subscription order', () => {
  const f = fake();
  const seen: string[] = [];
  f.loop.onFrame(() => seen.push('ui1'), { priority: PRIO.ui });
  f.loop.onFrame(() => seen.push('warm'), { priority: PRIO.warm });
  f.loop.onFrame(() => seen.push('render'), { priority: PRIO.render });
  f.loop.onFrame(() => seen.push('sim'), { priority: PRIO.sim });
  f.loop.onFrame(() => seen.push('ui2'));
  f.flush(16);
  assert.deepEqual(seen, ['sim', 'render', 'warm', 'ui1', 'ui2']);
});

test('dt is per subscriber, 0 on its first frame', () => {
  const f = fake();
  const got: number[][] = [];
  f.loop.onFrame((t, dt) => got.push([t, dt]));
  f.flush(100);
  f.flush(116);
  f.flush(150);
  assert.deepEqual(got, [[100, 0], [116, 16], [150, 34]]);
});

test('unsubscribe stops calls; no subscribers means no next frame', () => {
  const f = fake();
  let n = 0;
  const off = f.loop.onFrame(() => n++);
  f.flush(16);
  off();
  f.flush(32);
  assert.equal(n, 1);
  assert.equal(f.pending(), 0);
  assert.equal(f.loop.stats().scheduled, false);
  // Subscribing again restarts the loop
  f.loop.onFrame(() => n++);
  assert.equal(f.pending(), 1);
  f.flush(48);
  assert.equal(n, 2);
});

test('unsubscribing a later subscriber from an earlier one skips it in the same frame', () => {
  const f = fake();
  let late = 0;
  f.loop.onFrame(() => offLate(), { priority: 0 });
  const offLate = f.loop.onFrame(() => late++, { priority: 1 });
  f.flush(16);
  assert.equal(late, 0);
  assert.equal(f.pending(), 1);
});

test('subscribers added during a frame start on the next one', () => {
  const f = fake();
  let inner = 0;
  const off = f.loop.onFrame(() => {
    f.loop.onFrame(() => inner++, { priority: -1 });
    off();
  });
  f.flush(16);
  assert.equal(inner, 0);
  f.flush(32);
  assert.equal(inner, 1);
});

test('hidden document pauses the loop and visibilitychange resumes it', () => {
  const f = fake();
  let n = 0;
  f.loop.onFrame(() => n++);
  f.flush(16);
  f.setHidden(true);
  // The frame already queued arrives while hidden: dropped, nothing queued after it
  f.flush(32);
  assert.equal(n, 1);
  assert.equal(f.pending(), 0);
  // Subscribing while hidden does not queue a frame either
  f.loop.onFrame(() => n++);
  assert.equal(f.pending(), 0);
  f.setHidden(false);
  assert.equal(f.pending(), 1);
  f.flush(5000);
  assert.equal(n, 3);
});

test('visible() false skips the subscriber without unsubscribing it', () => {
  const f = fake();
  let on = false;
  let n = 0, other = 0;
  f.loop.onFrame(() => n++, { visible: () => on });
  f.loop.onFrame(() => other++);
  f.flush(16);
  f.flush(32);
  assert.deepEqual([n, other], [0, 2]);
  on = true;
  f.flush(48);
  assert.deepEqual([n, other], [1, 3]);
  assert.equal(f.loop.stats().subs, 2);
});

test('a throwing subscriber does not stop the others or the loop, and logs once', () => {
  const f = fake();
  let after = 0;
  f.loop.onFrame(() => {
    throw new Error('boom');
  }, { priority: 0 });
  f.loop.onFrame(() => after++, { priority: 1 });
  f.flush(16);
  f.flush(32);
  f.flush(48);
  assert.equal(after, 3);
  assert.equal(f.errors.length, 1);
  assert.equal(f.pending(), 1);
});

test('once / afterFrame run a single time', () => {
  const f = fake();
  let n = 0;
  f.loop.afterFrame(() => n++);
  f.loop.onFrame(() => n++, { once: true });
  f.flush(16);
  f.flush(32);
  assert.equal(n, 2);
  assert.equal(f.pending(), 0);
  // Cancelled before its frame: never runs
  const cancel = f.loop.afterFrame(() => n++);
  cancel();
  f.flush(48);
  assert.equal(n, 2);
});

test('nextFrame resolves with the frame timestamp', async () => {
  const f = fake();
  const p = f.loop.nextFrame();
  assert.equal(f.pending(), 1);
  f.flush(123);
  assert.equal(await p, 123);
  assert.equal(f.pending(), 0);
});

test('immediate runs once synchronously, then on every frame', () => {
  const f = fake();
  const got: number[][] = [];
  f.loop.onFrame((t, dt) => got.push([t, dt]), { immediate: true });
  assert.deepEqual(got, [[7, 0]]);
  f.flush(17);
  assert.deepEqual(got, [[7, 0], [17, 10]]);
});
