//! Wi-Fi：射频 / 基带 / MAC 硬件的行为模型（见 docs/WIFI.md）。
//!
//! 第一阶段只让 PHY 校准与驱动初始化跑通：射频、模拟前端里被轮询的"完成 / 空闲"位直接给出就绪值。

/// 对射频相关寄存器的读：返回 Some 表示由本模块给值（stored 是该地址上次写入的值）。
pub fn rf_read(a: u32, stored: u32) -> Option<u32> {
    Some(match a {
        // SAR / 峰值检测状态：位 26..24 == 7 表示空闲（rom_pkdet_vol_start、rom1_read_sar2_code 轮询）
        0x6000_e050 => stored | (7 << 24),
        // TX 直流校准比较器：位 24 = 转换完成（txdc_cal_v70 轮询），位 30 是比较结果，保持写入值
        0x6000_e04c => stored | (1 << 24),
        // FE：IQ 估计完成（位 16，rom_iq_est_enable 轮询）
        0x6000_6174 => stored | (1 << 16),
        // MAC：hal_init 写位 1 后等位 0 就绪
        0x6003_3d14 => stored | ((stored >> 1) & 1),
        _ => return None,
    })
}
