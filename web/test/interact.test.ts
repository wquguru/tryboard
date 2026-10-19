// 实验台交互的纯函数：时间线折叠 / 回退目标 / 截断（P0-03）、运行对比（P0-13）、接线规则（P0-12）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffRuns, fold, replayInputs, runResult, seekTarget, truncate, type BenchStep, type RunRec } from '../src/app/history.ts';
import { PART_LABEL, partLabel, wiresOf } from '../src/app/wiring.ts';
import { checkWiring } from '../src/app/wirecheck.ts';

const env = (temp: number) => ({ temp, humidity: 45, pressure: 101325 });
const steps: BenchStep[] = [
  { op: { k: 'place', label: 'BME280' }, run: 1, tMs: 0 },
  { op: { k: 'run', n: 1 }, run: 1, tMs: 0 },
  { op: { k: 'env', env: env(30) }, run: 1, tMs: 1200 },
  { op: { k: 'power', ext5v: true }, run: 1, tMs: 1800 },
  { op: { k: 'run', n: 2 }, run: 2, tMs: 0 },
  { op: { k: 'heat', part: 'bme280', env: env(38) }, run: 2, tMs: 900 },
  { op: { k: 'run', n: 3 }, run: 3, tMs: 0 },
];
const ends: Record<number, number> = { 1: 2500, 2: 1600, 3: 700 };

test('回到某一步 = 下一步发生之前；下一步在别的运行里就到这次运行收尾', () => {
  const end = (n: number) => ends[n] ?? null;
  assert.deepEqual(seekTarget(steps, 1, end), { run: 1, untilMs: 1200 });
  assert.deepEqual(seekTarget(steps, 3, end), { run: 1, untilMs: 2500 });
  assert.deepEqual(seekTarget(steps, 4, end), { run: 2, untilMs: 900 });
  assert.deepEqual(seekTarget(steps, 6, end), { run: 3, untilMs: 700 });
  assert.equal(seekTarget(steps, 6, () => null), null);
  // 放零件在第一次上电前：回到运行 #1 的 0 ms
  assert.deepEqual(seekTarget(steps, 0, end), { run: 1, untilMs: 0 });
});

test('折叠：编辑状态到第 i 步为止', () => {
  assert.deepEqual(fold(steps, 2).env, env(30));
  assert.equal(fold(steps, 2).power, null);
  assert.deepEqual(fold(steps, 3).power, { ext5v: true });
  assert.equal(fold(steps, 5).heat, 'bme280');
  assert.deepEqual(fold(steps, 5).env, env(38));
});

test('截断：停在中间做新操作，后面的步骤和运行都丢掉', () => {
  const runs = [1, 2, 3].map((n) => ({ n }) as RunRec);
  const t = truncate(steps, runs, 3);
  assert.equal(t.steps.length, 4);
  assert.deepEqual(t.runs.map((r) => r.n), [1]);
});

test('重放输入去掉上电和上电时的环境', () => {
  const r = replayInputs([
    { tMs: 0, kind: 'power', on: true },
    { tMs: 0, kind: 'env', temp: 23.5, humidity: 45, pressure: 101325 },
    { tMs: 5, kind: 'gpio', pin: 0, level: 0 },
  ]);
  assert.deepEqual(r.env0, env(23.5));
  assert.equal(r.events.length, 1);
});

test('运行结果取最后一行读数；对比列出变了的项', () => {
  assert.equal(runResult('boot\r\nT=23.50 C H=45.0 % P=1013.25 hPa LED=green PWM=1675us\r\nALARM OFF\r\n'), 'T=23.50 C H=45.0 % P=1013.25 hPa LED=green PWM=1675us');
  const a = { n: 1, fw: 'w', env0: 'x', envChanges: 0, power: 'USB', heat: '无', seconds: '1 s', fingerprint: 'aaaa·bbbb', result: 'r' };
  const d = diffRuns(a, { ...a, n: 2, env0: 'y', fingerprint: 'cccc·dddd' });
  assert.deepEqual(d.filter((x) => x.changed).map((x) => x.key), ['env0', 'fingerprint']);
});

const WEATHER = [
  { type: 'oled', addr: 0x3c, sda: 8, scl: 9 },
  { type: 'bme280', addr: 0x76, sda: 8, scl: 9 },
  { type: 'servo', pin: 4 },
  { type: 'buzzer', pin: 5 },
] as const;
const parts = (extra: unknown[] = []) => [...WEATHER, ...extra] as never[];
const rules = (p: never[], mods = {}) => checkWiring(p, wiresOf(p, false, mods)).map((f) => f.rule);

test('默认三个作品接线没有问题', () => {
  assert.deepEqual(rules(parts()), []);
  assert.deepEqual(rules([{ type: 'gc9a01', spi: 2 }, { type: 'servo', pin: 4 }] as never[]), []);
  assert.deepEqual(rules([{ type: 'gc9a01', spi: 2 }] as never[]), []);
});

test('W1 输出接输出：电位器滑片接到舵机信号脚', () => assert.deepEqual(rules(parts([{ type: 'pot', pin: 4 }])), ['W1']));
test('W2 5 V 进 GPIO：BME280 供电改接 5V', () => assert.deepEqual(rules(parts(), { retarget: { 'wire:3V3~bme280:VIN': '5V' } }), ['W2']));
test('W3 LED 没有限流电阻', () => {
  assert.deepEqual(rules(parts([{ type: 'led', pin: 6 }])), []);
  assert.deepEqual(rules(parts([{ type: 'led', pin: 6 }]), { noResistor: ['led:6'] }), ['W3']);
});
test('W4 缺地', () => assert.deepEqual(rules(parts(), { drop: ['wire:GND~bme280:GND'] }), ['W4']));
test('W5 I2C 地址冲突', () => assert.deepEqual(rules(parts().map((p: { type: string }) => (p.type === 'oled' ? { ...p, addr: 0x76 } : p)) as never[]), ['W5']));
test('线 id 与 3D 台面一致', () => {
  const ids = wiresOf(parts()).map((w) => w.id);
  for (const id of ['wire:GND~oled:GND', 'wire:3V3~oled:VCC', 'wire:GPIO9~oled:SCL', 'wire:GPIO8~oled:SDA', 'wire:3V3~bme280:VIN', 'wire:GND~bme280:GND', 'wire:GPIO4~servo:PWM', 'wire:5V~servo:VCC', 'wire:GND~servo:GND']) assert.ok(ids.includes(id), id);
  // 外接 5 V：网络换成 EXT5V，id 仍按台面画的 5V 针
  assert.equal(wiresOf(parts(), true).find((w) => w.id === 'wire:5V~servo:VCC')?.a, 'EXT5V');
});

test('蜂鸣器模块三根线：VCC → 3V3、I/O → GPIO5、GND（与 3D 台面同一套 id）', () => {
  const w = wiresOf([{ type: 'buzzer', pin: 5 }]);
  assert.deepEqual(w.map((x) => x.id), ['wire:3V3~buzzer:VCC', 'wire:GPIO5~buzzer:I/O', 'wire:GND~buzzer:GND']);
  assert.deepEqual(rules([{ type: 'buzzer', pin: 5 }] as never[]), []);
});

test('零件显示名全是中文 / 型号，不漏英文 type 名', () => {
  for (const [type, name] of Object.entries(PART_LABEL)) {
    assert.notEqual(name, type, type);
    assert.equal(partLabel(type), name);
  }
  assert.equal(partLabel('buzzer'), 'Buzzer');
  assert.equal(partLabel('servo'), 'Servo');
});
