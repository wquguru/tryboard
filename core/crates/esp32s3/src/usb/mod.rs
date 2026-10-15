//! 原生 USB OTG：DWC2 设备控制器 + 插在另一头的虚拟主机。

pub mod dwc2;
pub mod host;

use crate::CPU_HZ;

/// 中断源编号（soc/esp32s3/include/soc/interrupts.h：ETS_USB_INTR_SOURCE）
pub const SRC_USB: u32 = 38;

#[derive(Default)]
pub struct Usb {
    pub dev: dwc2::Dwc2,
    pub host: host::Host,
    next_us: u64,
}

impl Usb {
    pub fn contains(a: u32) -> bool {
        (dwc2::BASE..dwc2::BASE + dwc2::SIZE).contains(&a)
    }

    pub fn read(&mut self, a: u32) -> u32 {
        self.dev.read(a - dwc2::BASE)
    }

    pub fn write(&mut self, a: u32, v: u32) {
        self.dev.write(a - dwc2::BASE, v)
    }

    pub fn irq(&self) -> bool {
        self.dev.irq()
    }

    /// 推进虚拟主机；返回下一次需要推进的 CPU 周期。mem 给控制器的 DMA 用
    pub fn update(&mut self, now: u64, mem: &mut dyn dwc2::Mem) -> u64 {
        let now_us = now * 1_000_000 / CPU_HZ;
        // 固件还没碰过控制器：不必频繁唤醒
        if !self.dev.connected() && self.next_us == 0 {
            return u64::MAX;
        }
        if now_us >= self.next_us {
            self.next_us = self.host.tick(&mut self.dev, mem, now_us);
        }
        if !self.dev.connected() {
            self.next_us = 0;
            return u64::MAX;
        }
        (self.next_us * CPU_HZ).div_ceil(1_000_000)
    }

    /// 写过控制器寄存器后调用：设备一旦接上总线就开始调度主机
    pub fn kick(&mut self, now: u64) {
        if self.dev.connected() && self.next_us == 0 {
            self.next_us = now * 1_000_000 / CPU_HZ;
        }
    }
}
