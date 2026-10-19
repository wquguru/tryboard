//! Chip-agnostic machine shell: picks ESP32-C3 or ESP32-S3 from the image header chip ID, one interface for CLI and wasm.
//! A new chip adds a branch here; CLI / web stay unchanged.

use std::collections::{HashMap, VecDeque};
use tryboard_elec::board::{Activity, Board, ChipKind, Power};
use tryboard_esp32::Esp32;
pub use tryboard_esp32c3::devices::audio::{Analysis as AudioAnalysis, Block as AudioBlock};
use tryboard_esp32c3::devices::audio::{Audio, MicSource};
use tryboard_esp32c3::devices::{
    bme280::{Bme280, Env},
    cst816s::Cst816s,
    ft6236::Ft6236,
    gc9a01::Gc9a01,
    imu::Pose,
    mpu6050::Mpu6050,
    qmi8658::Qmi8658,
    ssd1306::Ssd1306,
};
pub use tryboard_esp32c3::iotrace::IoEvent;
use tryboard_esp32c3::iotrace::IoTrace;
use tryboard_esp32c3::rmt::Ws2812;
pub use tryboard_esp32c3::tasktrace::{TaskEvent, TaskInfo, TaskTrace};
use tryboard_esp32c3::Esp32c3;
use tryboard_esp32s3::Esp32s3;
use tryboard_soc::adc::{AdcModel, Sample as AdcSample};

pub use tryboard_esp32c3::periph::CPU_HZ;
pub use tryboard_esp32c3::wifi::phone::Cmd as PhoneCmd;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Chip {
    Esp32,
    Esp32c3,
    Esp32s3,
}

impl Chip {
    /// Chip ID from the image header (esp_app_format.h)
    pub fn from_image(flash: &[u8]) -> Option<Chip> {
        match tryboard_esp32s3::boot::image_chip_id(flash)? {
            0 => Some(Chip::Esp32),
            5 => Some(Chip::Esp32c3),
            9 => Some(Chip::Esp32s3),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Chip::Esp32 => "esp32",
            Chip::Esp32c3 => "esp32c3",
            Chip::Esp32s3 => "esp32s3",
        }
    }
    /// File name of this chip's ROM in esp-rom-elfs
    pub fn rom_file(self) -> &'static str {
        match self {
            Chip::Esp32 => "esp32_rev300_rom.elf",
            Chip::Esp32c3 => "esp32c3_rev3_rom.elf",
            Chip::Esp32s3 => "esp32s3_rev0_rom.elf",
        }
    }
    pub fn npins(self) -> usize {
        match self {
            Chip::Esp32 => tryboard_esp32::periph::NPINS,
            Chip::Esp32c3 => 22,
            Chip::Esp32s3 => tryboard_esp32s3::periph::NPINS,
        }
    }
    /// Numeric id for the web / tb_chip, same as the image header chip ID
    pub fn id(self) -> u32 {
        match self {
            Chip::Esp32 => 0,
            Chip::Esp32c3 => 5,
            Chip::Esp32s3 => 9,
        }
    }
}

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

#[allow(clippy::large_enum_variant)]
pub enum Hw {
    C3(Esp32c3),
    S3(Esp32s3),
    E32(Esp32),
}

/// External harness (P2-11, estimate, needs real hardware): total I2C wire length, antenna loss from metal / battery.
/// Like the power network it's outside world: survives software reset and is reattached to the new bus / Wi-Fi model
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Harness {
    /// None = ideal bus (no rise time; how all earlier cases ran)
    pub i2c_wire_cm: Option<f64>,
    pub antenna_loss_db: i32,
}

/// A machine = chip + board power network (tryboard-elec). The power network survives reset (it's outside world)
pub struct Machine {
    pub hw: Hw,
    pub elec: Board,
    harness: Harness,
    /// GPIO the touch controller's INT is wired to (low while pressed, high on release); None = not wired
    pub touch_int: Option<u32>,
}

pub struct BootInfo {
    pub offset: u32,
    pub entry: u32,
    pub segments: usize,
}

impl Machine {
    pub fn boot(rom: &[u8], flash: Vec<u8>) -> Result<(Machine, BootInfo), String> {
        match Chip::from_image(&flash) {
            Some(Chip::Esp32s3) => {
                let (m, a) = Esp32s3::boot(rom, flash)?;
                Ok((
                    Machine {
                        hw: Hw::S3(m),
                        elec: Board::new(ChipKind::S3),
                        touch_int: None,
                        harness: Harness::default(),
                    },
                    BootInfo {
                        offset: a.offset,
                        entry: a.entry,
                        segments: a.segments.len(),
                    },
                ))
            }
            Some(Chip::Esp32) => {
                let (m, a) = Esp32::boot(rom, flash)?;
                Ok((
                    Machine {
                        hw: Hw::E32(m),
                        elec: Board::new(ChipKind::Esp32),
                        touch_int: None,
                        harness: Harness::default(),
                    },
                    BootInfo {
                        offset: a.offset,
                        entry: a.entry,
                        segments: a.segments.len(),
                    },
                ))
            }
            Some(Chip::Esp32c3) | None => {
                let (m, a) = Esp32c3::boot(rom, flash)?;
                Ok((
                    Machine {
                        hw: Hw::C3(m),
                        elec: Board::new(ChipKind::C3),
                        touch_int: None,
                        harness: Harness::default(),
                    },
                    BootInfo {
                        offset: a.offset,
                        entry: a.entry,
                        segments: a.segments.len(),
                    },
                ))
            }
        }
    }

    /// Power up after software reset: flash (incl. NVS) kept, simulated time continues.
    /// S3 also keeps RTC memory and RTC_CNTL store registers (RTC_NOINIT, reset reason hints), see Esp32s3::reboot
    pub fn reboot(&mut self, reason: u32) -> Result<(), String> {
        // The virtual phone is the outside world: it survives a board reset, only the hotspot vanishes for a while
        let phone = self.wifi_mut().world.phone.take();
        // "Real network" is a web toggle that survives reset; request ids keep counting so late replies
        // from before the reset are not mistaken for new requests
        let (realnet, next_req) = {
            let t = &self.wifi().world.net.tcp;
            (t.realnet, t.next_req)
        };
        match &mut self.hw {
            Hw::C3(m) => m.reboot(reason)?,
            Hw::S3(m) => m.reboot(reason)?,
            Hw::E32(m) => m.reboot(reason)?,
        }
        self.apply_harness();
        {
            let t = &mut self.wifi_mut().world.net.tcp;
            t.realnet = realnet;
            t.next_req = next_req;
        }
        if let Some(mut p) = phone {
            let now = self.wifi_tsf_us();
            p.chip_reset(now);
            self.wifi_mut().world.enable_phone(p);
        }
        // We don't run the ROM boot, so add the three lines ROM prints on every reset (reason worded as ROM does) so web and CLI
        // consoles show rst:0x.. (not on first power-up, so existing cases' serial output stays unchanged)
        let banner = rom_banner(self.chip(), reason);
        self.console_push(banner.as_bytes());
        Ok(())
    }

