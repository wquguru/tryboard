// 编码器（P2-01）/ HC-SR04（P2-04）：接线、5 V 规则、输入日志动作与命令行参数
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wiresOf } from '../src/app/wiring.ts';
import { checkWiring } from '../src/app/wirecheck.ts';
import { action, cliArgs, toScript, type InputLog } from '../src/inputlog.ts';
import { bootOptions } from '../src/checks.ts';

const ENC = { type: 'encoder', a: 6, b: 7, sw: 15 } as const;
const SONAR = { type: 'hcsr04', trig: 17, echo: 18 } as const;
const rules = (p: unknown[], mods = {}) => checkWiring(p as never[], wiresOf(p as never[], false, mods)).map((f) => f.rule);

test('编码器五根线、超声波四根线：id 与 3D 台面同一套', () => {
  assert.deepEqual(wiresOf([ENC] as never[]).map((w) => w.id), ['wire:GND~encoder:GND', 'wire:3V3~encoder:+', 'wire:GPIO15~encoder:SW', 'wire:GPIO7~encoder:DT', 'wire:GPIO6~encoder:CLK']);
  assert.deepEqual(wiresOf([SONAR] as never[]).map((w) => w.id), ['wire:5V~hcsr04:VCC', 'wire:GPIO17~hcsr04:Trig', 'wire:GPIO18~hcsr04:Echo', 'wire:GND~hcsr04:GND']);
});

test('默认接法没有问题：编码器 3V3 上拉、超声波 Echo 经分压', () => {
  assert.deepEqual(rules([ENC, SONAR]), []);
});

test('W2：拆掉 Echo 分压 / 场景声明直连 / 编码器上拉改接 5V，都是 5 V 进 GPIO', () => {
  assert.deepEqual(rules([SONAR], { noDivider: ['hcsr04'] }), ['W2']);
  assert.deepEqual(rules([{ ...SONAR, divider: false }]), ['W2']);
  const f = checkWiring([SONAR] as never[], wiresOf([SONAR] as never[], false, { noDivider: ['hcsr04'] }));
  assert.ok(f[0].wires.includes('wire:GPIO18~hcsr04:Echo'));
  assert.deepEqual(rules([ENC], { retarget: { 'wire:3V3~encoder:+': '5V' } }), ['W2']);
});

test('W1：编码器 A 相和 LED 接同一个 GPIO（模块上拉在推电平）', () => {
  assert.deepEqual(rules([ENC, { type: 'led', pin: 6 }]), ['W1']);
});

test('输入日志动作：enc=+N / enc=-N、encsw=1|0、dist=厘米（两位小数）；命令行带 --encoder / --sonar', () => {
  assert.equal(action({ tMs: 1, kind: 'enc', steps: 3 }), 'enc=+3');
  assert.equal(action({ tMs: 1, kind: 'enc', steps: -2 }), 'enc=-2');
  assert.equal(action({ tMs: 1, kind: 'encsw', down: true }), 'encsw=1');
  assert.equal(action({ tMs: 1, kind: 'dist', cm: 25.3 }), 'dist=25.3');
  const log: InputLog = { version: 1, i2c: [], lcd: false, encoder: { a: 6, b: 7, sw: 15 }, sonar: { trig: 17, echo: 18 }, events: [{ tMs: 0, kind: 'dist', cm: 25 }, { tMs: 512.25, kind: 'enc', steps: 1 }] };
  assert.deepEqual(cliArgs(log, 'fw.bin', 'in.txt'), ['tryboard', 'run', 'fw.bin', '--encoder', '6,7,15', '--sonar', '17,18', '--inputs', 'in.txt']);
  assert.match(toScript(log), /0\.000000:dist=25\n0\.512250:enc=\+1\n/);
});

test('关卡 args 翻译成启动选项：--encoder / --sonar / --dist', () => {
  const o = bootOptions({ args: ['--encoder', '6,7', '--sonar', '17,18', '--dist', '42'] } as never);
  assert.deepEqual(o.encoder, { a: 6, b: 7 });
  assert.deepEqual(o.sonar, { trig: 17, echo: 18, cm: 42 });
});
