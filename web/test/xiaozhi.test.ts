// F-09b-2: voice server inputs round-trip through the input log, CLI flags carry the I2S pins and mic clip
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { action, cliArgs, fromAction, type InputLog } from '../src/inputlog.ts';
import { bubbles, sayText } from '../src/app/xzfeed.ts';
import { attachI2s } from '../src/partsdev.ts';

test('xz= actions round-trip', () => {
  for (const cmd of ['on', 'voice,demo', 'script,weather', 'say,Hi there', 'off']) {
    const a = action({ tMs: 0, kind: 'xz', cmd });
    assert.equal(a, `xz=${cmd}`);
    assert.deepEqual(fromAction(a!), { kind: 'xz', cmd });
  }
});

test('say text cannot break the script format', () => {
  assert.equal(sayText('  a;b # c\nd  '), 'a b c d');
  assert.equal(sayText('x'.repeat(300)).length, 200);
});

test('bubbles: stt is the user, tts sentences the assistant', () => {
  const b = bubbles([
    [1, 'listen start (manual)'],
    [2, 'stt "Hello"'],
    [3, 'tts start'],
    [4, 'tts sentence_start "Hi, I am the TryBoard virtual assistant."'],
  ]);
  assert.deepEqual(b.map((x) => [x.who, x.text]), [
    ['user', 'Hello'],
    ['bot', 'Hi, I am the TryBoard virtual assistant.'],
  ]);
});

test('I2S entries kind@bclk:ws:data reach the CLI flags and the wasm attach, as in the accept case', () => {
  const i2s = ['max98357a@15:16:7', 'inmp441@5:4:6'];
  const log: InputLog = { version: 1, chip: 'esp32s3', i2c: [{ kind: 'ssd1306', addr: 0x3c }], lcd: false, i2s, mic: 'xz_mic.wav', events: [] };
  const a = cliArgs(log, 'fw.bin', 'in.txt');
  assert.equal(a[a.indexOf('--i2s') + 1], 'max98357a@15:16:7,inmp441@5:4:6');
  assert.equal(a[a.indexOf('--mic') + 1], 'tools/audio/xz_mic.wav');
  const calls: unknown[][] = [];
  const ok = attachI2s({ tb_i2s_attach: (k: number) => (calls.push(['def', k]), 0), tb_i2s_attach_at: (k: number, b: number, w: number, d: number) => (calls.push([k, b, w, d]), 0) }, i2s);
  assert.equal(ok, true);
  assert.deepEqual(calls, [
    [0, 15, 16, 7],
    [1, 5, 4, 6],
  ]);
});
