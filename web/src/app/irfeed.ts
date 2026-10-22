// IR LED eye feed (F-08f): the worker drains the core's NEC decodes (wasm tb_ir_events), the bench IR cards read them.
import { useSyncExternalStore } from 'react';

const CAP = 12;

/** Key label and NEC command, in the remote's 3 × 7 layout */
export const IR_KEYS: [string, number][] = [
  ['CH-', 0x45], ['CH', 0x46], ['CH+', 0x47],
  ['⏮', 0x44], ['⏭', 0x40], ['⏯', 0x43],
  ['VOL-', 0x07], ['VOL+', 0x15], ['EQ', 0x09],
  ['0', 0x16], ['100+', 0x19], ['200+', 0x0d],
  ['1', 0x0c], ['2', 0x18], ['3', 0x5e],
  ['4', 0x08], ['5', 0x1c], ['6', 0x5a],
  ['7', 0x42], ['8', 0x52], ['9', 0x4a],
];
export const irHex = (v: number, n: number) => v.toString(16).toUpperCase().padStart(n, '0');
/** Script code for address 0x00 + command: 'FF00,BA45' (inverse byte first, as the firmware prints the 16-bit words) */
export const irCode = (cmd: number) => `FF00,${irHex(~cmd & 0xff, 2)}${irHex(cmd, 2)}`;

export interface IrSeen {
  /** Simulated seconds when the frame closed */
  t: number;
  pin: number;
  /** Same text as the CLI eye line, e.g. "NEC address=0xFF00 command=0xC936 (38.0 kHz carrier)" */
  text: string;
}

function createIrFeed() {
  let list: IrSeen[] = [];
  let total = 0;
  const subs = new Set<() => void>();
  let snap = { list, total };
  const notify = () => {
    snap = { list, total };
    for (const f of subs) f();
  };
  return {
    get: () => snap,
    subscribe(f: () => void) {
      subs.add(f);
      return () => {
        subs.delete(f);
      };
    },
    /** Worker text, one "seconds\tGPIO\ttext" line per frame; exact repeats (a rewind replaying the same frame) are dropped */
    push(text: string) {
      const add = text.split('\n').flatMap((l) => {
        const [t, pin, ...rest] = l.split('\t');
        return rest.length ? [{ t: Number(t), pin: Number(pin), text: rest.join('\t') }] : [];
      });
      const fresh = add.filter((a) => !list.some((x) => x.t === a.t && x.pin === a.pin && x.text === a.text));
      if (!fresh.length) return;
      total += fresh.length;
      list = [...fresh.reverse(), ...list].slice(0, CAP);
      notify();
    },
    clear() {
      list = [];
      total = 0;
      notify();
    },
    /** Fresh feed for a new sim; returns its LiveSim onIr callback */
    sink() {
      this.clear();
      return this.push;
    },
  };
}

export const irFeed = createIrFeed();
export const useIr = () => useSyncExternalStore(irFeed.subscribe, irFeed.get);
