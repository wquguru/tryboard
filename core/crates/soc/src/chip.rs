//! What the machine shell needs from a chip (R-06): each chip crate implements [`Chip`]; machine holds a `Box<dyn Chip>`.
//! Dispatch is per batch (`run` covers many instructions); the instruction loop stays monomorphic in the chip crate.

use crate::adc::AdcModel;
use crate::ble::Ble;
use crate::devices::audio::Audio;
use crate::devices::lcd::{Lcd, LcdKind};
use crate::devices::pins::PinDevices;
use crate::i2c::I2c;
use crate::iotrace::IoTrace;
use crate::rmt::Ws2812;
use crate::tasktrace::TaskTrace;
use crate::usb::Usb;
use crate::wifi::WifiMac;
use std::collections::{HashMap, VecDeque};

/// Why a run stopped (chip-agnostic)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stop {
    Budget,
    /// Firmware crashed, with a description
    Fault(String),
    /// Hit an unimplemented HLE function
    Hle(String),
    /// Firmware requested a software reset (esp_restart / reboot after panic), value = reset reason; call reboot() to power up
    Reset(u32),
}

/// Reset reason name as printed by the C3 / S3 ROMs (`rst:0x.. (NAME)`)
pub fn reset_name(reason: u32) -> &'static str {
    match reason {
        1 => "POWERON",
        3 => "RTC_SW_SYS_RST",
        12 => "RTC_SW_CPU_RST",
        15 => "BROWNOUT_RST",
        _ => "UNKNOWN",
    }
}

/// A simulated SoC as seen by the machine shell. Features only some chips have default to "absent"
/// (None / false / empty), so the shell never matches on the chip type.
pub trait Chip {
    // --- Running ---
    /// Run up to `cycles` CPU cycles (one batch; the hot loop stays inside the chip crate)
    fn run(&mut self, cycles: u64) -> Stop;
    /// Same, recording recent jump targets into `ring` (at most `cap` entries)
    fn run_traced(&mut self, cycles: u64, ring: &mut VecDeque<u32>, cap: usize) -> Stop;
    /// Power up after software reset: flash kept, simulated time continues
    fn reboot(&mut self, reason: u32) -> Result<(), String>;
    /// Brownout hold: no instructions run, time still advances
    fn hold(&mut self, cycles: u64);
    /// Core 0 cycle count (simulated time)
    fn cycles(&self) -> u64;
    /// Instructions retired, all running cores
    fn instret(&self) -> u64;
    fn pc(&self) -> u32;
    /// Core count (task timeline lanes)
    fn cores(&self) -> usize;
    /// CPU state description at halt (debug); sym maps addresses to symbols
    fn debug_state(&self, sym: &dyn Fn(u32) -> String) -> String;
    /// What this chip's ROM prints after a reset (the shell appends it to the console on reboot)
    fn rom_banner(&self, reason: u32) -> String;

    // --- Bus ---
    /// Peripheral (MMIO) address window, for the bus fuzz test (R-04)
    fn mmio_window(&self) -> (u32, u32);
    /// Raw bus access as if the firmware did it; faults are ignored
    fn bus_poke(&mut self, addr: u32, size: u32, val: u32, write: bool);
    /// Read a 32-bit word (debug; triggers MMIO read side effects)
    fn peek(&mut self, a: u32) -> Option<u32>;
    /// Unimplemented register accesses (address → count)
    fn unimpl(&self) -> &HashMap<u32, u64>;
    /// An external event changed peripheral state: update peripherals on the next bus step
    fn kick_events(&mut self);
    /// Same, and re-evaluate interrupt lines (external pin devices queued a new waveform)
    fn kick_pins(&mut self);
    /// Record accesses to this MMIO range (CLI `--watch`; C3 only for now)
    fn set_watch(&mut self, _range: Option<(u32, u32)>) {}
    /// Watched accesses so far: (pc, address, value, is write)
    fn watch_hits(&self) -> &[(u32, u32, u32, bool)] {
        &[]
    }
    /// Raw bytes for CLI `--dump` (C3 only for now; None = not supported)
    fn dump(&mut self, _addr: u32, _len: u32) -> Option<Vec<u8>> {
        None
    }
    /// Interrupt controller state for CLI `--dump-intc` (C3 only for now)
    fn intc_report(&self) -> Option<String> {
        None
    }

