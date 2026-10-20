//! Shared SoC parts: peripheral models, external devices and traces used by every chip (C3 / S3 / ESP32).
//! BLE (virtual controller at VHCI + virtual phone, C-01); Wi-Fi (MAC / RF behaviour model and virtual world), C3 vs S3 register layout via [`wifi::WifiLayout`].

pub mod adc;
pub mod ble;
pub mod boot;
pub mod chip;
pub mod crypto_hw;
pub mod devices;
pub mod gdma;
pub mod gpspi;
pub mod gpspi_classic;
pub mod i2c;
pub mod i2cpins;
pub mod i2s;
pub mod iotrace;
pub mod ledc;
pub mod pcnt;
pub mod periph;
pub mod rmt;
pub mod sigin;
pub mod spiflash;
pub mod tasktrace;
pub mod usb;
pub mod usj;
pub mod vcd;
pub mod wifi;

/// Memory access for peripheral models (DMA descriptors and buffers), implemented by each chip's SocBus
pub trait Mem {
    fn rd8(&mut self, a: u32) -> u8;
    fn rd32(&mut self, a: u32) -> u32;
    fn wr8(&mut self, a: u32, v: u8);
    fn wr32(&mut self, a: u32, v: u32);
}