    fn console_push(&mut self, b: &[u8]) {
        match &mut self.hw {
            Hw::C3(m) => m.bus.console.extend_from_slice(b),
            Hw::S3(m) => m.bus.console.extend_from_slice(b),
            Hw::E32(m) => m.bus.console.extend_from_slice(b),
        }
    }

    pub fn harness(&self) -> Harness {
        self.harness
    }

    /// Total I2C wire length (cm); None = ideal bus
    pub fn set_i2c_wire(&mut self, cm: Option<f64>) {
        self.harness.i2c_wire_cm = cm.map(|c| c.max(0.0));
        self.apply_harness();
    }

    /// Antenna loss (dB, >= 0)
    pub fn set_antenna_loss(&mut self, db: i32) {
        self.harness.antenna_loss_db = db.max(0);
        self.apply_harness();
    }

    fn apply_harness(&mut self) {
        let h = self.harness;
        self.i2c0().wire_cm = h.i2c_wire_cm;
        self.wifi_mut().world.antenna_loss_db = h.antenna_loss_db;
    }

    /// I2C0 bus load: (rise time ns, limit ns at current frequency, verdict); None for an ideal bus
    pub fn i2c_load(&mut self) -> Option<(f64, f64, tryboard_elec::i2cbus::Verdict)> {
        self.i2c0().load()
    }

    /// Bytes misread and address NACKs caused by excessive rise time (estimate)
    pub fn i2c_slow_stats(&mut self) -> (u64, u64) {
        let b = self.i2c0();
        (b.slow_bytes, b.slow_nacks)
    }

    /// Enable the virtual phone (C-02): adds the virtual router MyHome and moves the virtual network to 192.168.5.0/24.
    /// auto_open: open the login page once captive; auto_post: submit this body once a form shows up
    pub fn phone_enable(&mut self, auto_open: bool, auto_post: Option<String>) {
        let w = &mut self.wifi_mut().world;
        let mut p = w.phone.take().unwrap_or_default();
        p.auto_open = auto_open;
        p.auto_post = auto_post;
        w.enable_phone(p);
    }

    /// One phone step (join hotspot, open login page, GET / POST); enables the phone first if needed
    pub fn phone_cmd(&mut self, c: tryboard_esp32c3::wifi::phone::Cmd) {
        if self.wifi().world.phone.is_none() {
            self.phone_enable(false, None);
        }
        let now = self.wifi_tsf_us();
        if let Some(p) = self.wifi_mut().world.phone.as_mut() {
            p.command(c, now);
        }
        self.kick_events();
    }

    /// "Real network" switch (C-03, script action realnet=1/0): when on, HTTP requests not for tryboard.local go to the outbox
    pub fn realnet_set(&mut self, on: bool) {
        self.wifi_mut().world.net.tcp.realnet = on;
    }

    /// Drain the outbox (the web fetches them; the CLI stays offline and answers only from netreply= in --inputs)
    pub fn net_outbox_take(&mut self) -> Vec<tryboard_esp32c3::wifi::tcp::RealReq> {
        std::mem::take(&mut self.wifi_mut().world.net.tcp.outbox)
    }

    /// The part after the script action netreply=; false when unparsable
    pub fn net_reply(&mut self, s: &str) -> bool {
        let Some((id, status, info, body)) = tryboard_esp32c3::wifi::tcp::parse_netreply(s) else {
            return false;
        };
        let now = self.wifi_tsf_us();
        self.wifi_mut()
            .world
            .net
            .real_reply(id, status, &info, &body, now);
        self.kick_events();
        true
    }

    pub fn phone(&self) -> Option<&tryboard_esp32c3::wifi::phone::Phone> {
        self.wifi().world.phone.as_ref()
    }

    /// TSF of the Wi-Fi model (simulated microseconds)
    fn wifi_tsf_us(&self) -> u64 {
        self.cycles() / (self.wifi().layout.cpu_hz / 1_000_000)
    }

    /// An external event changed peripheral state: update peripherals on the next bus step (not at the cached next event)
    fn kick_events(&mut self) {
        match &mut self.hw {
            Hw::C3(m) => m.bus.next_event = 0,
            Hw::S3(m) => m.bus.next_event = 0,
            Hw::E32(m) => m.bus.next_event = 0,
        }
    }

    fn wifi_mut(&mut self) -> &mut tryboard_esp32c3::wifi::WifiMac {
        match &mut self.hw {
            Hw::C3(m) => m.bus.wifi_mut(),
            Hw::S3(m) => m.bus.wifi_mut(),
            Hw::E32(m) => m.bus.wifi_mut(),
        }
    }

    /// GPIO the servo signal is on (servo current only when attached; otherwise the network has only chip and modules)
    pub fn servo_attach(&mut self, pin: u32) {
        self.elec.attach_servo(pin);
    }

    /// Power source: USB (servo also draws USB 5V) or external 5 V (servo powered separately, common ground)
    pub fn set_power(&mut self, p: Power) {
        self.elec.set_power(p);
    }

