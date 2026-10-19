//! Native USB OTG: DWC2 device controller plus a virtual host plugged into the other end.

pub mod dwc2;
pub mod host;

use crate::CPU_HZ;

/// Interrupt source number (soc/esp32s3/include/soc/interrupts.h: ETS_USB_INTR_SOURCE)
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

    /// Advance the virtual host; returns the CPU cycle of the next required update. `mem` is for the controller's DMA
    pub fn update(&mut self, now: u64, mem: &mut dyn dwc2::Mem) -> u64 {
        let now_us = now * 1_000_000 / CPU_HZ;
        // Firmware hasn't touched the controller yet: no need to wake up often
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

    /// Call after a controller register write: once the device attaches to the bus, start scheduling the host
    pub fn kick(&mut self, now: u64) {
        if self.dev.connected() && self.next_us == 0 {
            self.next_us = now * 1_000_000 / CPU_HZ;
        }
    }
}
