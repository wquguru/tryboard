// 线束（P2-11，估算）：I2C 线长 → 上升时间、天线遮挡 → RSSI。与内核 core/crates/elec/src/i2cbus.rs、soc/src/wifi/world.rs 同一组数对拍；
// 实验台接线检查 W6；USB 关卡判定（P2-12）与 tools/check.py 同一规则
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { antennaLossDb, i2cLoad, maxWireCm, riseNs, rssiAfter, verdict, limitNs, wifiText } from '../src/app/harness.ts';
import { checkWiring } from '../src/app/wirecheck.ts';
import { benchI2cWire, wiresOf } from '../src/app/wiring.ts';
import { evaluate, bootOptions, type Level } from '../src/checks.ts';
import { action } from '../src/inputlog.ts';

test('I2C 上升时间：与内核 i2cbus.rs 的单测同一组数', () => {
  assert.ok(Math.abs(riseNs(20, 2) - 211.825) < 0.01);
  assert.equal(verdict(riseNs(20, 2), limitNs(400_000)), 'ok');
  assert.equal(verdict(riseNs(60, 2), limitNs(400_000)), 'marginal');
  assert.equal(verdict(riseNs(150, 2), limitNs(400_000)), 'fail');
  assert.equal(verdict(riseNs(150, 2), limitNs(100_000)), 'ok');
  assert.ok(Math.abs(maxWireCm(2) - 40.81) < 0.01);
  // 确定性：同样输入永远同样结果
  assert.deepEqual(i2cLoad(60, 2), i2cLoad(60, 2));
});

test('天线遮挡：金属贴着 45 dB → -87 dBm 连不上；10 mm 外 23 dB 能连；20 mm 外不影响', () => {
  assert.equal(antennaLossDb('metal', 0), 45);
  assert.equal(antennaLossDb('battery', 0), 30);
  assert.equal(antennaLossDb('metal', 10), 23);
  assert.equal(antennaLossDb('metal', 20), 0);
  assert.equal(antennaLossDb('none', 0), 0);
  assert.equal(rssiAfter(45), -87);
  assert.equal(wifiText(45).level, 'fail');
  assert.equal(wifiText(23).level, 'marginal');
  assert.equal(wifiText(0).level, 'ok');
  // 内核 --antenna-loss 30：TryBoard-WiFi -72（accept.json wifi-scan-antenna）
  assert.equal(rssiAfter(30), -72);
});

const weather = [
  { type: 'oled' as const, addr: 0x3c, sda: 8, scl: 9 },
  { type: 'bme280' as const, addr: 0x76, sda: 8, scl: 9 },
];

test('接线检查 W6：拉长 BME280 的线，60 cm 警告、150 cm 阻断；默认 10 cm 不报', () => {
  assert.equal(checkWiring(weather, wiresOf(weather)).filter((f) => f.rule === 'W6').length, 0);
  const mid = checkWiring(weather, wiresOf(weather, false, { lenCm: { bme280: 50 } })).find((f) => f.rule === 'W6');
  assert.ok(mid && mid.level === 'warn' && mid.confidence === '必须上真机', JSON.stringify(mid));
  assert.match(mid.detail, /一共 60 cm/);
  assert.equal(mid.wires.length, 4);
  const bad = checkWiring(weather, wiresOf(weather, false, { lenCm: { bme280: 140 } })).find((f) => f.rule === 'W6');
  assert.ok(bad && bad.level === 'block');
  // 交给模拟器的总线长度：没改过 = 理想（-1），改过 = SDA 总长
  assert.equal(benchI2cWire(weather, {}), -1);
  assert.equal(benchI2cWire(weather, { lenCm: { bme280: 50 } }), 60);
});

test('线束进输入日志：i2cwire=cm / antenna=dB，关卡参数 --i2c-wire / --antenna-loss / --usb-log', () => {
  assert.equal(action({ tMs: 0, kind: 'i2cwire', cm: 60 }), 'i2cwire=60');
  assert.equal(action({ tMs: 0, kind: 'antenna', db: 30 }), 'antenna=30');
  const o = bootOptions({ args: ['--usb-log', '--i2c-wire', '60', '--antenna-loss', '30'] } as Level);
  assert.equal(o.usb, true);
  assert.equal(o.i2cWire, 60);
  assert.equal(o.antenna, 30);
});

test('USB 关卡判定：状态 + 打出的字（与 tools/check.py 同样的文字）', () => {
  const l = { id: 'usbkey-3', usb: { state: '已配置', typed: 'aHello TryBoard\n' } } as Level;
  const ok = evaluate(l, 'TRYBOARD_OK', '[tryboard] USB 主机：已配置\n[tryboard] USB 键盘输入: "aHello TryBoard\\n"\n');
  assert.deepEqual(ok.map((r) => r.ok), [true, true]);
  assert.equal(ok[1].text, '电脑上打出 “aHello TryBoard↵”（要 “aHello TryBoard↵”）');
  const none = evaluate(l, '', '');
  assert.deepEqual(none.map((r) => r.text), ['电脑看到的 USB 设备：没有 USB 设备（要已配置）', '电脑上打出 “”（要 “aHello TryBoard↵”）']);
});