    /// What the chip did during this run segment, fed to the power network
    fn activity(&self, c0: u64, i0: u64, w0: (u64, u64)) -> Activity {
        let dc = self.cycles().saturating_sub(c0).max(1);
        let busy = (self.instret().saturating_sub(i0)) as f64 / dc as f64;
        let w = self.wifi_frames();
        let tx_frames = w.0.saturating_sub(w0.0);
        let tx = tx_frames as f64 * self.elec.p.tx_airtime / (dc as f64 / CPU_HZ as f64);
        let servo_pw_us = self
            .elec
            .servo_pin
            .and_then(|p| self.pin_pwm(p as usize))
            .and_then(|(d, f)| {
                // Servos only respond to ~50 Hz pulses; other frequencies (kHz buzzers) aren't servo signals
                if (20.0..=500.0).contains(&f) && d > 0.0 {
                    Some(d as f64 / f as f64 * 1e6)
                } else {
                    None
                }
            });
        let amp_i = self
            .audio()
            .and_then(|a| a.speaker.as_ref())
            .map(|s| s.supply_current())
            .unwrap_or(0.0);
        Activity {
            busy,
            wifi_on: w.0 + w.1 > 0,
            tx,
            servo_pw_us,
            amp_i,
        }
    }

    /// Wi-Fi MAC model (both chips share tryboard-soc's implementation): air log, frame counts
    pub fn wifi(&self) -> &tryboard_esp32c3::wifi::WifiMac {
        match &self.hw {
            Hw::C3(m) => m.bus.wifi(),
            Hw::S3(m) => m.bus.wifi(),
            Hw::E32(m) => m.bus.wifi(),
        }
    }

    /// Wi-Fi frame counts (tx, rx)
    fn wifi_frames(&self) -> (u64, u64) {
        let w = self.wifi();
        (w.tx_frames, w.rx_frames)
    }

    /// While brownout reset is held: the chip doesn't execute, time still runs (peripherals advance with CPU cycles)
    fn hold(&mut self, cycles: u64) {
        match &mut self.hw {
            Hw::C3(m) => {
                m.cpu.cycles += cycles;
                m.bus.now = m.cpu.cycles;
            }
            Hw::S3(m) => {
                m.cpu.cycles += cycles;
                m.bus.now = m.cpu.cycles;
                if m.cpu1_on {
                    m.cpu1.cycles = m.cpu.cycles;
                }
            }
            Hw::E32(m) => {
                m.cpu.cycles += cycles;
                m.bus.now = m.cpu.cycles;
                if m.cpu1_on {
                    m.cpu1.cycles = m.cpu.cycles;
                }
            }
        }
    }

    /// After a segment, advance the power network; on brownout end the segment as reset (reason 15 = RTCWDT_BROWN_OUT_RESET)
    fn after_run(&mut self, c0: u64, i0: u64, w0: (u64, u64), r: Stop) -> Stop {
        let act = self.activity(c0, i0, w0);
        let now = self.cycles();
        if self.elec.advance(now, &act) && matches!(r, Stop::Budget | Stop::Reset(_)) {
            return Stop::Reset(BROWNOUT_RESET);
        }
        r
    }

    /// Native USB (S3 only)
    pub fn usb(&self) -> Option<&tryboard_esp32s3::usb::Usb> {
        match &self.hw {
            Hw::S3(m) => m.bus.usb.as_deref(),
            Hw::C3(_) | Hw::E32(_) => None,
        }
    }

    pub fn usb_mut(&mut self) -> Option<&mut tryboard_esp32s3::usb::Usb> {
        match &mut self.hw {
            Hw::S3(m) => m.bus.usb.as_deref_mut(),
            Hw::C3(_) | Hw::E32(_) => None,
        }
    }

    /// BLE virtual world (C-01): present only when the VHCI boundary was found in firmware (C3 only for now)
    pub fn ble(&self) -> Option<&tryboard_esp32c3::ble::Ble> {
        match &self.hw {
            Hw::C3(m) => m.bus.ble.as_deref().map(|b| &*b.world),
            Hw::S3(_) | Hw::E32(_) => None,
        }
    }

    pub fn ble_mut(&mut self) -> Option<&mut tryboard_esp32c3::ble::Ble> {
        match &mut self.hw {
            Hw::C3(m) => m.bus.ble.as_deref_mut().map(|b| &mut *b.world),
            Hw::S3(_) | Hw::E32(_) => None,
        }
    }

    /// Why firmware uses BLE but the VHCI boundary wasn't found (or HLE failed); None = no BLE or all fine
    pub fn ble_error(&self) -> Option<String> {
        match &self.hw {
            Hw::C3(m) => m
                .bus
                .ble_error
                .clone()
                .or_else(|| m.bus.ble.as_ref().and_then(|b| b.error.clone())),
            Hw::S3(_) | Hw::E32(_) => None,
        }
    }

    /// Virtual phone action (the part after `ble=` in the input log)
    pub fn ble_phone(&mut self, cmd: &str) -> Result<(), String> {
        let now = self.cycles() / (CPU_HZ / 1_000_000);
        match self.ble_mut() {
            Some(b) => b.phone_cmd(cmd, now),
            None => Err("this firmware has no BLE that can be simulated".into()),
        }
    }

    pub fn chip(&self) -> Chip {
        match &self.hw {
            Hw::C3(_) => Chip::Esp32c3,
            Hw::S3(_) => Chip::Esp32s3,
            Hw::E32(_) => Chip::Esp32,
        }
    }

    /// Run cycles, then advance the power network from the chip's activity in that span.
    /// While brownout reset is held no instructions run (time still does); once voltage recovers the next run continues from reset
    pub fn run(&mut self, cycles: u64) -> Stop {
        let (c0, i0, w0) = (self.cycles(), self.instret(), self.wifi_frames());
        if self.elec.held {
            self.hold(cycles);
            return self.after_run(c0, i0, w0, Stop::Budget);
        }
        let r = match &mut self.hw {
            Hw::C3(m) => {
                let r = m.run(cycles);
                c3_stop(m, r)
            }
            Hw::S3(m) => {
                let r = m.run(cycles);
                s3_stop(m, r)
            }
            Hw::E32(m) => {
                let r = m.run(cycles);
                e32_stop(m, r)
            }
        };
        self.after_run(c0, i0, w0, r)
    }

    pub fn run_traced(&mut self, cycles: u64, ring: &mut VecDeque<u32>, cap: usize) -> Stop {
        let (c0, i0, w0) = (self.cycles(), self.instret(), self.wifi_frames());
        if self.elec.held {
            self.hold(cycles);
            return self.after_run(c0, i0, w0, Stop::Budget);
        }
        let r = match &mut self.hw {
            Hw::C3(m) => {
                let r = m.run_traced(cycles, ring, cap);
                c3_stop(m, r)
            }
            Hw::S3(m) => {
                let r = m.run_traced(cycles, ring, cap);
                s3_stop(m, r)
            }
            Hw::E32(m) => {
                let r = m.run_traced(cycles, ring, cap);
                e32_stop(m, r)
            }
        };
        self.after_run(c0, i0, w0, r)
    }

