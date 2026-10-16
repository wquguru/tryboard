// 逻辑分析仪数据层（P1-05）与 ⌘K 匹配（P1-06）的纯函数
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { B_NACK, B_READ, B_RESTART, IoStore, K, decodeEvents, eventLine, pwmLabel, txnNote, txnText, type IoEvent } from '../src/app/iotrace.ts';
import { fuzzy, highlight, parseRun, parseTemp, pushRecent } from '../src/app/cmdmatch.ts';

function bytes(evs: IoEvent[]) {
  const b = new Uint8Array(evs.length * 16);
  const dv = new DataView(b.buffer);
  evs.forEach((e, i) => {
    const o = i * 16;
    dv.setUint32(o, e.t % 2 ** 32, true);
    dv.setUint32(o + 4, Math.floor(e.t / 2 ** 32), true);
    dv.setUint8(o + 8, e.kind);
    dv.setUint8(o + 9, e.a);
    dv.setUint16(o + 10, e.b, true);
    dv.setUint32(o + 12, e.v, true);
  });
  return b;
}

/** BME280 一次突发读：START 0x76 W · 0xF7 · RESTART 0x76 R · 8 B · STOP（与 weather 固件在命令行 --trace-io 里看到的一致） */
function burst(t0: number, bit = 404): IoEvent[] {
  const ev: IoEvent[] = [{ t: t0, kind: K.I2C_START, a: 0, b: 0, v: bit }];
  let t = t0 + bit;
  ev.push({ t, kind: K.I2C_ADDR, a: 0x76, b: 0, v: 0 });
  ev.push({ t: (t += 9 * bit), kind: K.I2C_DATA, a: 0xf7, b: 0, v: 0 });
  ev.push({ t: (t += 9 * bit), kind: K.I2C_START, a: 0, b: B_RESTART, v: bit });
  ev.push({ t: (t += bit), kind: K.I2C_ADDR, a: 0x76, b: B_READ, v: 0 });
  for (let i = 0; i < 8; i++) ev.push({ t: (t += 9 * bit), kind: K.I2C_DATA, a: 0x60 + i, b: B_READ | (i === 7 ? B_NACK : 0), v: 0 });
  ev.push({ t: t + 9 * bit, kind: K.I2C_STOP, a: 0, b: 0, v: 0 });
  return ev;
}

test('事件字节解码与文本行和 Rust IoEvent::line 一致', () => {
  const evs: IoEvent[] = [
    { t: 1, kind: K.PWM, a: 4, b: 5489, v: 50000 },
    { t: 5, kind: K.I2C_ADDR, a: 0x76, b: B_READ, v: 0 },
    { t: 2 ** 40 + 7, kind: K.GPIO, a: 0, b: 1, v: 0 },
    { t: 9, kind: K.WS2812, a: 48, b: 1, v: 0x002000 },
    { t: 10, kind: K.I2C_START, a: 0, b: B_RESTART | (1 << 15), v: 404 },
  ];
  const back = decodeEvents(bytes(evs));
  assert.deepEqual(back, evs);
  assert.deepEqual(back.map(eventLine), ['1 PWM 4 5489 50000', '5 I2C0 ADDR 76 R ACK', `${2 ** 40 + 7} GPIO 0 1`, '9 WS2812 48 1 002000', '10 I2C1 RESTART 404']);
});

test('I2C 事务解码：泡泡文字 + BME280 寄存器注释', () => {
  const s = new IoStore();
  s.append(burst(1000));
  const xs = s.i2c.get(0)!;
  assert.equal(xs.length, 1);
  assert.equal(txnText(xs[0]), 'START 0x76 W · 0xF7 · RESTART 0x76 R · 8 B · STOP');
  assert.match(txnNote(xs[0]), /温度/);
  assert.ok(xs[0].done);
  // 结束时刻 = STOP 之后一位
  assert.equal(xs[0].t1, burst(1000).at(-1)!.t + 404);
});

