//! 挂在模拟总线上的外部器件（传感器、屏幕……）。

pub mod audio;
pub mod bme280;
pub mod gc9a01;
pub mod ssd1306;

use crate::i2c::I2cDevice;

/// 按名字创建 I2C 器件（CLI / 网页的接线描述用）
pub fn make_i2c(kind: &str, addr: u8) -> Option<Box<dyn I2cDevice>> {
    Some(match kind {
        "ssd1306" => Box::new(ssd1306::Ssd1306::new(addr)),
        "bme280" => Box::new(bme280::Bme280::new(addr)),
        _ => return None,
    })
}
