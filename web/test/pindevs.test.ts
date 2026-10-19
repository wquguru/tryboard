// Encoder (P2-01) / HC-SR04 (P2-04): wiring, 5 V rule, input log actions and CLI args
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wiresOf } from '../src/app/wiring.ts';
import { checkWiring } from '../src/app/wirecheck.ts';
import { action, cliArgs, toScript, type InputLog } from '../src/inputlog.ts';
import { bootOptions } from '../src/checks.ts';

const ENC = { type: 'encoder', a: 6, b: 7, sw: 15 } as const;
const SONAR = { type: 'hcsr04', trig: 17, echo: 18 } as const;
const rules = (p: unknown[], mods = {}) => checkWiring(p as never[], wiresOf(p as never[], false, mods)).map((f) => f.rule);

test('encoder five wires, ultrasonic four wires: same ids as the 3D bench', () => {
  assert.deepEqual(wiresOf([ENC] as never[]).map((w) => w.id), ['wire:GND~encoder:GND', 'wire:3V3~encoder:+', 'wire:GPIO15~encoder:SW', 'wire:GPIO7~encoder:DT', 'wire:GPIO6~encoder:CLK']);
  assert.deepEqual(wiresOf([SONAR] as never[]).map((w) => w.id), ['wire:5V~hcsr04:VCC', 'wire:GPIO17~hcsr04:Trig', 'wire:GPIO18~hcsr04:Echo', 'wire:GND~hcsr04:GND']);
});

test('default wiring is clean: encoder pulled up to 3V3, ultrasonic Echo through the divider', () => {
  assert.deepEqual(rules([ENC, SONAR]), []);
});

test('W2: Echo divider removed / scene declares direct / encoder pull-up on 5V are all 5 V into GPIO', () => {
  assert.deepEqual(rules([SONAR], { noDivider: ['hcsr04'] }), ['W2']);
  assert.deepEqual(rules([{ ...SONAR, divider: false }]), ['W2']);
  const f = checkWiring([SONAR] as never[], wiresOf([SONAR] as never[], false, { noDivider: ['hcsr04'] }));
  assert.ok(f[0].wires.includes('wire:GPIO18~hcsr04:Echo'));
  assert.deepEqual(rules([ENC], { retarget: { 'wire:3V3~encoder:+': '5V' } }), ['W2']);
});

test('W1: encoder phase A and an LED on the same GPIO (the module pull-up drives the level)', () => {
  assert.deepEqual(rules([ENC, { type: 'led', pin: 6 }]), ['W1']);
});

test('input log actions: enc=+N / enc=-N, encsw=1|0, dist=cm (two decimals); CLI gets --encoder / --sonar', () => {
  assert.equal(action({ tMs: 1, kind: 'enc', steps: 3 }), 'enc=+3');
  assert.equal(action({ tMs: 1, kind: 'enc', steps: -2 }), 'enc=-2');
  assert.equal(action({ tMs: 1, kind: 'encsw', down: true }), 'encsw=1');
  assert.equal(action({ tMs: 1, kind: 'dist', cm: 25.3 }), 'dist=25.3');
  const log: InputLog = { version: 1, i2c: [], lcd: false, encoder: { a: 6, b: 7, sw: 15 }, sonar: { trig: 17, echo: 18 }, events: [{ tMs: 0, kind: 'dist', cm: 25 }, { tMs: 512.25, kind: 'enc', steps: 1 }] };
  assert.deepEqual(cliArgs(log, 'fw.bin', 'in.txt'), ['tryboard', 'run', 'fw.bin', '--encoder', '6,7,15', '--sonar', '17,18', '--inputs', 'in.txt']);
  assert.match(toScript(log), /0\.000000:dist=25\n0\.512250:enc=\+1\n/);
});

test('checkpoint args become launch options: --encoder / --sonar / --dist', () => {
  const o = bootOptions({ args: ['--encoder', '6,7', '--sonar', '17,18', '--dist', '42'] } as never);
  assert.deepEqual(o.encoder, { a: 6, b: 7 });
  assert.deepEqual(o.sonar, { trig: 17, echo: 18, cm: 42 });
});
