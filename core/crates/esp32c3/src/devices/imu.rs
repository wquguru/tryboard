//! IMU 公共件：姿态（欧拉角 + 欧拉角速率）→ 传感器坐标系里的比力（加速度计读数）和角速度（陀螺读数）。
//!
//! 约定（MPU6050 / QMI8658 共用）：传感器坐标系 X 沿模块长边、Y 沿短边、Z 垂直芯片朝上（右手系）；
//! 姿态按航空 ZYX 顺序：R = Rz(yaw) · Ry(pitch) · Rx(roll)，把传感器坐标转到世界坐标（世界 Z 朝上）。
//! 平放静止时加速度计读 (0, 0, +1 g)；pitch 抬起 X 轴正向时 ax 变负，固件常用的
//! roll = atan2(ay, az)、pitch = atan2(-ax, √(ay² + az²)) 正好还原出设定值。
//!
//! 角速度：输入里给的是欧拉角变化率（°/s，网页由拖动速度算出、脚本里写明），这里换算成机体角速度。
//! 姿态在两次输入之间保持不变（不按角速率外推）：输入日志里每一次变化都有明确的时刻，重放才逐周期一致。

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pose {
    /// 度
    pub pitch: f64,
    pub roll: f64,
    pub yaw: f64,
    /// 欧拉角变化率，°/s
    pub dpitch: f64,
    pub droll: f64,
    pub dyaw: f64,
}

impl Pose {
    pub fn new(pitch: f64, roll: f64, yaw: f64) -> Self {
        Pose {
            pitch,
            roll,
            yaw,
            ..Pose::default()
        }
    }

    /// 加速度计读数（单位 g，传感器坐标系）：静止时只有重力的反作用
    pub fn accel_g(&self) -> [f64; 3] {
        let (t, f) = (self.pitch.to_radians(), self.roll.to_radians());
        [-t.sin(), f.sin() * t.cos(), f.cos() * t.cos()]
    }

    /// 陀螺读数（°/s，传感器坐标系）：欧拉角速率 → 机体角速度
    pub fn gyro_dps(&self) -> [f64; 3] {
        let (t, f) = (self.pitch.to_radians(), self.roll.to_radians());
        let (dt, df, dy) = (self.dpitch, self.droll, self.dyaw);
        [
            df - dy * t.sin(),
            dt * f.cos() + dy * f.sin() * t.cos(),
            -dt * f.sin() + dy * f.cos() * t.cos(),
        ]
    }
}

/// 确定性的小噪声：按样本序号和通道哈希出 [-1, 1)，同一时刻读到的值每次重放都一样
pub fn noise(sample: u64, ch: u64) -> f64 {
    let mut x = sample.wrapping_mul(0x9e37_79b9_7f4a_7c15) ^ ch.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x ^= x >> 31;
    x = x.wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^= x >> 29;
    (x >> 11) as f64 / (1u64 << 52) as f64 - 1.0
}

/// 物理量 × 灵敏度 → 16 位有符号输出（饱和）
pub fn to_i16(v: f64) -> i16 {
    v.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gravity_inverts_to_pose() {
        for (p, r) in [(0.0, 0.0), (30.0, -20.0), (-60.0, 45.0), (10.0, 170.0)] {
            let a = Pose::new(p, r, 77.0).accel_g();
            let roll = a[1].atan2(a[2]).to_degrees();
            let pitch = (-a[0])
                .atan2((a[1] * a[1] + a[2] * a[2]).sqrt())
                .to_degrees();
            assert!(
                (pitch - p).abs() < 1e-9 && (roll - r).abs() < 1e-9,
                "{p},{r} → {pitch},{roll}"
            );
            assert!(((a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) - 1.0).abs() < 1e-12);
        }
    }

    #[test]
    fn rates_to_body() {
        // 平放时绕 Z 转（yaw 速率）= 陀螺 Z
        let mut p = Pose::new(0.0, 0.0, 0.0);
        p.dyaw = 90.0;
        assert_eq!(p.gyro_dps(), [0.0, 0.0, 90.0]);
        // 只有横滚速率 = 陀螺 X
        let mut p = Pose::new(20.0, 0.0, 0.0);
        p.droll = 15.0;
        assert!((p.gyro_dps()[0] - 15.0).abs() < 1e-12);
        assert!(noise(3, 1) >= -1.0 && noise(3, 1) < 1.0 && noise(3, 1) == noise(3, 1));
    }
}
