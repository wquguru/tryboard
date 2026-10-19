// IMU pose maths (P2-03): pure functions so node --test can run them without three.
// Same convention as core/crates/esp32c3/src/devices/imu.rs: sensor X along the module's long edge, Y short edge, Z up out of the chip;
// pose R = Rz(yaw)·Ry(pitch)·Rx(roll) (sensor → world, world Z up).
// three.js is Y-up: a module lying flat has sensor X = three +X, Y = three −Z (inward), Z = three +Y.
// The two frames differ by a fixed permutation M, so an object's three rotation Q relates to the pose by Q = M·R·Mᵀ. lint: allow-long-comment

export interface Pose {
  pitch: number;
  roll: number;
  yaw: number;
}

/** 3×3 matrix, row-major */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

const D = Math.PI / 180;

export function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

export function transpose(a: Mat3): Mat3 {
  return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
}

/** Sensor frame → three frame (columns = sensor axes expressed in three) */
export const M: Mat3 = [1, 0, 0, 0, 0, 1, 0, -1, 0];

/** Pose → rotation matrix (sensor → world, Z up) */
export function poseMatrix(p: Pose): Mat3 {
  const [cp, sp, cr, sr, cy, sy] = [Math.cos(p.pitch * D), Math.sin(p.pitch * D), Math.cos(p.roll * D), Math.sin(p.roll * D), Math.cos(p.yaw * D), Math.sin(p.yaw * D)];
  return [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr, sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr, -sp, cp * sr, cp * cr];
}

/** Rotation matrix → pose (ZYX; at pitch ±90° yaw/roll are ambiguous, so roll = 0) */
export function matrixPose(r: Mat3): Pose {
  const s = Math.max(-1, Math.min(1, -r[6]));
  const pitch = Math.asin(s) / D;
  if (Math.abs(s) > 0.99999) return { pitch, roll: 0, yaw: Math.atan2(-r[1], r[4]) / D };
  return { pitch, roll: Math.atan2(r[7], r[8]) / D, yaw: Math.atan2(r[3], r[0]) / D };
}

/** Pose → rotation of the three object (bench / product) */
export function poseToThree(p: Pose): Mat3 {
  return mul(mul(M, poseMatrix(p)), transpose(M));
}

/** Rotation of the three object → pose */
export function threeToPose(q: Mat3): Pose {
  return matrixPose(mul(mul(transpose(M), q), M));
}

/** Gravity the accelerometer should read now (g, sensor frame); same formula as the core's Pose::accel_g */
export function gravity(p: Pose): [number, number, number] {
  const t = p.pitch * D, f = p.roll * D;
  return [-Math.sin(t), Math.sin(f) * Math.cos(t), Math.cos(f) * Math.cos(t)];
}

/** Signed angle difference (-180..180) */
export const angDiff = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;

/** Successive poses → Euler rates (°/s), clamped to ±2000 °/s (MPU6050 full scale). Push on every drag change (wall ms);
 *  the caller sends one zero-rate pose after the drag stops so the gyro settles back to 0. */
export class PoseRate {
  private last: { p: Pose; t: number } | null = null;
  push(p: Pose, tMs: number): [number, number, number] {
    const l = this.last;
    this.last = { p, t: tMs };
    if (!l || tMs - l.t <= 0 || tMs - l.t > 500) return [0, 0, 0];
    const dt = (tMs - l.t) / 1000;
    const c = (v: number) => Math.max(-2000, Math.min(2000, v));
    return [c(angDiff(l.p.pitch, p.pitch) / dt), c(angDiff(l.p.roll, p.roll) / dt), c(angDiff(l.p.yaw, p.yaw) / dt)];
  }
  reset() {
    this.last = null;
  }
}
