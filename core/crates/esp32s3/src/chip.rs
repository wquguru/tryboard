//! `tryboard_soc::chip::Chip` for the ESP32-S3 (R-06): what the machine shell calls, one batch at a time.

use crate::{Esp32s3, Stop, MMIO_HIGH, MMIO_LOW};
use std::collections::{HashMap, VecDeque};
use tryboard_soc::adc::AdcModel;
use tryboard_soc::ble::Ble;
use tryboard_soc::chip::{self, Chip};
use tryboard_soc::devices::audio::Audio;
use tryboard_soc::devices::gc9a01::Gc9a01;
use tryboard_soc::devices::pins::PinDevices;
use tryboard_soc::i2c::I2c;
use tryboard_soc::iotrace::IoTrace;
use tryboard_soc::rmt::Ws2812;
use tryboard_soc::tasktrace::TaskTrace;
use tryboard_soc::usb::Usb;
use tryboard_soc::wifi::WifiMac;
use tryboard_xtensa::Bus;

impl Esp32s3 {
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

impl Chip for Esp32s3 {
    fn run(&mut self, cycles: u64) -> chip::Stop {
        let r = Esp32s3::run(self, cycles);
        self.stop(r)
    }
    fn run_traced(&mut self, cycles: u64, ring: &mut VecDeque<u32>, cap: usize) -> chip::Stop {
        let r = Esp32s3::run_traced(self, cycles, ring, cap);
        self.stop(r)
    }
    fn reboot(&mut self, reason: u32) -> Result<(), String> {
        Esp32s3::reboot(self, reason)
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
    /// ESP32-S3 rev0 ROM 20210327
    fn rom_banner(&self, reason: u32) -> String {
        let name = chip::reset_name(reason);
        format!("ESP-ROM:esp32s3-20210327\nBuild:Mar 27 2021\nrst:0x{reason:x} ({name}),boot:0x8 (SPI_FAST_FLASH_BOOT)\n")
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
        Esp32s3::console_take(self)
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
    fn pcnt_count(&self, u: usize) -> Option<i16> {
        Some(self.bus.pcnt.count(u))
    }
    fn analog_set(&mut self, pin: usize, mv: f32) {
        if let Some(p) = self.bus.adc.pin_mv.get_mut(pin) {
            *p = mv;
        }
    }
    fn adc_model(&self) -> Option<&AdcModel> {
        Some(&self.bus.adc.model)
    }
    fn adc_model_mut(&mut self) -> Option<&mut AdcModel> {
        Some(&mut self.bus.adc.model)
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
    fn lcd_attach(&mut self) -> bool {
        self.bus.attach_lcd();
        true
    }
    fn lcd(&mut self) -> Option<&mut Gc9a01> {
        self.bus.lcd.as_deref_mut()
    }
    fn spi2_stats(&self) -> (u64, u64) {
        (self.bus.spi2.transfers, self.bus.spi2.bytes)
    }
    fn audio(&self) -> &Audio {
        &self.bus.audio
    }
    fn audio_mut(&mut self) -> &mut Audio {
        &mut self.bus.audio
    }
    fn attach_speaker(&mut self) -> bool {
        self.bus.attach_speaker();
        true
    }
    fn attach_mic(&mut self) -> bool {
        self.bus.attach_mic();
        true
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
    fn ble(&self) -> Option<&Ble> {
        self.bus.ble.hle.as_deref().map(|b| &*b.world)
    }
    fn ble_mut(&mut self) -> Option<&mut Ble> {
        self.bus.ble.hle.as_deref_mut().map(|b| &mut *b.world)
    }
    fn ble_error(&self) -> Option<String> {
        self.bus
            .ble
            .error
            .clone()
            .or_else(|| self.bus.ble.hle.as_ref().and_then(|b| b.error.clone()))
    }
    fn usb(&self) -> Option<&Usb> {
        self.bus.usb.as_deref()
    }
    fn usb_mut(&mut self) -> Option<&mut Usb> {
        self.bus.usb.as_deref_mut()
    }
}
