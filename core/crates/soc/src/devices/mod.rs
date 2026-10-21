//! External devices on the simulated buses (sensors, displays, ...).

pub mod aht20;
pub mod audio;
pub mod aw88298;
pub mod aw9523;
pub mod axp192;
pub mod axp2101;
pub mod bme280;
pub mod bmi270;
pub mod bmm150;
pub mod co5300;
pub mod codec;
pub mod cst816s;
pub mod cst9220;
pub mod dcs;
pub mod ds18b20;
pub mod ds3231;
pub mod ft6236;
pub mod gpio_parts;
pub mod imu;
pub mod ina219;
pub mod ina3221;
pub mod ir;
pub mod keymatrix;
pub mod lcd;
pub mod lp5562;
pub mod mpu6050;
pub mod pcf85063;
pub mod pcf8563;
pub mod pins;
pub mod qmi8658;
pub mod qmp6988;
pub mod rc522;
pub mod sh1106;
pub mod sht;
pub mod ssd1306;
pub mod tca8418;

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
        // M5Stack board parts (M5-04)
        "mpu6886" => Box::new(mpu6050::Mpu6050::mpu6886(addr)),
        "bmi270" => Box::new(bmi270::Bmi270::new(addr)),
        "bmm150" => Box::new(bmm150::Bmm150::new(addr)),
        "bm8563" | "pcf8563" => Box::new(pcf8563::Pcf8563::new(addr)),
        "aw9523" => Box::new(aw9523::Aw9523::new(addr)),
        "axp192" => Box::new(axp192::Axp192::new(addr)),
        "lp5562" => Box::new(lp5562::Lp5562::new(addr)),
        "tca8418" => Box::new(tca8418::Tca8418::new(addr)),
        "ft6336" => Box::new(ft6236::Ft6236::with_cipher(addr, ft6236::CHIP_ID_FT6336U)),
        "ft3267" => Box::new(ft6236::Ft6236::with_cipher(addr, ft6236::CHIP_ID_FT3267)),
        "ina3221" => Box::new(ina3221::Ina3221::new(addr)),
        "ltr553" => Box::new(codec::Codec::ltr553(addr)),
        "gc0308" => Box::new(codec::Codec::gc0308(addr)),
        "aw88298" => Box::new(aw88298::Aw88298::new(addr)),
        // Grove units (M5-09): ENV III = sht30 + qmp6988, ENV IV = sht40 + bmp280
        "sht30" | "sht31" | "sht35" => Box::new(sht::Sht3x::new(addr)),
        "sht40" | "sht41" | "sht45" => Box::new(sht::Sht4x::new(addr)),
        "qmp6988" => Box::new(qmp6988::Qmp6988::new(addr)),
        "bmp280" => Box::new(bme280::Bme280::bmp280(addr)),
        // 1.3" 128x64 OLED (F-04b)
        "sh1106" => Box::new(sh1106::Sh1106::new(addr)),
        // Common breakout modules (F-04e)
        "aht20" => Box::new(aht20::Aht20::new(addr)),
        "ina219" => Box::new(ina219::Ina219::new(addr)),
        "ds3231" => Box::new(ds3231::Ds3231::new(addr)),
        _ => return None,
    })
}