    /// Core 0 cycle count (simulated time)
    pub fn cycles(&self) -> u64 {
        match &self.hw {
            Hw::C3(m) => m.cpu.cycles,
            Hw::S3(m) => m.cpu.cycles,
            Hw::E32(m) => m.cpu.cycles,
        }
    }

    pub fn instret(&self) -> u64 {
        match &self.hw {
            Hw::C3(m) => m.cpu.instret,
            Hw::S3(m) => m.cpu.instret + if m.cpu1_on { m.cpu1.instret } else { 0 },
            Hw::E32(m) => m.cpu.instret + if m.cpu1_on { m.cpu1.instret } else { 0 },
        }
    }

    pub fn pc(&self) -> u32 {
        match &self.hw {
            Hw::C3(m) => m.cpu.pc,
            Hw::S3(m) => m.cpu.pc,
            Hw::E32(m) => m.cpu.pc,
        }
    }

    pub fn console_take(&mut self) -> Vec<u8> {
        match &mut self.hw {
            Hw::C3(m) => m.console_take(),
            Hw::S3(m) => m.console_take(),
            Hw::E32(m) => m.console_take(),
        }
    }

    pub fn gpio_level(&self) -> u64 {
        match &self.hw {
            Hw::C3(m) => m.bus.gpio.level() as u64,
            Hw::S3(m) => m.bus.gpio.level(),
            Hw::E32(m) => m.bus.gpio.level(),
        }
    }

    pub fn gpio_enable(&self) -> u64 {
        match &self.hw {
            Hw::C3(m) => m.bus.gpio.enable as u64,
            Hw::S3(m) => m.bus.gpio.enable,
            Hw::E32(m) => m.bus.gpio.enable,
        }
    }

    /// Drive a pin externally (button etc.). level < 0 means released (not driven)
    pub fn gpio_drive(&mut self, pin: u32, level: i32) {
        macro_rules! drive {
            ($m:expr, $one:expr) => {{
                let bit = $one << pin;
                let g = &mut $m.bus.gpio;
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
                let now = $m.cpu.cycles;
                $m.bus.gpio_changed(now);
            }};
        }
        match &mut self.hw {
            Hw::C3(m) => drive!(m, 1u32),
            Hw::S3(m) => drive!(m, 1u64),
            Hw::E32(m) => drive!(m, 1u64),
        }
    }

    /// Pin of the onboard BOOT button (C3: GPIO9, S3: GPIO0)
    pub fn boot_pin(&self) -> u32 {
        match &self.hw {
            Hw::C3(_) => 9,
            Hw::S3(_) | Hw::E32(_) => 0,
        }
    }

    pub fn uart_push(&mut self, data: &[u8]) {
        match &mut self.hw {
            Hw::C3(m) => {
                m.bus.uart0.push_rx(data);
                m.bus.irq_dirty = true;
            }
            Hw::S3(m) => {
                m.bus.uart0.push_rx(data);
                m.bus.irq_dirty = true;
            }
            Hw::E32(m) => {
                m.bus.uart0.push_rx(data);
                m.bus.irq_dirty = true;
            }
        }
    }

    pub fn pin_pwm(&self, pin: usize) -> Option<(f32, f32)> {
        match &self.hw {
            Hw::C3(m) => m.bus.pin_pwm(pin),
            Hw::S3(m) => m.bus.pin_pwm(pin),
            Hw::E32(m) => m.bus.pin_pwm(pin),
        }
    }

    /// Analog voltage on a pin (mV), read by the ADC
    pub fn analog_set(&mut self, pin: usize, mv: f32) {
        let slot = match &mut self.hw {
            Hw::C3(m) => m.bus.adc.pin_mv.get_mut(pin),
            Hw::S3(m) => m.bus.adc.pin_mv.get_mut(pin),
            Hw::E32(m) => m.bus.adc.pin_mv.get_mut(pin),
        };
        if let Some(p) = slot {
            *p = mv;
        }
    }

    fn adc_model(&mut self) -> Option<&mut AdcModel> {
        match &mut self.hw {
            Hw::C3(m) => Some(&mut m.bus.adc.model),
            Hw::S3(m) => Some(&mut m.bus.adc.model),
            Hw::E32(_) => None,
        }
    }

    /// Session seed (D batch, default 7): each random stream salts it (ADC: seed ^ 0x41444300)
    pub fn set_seed(&mut self, seed: u32) {
        if let Some(a) = self.adc_model() {
            a.reseed(seed);
        }
    }

    /// `adc=ideal` (linear, noiseless) or `adc=real` (calibration curve, bends, noise; default)
    pub fn set_adc_ideal(&mut self, ideal: bool) {
        if let Some(a) = self.adc_model() {
            a.set_ideal(ideal);
        }
    }

    pub fn adc_ideal(&self) -> bool {
        match &self.hw {
            Hw::C3(m) => m.bus.adc.model.ideal,
            Hw::S3(m) => m.bus.adc.model.ideal,
            Hw::E32(_) => false,
        }
    }

    /// Recent conversions on a pin (raw, calibrated mV), oldest first, at most 48
    pub fn adc_samples(&self, pin: usize) -> Vec<AdcSample> {
        match &self.hw {
            Hw::C3(m) => m.bus.adc.model.samples(pin).copied().collect(),
            Hw::S3(m) => m.bus.adc.model.samples(pin).copied().collect(),
            Hw::E32(_) => Vec::new(),
        }
    }

    /// ADC2 reads refused because Wi-Fi held the arbiter
    pub fn adc_blocked(&self) -> u64 {
        match &self.hw {
            Hw::C3(m) => m.bus.adc.model.blocked,
            Hw::S3(m) => m.bus.adc.model.blocked,
            Hw::E32(_) => 0,
        }
    }

    pub fn ws2812(&self) -> &HashMap<u32, Ws2812> {
        match &self.hw {
            Hw::C3(m) => &m.bus.ws2812,
            Hw::S3(m) => &m.bus.ws2812,
            Hw::E32(m) => &m.bus.ws2812,
        }
    }

