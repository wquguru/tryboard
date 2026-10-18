// 接线错误走网络求解（P2-14）：wirecheck 给每种错接带上网表参数；有 wasm 产物时直接用它求解，数值与 core/crates/elec/src/fault.rs 的测试同一组
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { wiresOf } from '../src/app/wiring.ts';
import { checkWiring, type WireFault } from '../src/app/wirecheck.ts';
import { consequence, estimateNet, type FaultExports } from '../src/app/faultsolve.ts';

const WEATHER = [
  { type: 'oled', addr: 0x3c, sda: 8, scl: 9 },
  { type: 'bme280', addr: 0x76, sda: 8, scl: 9 },
  { type: 'servo', pin: 4 },
] as never[];
const SONAR = [{ type: 'hcsr04', trig: 17, echo: 18 }] as never[];
const check = (p: never[], mods = {}) => checkWiring(p, wiresOf(p, false, mods));
const one = (fs: WireFault[], rule: string) => {
  const f = fs.find((x) => x.rule === rule);
  assert.ok(f, `没有 ${rule}：${fs.map((x) => x.rule)}`);
  return f!;
};

const CASES = {
  drive: () => one(check([...WEATHER, { type: 'pot', pin: 4 }] as never[]), 'W1'),
  nores: () => one(check([...WEATHER, { type: 'led', pin: 6 }] as never[], { noResistor: ['led:6'] }), 'W3'),
  short3v3: () => one(check(WEATHER, { jumpers: [['3V3', 'GND']] }), 'W7'),
  short5v: () => one(check(WEATHER, { jumpers: [['GND', '5V']] }), 'W7'),
  nodiv: () => one(check(SONAR, { noDivider: ['hcsr04'] }), 'W2'),
  bme5v: () => one(check(WEATHER, { retarget: { 'wire:3V3~bme280:VIN': '5V' } }), 'W2'),
};

test('每种错接都带网表：kind 与参数对得上 tb_fault', () => {
  assert.deepEqual(CASES.drive().net, {
    kind: 1,
    cases: [
      { args: [3.3, 1], what: '电位器滑片转到头（≈ 直接接 3V3 / GND），GPIO 输出相反电平' },
      { args: [0, 1], what: '电位器滑片转到头（≈ 直接接 3V3 / GND），GPIO 输出相反电平' },
    ],
  });
  assert.deepEqual(CASES.nores().net?.kind, 3);
  assert.deepEqual(CASES.short3v3().net?.cases[0].args, [0]);
  assert.deepEqual(CASES.short5v().net?.cases[0].args, [1]);
  assert.deepEqual(CASES.nodiv().net?.cases.map((c) => c.args), [[50]]);
  assert.deepEqual(CASES.bme5v().net?.cases.map((c) => c.args), [[10_000], [10_000]]);
  // 跳线不算零件：默认接线加一根无害跳线（GND 接 GND）不出新问题
  assert.deepEqual(check(WEATHER, { jumpers: [['GND', 'GND']] }).map((f) => f.rule), []);
});

test('后果文字按门限分档（不依赖 wasm）', () => {
  assert.match(consequence(1, { i: 0.097, vPin: 0.1, v5: NaN, v33: NaN, limiter: 0 }), /超过数据手册 40 mA 上限（2\.4 倍）/);
  assert.match(consequence(3, { i: 0.0349, vPin: 2.15, v5: NaN, v33: NaN, limiter: 0 }), /1\.7 倍过流/);
  assert.match(consequence(4, { i: 0.717, vPin: 0, v5: 0.41, v33: 0.04, limiter: 4 }), /板载 LDO 掉进压差区/);
  assert.match(consequence(5, { i: 0.0001, vPin: 3.9, v5: 5, v33: 3.3, limiter: 0 }), /电流不大/);
});

const WASM = new URL('../public/wasm/tryboard.wasm', import.meta.url);
test('wasm 求解：电流与 elec 单元测试 / ngspice 同一量级（tools/build_web.sh 之后才跑）', { skip: !existsSync(WASM) && '没有 public/wasm/tryboard.wasm' }, async () => {
  const { instance } = await WebAssembly.instantiate(readFileSync(WASM), {});
  const x = instance.exports as unknown as FaultExports;
  const mA = (f: WireFault) => estimateNet(x, f.net!, false)!.mA;
  // 电位器接地 vs GPIO 推高 33 Ω：3.3 / 34 = 97.1 mA（比推低那组 90.8 mA 大，取最坏）
  assert.equal(mA(CASES.drive()), 97.1);
  // GPIO 33 Ω + 红灯 1.8 V / 10 Ω：(3.3 - 1.8) / 43 = 34.9 mA
  assert.equal(mA(CASES.nores()), 34.9);
  // 3V3 短路：USB 限流折返 + LDO 压差，≈ 0.72 A；5V 短路只剩 USB 口限流，≈ 0.74 A（与 13 / 14-*.cir 同解）
  assert.ok(Math.abs(mA(CASES.short3v3()) - 717) < 2, String(mA(CASES.short3v3())));
  assert.ok(Math.abs(mA(CASES.short5v()) - 736) < 2, String(mA(CASES.short5v())));
  // HC-SR04 Echo 直连 5 V（50 Ω）进钳位：≈ 18 mA；BME280 10 kΩ 上拉只有 0.1 mA
  assert.ok(Math.abs(mA(CASES.nodiv()) - 18) < 1, String(mA(CASES.nodiv())));
  assert.ok(mA(CASES.bme5v()) > 0.05 && mA(CASES.bme5v()) < 0.2, String(mA(CASES.bme5v())));
  // 同样参数再算一遍，结果逐位相同
  assert.deepEqual(estimateNet(x, CASES.short3v3().net!, false), estimateNet(x, CASES.short3v3().net!, false));
  assert.match(estimateNet(x, CASES.short3v3().net!, false)!.text, /由板载 LDO 掉进压差区限住/);
});
