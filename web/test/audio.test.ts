// I2S 音频：网页侧测频（pcm.ts analyze，与内核 devices/audio.rs 同一算法）、音频器件的接线与输入日志的重放参数
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/pcm.ts';
import { wiresOf, partInfo } from '../src/app/wiring.ts';
import { cliArgs } from '../src/inputlog.ts';

test('analyze：48 kHz 下 440 Hz 正弦测得 440 Hz、RMS = 幅度 / √2', () => {
  const x = Float32Array.from({ length: 8192 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / 48000));
  const r = analyze(x, 48000);
  assert.ok(Math.abs(r.freq - 440) < 0.05, String(r.freq));
  assert.ok(Math.abs(r.rms - 0.3 / Math.SQRT2) < 1e-3);
  assert.equal(analyze(new Float32Array(100), 48000).freq, 0);
});

test('MAX98357A / INMP441 的接线：功放吃 5 V，麦克风 L/R 接地', () => {
  const w = wiresOf([{ type: 'max98357a' }, { type: 'inmp441' }]);
  const pick = (part: string, pin: string) => w.find((x) => x.part === part && x.pin === pin)?.a;
  assert.equal(pick('max98357a', 'Vin'), '5V');
  assert.equal(pick('max98357a', 'DIN'), 'GPIO18');
  assert.equal(pick('inmp441', 'L/R'), 'GND');
  assert.equal(pick('inmp441', 'SD'), 'GPIO41');
  assert.match(partInfo({ type: 'inmp441' }).iface, /SD 41/);
});

test('输入日志里的 I2S 器件与测试 WAV 变成 --i2s / --mic', () => {
  const a = cliArgs({ version: 1, i2c: [], lcd: false, i2s: ['max98357a', 'inmp441'], mic: 'sine1k.wav', events: [] }, 'fw.bin', 'in.txt');
  assert.deepEqual(a.slice(a.indexOf('--i2s'), a.indexOf('--i2s') + 4), ['--i2s', 'max98357a,inmp441', '--mic', 'tools/audio/sine1k.wav']);
});
