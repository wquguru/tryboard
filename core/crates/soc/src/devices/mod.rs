//! External devices on the simulated buses (sensors, displays, ...).

pub mod audio;
pub mod axp2101;
pub mod bme280;
pub mod co5300;
pub mod codec;
pub mod cst816s;
pub mod cst9220;
pub mod dcs;
pub mod ft6236;
pub mod imu;
pub mod lcd;
pub mod mpu6050;
pub mod pcf85063;
pub mod pins;
pub mod qmi8658;
pub mod ssd1306;

use crate::i2c::I2cDevice;

/// Create an I2C device by name (used by CLI / web wiring descriptions)
pub fn make_i2c(kind: &str, addr: u8) -> Option<Box<dyn I2cDevice>> {
    Some(match kind {
        "ssd1306" => Box::new(ssd1306::Ssd1306::new(addr)),
        "bme280" => Box::new(bme280::Bme280::new(addr)),
        "mpu6050" => Box::new(mpu6050::Mpu6050::new(addr)),
        "qmi8658" => Box::new(qmi8658::Qmi8658::new(addr)),
        "cst816s" => Box::new(cst816s::Cst816s::new(addr)),
        "ft6236" => Box::new(ft6236::Ft6236::new(addr)),
        "cst9220" => Box::new(cst9220::Cst9220::new(addr)),
        "axp2101" => Box::new(axp2101::Axp2101::new(addr)),
        "pcf85063" => Box::new(pcf85063::Pcf85063::new(addr)),
        "es8311" => Box::new(codec::Codec::es8311(addr)),
        "es7210" => Box::new(codec::Codec::es7210(addr)),
        _ => return None,
    })
}
