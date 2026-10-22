// MicroPython on the bench (F-07b): detect the user's MicroPython image, keep main.py in this browser, drive the MpyLink.
// Every byte goes through session.sim.uart, so it lands in the input log and replays with `tryboard run --inputs`.
import { isMicroPython, MpyLink, type MpyStatus } from '../mpy';
import { createStore } from './store';
import { bc, setBc, setDock } from './chrome';
import type { Session } from './types';

const KEY = 'tryboard-mpy-main';
/** Longest main.py the editor, the local copy and share state carry */
export const MPY_MAX = 64 * 1024;
export const MPY_SAMPLE = `# main.py: runs after every soft reset
import time
from machine import Pin

led = Pin(8, Pin.OUT)
for i in range(5):
    led.value(i % 2)
    print("tick", i, time.ticks_ms())
    time.sleep_ms(200)
print("done")
`;

function loadText(): string {
  try {
    return localStorage.getItem(KEY) ?? MPY_SAMPLE;
  } catch {
    return MPY_SAMPLE;
  }
}
function saveText(text: string) {
  try {
    localStorage.setItem(KEY, text);
  } catch {
    /* private mode: the editor still works for this page */
  }
}

export interface MpyView {
  text: string;
  /** REPL up since power-up */
  ready: boolean;
  busy: boolean;
  status: MpyStatus;
  /** Serial since the last Run (control bytes stripped), for the pane's output box */
  out: string;
}
export const mpy = createStore<MpyView>({ text: loadText(), ready: false, busy: false, status: { phase: 'idle', sent: 0, total: 0 }, out: '' });

let link: MpyLink | null = null;
/** Set when the page opened a share whose run already contains the upload: no automatic re-send until the user runs */
let holdAuto = false;
let shared = false;

/** Text typed in the editor: kept locally unless it came from a share and was not run yet (the user's own copy stays) */
export function setText(text: string) {
  mpy.set({ text: text.slice(0, MPY_MAX) });
  if (!shared) saveText(mpy.get().text);
}

/** Restoring a share or .tryboard (before its firmware boots) */
export function takeShared(text: string | undefined, hasRun: boolean) {
  if (text !== undefined) {
    shared = true;
    mpy.set({ text: text.slice(0, MPY_MAX) });
  }
  if (hasRun) holdAuto = true;
}

/** main.py for share state: only while MicroPython is on the bench */
export const sharedText = () => (bc.get().mpy ? mpy.get().text : undefined);

export function runMain() {
  if (!link) return;
  shared = false;
  holdAuto = false;
  saveText(mpy.get().text);
  mpy.set({ out: '' });
  void link.run(mpy.get().text);
}

export function installMpy(session: Session) {
  link = new MpyLink(
    (text) => session.sim?.uart(text),
    (l) => mpy.set({ ready: l.ready, busy: l.busy, status: l.status }),
  );
  session.onBoot(() => {
    link!.powerUp();
    const on = !!session.fwBuf && isMicroPython(session.fwBuf);
    if (on !== bc.get().mpy) {
      setBc({ mpy: on });
      if (on) setDock({ tab: 'py', collapsed: false });
      else if (bc.get().dock.tab === 'py') setDock({ tab: 'serial' });
    }
    // A fresh power-up has a freshly formatted filesystem: re-send the saved main.py (RS-1, no littlefs image)
    if (on && !holdAuto && mpy.get().text.trim()) {
      mpy.set({ out: '' });
      link!.runWhenReady(mpy.get().text);
    }
  });
  session.onConsole((text) => {
    link!.feed(text);
    if (!bc.get().mpy) return;
    const clean = text.replace(/\r/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f\uFFFD]/g, '');
    if (clean) mpy.set({ out: (mpy.get().out + clean).slice(-4000) });
  });
}