    fn i2c0(&mut self) -> &mut tryboard_esp32c3::i2c::I2c {
        match &mut self.hw {
            Hw::C3(m) => &mut m.bus.i2c0,
            Hw::S3(m) => &mut m.bus.i2c0,
            Hw::E32(m) => &mut m.bus.i2c0,
        }
    }

    /// Attach a device to the I2C0 bus ("ssd1306" / "bme280")
    pub fn i2c_attach(&mut self, kind: &str, addr: u8) -> bool {
        match tryboard_esp32c3::devices::make_i2c(kind, addr) {
            Some(d) => {
                self.i2c0().attach(d);
                self.elec.add_module(kind);
                true
            }
            None => false,
        }
    }

    pub fn i2c_stats(&mut self) -> (u64, u64) {
        let b = self.i2c0();
        (b.transactions, b.nacks)
    }

    pub fn env_set(&mut self, env: Env) {
        let t = env.temp_c;
        let bus = self.i2c0();
        if let Some(b) = bus.device::<Bme280>() {
            b.env = env;
        }
        // The IMU's on-chip thermometer reads die temperature: use ambient (self-heating not modelled)
        if let Some(d) = bus.device::<Mpu6050>() {
            d.temp_c = t;
        }
        if let Some(d) = bus.device::<Qmi8658>() {
            d.temp_c = t;
        }
    }

    /// Pose (applies to MPU6050 / QMI8658 on the bus): Euler angles (deg) + rates (deg/s), see devices/imu.rs
    pub fn imu_set(&mut self, pose: Pose) {
        let bus = self.i2c0();
        if let Some(d) = bus.device::<Mpu6050>() {
            d.pose = pose;
        }
        if let Some(d) = bus.device::<Qmi8658>() {
            d.pose = pose;
        }
    }

    /// GPIO the touch INT is wired to: drive it high (not pressed) once attached
    pub fn touch_int_attach(&mut self, pin: u32) {
        self.touch_int = Some(pin);
        self.gpio_drive(pin, 1);
    }

    /// Finger on the touchscreen (x, y in screen pixels; CST816S clamps to 0..239, FT6236 is 12-bit); down = false lifts
    pub fn touch(&mut self, x: u16, y: u16, down: bool) {
        let now = self.cycles();
        let bus = self.i2c0();
        if let Some(d) = bus.device::<Cst816s>() {
            if down {
                d.press(x, y, now);
            } else {
                d.release(now);
            }
        } else if let Some(d) = bus.device::<Ft6236>() {
            if down {
                d.press(x, y);
            } else {
                d.release();
            }
        } else {
            return;
        }
        if let Some(pin) = self.touch_int {
            self.gpio_drive(pin, if down { 0 } else { 1 });
        }
    }

    pub fn oled(&mut self) -> Option<&mut Ssd1306> {
        self.i2c0().device::<Ssd1306>()
    }

    /// Attach a screen on SPI2 (only "gc9a01" for now). Pins per chip:
    /// S3 see tryboard_esp32s3::lcd_pin, C3 see tryboard_esp32c3::lcd_pin
    pub fn lcd_attach(&mut self, kind: &str) -> bool {
        match (&mut self.hw, kind) {
            (Hw::S3(m), "gc9a01") => {
                m.bus.attach_lcd();
                self.elec.add_module("gc9a01");
                true
            }
            (Hw::C3(m), "gc9a01") => {
                m.bus.attach_lcd();
                self.elec.add_module("gc9a01");
                true
            }
            _ => false,
        }
    }

    pub fn lcd(&mut self) -> Option<&mut Gc9a01> {
        match &mut self.hw {
            Hw::S3(m) => m.bus.lcd.as_deref_mut(),
            Hw::C3(m) => m.bus.lcd.as_deref_mut(),
            Hw::E32(_) => None,
        }
    }

    pub fn audio(&self) -> Option<&Audio> {
        let a = match &self.hw {
            Hw::S3(m) => &m.bus.audio,
            Hw::C3(m) => &m.bus.audio,
            Hw::E32(m) => &m.bus.audio,
        };
        (!a.is_empty()).then_some(a)
    }

    fn audio_mut(&mut self) -> &mut Audio {
        match &mut self.hw {
            Hw::S3(m) => &mut m.bus.audio,
            Hw::C3(m) => &mut m.bus.audio,
            Hw::E32(m) => &mut m.bus.audio,
        }
    }

    /// Attach an I2S audio device: "max98357a" (speaker) / "inmp441" (mic). Pins per chip:
    /// S3 see tryboard_esp32s3::i2s_pin, C3 see tryboard_esp32c3::i2s_pin
    pub fn i2s_attach(&mut self, kind: &str) -> bool {
        match (&mut self.hw, kind) {
            (Hw::S3(m), "max98357a") => m.bus.attach_speaker(),
            (Hw::C3(m), "max98357a") => m.bus.attach_speaker(),
            (Hw::S3(m), "inmp441") => m.bus.attach_mic(),
            (Hw::C3(m), "inmp441") => m.bus.attach_mic(),
            _ => return false,
        }
        self.elec.add_module(kind);
        true
    }

    /// Mic hears a fixed WAV (looped); attaches a mic if none
    pub fn mic_wav(&mut self, rate: f64, data: Vec<f32>) {
        if self.audio_mut().mic.is_none() {
            self.i2s_attach("inmp441");
        }
        if let Some(m) = self.audio_mut().mic.as_mut() {
            m.source = MicSource::Wav { rate, data };
        }
    }

    /// Mic hears live pushed audio (web mic), rate = sample rate of the pushed data
    pub fn mic_push(&mut self, rate: f64, x: &[f32]) {
        if let Some(m) = self.audio_mut().mic.as_mut() {
            m.push_live(rate, x);
        }
    }

    /// Mic back to silence
    pub fn mic_silence(&mut self) {
        if let Some(m) = self.audio_mut().mic.as_mut() {
            m.source = MicSource::Silence;
        }
    }

    /// Take the speaker's accumulated audio (with simulated timestamps)
    pub fn audio_take(&mut self) -> Vec<AudioBlock> {
        self.audio_mut()
            .speaker
            .as_mut()
            .map(|s| s.take())
            .unwrap_or_default()
    }

