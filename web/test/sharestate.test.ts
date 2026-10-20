// Share state v1 (F-01a): script round trip, encode / decode, version check, redaction, long-link fallback
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { action, fromScript, toScript, toScriptBody, toScriptInline, type InputEvent, type InputLog } from '../src/inputlog.ts';
import { captureState, decodeState, encodeState, packTryfile, redact, shareKey, shareLink, ShareDecodeError, SHARE_LINK_MAX, unpackTryfile, type ShareState } from '../src/app/sharestate.ts';

const EVENTS: InputEvent[] = [
  { tMs: 0, kind: 'power', on: true },
  { tMs: 0, kind: 'env', temp: 23.5, humidity: 45, pressure: 101325 },
  { tMs: 0, kind: 'i2cwire', cm: 60 },
  { tMs: 0, kind: 'antenna', db: 30 },
  { tMs: 0, kind: 'realnet', on: true },
  { tMs: 1203.456789, kind: 'gpio', pin: 0, level: 0 },
  { tMs: 1353.1, kind: 'gpio', pin: 0, level: -1 },
  { tMs: 1400, kind: 'gpio', pin: 4, level: 1 },
  { tMs: 1500, kind: 'pot', pin: 1, mv: 1650 },
  { tMs: 1600, kind: 'uart', text: 'hi; there\n' },
  { tMs: 1601, kind: 'usbcdc', text: 'x' },
  { tMs: 1700, kind: 'supply', mode: 'ext' },
  { tMs: 1800, kind: 'enc', steps: -3 },
  { tMs: 1801, kind: 'enc', steps: 2 },
  { tMs: 1802, kind: 'encsw', down: true },
  { tMs: 1900, kind: 'dist', cm: 12.34 },
  { tMs: 2000, kind: 'imu', pitch: 10.5, roll: -3, yaw: 0 },
  { tMs: 2001, kind: 'imu', pitch: 1, roll: 2, yaw: 3, rates: [4, 5, 6] },
  { tMs: 2100, kind: 'touch', down: true, x: 120, y: 80 },
  { tMs: 2101, kind: 'touch', down: false, x: 0, y: 0 },
  { tMs: 2200, kind: 'ble', cmd: 'read 2A19' },
  { tMs: 2201, kind: 'ble', cmd: 'pc=key a' },
  { tMs: 2300, kind: 'phone', cmd: 'post,,ssid=Home2&pass=s3cret' },
  { tMs: 2301, kind: 'phone', cmd: 'join,TryBoard-Setup' },
  { tMs: 2400, kind: 'netreply', reply: '1,200,12,text/plain,aGk=' },
  { tMs: 2500, kind: 'seed', seed: 42 },
  { tMs: 2501, kind: 'net', preset: 'weak' },
  { tMs: 2502, kind: 'netfault', fault: 'silent', dur: 3 },
  { tMs: 2503, kind: 'netfault', fault: 'reboot' },
  { tMs: 2600, kind: 'adc', ideal: true },
  { tMs: 2700, kind: 'bat', pct: 40, usb: true },
  { tMs: 2800, kind: 'pwrkey', long: true },
  { tMs: 2900, kind: 'env', temp: 35, humidity: 45, pressure: 101325 },
];
const LOG: InputLog = { version: 1, chip: 'esp32c3', i2c: [{ kind: 'bme280', addr: 0x76 }], lcd: false, events: EVENTS, endMs: 3123.456789 };
const actions = (evs: InputEvent[]) => evs.map(action).filter((a) => a !== null);

test('fromScript inverts toScript / toScriptBody / toScriptInline for every action', () => {
  const want = actions(EVENTS);
  assert.deepEqual(actions(fromScript(toScript(LOG))), want);
  assert.deepEqual(actions(fromScript(toScriptBody(EVENTS))), want);
  // Inline form splits on "; ": only safe without text payloads containing it
  const plain = EVENTS.filter((e) => e.kind !== 'uart');
  assert.deepEqual(actions(fromScript(toScriptInline({ ...LOG, events: plain }))), actions(plain));
  // Times survive at microsecond precision (floored), so replay applies them in the same 1 ms slice
  const ev = fromScript(toScriptBody(EVENTS)).find((e) => e.kind === 'gpio')!;
  assert.equal(ev.tMs, 1203.456);
  assert.equal(toScriptBody(fromScript(toScriptBody(EVENTS))), toScriptBody(EVENTS));
});

