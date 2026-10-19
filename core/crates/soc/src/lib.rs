//! Shared SoC parts: peripheral models used by several chips.
//! BLE (virtual controller at VHCI + virtual phone, C-01); Wi-Fi (MAC / RF behaviour model and virtual world), C3 vs S3 register layout via [`wifi::WifiLayout`].

pub mod ble;
pub mod wifi;

/// Memory access for peripheral models (DMA descriptors and buffers), implemented by each chip's SocBus
pub trait Mem {
    fn rd8(&mut self, a: u32) -> u8;
    fn rd32(&mut self, a: u32) -> u32;
    fn wr8(&mut self, a: u32, v: u8);
    fn wr32(&mut self, a: u32, v: u32);
}