    /// Speaker readings over the last secs seconds
    pub fn audio_analyze(&self, secs: f64) -> Option<AudioAnalysis> {
        self.audio()?.speaker.as_ref().map(|s| s.analyze(secs))
    }

    /// `[tryboard] I2S ...` observation records (empty without audio devices)
    pub fn audio_report(&self) -> String {
        self.audio().map(|a| a.report()).unwrap_or_default()
    }

    /// SPI2 transfer stats (count, MOSI bytes)
    pub fn spi_stats(&self) -> (u64, u64) {
        match &self.hw {
            Hw::S3(m) => (m.bus.spi2.transfers, m.bus.spi2.bytes),
            Hw::C3(m) => (m.bus.spi2.transfers, m.bus.spi2.bytes),
            Hw::E32(_) => (0, 0),
        }
    }

    fn pins(&mut self) -> &mut tryboard_esp32c3::devices::pins::PinDevices {
        match &mut self.hw {
            Hw::C3(m) => &mut m.bus.pins,
            Hw::S3(m) => &mut m.bus.pins,
            Hw::E32(m) => &mut m.bus.pins,
        }
    }

    /// Make the SoC poll external pin devices again right away (a new waveform was queued)
    fn pins_kick(&mut self) {
        match &mut self.hw {
            Hw::C3(m) => {
                m.bus.next_event = 0;
                m.bus.irq_dirty = true;
            }
            Hw::S3(m) => {
                m.bus.next_event = 0;
                m.bus.irq_dirty = true;
            }
            Hw::E32(m) => {
                m.bus.next_event = 0;
                m.bus.irq_dirty = true;
            }
        }
    }

    /// Attach a rotary encoder (P2-01): A / B phases and optional switch pin; 3V3-powered, current goes to the power network
    pub fn encoder_attach(&mut self, a: u32, b: u32, sw: Option<u32>) {
        let now = self.cycles();
        self.pins()
            .encoders
            .push(tryboard_esp32c3::devices::pins::Encoder::new(a, b, sw, now));
        self.elec.add_module("encoder");
        self.pins_kick();
    }

    /// Turn the encoder by steps detents (positive = clockwise); script action enc=+N / enc=-N
    pub fn encoder_turn(&mut self, steps: i32) {
        let now = self.cycles();
        if let Some(e) = self.pins().encoders.first_mut() {
            e.turn(now, steps);
        }
        self.pins_kick();
    }

    /// Encoder switch; script action encsw=1|0
    pub fn encoder_press(&mut self, down: bool) {
        let now = self.cycles();
        if let Some(e) = self.pins().encoders.first_mut() {
            e.press(now, down);
        }
        self.pins_kick();
    }

    /// Detents turned so far (clockwise positive)
    pub fn encoder_position(&mut self) -> Option<i64> {
        self.pins().encoders.first().map(|e| e.position)
    }

    /// Attach an HC-SR04 (P2-04): Trig driven by the chip, Echo by the module; 5 V powered, current on the 5V rail
    pub fn sonar_attach(&mut self, trig: u32, echo: u32) {
        let now = self.cycles();
        self.pins()
            .sonars
            .push(tryboard_esp32c3::devices::pins::Hcsr04::new(
                trig, echo, now,
            ));
        self.elec.add_module("hcsr04");
        self.pins_kick();
    }

    /// Distance from probe to obstacle (cm); negative = nothing ahead (out of range). Script action dist=<cm>
    pub fn sonar_distance(&mut self, cm: f64) {
        if let Some(s) = self.pins().sonars.first_mut() {
            s.distance_cm = (cm >= 0.0).then_some(cm);
        }
    }

    /// Ultrasonic stats (triggers, echoes, last echo width us)
    pub fn sonar_stats(&mut self) -> Option<(u64, u64, f64)> {
        self.pins()
            .sonars
            .first()
            .map(|s| (s.pings, s.echoes, s.last_us))
    }

    /// Current count of pulse counter unit u (only S3 has PCNT)
    pub fn pcnt_count(&self, u: usize) -> Option<i16> {
        match &self.hw {
            Hw::S3(m) => Some(m.bus.pcnt.count(u)),
            Hw::C3(_) | Hw::E32(_) => None,
        }
    }

    /// GPIO level change log (cycle, levels)
    pub fn gpio_log(&self) -> Vec<(u64, u64)> {
        match &self.hw {
            Hw::C3(m) => m
                .bus
                .gpio_log
                .iter()
                .map(|(t, l)| (*t, *l as u64))
                .collect(),
            Hw::S3(m) => m.bus.gpio_log.clone(),
            Hw::E32(m) => m.bus.gpio_log.clone(),
        }
    }

    fn iotrace(&mut self) -> &mut IoTrace {
        match &mut self.hw {
            Hw::C3(m) => &mut m.bus.iotrace,
            Hw::S3(m) => &mut m.bus.iotrace,
            Hw::E32(m) => &mut m.bus.iotrace,
        }
    }

    /// GPIOs the logic analyzer watches (bit = pin). PWM / WS2812 / I2C events are always logged
    pub fn io_watch(&mut self, mask: u64) {
        self.iotrace().watch = mask;
    }

    /// Event buffer cap (entries); 0 = don't record
    pub fn io_cap(&mut self, cap: usize) {
        self.iotrace().cap = cap;
    }

    /// Take all buffered events (in recording order)
    pub fn io_take(&mut self) -> Vec<IoEvent> {
        self.iotrace().take()
    }

    /// Entries dropped because the buffer was full
    pub fn io_dropped(&mut self) -> u64 {
        self.iotrace().dropped
    }

    fn tasktrace(&mut self) -> &mut TaskTrace {
        match &mut self.hw {
            Hw::C3(m) => &mut m.bus.tasks,
            Hw::S3(m) => &mut m.bus.tasks,
            Hw::E32(m) => &mut m.bus.tasks,
        }
    }

    /// Enable the task timeline (C-04): event cap (entries), 0 = don't record
    pub fn tasks_enable(&mut self, cap: usize) {
        self.tasktrace().cap = cap;
    }

    /// Take task switch events (in order)
    pub fn tasks_take(&mut self) -> Vec<TaskEvent> {
        self.tasktrace().take()
    }

    /// Tasks seen so far (an event's task is an index here; only grows)
    pub fn tasks_list(&mut self) -> &[TaskInfo] {
        &self.tasktrace().tasks
    }