    // --- Console ---
    fn console_take(&mut self) -> Vec<u8>;
    /// Append text as if the chip printed it (ROM reset banner)
    fn console_push(&mut self, b: &[u8]);
    /// Bytes arriving on UART0 RX
    fn uart_push(&mut self, data: &[u8]);

    // --- GPIO / analog ---
    fn gpio_level(&self) -> u64;
    fn gpio_enable(&self) -> u64;
    /// Pin levels at power-up (gpio_log's starting point)
    fn gpio_reset_level(&self) -> u64;
    /// Drive a pin externally (button etc.). level < 0 means released (not driven)
    fn gpio_drive(&mut self, pin: u32, level: i32);
    /// GPIO level change log (cycle, levels)
    fn gpio_log(&self) -> Vec<(u64, u64)>;
    /// (duty, frequency Hz) of the PWM routed to a pin
    fn pin_pwm(&self, pin: usize) -> Option<(f32, f32)>;
    fn ws2812(&self) -> &HashMap<u32, Ws2812>;
    /// Current count of pulse counter unit u (chips with PCNT)
    fn pcnt_count(&self, _u: usize) -> Option<i16> {
        None
    }
    /// Analog voltage on a pin (mV), read by the ADC
    fn analog_set(&mut self, pin: usize, mv: f32);
    /// ADC behaviour model (calibration curve, noise, Wi-Fi arbiter); None where the chip has no such model yet
    fn adc_model(&self) -> Option<&AdcModel> {
        None
    }
    fn adc_model_mut(&mut self) -> Option<&mut AdcModel> {
        None
    }

    // --- External devices ---
    fn i2c0(&mut self) -> &mut I2c;
    /// I2C controller n (None past the last one)
    fn i2c(&self, n: usize) -> Option<&I2c>;
    fn pins(&mut self) -> &mut PinDevices;
    /// Attach a screen on SPI2 (pins per chip crate's `lcd_pin` / `co5300_pin`); false when the chip lacks that model
    fn lcd_attach(&mut self, _kind: LcdKind) -> bool {
        false
    }
    fn lcd(&mut self) -> Option<&mut Lcd> {
        None
    }
    /// SPI2 transfer stats (count, MOSI bytes)
    fn spi2_stats(&self) -> (u64, u64) {
        (0, 0)
    }
    fn audio(&self) -> &Audio;
    fn audio_mut(&mut self) -> &mut Audio;
    /// Attach an I2S speaker / mic (pins per chip crate's `i2s_pin`); false when unsupported
    fn attach_speaker(&mut self) -> bool {
        false
    }
    fn attach_mic(&mut self) -> bool {
        false
    }

    // --- Traces ---
    fn iotrace(&mut self) -> &mut IoTrace;
    fn tasktrace(&mut self) -> &mut TaskTrace;
    /// Timing-sensitive code report line (D-03)
    fn timing_line(&self) -> Option<String> {
        None
    }
    /// The same as JSON for the web
    fn timing_json(&self) -> String {
        "{}".into()
    }

    // --- Radio / USB ---
    fn wifi(&self) -> &WifiMac;
    fn wifi_mut(&mut self) -> &mut WifiMac;
    /// BLE virtual world: present only when the VHCI boundary was found in firmware
    fn ble(&self) -> Option<&Ble> {
        None
    }
    fn ble_mut(&mut self) -> Option<&mut Ble> {
        None
    }
    /// Why firmware uses BLE but it can't be simulated; None = no BLE or all fine
    fn ble_error(&self) -> Option<String> {
        None
    }
    /// Native USB OTG
    fn usb(&self) -> Option<&Usb> {
        None
    }
    fn usb_mut(&mut self) -> Option<&mut Usb> {
        None
    }
}
