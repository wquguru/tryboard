// F-07b: MicroPython main.py link against a fake board (raw-paste flow control, raw REPL fallback, errors) + serial escapes
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMicroPython, MpyLink, pyWriter } from '../src/mpy.ts';
import { action, escUart, fromAction, unescUart } from '../src/inputlog.ts';

/** Decode the w(b'...') lines of pyWriter back to bytes (Python bytes-literal subset it emits) */
function written(prog: string): string {
  const out: number[] = [];
  for (const m of prog.matchAll(/^w\(b'(.*)'\)$/gm)) {
    const s = m[1];
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== '\\') out.push(s.charCodeAt(i));
      else if (s[i + 1] === 'x') (out.push(parseInt(s.slice(i + 2, i + 4), 16)), (i += 3));
      else out.push({ n: 10, '\\': 92, "'": 39 }[s[i + 1]] as number), i++;
    }
  }
  return new TextDecoder().decode(new Uint8Array(out));
}

/** Byte-level fake of the MicroPython REPL protocol (pyexec raw-paste) with a 128-byte window */
function fakeBoard(opts: { paste: boolean; err?: string }) {
  let link!: MpyLink;
  let mode: 'friendly' | 'raw' | 'paste' = 'friendly';
  let code = '';
  let left = 0;
  const log: string[] = [];
  let maxBurst = 0;
  const reply = (s: string) => setTimeout(() => link.feed(s), 1);
  const send = (text: string) => {
    log.push(text);
    if (mode === 'paste') {
      if (text === '\x04') {
        mode = 'raw';
        reply('\x04');
        reply(`\x04${opts.err ?? ''}\x04>`);
        return;
      }
      left -= text.length;
      maxBurst = Math.max(maxBurst, 128 - left);
      assert.ok(left >= 0, 'sent past the window');
      code += text;
      if (left === 0) ((left = 128), reply('\x01'));
      return;
    }
    if (mode === 'raw') {
      if (text === '\x05A\x01') {
        if (!opts.paste) return reply('R\x00');
        mode = 'paste';
        left = 128;
        // 0x80 0x00 as the worker's UTF-8 decoder delivers it
        return reply('R\x01\uFFFD\x00');
      }
      if (text === '\x02') return ((mode = 'friendly'), reply('\r\nMicroPython v1.29.0 on 2026-08-24; ESP32C3\r\n>>> '));
      if (text.endsWith('\x04')) {
        code += text.slice(0, -1);
        return reply(`OK\x04${opts.err ?? ''}\x04>`);
      }
      return;
    }
    if (text === '\x03\x03') return reply('\r\n>>> \r\n>>> ');
    if (text === '\x01') return ((mode = 'raw'), reply('\r\nraw REPL; CTRL-B to exit\r\n>'));
    if (text === '\x04') return reply('MPY: soft reboot\r\nhello\r\n');
  };
  link = new MpyLink(send, () => {}, 2000);
  return { link, log, code: () => code, burst: () => maxBurst };
}

const SRC = "# 中文 comment; \\ path\nimport time\nfor i in range(3):\n    print('tick', i)\n    time.sleep_ms(200)\n" + 'x = 1\n'.repeat(80);

test('raw-paste upload honours the window and ends with a soft reset', async () => {
  const b = fakeBoard({ paste: true });
  b.link.feed('MicroPython v1.29.0\r\n>>> ');
  assert.equal(b.link.ready, true);
  assert.equal(await b.link.run(SRC), true);
  assert.equal(b.link.status.phase, 'done');
  assert.equal(b.link.status.mode, 'paste');
  assert.equal(b.code(), pyWriter(SRC));
  assert.equal(written(b.code()), SRC);
  assert.ok(b.code().length > 256, 'needs several windows');
  assert.equal(b.burst(), 128);
  assert.deepEqual(b.log.slice(-2), ['\x02', '\x04']);
});

test('falls back to raw REPL when raw-paste is refused', async () => {
  const b = fakeBoard({ paste: false });
  b.link.feed('>>> ');
  assert.equal(await b.link.run(SRC), true);
  assert.equal(b.link.status.mode, 'raw');
  assert.equal(written(b.code()), SRC);
});

test('board error is reported and raw REPL is left', async () => {
  const b = fakeBoard({ paste: true, err: 'Traceback\r\nOSError: 28\r\n' });
  b.link.feed('>>> ');
  assert.equal(await b.link.run('print(1)\n'), false);
  assert.equal(b.link.status.error, 'board');
  assert.match(b.link.status.detail ?? '', /OSError: 28/);
  assert.equal(b.log.at(-1), '\x02');
});

test('auto run waits for the first prompt; power-up cancels it', async () => {
  const b = fakeBoard({ paste: true });
  b.link.runWhenReady('print(2)\n');
  assert.equal(b.log.length, 0);
  b.link.feed('boot...\r\n>');
  b.link.feed('>> ');
  assert.equal(b.log[0], '\x03\x03');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(b.link.status.phase, 'done');
  const c = fakeBoard({ paste: true });
  c.link.runWhenReady('print(3)\n');
  c.link.powerUp();
  c.link.feed('>>> ');
  assert.equal(c.log.length, 0);
});

test('timeout when the board never answers', async () => {
  const link = new MpyLink(() => {}, () => {}, 50);
  link.feed('>>> ');
  assert.equal(await link.run('x=1\n'), false);
  assert.equal(link.status.error, 'timeout');
});

test('image scan finds the banner', () => {
  const b = new Uint8Array(4096).fill(0xff);
  assert.equal(isMicroPython(b), false);
  b.set(new TextEncoder().encode('MicroPython v1.29.0'), 3000);
  assert.equal(isMicroPython(b.buffer), true);
});

test('serial escape round-trips control bytes, separators and edge spaces like the CLI', () => {
  for (const s of ['\x03\x03', '\x05A\x01', ' a;b#c\\d\r\n ', 'ping\n', '中文 ok', pyWriter(SRC).slice(0, 128)]) {
    const e = escUart(s);
    assert.ok(!/[;\x00-\x09\x0b-\x1f]/.test(e), e);
    assert.equal(e, e.trim());
    assert.equal(unescUart(e), s);
    assert.deepEqual(fromAction(action({ tMs: 0, kind: 'uart', text: s })!), { kind: 'uart', text: s });
  }
  // Same decoding rules as cli/src/escape.rs: only \n and strict \xNN
  assert.equal(unescUart('\\x3b\\x0A'), ';\n');
  assert.equal(unescUart('C:\\temp \\t \\x \\xg1'), 'C:\\temp \\t \\x \\xg1');
});