test('fromScript rejects garbage', () => {
  assert.throws(() => fromScript('0.1:nope=1'));
  assert.throws(() => fromScript('x:gpio0=1'));
  assert.throws(() => fromScript('0.1:env=1,2'));
});

test('redact drops real-network replies and non-demo Wi-Fi credentials', () => {
  const r = redact(EVENTS);
  assert.deepEqual(r.cut.sort(), ['net', 'wifi']);
  assert.ok(!r.events.some((e) => e.kind === 'netreply' || e.kind === 'realnet'));
  const post = r.events.find((e) => e.kind === 'phone' && e.cmd.startsWith('post'))!;
  assert.equal(post.kind === 'phone' && post.cmd, 'post,,ssid=***&pass=***');
  // The virtual router's public demo values stay, so the default provisioning flow still replays exactly
  const demo = redact([{ tMs: 1, kind: 'phone', cmd: 'post,,ssid=MyHome&pass=12345678' }]);
  assert.deepEqual(demo.cut, []);
  assert.equal(demo.events[0].kind === 'phone' && demo.events[0].cmd, 'post,,ssid=MyHome&pass=12345678');
});

const base = {
  workId: 'blank',
  example: 'weather',
  fwName: 'weather/flash.bin',
  fwBuf: new Uint8Array([1, 2, 3]).buffer,
  chip: 'esp32c3' as const,
  scene: { parts: [{ type: 'bme280', addr: 0x76 }] } as never,
  defaultScene: { parts: [{ type: 'bme280', addr: 0x76 }] } as never,
  ext5v: false,
  mods: {},
  harness: null,
  defaultHarness: { i2cCm: 6, obstacle: 'none' as const, distMm: 20 },
  env: { temp: 23.5, humidity: 45, pressure: 101325 },
  heat: null,
  loc: 'zh',
  log: LOG,
};

test('captureState writes only what differs from the defaults', async () => {
  const { state, ownFw } = await captureState(base);
  assert.equal(ownFw, false);
  assert.equal(state.w, 'blank:weather');
  // sha256(01 02 03)[:10]
  assert.deepEqual(state.fw, { ex: 'weather', h: '039058c6f2' });
  assert.equal(state.scene, undefined);
  assert.equal(state.mods, undefined);
  assert.equal(state.env, undefined);
  assert.equal(state.run!.endMs, LOG.endMs);
  assert.ok(!state.run!.s.includes('netreply') && !state.run!.s.includes('s3cret'));
  const own = await captureState({ ...base, fwName: 'mine.bin', mods: { drop: ['w1'] }, scene: { parts: [] } as never });
  assert.equal(own.ownFw, true);
  assert.equal(own.state.fw, undefined);
  assert.equal(own.state.run, undefined);
  assert.deepEqual(own.state.mods, { drop: ['w1'] });
  assert.deepEqual(own.state.scene, { parts: [] });
  assert.deepEqual(own.state.env, base.env);
});