test('I2C：地址没应答、命令分两批（END 之后接着 RESTART）、SSD1306 命令与显存', () => {
  const s = new IoStore();
  s.append([
    { t: 0, kind: K.I2C_START, a: 0, b: 0, v: 400 },
    { t: 400, kind: K.I2C_ADDR, a: 0x08, b: B_NACK, v: 0 },
    { t: 4000, kind: K.I2C_STOP, a: 0, b: 0, v: 0 },
  ]);
  s.append([
    { t: 10000, kind: K.I2C_START, a: 0, b: 0, v: 400 },
    { t: 10400, kind: K.I2C_ADDR, a: 0x3c, b: 0, v: 0 },
    { t: 14000, kind: K.I2C_DATA, a: 0x00, b: 0, v: 0 },
    { t: 17600, kind: K.I2C_DATA, a: 0xaf, b: 0, v: 0 },
    { t: 21200, kind: K.I2C_STOP, a: 0, b: 0, v: 0 },
    { t: 30000, kind: K.I2C_START, a: 0, b: 0, v: 400 },
    { t: 30400, kind: K.I2C_ADDR, a: 0x3c, b: 0, v: 0 },
    { t: 34000, kind: K.I2C_DATA, a: 0x40, b: 0, v: 0 },
    ...Array.from({ length: 16 }, (_, i) => ({ t: 37600 + i * 3600, kind: K.I2C_DATA, a: i, b: 0, v: 0 })),
    { t: 100000, kind: K.I2C_STOP, a: 0, b: 0, v: 0 },
  ]);
  const xs = s.i2c.get(0)!;
  assert.equal(xs.length, 3);
  assert.equal(txnText(xs[0]), 'START 0x08 W NACK · STOP');
  assert.match(txnNote(xs[0]), /没有器件应答/);
  assert.equal(txnText(xs[1]), 'START 0x3C W · 0x00 · 0xAF · STOP');
  assert.equal(txnNote(xs[1]), 'OLED 命令：开显示');
  assert.equal(txnNote(xs[2]), '写显存 16 字节');
  assert.match(txnText(xs[2]), /17 B/);
});

test('PWM / GPIO 按通道整理、导出文本', () => {
  const s = new IoStore();
  s.append([
    { t: 10, kind: K.PWM, a: 4, b: 5488, v: 50000 },
    { t: 20, kind: K.GPIO, a: 0, b: 0, v: 0 },
    { t: 30, kind: K.PWM, a: 4, b: 0, v: 0 },
  ]);
  const p = s.pwm.get(4)!;
  assert.deepEqual(p.t, [10, 30]);
  assert.ok(Math.abs(p.duty[0] - 0.08374) < 1e-4);
  assert.equal(p.freq[0], 50);
  assert.equal(pwmLabel(p.duty[0], p.freq[0]), '50 Hz · 1.675 ms');
  assert.equal(pwmLabel(0.5, 2700), '2.70 kHz · 185.2 µs');
  assert.deepEqual(s.gpio.get(0)!.v, [0]);
  assert.equal(s.text(), '10 PWM 4 5488 50000\n20 GPIO 0 0\n30 PWM 4 0 0\n');
});

test('⌘K：模糊匹配、参数识别、最近命令', () => {
  assert.ok(fuzzy('室温', '把室温设为 … ℃'));
  assert.ok(fuzzy('gpio4', 'GPIO4')!.score > fuzzy('gpio4', 'GPIO48')!.score);
  assert.equal(fuzzy('xyz', 'GPIO4'), null);
  assert.ok(fuzzy('fxy', '打开逻辑分析仪', '逻辑分析仪 示波器 fenxiyi') !== null);
  assert.equal(parseTemp('室温 35'), 35);
  assert.equal(parseTemp('把室温设为 18.5 ℃'), 18.5);
  assert.equal(parseTemp('GPIO4'), null);
  assert.equal(parseRun('回到第 1 次运行'), 1);
  assert.equal(parseRun('GPIO4'), null);
  assert.equal(highlight('GPIO4', [0, 1]), '<mark>GP</mark>IO4');
  assert.deepEqual(pushRecent(['a', 'b', 'c'], 'b', 3), ['b', 'a', 'c']);
});
