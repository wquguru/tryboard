// MicroPython main.py over the virtual UART (F-07b): a minimal prompt-driven mpremote. It runs on the main thread and sends
// through the logged serial input, so an exported input log replays byte for byte with `tryboard run --inputs`.
// Pure module (no DOM, no i18n): web/test/mpy.test.ts drives it against a fake board.

/** Banner MicroPython prints at every (soft) boot; the image contains the same text */
export const MPY_NAME = 'MicroPython';
const PROMPT = '>>> ';
const RAW = 'raw REPL; CTRL-B to exit\r\n>';
/** Wall-clock limit per wait: only to report a stuck board, never to pace sends */
const WAIT_MS = 20_000;

/** Flash image contains the MicroPython banner (scan of the uploaded .bin; works before the first serial byte) */
export function isMicroPython(bin: ArrayBuffer | Uint8Array): boolean {
  const b = bin instanceof Uint8Array ? bin : new Uint8Array(bin);
  const n = [...MPY_NAME].map((c) => c.charCodeAt(0));
  outer: for (let i = b.indexOf(n[0]); i >= 0 && i <= b.length - n.length; i = b.indexOf(n[0], i + 1)) {
    for (let k = 1; k < n.length; k++) if (b[i + k] !== n[k]) continue outer;
    return true;
  }
  return false;
}

/** Python bytes literal body: printable ASCII as is, everything else \xNN, so the program text is pure ASCII */
function bytesLit(b: Uint8Array): string {
  let o = '';
  for (const c of b) {
    if (c === 0x5c) o += '\\\\';
    else if (c === 0x27) o += "\\'";
    else if (c === 0x0a) o += '\\n';
    else if (c >= 0x20 && c < 0x7f) o += String.fromCharCode(c);
    else o += `\\x${c.toString(16).padStart(2, '0')}`;
  }
  return o;
}

/** Program the board runs in raw mode to write main.py: 64-byte writes keep each line short and the heap small */
export function pyWriter(src: string): string {
  const b = new TextEncoder().encode(src);
  const lines = ["f=open('main.py','wb')", 'w=f.write'];
  for (let i = 0; i < b.length; i += 64) lines.push(`w(b'${bytesLit(b.subarray(i, i + 64))}')`);
  lines.push('f.close()');
  return lines.join('\n') + '\n';
}

export type MpyPhase = 'idle' | 'wait' | 'raw' | 'paste' | 'exec' | 'reset' | 'done' | 'error';
export interface MpyStatus {
  phase: MpyPhase;
  /** Program bytes sent / total during upload */
  sent: number;
  total: number;
  /** paste = raw-paste with flow control; raw = plain raw REPL fallback */
  mode?: 'paste' | 'raw';
  /** timeout = no prompt within WAIT_MS; board = the write program raised (detail = its traceback); reset = power cycle mid-run */
  error?: 'timeout' | 'board' | 'reset';
  detail?: string;
}

class Abort extends Error {
  readonly why: 'timeout' | 'reset';
  constructor(why: 'timeout' | 'reset') {
    super(why);
    this.why = why;
  }
}

