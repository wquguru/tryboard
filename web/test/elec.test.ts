// 供电 / 万用表的网页侧纯函数（P1-02 / P1-04）：输入日志里的供电切换、万用表读数换算
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { action, cliArgs, toScript, type InputLog } from '../src/inputlog.ts';
import { meterVolts, powerVolts } from '../src/app/pinscope.ts';

const elec = { v5: 3.46, v3v3: 3.287, vServo: 3.38, vExt: 0, iUsb: 0.56, iExt: 0, iServo: 0.5, i3v3: 0.055, min5: 3.4, min3v3: 3.2, peakUsb: 0.58, peakServo: 0.6, resets: 0, held: false, servoAngle: 90, power: 'usb' as const };
const frame = { pwm: [-1, -1, -1, -1, 0.075], gpio: 1 << 5, enable: 1 << 5, gpioHi: 0, enableHi: 0 };

test('供电切换进输入日志，导出成 power=usb|ext，重放命令带 --servo / --power', () => {
  assert.equal(action({ tMs: 1, kind: 'supply', mode: 'ext' }), 'power=ext');
  const log: InputLog = { version: 1, i2c: [], lcd: false, servo: 4, power: 'usb', events: [{ tMs: 1500.25, kind: 'supply', mode: 'ext' }], endMs: 3000 };
  assert.match(toScript(log), /^1\.500250:power=ext$/m);
  assert.deepEqual(cliArgs(log, 'fw.bin', 'log.txt').slice(3), ['--servo', '4', '--power', 'usb', '--inputs', 'log.txt']);
});

test('万用表：电源脚 = 求解器节点电压，信号脚按逻辑电平，PWM 读平均值', () => {
  assert.equal(meterVolts('3V3', elec, frame, false).v, 3.287);
  assert.equal(meterVolts('5V', elec, frame, false).v, 3.46);
  assert.equal(meterVolts('GND', elec, frame, false).v, 0);
  assert.equal(meterVolts('GPIO5', elec, frame, false).v, 3.287);
  assert.equal(meterVolts('GPIO6', elec, frame, false).v, 0);
  assert.ok(Math.abs(meterVolts('GPIO4', elec, frame, false).v! - 0.075 * 3.287) < 1e-12);
  assert.equal(meterVolts('EXT5V', elec, frame, false).v, null);
  // 欠压复位按住时引脚高阻、EN 被拉低
  assert.equal(meterVolts('GPIO5', { ...elec, held: true }, frame, false).v, 0);
  assert.match(powerVolts('3V3', false, elec), /^3\.287 V/);
});
