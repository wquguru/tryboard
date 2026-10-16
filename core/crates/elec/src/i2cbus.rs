//! I2C 总线负载（P2-11，估算，必须上真机）：线长 → 总线电容 → 上升时间 → 和 I2C 规范的上限比。
//! 确定性：同样的线长和器件数永远给同样的结论，不引入随机。网页 web/src/app/harness.ts 用同一套常数（elec.test.ts 对拍）。
//!
//! 开漏总线靠上拉电阻把线拉高，上升时间（30% → 70% VDD）t_r = 0.8473 · R · C（I2C 规范 UM10204 §7.1）。
//! 上限：标准模式（≤ 100 kHz）1000 ns，快速模式（≤ 400 kHz）300 ns，快速 + 模式 120 ns。

/// 杜邦线 / 排线每厘米对地 + 线间电容（pF，估算：空气中单根线约 0.5–1.5 pF/cm，取中间偏上）
pub const PF_PER_CM: f64 = 1.0;
/// 每个器件的引脚电容（pF，I2C 规范 Ci 上限）
pub const PF_PER_DEVICE: f64 = 10.0;
/// 开发板引脚 + 走线 + 面包板（pF，估算）
pub const PF_BASE: f64 = 10.0;
/// 常见模块板载上拉（Ω）：每个模块一只 10 kΩ，并联
pub const PULLUP_PER_MODULE: f64 = 10_000.0;
/// 没有模块上拉时只剩 ESP32 内部上拉（Ω，数据手册约 45 kΩ）
pub const PULLUP_INTERNAL: f64 = 45_000.0;

/// 总线电容（pF）
pub fn bus_pf(wire_cm: f64, devices: usize) -> f64 {
    PF_BASE + PF_PER_DEVICE * devices as f64 + PF_PER_CM * wire_cm.max(0.0)
}

/// 等效上拉（Ω）：n 个模块的 10 kΩ 并联
pub fn pullup_ohm(devices: usize) -> f64 {
    if devices == 0 {
        PULLUP_INTERNAL
    } else {
        PULLUP_PER_MODULE / devices as f64
    }
}

/// 上升时间（ns）
pub fn rise_ns(wire_cm: f64, devices: usize) -> f64 {
    // Ω × pF = 1e-12 s，再 ×1e9 换成 ns
    0.8473 * pullup_ohm(devices) * bus_pf(wire_cm, devices) * 1e-3
}

/// 这个 SCL 频率下规范允许的最大上升时间（ns）
pub fn limit_ns(scl_hz: f64) -> f64 {
    if scl_hz <= 100_000.5 {
        1000.0
    } else if scl_hz <= 400_000.5 {
        300.0
    } else {
        120.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// 在规范内
    Ok,
    /// 超出规范、不到两倍：从机放开 SDA 后线爬不到高电平就被采样，读回的字节里 0→1 的位读成 0
    Marginal,
    /// 超过两倍：地址字节都传不对，器件不应答（NACK）
    Fail,
}

pub fn verdict(rise_ns: f64, limit_ns: f64) -> Verdict {
    if rise_ns <= limit_ns {
        Verdict::Ok
    } else if rise_ns <= 2.0 * limit_ns {
        Verdict::Marginal
    } else {
        Verdict::Fail
    }
}

/// 慢上升把读回字节里"前一位是 0、这一位是 1"的位读成 0（MSB 先发；最高位前面是上一字节的 ACK，按高电平算）
pub fn corrupt_read(b: u8) -> u8 {
    b & ((b >> 1) | 0x80)
}

/// 不出警告的最长线（cm）
pub fn max_wire_cm(devices: usize, scl_hz: f64) -> f64 {
    let c = limit_ns(scl_hz) / (0.8473 * pullup_ohm(devices) * 1e-3);
    ((c - PF_BASE - PF_PER_DEVICE * devices as f64) / PF_PER_CM).max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weather_bus_thresholds() {
        // 气象站：OLED + BME280 两个模块，400 kHz。网页 harness.ts 用同样的数（elec.test.ts）
        assert!((rise_ns(20.0, 2) - 211.825).abs() < 0.01);
        assert_eq!(verdict(rise_ns(20.0, 2), limit_ns(400_000.0)), Verdict::Ok);
        assert_eq!(
            verdict(rise_ns(60.0, 2), limit_ns(400_000.0)),
            Verdict::Marginal
        );
        assert_eq!(
            verdict(rise_ns(150.0, 2), limit_ns(400_000.0)),
            Verdict::Fail
        );
        assert!((max_wire_cm(2, 400_000.0) - 40.81).abs() < 0.01);
        // 100 kHz 宽松得多
        assert_eq!(verdict(rise_ns(150.0, 2), limit_ns(100_000.0)), Verdict::Ok);
    }

    #[test]
    fn corrupt_read_loses_rising_bits() {
        assert_eq!(corrupt_read(0xff), 0xff);
        assert_eq!(corrupt_read(0x00), 0x00);
        // 0101 0101：每个 1 前面都是 0 → 全丢
        assert_eq!(corrupt_read(0x55), 0x00);
        // 1100 0110 → 1100 0010（第 2 位前面是 0，丢；第 1 位前面原本是 1，留）
        assert_eq!(corrupt_read(0xc6), 0xc2);
        // BME280 芯片 ID 0x60 = 0110 0000 → 0x20
        assert_eq!(corrupt_read(0x60), 0x20);
    }
}
