// Virtual PC data feed (M5) without the dock UI: the session pushes, the lazy USB tab reads (R-12).
import type { UsbView } from '../usb3d';

/** Virtual PC data: device state notifies React at ≤ 10 Hz; every mouse report is kept for the canvas trail. */
function createUsbFeed() {
  let view: UsbView | null = null;
  const trail: [number, number][] = [];
  let lastReports = -1;
  let timer = 0;
  let last = 0;
  const subs = new Set<() => void>();
  const notify = () => {
    timer = 0;
    last = performance.now();
    for (const f of subs) f();
  };
  return {
    get: () => view,
    trail,
    update(v: UsbView | null) {
      view = v;
      if (v && v.mouse.reports !== lastReports) {
        lastReports = v.mouse.reports;
        trail.push([v.mouse.x, v.mouse.y]);
        if (trail.length > 300) trail.shift();
      }
      if (timer) return;
      const wait = 100 - (performance.now() - last);
      if (wait <= 0) notify();
      else timer = window.setTimeout(notify, wait);
    },
    reset() {
      clearTimeout(timer);
      view = null;
      trail.length = 0;
      lastReports = -1;
      notify();
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}
export type UsbFeed = ReturnType<typeof createUsbFeed>;
/** One per page: session pushes, the dock tab reads. */
export const usbFeed = createUsbFeed();
