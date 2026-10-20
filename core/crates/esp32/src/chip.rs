//! `tryboard_soc::chip::Chip` for the classic ESP32 (R-06): what the machine shell calls, one batch at a time.
//! No ADC model, LCD, I2S devices, PCNT, BLE or USB yet: those keep the trait's "absent" defaults.

use crate::{Esp32, Stop, MMIO_HIGH, MMIO_LOW};
use std::collections::{HashMap, VecDeque};
use tryboard_soc::chip::{self, Chip};
use tryboard_soc::devices::audio::Audio;
use tryboard_soc::devices::pins::PinDevices;
use tryboard_soc::i2c::I2c;
use tryboard_soc::i2cpins::{PinBus, PinBuses};
use tryboard_soc::iotrace::IoTrace;
use tryboard_soc::rmt::Ws2812;
use tryboard_soc::tasktrace::TaskTrace;
use tryboard_soc::wifi::WifiMac;
use tryboard_xtensa::Bus;

impl Esp32 {
    fn stop(&self, r: Stop) -> chip::Stop {
        match r {
            Stop::Budget => chip::Stop::Budget,
            Stop::Fault { cause, epc, vaddr } => chip::Stop::Fault(format!(
                "CPU exception EXCCAUSE={cause} EPC1=0x{epc:08x} EXCVADDR=0x{vaddr:08x}"
            )),
            Stop::Break(v) => chip::Stop::Fault(format!("BREAK 0x{v:x}")),
            Stop::Hle(pc) => {
                chip::Stop::Hle(format!("0x{pc:08x} {}", self.symbol_at(pc).unwrap_or("")))
            }
            Stop::Reset(r) => chip::Stop::Reset(r),
        }
    }
}

impl Chip for Esp32 {
    fn run(&mut self, cycles: u64) -> chip::Stop {
        let r = Esp32::run(self, cycles);
        self.stop(r)
    }
    fn run_traced(&mut self, cycles: u64, ring: &mut VecDeque<u32>, cap: usize) -> chip::Stop {
        let r = Esp32::run_traced(self, cycles, ring, cap);
        self.stop(r)
    }
    fn reboot(&mut self, reason: u32) -> Result<(), String> {
        Esp32::reboot(self, reason)
    }
    fn hold(&mut self, cycles: u64) {
        self.cpu.cycles += cycles;
        self.bus.now = self.cpu.cycles;
        if self.cpu1_on {
            self.cpu1.cycles = self.cpu.cycles;
        }
    }
    fn cycles(&self) -> u64 {
        self.cpu.cycles
    }
    fn instret(&self) -> u64 {
        self.cpu.instret + if self.cpu1_on { self.cpu1.instret } else { 0 }
    }
    fn pc(&self) -> u32 {
        self.cpu.pc
    }
    fn cores(&self) -> usize {
        2
    }
    fn debug_state(&self, sym: &dyn Fn(u32) -> String) -> String {
        tryboard_xtensa::halt_state(&self.cpu, self.cpu1_on.then_some(&self.cpu1), sym)
    }
    /// Classic ESP32 first-gen ROM (2016-06-08): only two lines, old-style reset reason names
    fn rom_banner(&self, reason: u32) -> String {
        let name = match reason {
            1 => "POWERON_RESET",
            3 => "SW_RESET",
            12 => "SW_CPU_RESET",
            15 => "RTCWDT_BROWN_OUT_RESET",
            _ => "UNKNOWN",
        };
        format!("ets Jun  8 2016 00:22:57\n\nrst:0x{reason:x} ({name}),boot:0x13 (SPI_FAST_FLASH_BOOT)\n")
    }

    fn mmio_window(&self) -> (u32, u32) {
        (MMIO_LOW, MMIO_HIGH)
    }
    fn bus_poke(&mut self, addr: u32, size: u32, val: u32, write: bool) {
        let _ = if write {
            self.bus.store(addr, size, val)
        } else {
            self.bus.load(addr, size).map(|_| ())
        };
    }
    fn peek(&mut self, a: u32) -> Option<u32> {
        self.bus.load(a, 4).ok()
    }
    fn unimpl(&self) -> &HashMap<u32, u64> {
        &self.bus.unimpl
    }
    fn kick_events(&mut self) {
        self.bus.next_event = 0;
    }
    fn kick_pins(&mut self) {
        self.bus.next_event = 0;
        self.bus.irq_dirty = true;
    }

