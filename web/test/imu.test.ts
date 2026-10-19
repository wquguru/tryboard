// P2-02 / P2-03: attitude conversion, imu / touch actions in the input log (same syntax as CLI scripts)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gravity, matrixPose, poseMatrix, poseToThree, threeToPose, PoseRate, angDiff } from '../src/imupose.ts';
import { action, cliArgs, roundImu, toScript, type InputLog } from '../src/inputlog.ts';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('attitude <-> rotation matrix <-> three rotation round-trip', () => {
  for (const p of [{ pitch: 0, roll: 0, yaw: 0 }, { pitch: 30, roll: -20, yaw: 45 }, { pitch: -70, roll: 170, yaw: -120 }]) {
    const q = matrixPose(poseMatrix(p));
    near(q.pitch, p.pitch);
    near(q.roll, p.roll);
    near(q.yaw, p.yaw);
    const t = threeToPose(poseToThree(p));
    near(t.pitch, p.pitch);
    near(t.roll, p.roll);
    near(t.yaw, p.yaw);
  }
});

test('in three, rotating about X (module tilts sideways) = roll, about −Z = pitch, about Y = yaw', () => {
  const a = 25 * (Math.PI / 180), c = Math.cos(a), s = Math.sin(a);
  // three: rotate a about +X
  near(threeToPose([1, 0, 0, 0, c, -s, 0, s, c]).roll, 25);
  // three: rotate a about +Y (counter-clockwise seen from above) = heading +a
  near(threeToPose([c, 0, s, 0, 1, 0, -s, 0, c]).yaw, 25);
  // three: rotate a about −Z = rotate a about sensor Y = pitch +a
  near(threeToPose([c, s, 0, -s, c, 0, 0, 0, 1]).pitch, 25);
});

test('pitch / roll from gravity components (the firmware atan2 formula)', () => {
  const [ax, ay, az] = gravity({ pitch: 30, roll: -20, yaw: 0 });
  near((Math.atan2(-ax, Math.hypot(ay, az)) * 180) / Math.PI, 30);
  near((Math.atan2(ay, az) * 180) / Math.PI, -20);
});

test('drag rate: wall-clock based, shortest way across ±180°, reset after a long pause', () => {
  const r = new PoseRate();
  assert.deepEqual(r.push({ pitch: 0, roll: 0, yaw: 170 }, 1000), [0, 0, 0]);
  const v = r.push({ pitch: 10, roll: 0, yaw: -170 }, 1100);
  near(v[0], 100);
  near(v[2], 200);
  assert.deepEqual(r.push({ pitch: 20, roll: 0, yaw: 0 }, 5000), [0, 0, 0]);
  near(angDiff(179, -179), 2);
});

test('imu / touch actions match the CLI script syntax', () => {
  assert.equal(action({ tMs: 1, kind: 'imu', pitch: 30, roll: -20.004, yaw: 0 }), 'imu=30,-20,0');
  assert.equal(action({ tMs: 1, kind: 'imu', pitch: 1, roll: 2, yaw: 3, rates: [0, 0, 0] }), 'imu=1,2,3');
  assert.equal(action({ tMs: 1, kind: 'imu', pitch: 1, roll: 2, yaw: 3, rates: [10.126, 0, -5] }), 'imu=1,2,3,10.13,0,-5');
  assert.equal(action({ tMs: 1, kind: 'touch', down: true, x: 60.4, y: 120 }), 'touch=60,120');
  assert.equal(action({ tMs: 1, kind: 'touch', down: false, x: 60, y: 120 }), 'release');
  assert.deepEqual(roundImu({ pitch: 1.23456, roll: 0, yaw: -0.001, rates: [1.006, 0, 0] as [number, number, number] }), { pitch: 1.23, roll: 0, yaw: -0, rates: [1.01, 0, 0] });
  const log: InputLog = { version: 1, i2c: [{ kind: 'cst816s', addr: 0x15 }], lcd: true, touchInt: 5, events: [{ tMs: 1000.25, kind: 'touch', down: true, x: 10, y: 20 }, { tMs: 1100, kind: 'touch', down: false, x: 10, y: 20 }] };
  assert.match(toScript(log), /^1\.000250:touch=10,20$/m);
  assert.match(toScript(log), /^1\.100000:release$/m);
  assert.deepEqual(cliArgs(log, 'fw.bin', 'in.txt'), ['tryboard', 'run', 'fw.bin', '--i2c', 'cst816s@0x15', '--spi', 'gc9a01', '--touch-int', '5', '--inputs', 'in.txt']);
});

test('shopping list -> bench: IMU and touch round LCD scenes follow the wiring (as examples.json s3-imu / s3-touch)', async () => {
  const { toScene } = await import('../src/catalog/templates.ts');
  assert.deepEqual(toScene([{ partId: 'mpu6050' }], [{ part: 'mpu6050', pin: 'SDA', net: 'GPIO8' }, { part: 'mpu6050', pin: 'SCL', net: 'GPIO9' }]), [{ type: 'mpu6050', addr: 0x68, sda: 8, scl: 9 }]);
  assert.deepEqual(toScene([{ partId: 'qmi8658' }], [{ part: 'qmi8658', pin: 'SDA', net: 'GPIO8' }, { part: 'qmi8658', pin: 'SCL', net: 'GPIO9' }]), [{ type: 'qmi8658', addr: 0x6b, sda: 8, scl: 9 }]);
  const w = [['TP_SDA', 6], ['TP_SCL', 7], ['TP_INT', 5], ['TP_RST', 16], ['RES', 13]].map(([pin, g]) => ({ part: 'gc9a01-touch', pin: String(pin), net: `GPIO${g}` }));
  assert.deepEqual(toScene([{ partId: 'gc9a01-touch' }], w), [{ type: 'gc9a01', spi: 2 }, { type: 'cst816s', addr: 0x15, sda: 6, scl: 7, int: 5, rst: 16 }]);
});
