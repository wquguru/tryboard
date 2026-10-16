// IMU 姿态换算（P2-03），纯函数，node --test 直接测，不依赖 three。
// 约定与内核 core/crates/esp32c3/src/devices/imu.rs 相同：传感器 X 沿模块长边、Y 沿短边、Z 垂直芯片朝上；
// 姿态 R = Rz(yaw)·Ry(pitch)·Rx(roll)（传感器 → 世界，世界 Z 朝上）。
// 3D 台面 / 成品里用的是 three.js 的 Y 朝上坐标：模块平放时传感器 X = three +X、Y = three −Z（朝里）、Z = three +Y。
// 两套坐标之间是一个固定的置换 M，所以 three 里物体的旋转 Q 与姿态 R 的关系是 Q = M·R·Mᵀ。

export interface Pose {
  pitch: number;
  roll: number;
  yaw: number;
}

/** 3×3 矩阵，行优先 */
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

/** 传感器坐标 → three 坐标（列 = 传感器三个轴在 three 里的方向） */
export const M: Mat3 = [1, 0, 0, 0, 0, 1, 0, -1, 0];

/** 姿态 → 旋转矩阵（传感器 → 世界，Z 朝上） */
export function poseMatrix(p: Pose): Mat3 {
  const [cp, sp, cr, sr, cy, sy] = [Math.cos(p.pitch * D), Math.sin(p.pitch * D), Math.cos(p.roll * D), Math.sin(p.roll * D), Math.cos(p.yaw * D), Math.sin(p.yaw * D)];
  return [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr, sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr, -sp, cp * sr, cp * cr];
}

/** 旋转矩阵 → 姿态（ZYX 分解；pitch 在 ±90° 时 yaw / roll 不唯一，取 roll = 0） */
export function matrixPose(r: Mat3): Pose {
  const s = Math.max(-1, Math.min(1, -r[6]));
  const pitch = Math.asin(s) / D;
  if (Math.abs(s) > 0.99999) return { pitch, roll: 0, yaw: Math.atan2(-r[1], r[4]) / D };
  return { pitch, roll: Math.atan2(r[7], r[8]) / D, yaw: Math.atan2(r[3], r[0]) / D };
}

/** 姿态 → three 里物体（台面 / 成品）的旋转矩阵 */
export function poseToThree(p: Pose): Mat3 {
  return mul(mul(M, poseMatrix(p)), transpose(M));
}

/** three 里物体的旋转矩阵 → 姿态 */
export function threeToPose(q: Mat3): Pose {
  return matrixPose(mul(mul(transpose(M), q), M));
}

/** 加速度计此刻应读到的重力分量（g，传感器坐标），与内核 Pose::accel_g 同式 */
export function gravity(p: Pose): [number, number, number] {
  const t = p.pitch * D, f = p.roll * D;
  return [-Math.sin(t), Math.sin(f) * Math.cos(t), Math.cos(f) * Math.cos(t)];
}

/** 两个角度之差（-180..180） */
export const angDiff = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;

/**
 * 连续姿态 → 欧拉角变化率（°/s）。拖动 / 滑块时每次变化 push 一次（墙钟毫秒），返回这一段的平均速率；
 * 停下来以后由调用方再发一次速率为 0 的姿态（陀螺回零）。速率限在 ±2000 °/s（MPU6050 最大量程）。
 */
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