    fn console_take(&mut self) -> Vec<u8> {
        Esp32::console_take(self)
    }
    fn console_push(&mut self, b: &[u8]) {
        self.bus.console.extend_from_slice(b);
    }
    fn uart_push(&mut self, data: &[u8]) {
        self.bus.uart0.push_rx(data);
        self.bus.irq_dirty = true;
    }

    fn gpio_level(&self) -> u64 {
        self.bus.gpio.level()
    }
    fn gpio_enable(&self) -> u64 {
        self.bus.gpio.enable
    }
    fn gpio_reset_level(&self) -> u64 {
        1
    }
    fn gpio_drive(&mut self, pin: u32, level: i32) {
        let bit = 1u64 << pin;
        let g = &mut self.bus.gpio;
        if level < 0 {
            g.ext_driven &= !bit;
        } else {
            g.ext_driven |= bit;
            if level > 0 {
                g.ext_in |= bit;
            } else {
                g.ext_in &= !bit;
            }
        }
        let now = self.cpu.cycles;
        self.bus.gpio_changed(now);
    }
    fn gpio_log(&self) -> Vec<(u64, u64)> {
        self.bus.gpio_log.clone()
    }
    fn pin_pwm(&self, pin: usize) -> Option<(f32, f32)> {
        self.bus.pin_pwm(pin)
    }
    fn ws2812(&self) -> &HashMap<u32, Ws2812> {
        &self.bus.ws2812
    }
    fn analog_set(&mut self, pin: usize, mv: f32) {
        if let Some(p) = self.bus.adc.pin_mv.get_mut(pin) {
            *p = mv;
        }
    }

    fn i2c0(&mut self) -> &mut I2c {
        &mut self.bus.i2c0
    }
    fn i2c(&self, n: usize) -> Option<&I2c> {
        match n {
            0 => Some(&self.bus.i2c0),
            1 => Some(&self.bus.i2c1),
            _ => None,
        }
    }
    fn pins(&mut self) -> &mut PinDevices {
        &mut self.bus.pins
    }
    fn i2c_pin_buses(&mut self) -> Option<&mut PinBuses> {
        Some(&mut self.bus.i2c_pins)
    }
    fn i2c_bus_add(&mut self, bus: PinBus) -> Option<usize> {
        let pull = if bus.pullup { bus.mask() } else { 0 };
        let i = self.bus.i2c_pins.add(bus)?;
        self.bus.gpio.board_pullup |= pull;
        let now = self.cpu.cycles;
        self.bus.gpio_changed(now);
        Some(i)
    }
    fn set_efuse_pkg(&mut self, pkg: u32) -> bool {
        if pkg > 15 {
            return false;
        }
        // CHIP_PACKAGE (BLK0 RDATA3 bits 9..11) + CHIP_PACKAGE_4BIT (bit 2)
        let w = &mut self.bus.efuse[3];
        *w = *w & !(7 << 9 | 1 << 2) | (pkg & 7) << 9 | (pkg >> 3) << 2;
        // PICO-D4 boards (Atom, StickC) are pre-v3 silicon; M5GFX maps PICO-D4 + DATE bit 31 to PICO-V3-02
        self.bus.chip_v3 = pkg != 5;
        // PICO-V3-02 carries 2MB PSRAM in the package; --psram after this still overrides
        if pkg == 6 {
            self.set_psram(2 << 20);
        }
        true
    }
    fn set_psram(&mut self, bytes: usize) -> bool {
        if ![0, 2 << 20, 4 << 20, 8 << 20].contains(&bytes) {
            return false;
        }
        self.bus.spi1.psram = crate::psram::QuadPsram::with_size(bytes);
        true
    }
    fn audio(&self) -> &Audio {
        &self.bus.audio
    }
    fn audio_mut(&mut self) -> &mut Audio {
        &mut self.bus.audio
    }

    fn iotrace(&mut self) -> &mut IoTrace {
        &mut self.bus.iotrace
    }
    fn tasktrace(&mut self) -> &mut TaskTrace {
        &mut self.bus.tasks
    }

    fn wifi(&self) -> &WifiMac {
        self.bus.wifi()
    }
    fn wifi_mut(&mut self) -> &mut WifiMac {
        self.bus.wifi_mut()
    }
}