/** Waits on serial text received since the wait began; test returns how much to consume, or -1 to keep waiting */
interface Wait {
  test: (buf: string) => number;
  done: (buf: string, end: number) => void;
  fail: (e: Abort) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MpyLink {
  /** A `>>> ` prompt has been seen since power-up (the REPL is up, Run may start) */
  ready = false;
  busy = false;
  status: MpyStatus = { phase: 'idle', sent: 0, total: 0 };
  private buf = '';
  private tail = '';
  private wait: Wait | null = null;
  private auto: string | null = null;

  private readonly send: (text: string) => void;
  private readonly onChange: (link: MpyLink) => void;
  private readonly waitMs: number;

  constructor(send: (text: string) => void, onChange: (link: MpyLink) => void = () => {}, waitMs = WAIT_MS) {
    this.send = send;
    this.onChange = onChange;
    this.waitMs = waitMs;
  }

  /** New power-up: the board's flash is fresh and any upload in flight is lost */
  powerUp() {
    this.ready = false;
    this.tail = '';
    this.auto = null;
    this.abort(new Abort('reset'));
    this.busy = false;
    this.set({ phase: 'idle', sent: 0, total: 0 });
  }

  /** Serial text from the board (any chunking) */
  feed(text: string) {
    // Waits first: an auto run started below must not see this chunk's prompt as its reply
    if (this.busy) {
      this.buf += text;
      this.check();
    }
    if (!this.ready) {
      const s = this.tail + text;
      this.tail = s.slice(-PROMPT.length);
      if (s.includes(PROMPT)) {
        this.ready = true;
        this.onChange(this);
        const a = this.auto;
        this.auto = null;
        if (a !== null) void this.run(a);
      }
    }
  }

  /** Run once the REPL is up (page reload re-sends the saved main.py) */
  runWhenReady(src: string) {
    if (this.ready) void this.run(src);
    else this.auto = src;
  }

  /** Write main.py and soft-reset so it runs. Resolves false when already busy or on failure (status says why) */
  async run(src: string): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    const prog = pyWriter(src);
    const total = prog.length;
    try {
      this.set({ phase: 'wait', sent: 0, total });
      this.tx('\x03\x03');
      await this.until(PROMPT);
      this.tx('\x01');
      await this.until(RAW);
      this.tx('\x05A\x01');
      // R\x01 + 16-bit LE window, or R\x00 (raw-paste refused); firmware without raw-paste just repeats the raw prompt
      const hdr = await this.untilFn((b) => {
        const r = b.indexOf('R\x01');
        if (r >= 0 && b.length >= r + 4) return r + 4;
        const n = b.indexOf('R\x00');
        if (n >= 0) return n + 2;
        const p = b.indexOf(RAW);
        return p >= 0 ? p + RAW.length : -1;
      });
      if (hdr.endsWith('R\x00') || !hdr.includes('R\x01')) {
        // Plain raw REPL: the simulated UART queues every byte (F-07a), so one push needs no pacing
        this.set({ phase: 'raw', sent: 0, total, mode: 'raw' });
        this.tx(prog + '\x04');
        this.set({ ...this.status, sent: total });
        await this.until('OK');
      } else {
        const lo = hdr.charCodeAt(hdr.length - 2);
        const hi = hdr.charCodeAt(hdr.length - 1);
        // The worker decodes serial as UTF-8, so a window byte >= 0x80 arrives as U+FFFD: any such window is >= 128
        const win = lo < 0x80 && hi < 0x80 ? lo | (hi << 8) || 128 : 128;
        let credit = win;
        let sent = 0;
        this.set({ phase: 'paste', sent, total, mode: 'paste' });
        while (sent < total) {
          if (credit === 0) {
            const c = await this.untilFn((b) => {
              const k = b.search(/[\x01\x04]/);
              return k >= 0 ? k + 1 : -1;
            });
            if (c.endsWith('\x04')) throw new BoardError('raw-paste aborted by the board');
            credit += win;
            continue;
          }
          const n = Math.min(credit, total - sent);
          this.tx(prog.slice(sent, sent + n), true);
          credit -= n;
          sent += n;
          this.set({ ...this.status, sent });
        }
        this.tx('\x04', true);
        // Credits may still arrive before the end-of-data ack
        await this.until('\x04');
      }
      this.set({ ...this.status, phase: 'exec' });
      const out = await this.untilFn((b) => {
        const a = b.indexOf('\x04');
        const z = a >= 0 ? b.indexOf('\x04>', a + 1) : -1;
        return z >= 0 ? z + 2 : -1;
      });
      const err = out.slice(out.indexOf('\x04') + 1, -2).trim();
      if (err) throw new BoardError(err);
      this.set({ ...this.status, phase: 'reset' });
      this.tx('\x02');
      await this.until(PROMPT);
      this.tx('\x04');
      await this.until('soft reboot');
      this.set({ ...this.status, phase: 'done' });
      return true;
    } catch (e) {
      if (e instanceof Abort) {
        if (e.why === 'timeout') this.set({ ...this.status, phase: 'error', error: 'timeout' });
      } else if (e instanceof BoardError) {
        // Leave raw REPL so the serial box is usable again
        this.tx('\x02');
        this.set({ ...this.status, phase: 'error', error: 'board', detail: e.message });
      } else throw e;
      return false;
    } finally {
      this.busy = false;
      this.onChange(this);
    }
  }

  private set(s: MpyStatus) {
    this.status = s;
    this.onChange(this);
  }

  private tx(text: string, keep = false) {
    // Text received before a command is a reply to something earlier; paste chunks keep it (it may hold window credits)
    if (!keep) this.buf = '';
    this.send(text);
  }

  private until(s: string) {
    return this.untilFn((b) => {
      const i = b.indexOf(s);
      return i >= 0 ? i + s.length : -1;
    });
  }

  /** Resolves with the consumed text; the rest stays buffered for the next wait */
  private untilFn(test: (buf: string) => number): Promise<string> {
    return new Promise((done, fail) => {
      const timer = setTimeout(() => this.abort(new Abort('timeout')), this.waitMs);
      this.wait = {
        test,
        done: (b, end) => {
          this.buf = b.slice(end);
          done(b.slice(0, end));
        },
        fail,
        timer,
      };
      this.check();
    });
  }

  private check() {
    const w = this.wait;
    if (!w) return;
    const end = w.test(this.buf);
    if (end < 0) return;
    clearTimeout(w.timer);
    this.wait = null;
    w.done(this.buf, end);
  }

  private abort(e: Abort) {
    const w = this.wait;
    if (!w) return;
    clearTimeout(w.timer);
    this.wait = null;
    this.buf = '';
    w.fail(e);
  }
}

class BoardError extends Error {}