    pub fn tasks_dropped(&mut self) -> u64 {
        self.tasktrace().dropped
    }

    /// Core count (task timeline lanes)
    pub fn cores(&self) -> usize {
        match &self.hw {
            Hw::C3(_) => 1,
            Hw::S3(_) | Hw::E32(_) => 2,
        }
    }

    /// Pin levels at power-up (gpio_log's starting point)
    pub fn gpio_reset_level(&self) -> u64 {
        match &self.hw {
            Hw::C3(_) => 0,
            Hw::S3(_) | Hw::E32(_) => 1,
        }
    }

    pub fn unimpl(&self) -> Vec<(u32, u64)> {
        let m = match &self.hw {
            Hw::C3(m) => &m.bus.unimpl,
            Hw::S3(m) => &m.bus.unimpl,
            Hw::E32(m) => &m.bus.unimpl,
        };
        let mut v: Vec<_> = m.iter().map(|(a, n)| (*a, *n)).collect();
        v.sort_by_key(|x| std::cmp::Reverse(x.1));
        v
    }

    /// Read a 32-bit word (debug; triggers MMIO read side effects)
    pub fn peek(&mut self, a: u32) -> Option<u32> {
        match &mut self.hw {
            Hw::C3(m) => tryboard_rv32::Bus::load(&mut m.bus, a, 4).ok(),
            Hw::S3(m) => tryboard_xtensa::Bus::load(&mut m.bus, a, 4).ok(),
            Hw::E32(m) => tryboard_xtensa::Bus::load(&mut m.bus, a, 4).ok(),
        }
    }

    /// CPU state description at halt (debug); sym maps addresses to symbols
    pub fn debug_state(&self, sym: &dyn Fn(u32) -> String) -> String {
        match &self.hw {
            Hw::C3(m) => format!("pc {}  ra {}", sym(m.cpu.pc), sym(m.cpu.x[1])),
            Hw::S3(m) => xtensa_state(&m.cpu, m.cpu1_on.then_some(&m.cpu1), sym),
            Hw::E32(m) => xtensa_state(&m.cpu, m.cpu1_on.then_some(&m.cpu1), sym),
        }
    }
}

/// Halt state of dual-core Xtensa (shared by S3 and ESP32)
fn xtensa_state(
    c0: &tryboard_xtensa::Cpu,
    c1: Option<&tryboard_xtensa::Cpu>,
    sym: &dyn Fn(u32) -> String,
) -> String {
    use tryboard_xtensa::sr;
    let core = |c: &tryboard_xtensa::Cpu, k: usize| {
        format!(
            "core{k} pc {}  PS=0x{:08x} WB={} WS=0x{:04x} INTENABLE=0x{:08x} INTERRUPT=0x{:08x} EXCCAUSE={} EPC1={}",
            sym(c.pc),
            c.ps(),
            c.windowbase,
            c.windowstart,
            c.read_sr(sr::INTENABLE),
            c.read_sr(sr::INTERRUPT),
            c.read_sr(sr::EXCCAUSE),
            sym(c.read_sr(sr::EPC1)),
        )
    };
    let mut s = core(c0, 0);
    if let Some(c1) = c1 {
        s += "\n[tryboard] ";
        s += &core(c1, 1);
    }
    s
}

/// RTCWDT_BROWN_OUT_RESET (esp_rom rtc.h, same on S3 / C3): esp_reset_reason() reads ESP_RST_BROWNOUT
pub const BROWNOUT_RESET: u32 = 15;

/// The three lines ROM prints after reset (format of ESP32-S3 rev0 ROM 20210327, ESP32-C3 ROM 20210207)
pub fn rom_banner(chip: Chip, reason: u32) -> String {
    let name = match reason {
        1 => "POWERON",
        3 => "RTC_SW_SYS_RST",
        12 => "RTC_SW_CPU_RST",
        15 => "BROWNOUT_RST",
        _ => "UNKNOWN",
    };
    match chip {
        // Classic ESP32 first-gen ROM (2016-06-08): only two lines, old-style reset reason names
        Chip::Esp32 => {
            let name = match reason {
                1 => "POWERON_RESET",
                3 => "SW_RESET",
                12 => "SW_CPU_RESET",
                15 => "RTCWDT_BROWN_OUT_RESET",
                _ => "UNKNOWN",
            };
            format!("ets Jun  8 2016 00:22:57\n\nrst:0x{reason:x} ({name}),boot:0x13 (SPI_FAST_FLASH_BOOT)\n")
        }
        Chip::Esp32s3 => format!("ESP-ROM:esp32s3-20210327\nBuild:Mar 27 2021\nrst:0x{reason:x} ({name}),boot:0x8 (SPI_FAST_FLASH_BOOT)\n"),
        Chip::Esp32c3 => format!("ESP-ROM:esp32c3-api1-20210207\nBuild:Feb  7 2021\nrst:0x{reason:x} ({name}),boot:0xc (SPI_FAST_FLASH_BOOT)\n"),
    }
}

fn c3_stop(m: &Esp32c3, r: tryboard_esp32c3::Stop) -> Stop {
    use tryboard_esp32c3::Stop as S;
    match r {
        S::Budget => Stop::Budget,
        S::Fault { cause, pc, tval } => Stop::Fault(format!(
            "CPU exception cause={cause} pc=0x{pc:08x} tval=0x{tval:08x}"
        )),
        S::Hle(pc) => Stop::Hle(format!("0x{pc:08x} {}", m.symbol_at(pc).unwrap_or(""))),
        S::Reset(r) => Stop::Reset(r),
    }
}

fn e32_stop(m: &Esp32, r: tryboard_esp32::Stop) -> Stop {
    use tryboard_esp32::Stop as S;
    match r {
        S::Budget => Stop::Budget,
        S::Fault { cause, epc, vaddr } => Stop::Fault(format!(
            "CPU exception EXCCAUSE={cause} EPC1=0x{epc:08x} EXCVADDR=0x{vaddr:08x}"
        )),
        S::Break(v) => Stop::Fault(format!("BREAK 0x{v:x}")),
        S::Hle(pc) => Stop::Hle(format!("0x{pc:08x} {}", m.symbol_at(pc).unwrap_or(""))),
        S::Reset(r) => Stop::Reset(r),
    }
}