test('encode / decode round trip, version and corruption errors', async () => {
  const { state } = await captureState(base);
  const s = await encodeState(state);
  assert.match(s, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(await decodeState(s), JSON.parse(JSON.stringify(state)));
  assert.match(shareKey(s), /^share:[0-9a-f]{8}$/);
  const bad = async (x: string, reason: string) => {
    await assert.rejects(decodeState(x), (e: unknown) => e instanceof ShareDecodeError && e.reason === reason);
  };
  await bad('not*base64', 'corrupt');
  await bad(s.slice(0, s.length - 6), 'corrupt');
  await bad(await encodeState({ v: 2, w: 'weather' } as unknown as ShareState), 'newer');
  await bad(await encodeState({ v: 1 } as unknown as ShareState), 'corrupt');
  await bad(await encodeState({ v: 1, w: 'weather', run: { endMs: 1, s: '0.1:bogus=1' } }), 'corrupt');
});

test('typical bench fits a short link; very long runs fall back to the bench-only link', async () => {
  const { state } = await captureState(base);
  const short = await shareLink('http://x/app', state);
  assert.ok(!short.truncated && short.s.length < 2000, `${short.s.length} chars`);
  assert.ok(short.url.startsWith('http://x/app?s=') && short.url.endsWith('#bench'));
  // 3000 pseudo-random pot moves do not compress below the link budget
  let x = 1;
  const many: InputEvent[] = [{ tMs: 0, kind: 'env', temp: 21, humidity: 40, pressure: 101000 }];
  for (let i = 0; i < 3000; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    many.push({ tMs: i * 3.7 + (x % 1000) / 1000, kind: 'pot', pin: 1, mv: x % 3300 });
  }
  const big = await captureState({ ...base, log: { ...LOG, events: many } });
  const long = await shareLink('http://x/app', big.state);
  assert.ok(long.truncated && long.s.length <= SHARE_LINK_MAX);
  const back = await decodeState(long.s);
  assert.equal(back.run, undefined);
  assert.deepEqual(back.env, { temp: 21, humidity: 40, pressure: 101000 });
});

test(".tryboard file round trip with the user's own bin; checks magic, version, size and sha256 (F-01b)", async () => {
  const own = await captureState({ ...base, fwName: 'my/blink.bin', ownRun: true });
  assert.equal(own.ownFw, true);
  assert.equal(own.state.run!.endMs, LOG.endMs);
  // Binary that is not UTF-8 and contains newlines
  const bin = new Uint8Array([0xe9, 0x0a, 0xff, 0x00, 0x0a, 0x80]).buffer;
  const bytes = await packTryfile(own.state, bin, 'my/blink.bin');
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 11)), 'TRYBOARD 1\n');
  const back = await unpackTryfile(bytes);
  assert.deepEqual(new Uint8Array(back.bin!), new Uint8Array(bin));
  assert.equal(back.state.bin!.name, 'my-blink.bin');
  assert.equal(back.state.bin!.size, 6);
  assert.match(back.state.bin!.h, /^[0-9a-f]{64}$/);
  assert.deepEqual({ ...back.state, bin: undefined }, { ...own.state, bin: undefined });
  // The state survives the ?s= hop the page makes after opening the file
  assert.deepEqual(await decodeState(await encodeState(back.state)), back.state);
  const reject = (b: Uint8Array, reason: 'corrupt' | 'newer') => assert.rejects(unpackTryfile(b), (e) => e instanceof ShareDecodeError && e.reason === reason);
  const flip = bytes.slice();
  flip[flip.length - 1] ^= 1;
  await reject(flip, 'corrupt');
  await reject(bytes.slice(0, -1), 'corrupt');
  await reject(new TextEncoder().encode('TRYBOARD 2\n{}\n'), 'newer');
  await reject(new TextEncoder().encode('hello\n{}\n'), 'corrupt');
  await reject(new TextEncoder().encode('TRYBOARD 1\n{"v":1,"w":"x","bin":{"name":"a","h":"00","size":1}}\nA'), 'corrupt');
  // Built-in firmware: no bin bytes, the file is just the state (long runs that a link drops)
  const builtin = await unpackTryfile(await packTryfile((await captureState(base)).state, null));
  assert.equal(builtin.bin, null);
  assert.equal(builtin.state.fw!.ex, 'weather');
});

test('F-02 QR budget: a mid-size run fits the 8000 link but is dropped at the card max of 2000', async () => {
  let x = 7;
  const mid: InputEvent[] = [{ tMs: 0, kind: 'env', temp: 22, humidity: 41, pressure: 101100 }];
  for (let i = 0; i < 600; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    mid.push({ tMs: i * 3.7 + (x % 1000) / 1000, kind: 'pot', pin: 1, mv: x % 3300 });
  }
  const { state } = await captureState({ ...base, log: { ...LOG, events: mid } });
  const full = await shareLink('http://x/app', state);
  assert.ok(!full.truncated && full.s.length > 2000, `${full.s.length} chars`);
  const card = await shareLink('http://x/app', state, 2000 - 'http://x/app?s=#bench'.length);
  assert.ok(card.truncated && card.url.length <= 2000, `${card.url.length} chars`);
  assert.deepEqual((await decodeState(card.s)).env, { temp: 22, humidity: 41, pressure: 101100 });
});
