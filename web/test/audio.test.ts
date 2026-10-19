// I2S audio: web-side frequency measurement (pcm.ts analyze, same algorithm as devices/audio.rs), wiring, replay args
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/pcm.ts';
import { wiresOf, partInfo } from '../src/app/wiring.ts';
import { cliArgs } from '../src/inputlog.ts';

test('analyze: a 440 Hz sine at 48 kHz measures 440 Hz, RMS = amplitude / √2', () => {
  const x = Float32Array.from({ length: 8192 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / 48000));
  const r = analyze(x, 48000);
  assert.ok(Math.abs(r.freq - 440) < 0.05, String(r.freq));
  assert.ok(Math.abs(r.rms - 0.3 / Math.SQRT2) < 1e-3);
  assert.equal(analyze(new Float32Array(100), 48000).freq, 0);
});

test('MAX98357A / INMP441 wiring: amp on 5 V, mic L/R to ground', () => {
  const w = wiresOf([{ type: 'max98357a' }, { type: 'inmp441' }]);
  const pick = (part: string, pin: string) => w.find((x) => x.part === part && x.pin === pin)?.a;
  assert.equal(pick('max98357a', 'Vin'), '5V');
  assert.equal(pick('max98357a', 'DIN'), 'GPIO18');
  assert.equal(pick('inmp441', 'L/R'), 'GND');
  assert.equal(pick('inmp441', 'SD'), 'GPIO41');
  assert.match(partInfo({ type: 'inmp441' }).iface, /SD 41/);
});

test('I2S devices and test WAV in the input log become --i2s / --mic', () => {
  const a = cliArgs({ version: 1, i2c: [], lcd: false, i2s: ['max98357a', 'inmp441'], mic: 'sine1k.wav', events: [] }, 'fw.bin', 'in.txt');
  assert.deepEqual(a.slice(a.indexOf('--i2s'), a.indexOf('--i2s') + 4), ['--i2s', 'max98357a,inmp441', '--mic', 'tools/audio/sine1k.wav']);
});