fn s3_stop(m: &Esp32s3, r: tryboard_esp32s3::Stop) -> Stop {
    use tryboard_esp32s3::Stop as S;
    match r {
        S::Budget => Stop::Budget,
        S::Fault { cause, epc, vaddr } => Stop::Fault(format!(
            "CPU exception EXCCAUSE={cause} EPC1=0x{epc:08x} EXCVADDR=0x{vaddr:08x}"
        )),
        S::Break(v) => Stop::Fault(format!("BREAK 0x{v:x}")),
        S::Hle(pc) => Stop::Hle(format!("0x{pc:08x} {}", m.symbol_at(pc).unwrap_or(""))),
        S::Reset(r) => Stop::Reset(r),
    }
}

pub use tryboard_esp32c3::devices::bme280::Env as SensorEnv;
pub use tryboard_esp32c3::devices::imu::Pose as ImuPose;

/// Argument part of script action `imu=pitch,roll,yaw[,dpitch,droll,dyaw]` (deg, deg/s)
pub fn parse_imu(s: &str) -> Option<Pose> {
    let v: Vec<f64> = s
        .split(',')
        .map(|x| x.trim().parse().ok())
        .collect::<Option<_>>()?;
    match v.as_slice() {
        [p, r, y] => Some(Pose::new(*p, *r, *y)),
        [p, r, y, dp, dr, dy] => Some(Pose {
            pitch: *p,
            roll: *r,
            yaw: *y,
            dpitch: *dp,
            droll: *dr,
            dyaw: *dy,
        }),
        _ => None,
    }
}

/// Argument part of script action `touch=x,y` (screen pixels). Clamped to the touch chip's 12-bit range;
/// the device model clamps to its actual screen (CST816S round screen 240x240)
pub fn parse_touch(s: &str) -> Option<(u16, u16)> {
    let (x, y) = s.split_once(',')?;
    let f = |t: &str| {
        t.trim()
            .parse::<f64>()
            .ok()
            .map(|v| v.round().clamp(0.0, 4095.0) as u16)
    };
    Some((f(x)?, f(y)?))
}
pub use tryboard_elec::board::Power as PowerMode;

/// One-line I2C wire verdict (P2-11); None without a wire length (ideal bus). Shared by CLI and web; text matched by accept.json
pub fn harness_i2c_line(m: &mut Machine) -> Option<String> {
    use tryboard_elec::i2cbus::Verdict;
    let cm = m.harness().i2c_wire_cm?;
    let (rise, limit, v) = m.i2c_load()?;
    let khz = m.i2c0().scl_hz() / 1000.0;
    let (bad, nacks) = m.i2c_slow_stats();
    let what = match v {
        Verdict::Ok => "within spec".to_string(),
        Verdict::Marginal => {
            format!("out of spec: read-back bytes will be wrong ({bad} bytes wrong so far)")
        }
        Verdict::Fail => format!("over twice the limit: device does not ACK (NACK {nacks} times)"),
    };
    #[rustfmt::skip]
    let line = format!("[tryboard] I2C wire {cm} cm: rise time {rise:.0} ns, {khz:.0} kHz allows {limit:.0} ns, {what} (estimate, must verify on real hardware)");
    Some(line)
}

/// One-line antenna loss verdict (P2-11); None when unobstructed. Text matched by accept.json / harness.mjs
pub fn harness_wifi_line(m: &Machine) -> Option<String> {
    use tryboard_esp32c3::wifi::world::{LINK_MIN_DBM, SCAN_MIN_DBM};
    let db = m.harness().antenna_loss_db;
    if db == 0 {
        return None;
    }
    let w = &m.wifi().world;
    let aps: Vec<String> = (0..w.aps.len())
        .map(|i| {
            let r = w.rssi(i) as i32;
            let note = if r < SCAN_MIN_DBM {
                " (out of range)"
            } else if r < LINK_MIN_DBM {
                " (cannot connect)"
            } else {
                ""
            };
            format!("{} {r} dBm{note}", w.aps[i].ssid)
        })
        .collect();
    Some(format!(
        "[tryboard] antenna blockage {db} dB: {} (estimate, must verify on real hardware)",
        aps.join(", ")
    ))
}

/// USB virtual host verdict for level checks (P2-12): host state + typed text. CLI `--usb-log` prints these two lines (plus
/// enumeration logs); wasm tb_usb_report emits the same text so fingerprints match
pub fn usb_report_lines(m: &Machine) -> String {
    let Some(u) = m.usb() else {
        return String::new();
    };
    let h = &u.host;
    let mut o = format!("[tryboard] USB host: {}\n", h.state_name());
    if !h.typed.is_empty() {
        o.push_str(&format!("[tryboard] USB keyboard typed: {:?}\n", h.typed));
    }
    o
}

/// I2C criteria for generated checkpoints (U-17): ACK count per addressed 7-bit address, ascending. CLI `--i2c-log` prints these;
/// wasm tb_i2c_report emits the same text so fingerprints match. Both S3 controllers merged: any controller counts as wired
pub fn i2c_ack_lines(m: &Machine) -> String {
    let mut acks: std::collections::BTreeMap<u8, u64> = std::collections::BTreeMap::new();
    let mut add = |b: &tryboard_esp32c3::i2c::I2c| {
        for (a, (_, ok)) in &b.addr_acks {
            *acks.entry(*a).or_insert(0) += ok;
        }
    };
    match &m.hw {
        Hw::C3(c) => add(&c.bus.i2c0),
        Hw::S3(s) => {
            add(&s.bus.i2c0);
            add(&s.bus.i2c1);
        }
        Hw::E32(s) => {
            add(&s.bus.i2c0);
            add(&s.bus.i2c1);
        }
    }
    acks.iter()
        .map(|(a, n)| format!("[tryboard] I2C 0x{a:02x} acked {n} times\n"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imu_touch_actions() {
        assert_eq!(parse_imu("30,-20,5"), Some(Pose::new(30.0, -20.0, 5.0)));
        assert_eq!(parse_imu("1,2,3,4,5,6").map(|p| p.dyaw), Some(6.0));
        assert_eq!(parse_imu("1,2"), None);
        assert_eq!(parse_touch("120.4, 300"), Some((120, 300)));
        assert_eq!(parse_touch("-3, 9000"), Some((0, 4095)));
        assert_eq!(parse_touch("x,1"), None);
    }
}
