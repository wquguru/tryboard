//! SoC 公共件：多颗芯片共用的外设模型。
//!
//! 目前放的是 Wi-Fi（MAC / 射频的行为模型与虚拟世界），C3 与 S3 按 [`wifi::WifiLayout`] 区分寄存器排布。

pub mod wifi;

/// 外设模型访问内存（DMA 描述符与缓冲区）用的接口；由各芯片的 SocBus 实现
pub trait Mem {
    fn rd8(&mut self, a: u32) -> u8;
    fn rd32(&mut self, a: u32) -> u32;
    fn wr8(&mut self, a: u32, v: u8);
    fn wr32(&mut self, a: u32, v: u32);
}
