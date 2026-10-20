//! IMU common code: pose (Euler angles + rates) -> specific force (accel) and angular rate (gyro) in the sensor frame.
//! Convention (MPU6050 / QMI8658): X along the module's long edge, Y short edge, Z up from the chip (right-handed);
//! aerospace ZYX order R = Rz(yaw)·Ry(pitch)·Rx(roll) maps sensor to world (world Z up). Flat at rest reads (0, 0, +1 g);
//! pitching +X up makes ax negative, so roll = atan2(ay, az), pitch = atan2(-ax, √(ay² + az²)) recover the set values.
//! Input rates are Euler-angle rates (°/s), converted here to body rates. Pose is held between inputs (no extrapolation)
//! so every change in the input log has an exact time and replay matches cycle for cycle. (lint: allow-long-comment)

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pose {
    /// Degrees
    pub pitch: f64,
    pub roll: f64,
    pub yaw: f64,
    /// Euler angle rates, °/s
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

    /// Accelerometer reading (g, sensor frame): at rest only the reaction to gravity
    pub fn accel_g(&self) -> [f64; 3] {
        let (t, f) = (self.pitch.to_radians(), self.roll.to_radians());
        [-t.sin(), f.sin() * t.cos(), f.cos() * t.cos()]
    }

    /// World vector (X north, Y west, Z up) seen in the sensor frame: R^T * v with R = Rz(yaw)·Ry(pitch)·Rx(roll)
    pub fn world_to_sensor(&self, v: [f64; 3]) -> [f64; 3] {
        let (sy, cy) = self.yaw.to_radians().sin_cos();
        let (st, ct) = self.pitch.to_radians().sin_cos();
        let (sf, cf) = self.roll.to_radians().sin_cos();
        let a = [cy * v[0] + sy * v[1], -sy * v[0] + cy * v[1], v[2]];
        let b = [ct * a[0] - st * a[2], a[1], st * a[0] + ct * a[2]];
        [b[0], cf * b[1] + sf * b[2], -sf * b[1] + cf * b[2]]
    }

    /// Gyro reading (°/s, sensor frame): Euler rates -> body angular rate
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

/// Deterministic small noise: hash of sample index and channel into [-1, 1), so replays read identical values
pub fn noise(sample: u64, ch: u64) -> f64 {
    let mut x = sample.wrapping_mul(0x9e37_79b9_7f4a_7c15) ^ ch.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x ^= x >> 31;
    x = x.wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^= x >> 29;
    (x >> 11) as f64 / (1u64 << 52) as f64 - 1.0
}

/// How a chip sits on its board: sensor axis i reads `sign * board[axis]` for `MOUNT[i] = (axis, sign)`.
/// Pose is in the board frame; drivers such as M5Unified undo the mounting, so both must agree (AtomS3R BMI270).
pub type Mount = [(u8, i8); 3];
pub const MOUNT_IDENTITY: Mount = [(0, 1), (1, 1), (2, 1)];

pub fn mount(m: &Mount, v: [f64; 3]) -> [f64; 3] {
    m.map(|(axis, sign)| sign as f64 * v[axis as usize])
}

/// Physical value x sensitivity -> saturated signed 16-bit output
pub fn to_i16(v: f64) -> i16 {
    v.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mount_undoes_driver_remap() {
        // AtomS3R: M5Unified reads (y, -x, z), so the chip must report (-board.y, board.x, board.z)
        let m: Mount = [(1, -1), (0, 1), (2, 1)];
        let s = mount(&m, [0.1, 0.2, 0.9]);
        assert_eq!([s[1], -s[0], s[2]], [0.1, 0.2, 0.9]);
        assert_eq!(mount(&MOUNT_IDENTITY, [1.0, 2.0, 3.0]), [1.0, 2.0, 3.0]);
    }

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
    fn world_to_sensor_matches_gravity() {
        for (p, r, y) in [(0.0, 0.0, 0.0), (30.0, -20.0, 77.0), (-60.0, 45.0, 200.0)] {
            let pose = Pose::new(p, r, y);
            let (a, b) = (pose.accel_g(), pose.world_to_sensor([0.0, 0.0, 1.0]));
            assert!((0..3).all(|i| (a[i] - b[i]).abs() < 1e-12), "{a:?} {b:?}");
        }
        // Yaw 90° (nose to west): a north vector lies along sensor -Y
        let v = Pose::new(0.0, 0.0, 90.0).world_to_sensor([1.0, 0.0, 0.0]);
        assert!(v[0].abs() < 1e-12 && (v[1] + 1.0).abs() < 1e-12);
    }

    #[test]
    fn rates_to_body() {
        // Rotating about Z while flat (yaw rate) = gyro Z
        let mut p = Pose::new(0.0, 0.0, 0.0);
        p.dyaw = 90.0;
        assert_eq!(p.gyro_dps(), [0.0, 0.0, 90.0]);
        // Roll rate only = gyro X
        let mut p = Pose::new(20.0, 0.0, 0.0);
        p.droll = 15.0;
        assert!((p.gyro_dps()[0] - 15.0).abs() < 1e-12);
        assert!(noise(3, 1) >= -1.0 && noise(3, 1) < 1.0 && noise(3, 1) == noise(3, 1));
    }
}
