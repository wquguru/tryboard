//! Chip-agnostic machine shell: picks the SoC from the image header chip ID, one interface for CLI and wasm.
//! Everything after boot goes through `tryboard_soc::chip::Chip`; a new chip adds a `Chip` variant and a branch in `boot`.

mod boards;
pub use boards::{
    list as board_list, BoardPreset, Button as BoardButton, I2cBus as BoardI2cBus, BOARDS,
};
use std::collections::{HashMap, VecDeque};
use tryboard_elec::board::{Activity, Board, ChipKind, Power};
use tryboard_esp32::Esp32;
use tryboard_esp32c3::Esp32c3;
use tryboard_esp32s3::Esp32s3;
use tryboard_soc::adc::{AdcModel, Sample as AdcSample};
pub use tryboard_soc::chip::Stop;
pub use tryboard_soc::devices::audio::{Analysis as AudioAnalysis, Block as AudioBlock};
use tryboard_soc::devices::audio::{Audio, MicSource};
pub use tryboard_soc::devices::lcd::{Lcd, LcdKind, LcdPins};
use tryboard_soc::devices::{
    aw9523::Aw9523,
    axp192::Axp192,
    axp2101::Axp2101,
    bme280::{Bme280, Env},
    bmi270::Bmi270,
    cst816s::Cst816s,
    cst9220::Cst9220,
    ft6236::Ft6236,
    imu::Pose,
    mpu6050::Mpu6050,
    pcf85063::Pcf85063,
    pcf8563::Pcf8563,
    qmi8658::Qmi8658,
    ssd1306::Ssd1306,
};
use tryboard_soc::i2c::I2cDevice;
pub use tryboard_soc::iotrace::IoEvent;
use tryboard_soc::iotrace::IoTrace;
use tryboard_soc::rmt::Ws2812;
pub use tryboard_soc::tasktrace::{TaskEvent, TaskInfo, TaskTrace};

pub use tryboard_soc::periph::CPU_HZ;
use tryboard_soc::wifi::netcond::{FaultKind, Preset, DEFAULT_FAULT_S};
pub use tryboard_soc::wifi::phone::Cmd as PhoneCmd;
pub use tryboard_soc::wifi::world::NetSummary;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Chip {
    Esp32,
    Esp32c3,
    Esp32s3,
}

impl Chip {
    pub const ALL: [Chip; 3] = [Chip::Esp32, Chip::Esp32c3, Chip::Esp32s3];
    /// Chip ID from the image header (esp_app_format.h)
    pub fn from_image(flash: &[u8]) -> Option<Chip> {
        Chip::from_id(tryboard_soc::boot::image_chip_id(flash)? as u32)
    }
    pub fn from_id(id: u32) -> Option<Chip> {
        Chip::ALL.into_iter().find(|c| c.id() == id)
    }
    /// GPIO wired to the dev board's BOOT button
    pub fn boot_pin(self) -> u32 {
        match self {
            Chip::Esp32c3 => 9,
            Chip::Esp32 | Chip::Esp32s3 => 0,
        }
    }
    /// GPIO of the on-board WS2812 (ESP32-DevKitC V4 has none)
    pub fn rgb_pin(self) -> Option<u32> {
        match self {
            Chip::Esp32 => None,
            Chip::Esp32c3 => Some(8),
            Chip::Esp32s3 => Some(48),
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
    /// The SoC behind the trait (R-06); the concrete type is chosen only in `boot`
    hw: Box<dyn tryboard_soc::chip::Chip>,
    chip: Chip,
    pub elec: Board,
    harness: Harness,
    /// GPIO the touch controller's INT is wired to (low while pressed, high on release); None = not wired
    pub touch_int: Option<u32>,
    /// Board preset applied by `board_preset` (M5-05)
    board: Option<&'static BoardPreset>,
}

pub struct BootInfo {
    pub offset: u32,
    pub entry: u32,
    pub segments: usize,
}

impl Machine {
    pub fn boot(rom: &[u8], flash: Vec<u8>) -> Result<(Machine, BootInfo), String> {
        let chip = Chip::from_image(&flash).ok_or_else(|| {
            match tryboard_soc::boot::image_chip_id(&flash) {
                Some(id) => format!("unsupported chip id {id} in the image header (TryBoard simulates ESP32, ESP32-C3, ESP32-S3)"),
                None => "no ESP-IDF app image found (missing 0xE9 header / partition table)".into(),
            }
        })?;
        // The only place that names concrete chip types: pick the SoC from the image header chip ID
        let (hw, kind, offset, entry, segments): (Box<dyn tryboard_soc::chip::Chip>, _, _, _, _) =
            match chip {
                Chip::Esp32c3 => {
                    let (m, a) = Esp32c3::boot(rom, flash)?;
                    (
                        Box::new(m),
                        ChipKind::C3,
                        a.offset,
                        a.entry,
                        a.segments.len(),
                    )
                }
                Chip::Esp32s3 => {
                    let (m, a) = Esp32s3::boot(rom, flash)?;
                    (
                        Box::new(m),
                        ChipKind::S3,
                        a.offset,
                        a.entry,
                        a.segments.len(),
                    )
                }
                Chip::Esp32 => {
                    let (m, a) = Esp32::boot(rom, flash)?;
                    (
                        Box::new(m),
                        ChipKind::Esp32,
                        a.offset,
                        a.entry,
                        a.segments.len(),
                    )
                }
            };
        Ok((
            Machine {
                hw,
                chip,
                elec: Board::new(kind),
                touch_int: None,
                board: None,
                harness: Harness::default(),
            },
            BootInfo {
                offset,
                entry,
                segments,
            },
        ))
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
        // Network conditions (D-01) belong to the router, not the board: preset, schedule and PRNG state carry over
        let cond = std::mem::take(&mut self.wifi_mut().world.cond);
        self.hw.reboot(reason)?;
        self.apply_harness();
        {
            let t = &mut self.wifi_mut().world.net.tcp;
            t.realnet = realnet;
            t.next_req = next_req;
        }
        self.wifi_mut().world.cond = cond;
        if let Some(mut p) = phone {
            let now = self.wifi_tsf_us();
            p.chip_reset(now);
            self.wifi_mut().world.enable_phone(p);
        }
        // We don't run the ROM boot, so add the three lines ROM prints on every reset (reason worded as ROM does) so web and CLI
        // consoles show rst:0x.. (not on first power-up, so existing cases' serial output stays unchanged)
        let banner = self.hw.rom_banner(reason);
        self.console_push(banner.as_bytes());
        Ok(())
    }

    fn console_push(&mut self, b: &[u8]) {
        self.hw.console_push(b);
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
    pub fn phone_cmd(&mut self, c: tryboard_soc::wifi::phone::Cmd) {
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
    pub fn net_outbox_take(&mut self) -> Vec<tryboard_soc::wifi::tcp::RealReq> {
        std::mem::take(&mut self.wifi_mut().world.net.tcp.outbox)
    }

    /// The part after the script action netreply=; false when unparsable
    pub fn net_reply(&mut self, s: &str) -> bool {
        let Some((id, status, info, body)) = tryboard_soc::wifi::tcp::parse_netreply(s) else {
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

    /// Session seed (D batch, default 7): each stream salts it (network seed ^ 0x4E45_5400, ADC seed ^ 0x41444300).
    /// Set it before net= so flaky drops follow it
    pub fn set_seed(&mut self, seed: u32) {
        self.wifi_mut().world.cond.set_seed(seed);
        if let Some(a) = self.adc_model() {
            a.reseed(seed);
        }
    }

    /// Network preset (D-01): normal / weak / flaky / offline; false when unknown
    pub fn net_preset(&mut self, name: &str) -> bool {
        let Some(p) = Preset::parse(name) else {
            return false;
        };
        let now = self.wifi_tsf_us();
        self.wifi_mut().world.set_preset(p, now);
        self.kick_events();
        true
    }

    /// Schedule a fault (D-01): reboot / dns / silent from start_s (None = now) for dur_s seconds (None = 8)
    pub fn net_fault(&mut self, kind: &str, start_s: Option<f64>, dur_s: Option<f64>) -> bool {
        let Some(k) = FaultKind::parse(kind) else {
            return false;
        };
        let dur = dur_s.unwrap_or(DEFAULT_FAULT_S);
        if dur.is_nan()
            || dur <= 0.0
            || dur.is_infinite()
            || start_s.is_some_and(|s| s.is_nan() || s < 0.0)
        {
            return false;
        }
        let now = self.wifi_tsf_us();
        let start = start_s.map_or(now, |s| (s * 1e6).round() as u64);
        self.wifi_mut()
            .world
            .add_fault(k, start, (dur * 1e6).round() as u64);
        self.kick_events();
        true
    }

    /// Script actions seed= / net= / netfault=kind[,dur] (D-01; shared by CLI and web); None when not a network action
    pub fn net_action(&mut self, act: &str) -> Option<bool> {
        if let Some(v) = act.strip_prefix("seed=") {
            return Some(v.trim().parse().map(|s| self.set_seed(s)).is_ok());
        }
        if let Some(v) = act.strip_prefix("net=") {
            return Some(self.net_preset(v));
        }
        let v = act.strip_prefix("netfault=")?;
        let (k, d) = v.split_once(',').unwrap_or((v, ""));
        let dur = match d.trim() {
            "" => None,
            d => match d.parse::<f64>() {
                Ok(x) => Some(x),
                Err(_) => return Some(false),
            },
        };
        Some(self.net_fault(k, None, dur))
    }

    /// Network summary (D-01); None while conditions are untouched
    pub fn net_summary(&self) -> Option<NetSummary> {
        self.wifi().world.net_summary()
    }

    pub fn phone(&self) -> Option<&tryboard_soc::wifi::phone::Phone> {
        self.wifi().world.phone.as_ref()
    }

    /// TSF of the Wi-Fi model (simulated microseconds)
    fn wifi_tsf_us(&self) -> u64 {
        self.cycles() / (self.wifi().layout.cpu_hz / 1_000_000)
    }

    /// An external event changed peripheral state: update peripherals on the next bus step (not at the cached next event)
    fn kick_events(&mut self) {
        self.hw.kick_events();
    }

    fn wifi_mut(&mut self) -> &mut tryboard_soc::wifi::WifiMac {
        self.hw.wifi_mut()
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
    pub fn wifi(&self) -> &tryboard_soc::wifi::WifiMac {
        self.hw.wifi()
    }

    /// Wi-Fi frame counts (tx, rx)
    fn wifi_frames(&self) -> (u64, u64) {
        let w = self.wifi();
        (w.tx_frames, w.rx_frames)
    }

    /// While brownout reset is held: the chip doesn't execute, time still runs (peripherals advance with CPU cycles)
    fn hold(&mut self, cycles: u64) {
        self.hw.hold(cycles);
    }

    /// After a segment, advance the power network; on brownout end the segment as reset (reason 15 = RTCWDT_BROWN_OUT_RESET)
    fn after_run(&mut self, c0: u64, i0: u64, w0: (u64, u64), r: Stop) -> Stop {
        self.sync_expander_int();
        let act = self.activity(c0, i0, w0);
        let now = self.cycles();
        if self.elec.advance(now, &act) && matches!(r, Stop::Budget | Stop::Reset(_)) {
            return Stop::Reset(BROWNOUT_RESET);
        }
        r
    }

    /// Native USB (S3 only)
    pub fn usb(&self) -> Option<&tryboard_soc::usb::Usb> {
        self.hw.usb()
    }

    pub fn usb_mut(&mut self) -> Option<&mut tryboard_soc::usb::Usb> {
        self.hw.usb_mut()
    }

    /// BLE virtual world (C-01): present only when the VHCI boundary was found in firmware (C3 only for now)
    pub fn ble(&self) -> Option<&tryboard_soc::ble::Ble> {
        self.hw.ble()
    }

    pub fn ble_mut(&mut self) -> Option<&mut tryboard_soc::ble::Ble> {
        self.hw.ble_mut()
    }

    /// Why firmware uses BLE but the VHCI boundary wasn't found (or HLE failed); None = no BLE or all fine
    pub fn ble_error(&self) -> Option<String> {
        self.hw.ble_error()
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
        self.chip
    }

    /// Run cycles, then advance the power network from the chip's activity in that span.
    /// While brownout reset is held no instructions run (time still does); once voltage recovers the next run continues from reset
    pub fn run(&mut self, cycles: u64) -> Stop {
        let (c0, i0, w0) = (self.cycles(), self.instret(), self.wifi_frames());
        if self.elec.held {
            self.hold(cycles);
            return self.after_run(c0, i0, w0, Stop::Budget);
        }
        let r = self.hw.run(cycles);
        self.after_run(c0, i0, w0, r)
    }

    pub fn run_traced(&mut self, cycles: u64, ring: &mut VecDeque<u32>, cap: usize) -> Stop {
        let (c0, i0, w0) = (self.cycles(), self.instret(), self.wifi_frames());
        if self.elec.held {
            self.hold(cycles);
            return self.after_run(c0, i0, w0, Stop::Budget);
        }
        let r = self.hw.run_traced(cycles, ring, cap);
        self.after_run(c0, i0, w0, r)
    }

    /// Core 0 cycle count (simulated time)
    pub fn cycles(&self) -> u64 {
        self.hw.cycles()
    }

    pub fn instret(&self) -> u64 {
        self.hw.instret()
    }

    pub fn pc(&self) -> u32 {
        self.hw.pc()
    }

    pub fn console_take(&mut self) -> Vec<u8> {
        self.hw.console_take()
    }

    pub fn gpio_level(&self) -> u64 {
        self.hw.gpio_level()
    }

    pub fn gpio_enable(&self) -> u64 {
        self.hw.gpio_enable()
    }

    /// Drive a pin externally (button etc.). level < 0 means released (not driven)
    pub fn gpio_drive(&mut self, pin: u32, level: i32) {
        self.hw.gpio_drive(pin, level);
    }

    /// Pin of the onboard BOOT button (C3: GPIO9, S3: GPIO0)
    pub fn boot_pin(&self) -> u32 {
        self.chip().boot_pin()
    }

    /// Peripheral (MMIO) address window of this chip, for the bus fuzz test (R-04)
    #[doc(hidden)]
    pub fn mmio_window(&self) -> (u32, u32) {
        self.hw.mmio_window()
    }

    /// Raw bus access as if the firmware did it (fuzz test only); faults are ignored, panics are the bug being hunted
    #[doc(hidden)]
    pub fn bus_poke(&mut self, addr: u32, size: u32, val: u32, write: bool) {
        self.hw.bus_poke(addr, size, val, write);
    }

    pub fn uart_push(&mut self, data: &[u8]) {
        self.hw.uart_push(data);
    }

    pub fn pin_pwm(&self, pin: usize) -> Option<(f32, f32)> {
        self.hw.pin_pwm(pin)
    }

    /// Analog voltage on a pin (mV), read by the ADC
    pub fn analog_set(&mut self, pin: usize, mv: f32) {
        self.hw.analog_set(pin, mv);
    }

    fn adc_model(&mut self) -> Option<&mut AdcModel> {
        self.hw.adc_model_mut()
    }

    /// `adc=ideal` (linear, noiseless) or `adc=real` (calibration curve, bends, noise; default)
    pub fn set_adc_ideal(&mut self, ideal: bool) {
        if let Some(a) = self.adc_model() {
            a.set_ideal(ideal);
        }
    }

    pub fn adc_ideal(&self) -> bool {
        self.hw.adc_model().is_some_and(|a| a.ideal)
    }

    /// Recent conversions on a pin (raw, calibrated mV), oldest first, at most 48
    pub fn adc_samples(&self, pin: usize) -> Vec<AdcSample> {
        self.hw
            .adc_model()
            .map(|a| a.samples(pin).copied().collect())
            .unwrap_or_default()
    }

    /// ADC2 reads refused because Wi-Fi held the arbiter
    pub fn adc_blocked(&self) -> u64 {
        self.hw.adc_model().map_or(0, |a| a.blocked)
    }

    pub fn ws2812(&self) -> &HashMap<u32, Ws2812> {
        self.hw.ws2812()
    }

    fn i2c0(&mut self) -> &mut tryboard_soc::i2c::I2c {
        self.hw.i2c0()
    }

    /// Attach a device to the I2C0 bus ("ssd1306" / "bme280")
    pub fn i2c_attach(&mut self, kind: &str, addr: u8) -> bool {
        match tryboard_soc::devices::make_i2c(kind, addr) {
            Some(d) => {
                self.i2c0().attach(d);
                self.elec.add_module(kind);
                true
            }
            None => false,
        }
    }

    /// Add an I2C bus on fixed pads (M5-02): whichever controller the GPIO matrix routes to both pads reaches its
    /// devices, and so does firmware bit-banging the pads; `pullup` = external pull-ups. None if a pad is taken.
    pub fn i2c_bus_add(&mut self, sda: u32, scl: u32, pullup: bool) -> Option<usize> {
        self.hw
            .i2c_bus_add(tryboard_soc::i2cpins::PinBus::new(sda, scl, pullup))
    }

    /// Attach a device to pin bus `bus` (from `i2c_bus_add`)
    pub fn i2c_attach_bus(&mut self, bus: usize, kind: &str, addr: u8) -> bool {
        let Some(d) = tryboard_soc::devices::make_i2c(kind, addr) else {
            return false;
        };
        let Some(b) = self.hw.i2c_pin_buses().and_then(|p| p.buses.get_mut(bus)) else {
            return false;
        };
        b.attach(d);
        self.elec.add_module(kind);
        true
    }

    /// Package version eFuse (S3 0 = QFN56, 1 = PICO; ESP32 5 = PICO-D4, 6 = PICO-V3-02); false if unsupported
    pub fn set_efuse_pkg(&mut self, pkg: u32) -> bool {
        self.hw.set_efuse_pkg(pkg)
    }

    /// Quad PSRAM size in MB (classic ESP32: 0 / 2 / 4 / 8); false if unsupported
    pub fn set_psram_mb(&mut self, mb: u32) -> bool {
        self.hw.set_psram(mb as usize * (1 << 20))
    }

    /// ESP32-S3: PSRAM die on the QSPI interface (e.g. CoreS3) instead of the default octal one
    pub fn set_psram_quad(&mut self, quad: bool) -> bool {
        self.hw.set_psram_quad(quad)
    }

    /// First device of type T: legacy I2C0 devices, then pin buses
    fn i2c_dev<T: 'static>(&mut self) -> Option<&mut T> {
        if self.hw.i2c0().device::<T>().is_some() {
            return self.hw.i2c0().device::<T>();
        }
        self.hw.i2c_pin_buses()?.device::<T>()
    }

    pub fn i2c_stats(&mut self) -> (u64, u64) {
        let b = self.i2c0();
        (b.transactions, b.nacks)
    }

    pub fn env_set(&mut self, env: Env) {
        let t = env.temp_c;
        let h = env.humidity;
        if let Some(b) = self.i2c_dev::<Bme280>() {
            b.env = env;
        }
        // The IMU's on-chip thermometer reads die temperature: use ambient (self-heating not modelled)
        if let Some(d) = self.i2c_dev::<Mpu6050>() {
            d.temp_c = t;
        }
        if let Some(d) = self.i2c_dev::<Qmi8658>() {
            d.temp_c = t;
        }
        if let Some(d) = self.i2c_dev::<Bmi270>() {
            d.temp_c = t;
        }
        for d in &mut self.pins().dhts {
            d.temp_c = t;
            d.humidity = h;
        }
        for b in &mut self.pins().onewire {
            b.set_temp(t);
        }
    }

    /// Pose (applies to MPU6050 / MPU6886 / QMI8658 / BMI270 + BMM150 on the bus): Euler angles (deg) + rates (deg/s), see devices/imu.rs
    pub fn imu_set(&mut self, pose: Pose) {
        if let Some(d) = self.i2c_dev::<Mpu6050>() {
            d.pose = pose;
        }
        if let Some(d) = self.i2c_dev::<Qmi8658>() {
            d.pose = pose;
        }
        if let Some(d) = self.i2c_dev::<Bmi270>() {
            d.pose = pose;
        }
    }

    /// GPIO the touch INT is wired to: drive it high (not pressed) once attached
    pub fn touch_int_attach(&mut self, pin: u32) {
        self.touch_int = Some(pin);
        self.gpio_drive(pin, 1);
    }

    /// Finger on the touchscreen (x, y in screen pixels; CST816S clamps to 0..239, FT6236 is 12-bit, CST9220 to its resolution); down = false lifts
    pub fn touch(&mut self, x: u16, y: u16, down: bool) {
        let now = self.cycles();
        if let Some(d) = self.i2c_dev::<Cst816s>() {
            if down {
                d.press(x, y, now);
            } else {
                d.release(now);
            }
        } else if let Some(d) = self.i2c_dev::<Ft6236>() {
            if down {
                d.press(x, y);
            } else {
                d.release();
            }
        } else if let Some(d) = self.i2c_dev::<Cst9220>() {
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
        if let Some((port, bit, _)) = self.board.and_then(|b| b.touch_int_aw9523) {
            if let Some(d) = self.i2c_dev::<Aw9523>() {
                d.set_input(port, bit, !down);
            }
            self.sync_expander_int();
        }
    }

    /// AW9523 INTN follows its pending state, which a port read clears; resynced once per run slice
    fn sync_expander_int(&mut self) {
        let Some((_, _, pin)) = self.board.and_then(|b| b.touch_int_aw9523) else {
            return;
        };
        let pending = self.i2c_dev::<Aw9523>().is_some_and(|d| d.int_pending());
        self.gpio_drive(pin, !pending as i32);
    }

    /// AXP2101 / AXP192 battery level / USB plug (action `bat=pct[,usb]`); false without a PMIC on the bus
    pub fn battery_set(&mut self, percent: u8, usb: bool) -> bool {
        if let Some(d) = self.i2c_dev::<Axp2101>() {
            d.set_battery(percent, usb);
        } else if let Some(d) = self.i2c_dev::<Axp192>() {
            d.set_battery(percent, usb);
        } else {
            return false;
        }
        true
    }

    /// AXP2101 PWRON / AXP192 PEK key press (action `pwrkey=short|long`)
    pub fn pwrkey(&mut self, long: bool) -> bool {
        if let Some(d) = self.i2c_dev::<Axp2101>() {
            d.pwrkey(long);
        } else if let Some(d) = self.i2c_dev::<Axp192>() {
            d.pwrkey(long);
        } else {
            return false;
        }
        true
    }

    /// PCF85063 / PCF8563 (BM8563) time (UTC epoch seconds) as of now
    pub fn rtc_set(&mut self, epoch: i64) -> bool {
        let now = self.cycles();
        if let Some(d) = self.i2c_dev::<Pcf85063>() {
            d.set_time(now);
            d.set_epoch(epoch);
        } else if let Some(d) = self.i2c_dev::<Pcf8563>() {
            d.set_time(now);
            d.set_epoch(epoch);
        } else {
            return false;
        }
        true
    }

    /// PMIC registers accessed without a model: (chip name, [(register, count)]); empty list without a PMIC
    pub fn pmic_unimpl(&mut self) -> (&'static str, Vec<(u8, u64)>) {
        let list =
            |m: &std::collections::BTreeMap<u8, u64>| m.iter().map(|(r, n)| (*r, *n)).collect();
        if let Some(d) = self.i2c_dev::<Axp2101>() {
            ("AXP2101", list(&d.unimpl))
        } else if let Some(d) = self.i2c_dev::<Axp192>() {
            ("AXP192", list(&d.unimpl))
        } else {
            ("", Vec::new())
        }
    }

    pub fn oled(&mut self) -> Option<&mut Ssd1306> {
        self.i2c_dev::<Ssd1306>()
    }

    /// Attach a screen on SPI2: "gc9a01" (C3 / S3, pins `lcd_pin`) or "co5300" (S3 only, pins `co5300_pin`);
    /// other chips / names return false
    pub fn lcd_attach(&mut self, kind: &str) -> bool {
        self.lcd_attach_spec(kind).is_ok()
    }

    /// "kind" or "kind@sclk=36,mosi=37,miso=35,cs=3,dc=35,rst=-1,bl=-1" (S3; pins not given keep `LcdPins::S3_DEFAULT`).
    /// DCS kinds: gc9a01 gc9107 st7735 st7789 st7789l ili9342(c) ili9342e; Err says what is wrong
    pub fn lcd_attach_spec(&mut self, spec: &str) -> Result<(), String> {
        let (name, pins) = match spec.split_once('@') {
            Some((n, p)) => (n, Some(p)),
            None => (spec, None),
        };
        let k = LcdKind::parse(name).ok_or_else(|| format!("unknown SPI device {name}"))?;
        let ok = match pins {
            None => self.hw.lcd_attach(k),
            Some(p) => {
                let pins = LcdPins::parse(self.hw.lcd_default_pins(), p)?;
                self.hw.lcd_attach_pins(k, pins)
            }
        };
        if !ok {
            return Err(format!("SPI device {spec} is not supported on this chip"));
        }
        self.elec.add_module(k.id());
        Ok(())
    }

    pub fn lcd(&mut self) -> Option<&mut Lcd> {
        self.hw.lcd()
    }

    pub fn audio(&self) -> Option<&Audio> {
        let a = self.hw.audio();
        (!a.is_empty()).then_some(a)
    }

    fn audio_mut(&mut self) -> &mut Audio {
        self.hw.audio_mut()
    }

    /// Attach an I2S audio device: "max98357a" (speaker) / "inmp441" (mic). Pins per chip:
    /// see `i2s_pin` in the chip crate (C3 / S3; other chips return false)
    pub fn i2s_attach(&mut self, kind: &str) -> bool {
        let ok = match kind {
            "max98357a" => self.hw.attach_speaker(),
            "inmp441" => self.hw.attach_mic(),
            _ => false,
        };
        if ok {
            self.elec.add_module(kind);
        }
        ok
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
        self.hw.spi2_stats()
    }

    /// SPI3 transfer stats (count, MOSI bytes)
    pub fn spi3_stats(&self) -> (u64, u64) {
        self.hw.spi3_stats()
    }

    fn pins(&mut self) -> &mut tryboard_soc::devices::pins::PinDevices {
        self.hw.pins()
    }

    /// Make the SoC poll external pin devices again right away (a new waveform was queued)
    fn pins_kick(&mut self) {
        self.hw.kick_pins();
    }

    /// Attach a rotary encoder (P2-01): A / B phases and optional switch pin; 3V3-powered, current goes to the power network
    pub fn encoder_attach(&mut self, a: u32, b: u32, sw: Option<u32>) {
        let now = self.cycles();
        self.pins()
            .encoders
            .push(tryboard_soc::devices::pins::Encoder::new(a, b, sw, now));
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
            .push(tryboard_soc::devices::pins::Hcsr04::new(trig, echo, now));
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

    /// Attach a DHT11 (D-03) on one open-drain data pin (25 °C / 50 %RH until env_set; attach before setting env)
    pub fn dht11_attach(&mut self, pin: u32) {
        let now = self.cycles();
        let d = tryboard_soc::devices::pins::Dht11::new(pin, now);
        self.pins().dhts.push(d);
        self.elec.add_module("dht11");
        self.pins_kick();
    }

    /// Attach a 1-Wire bus with `count` DS18B20s (F-04c) on one data pin; device i reads env + 0.5·i °C (attach before env_set)
    pub fn ds18b20_attach(&mut self, pin: u32, count: usize) {
        let now = self.cycles();
        let b = tryboard_soc::devices::ds18b20::OneWireBus::new(pin, count, now);
        for _ in &b.devs {
            self.elec.add_module("ds18b20");
        }
        self.pins().onewire.push(b);
        self.pins_kick();
    }

    /// DS18B20 bus stats (pin, devices, resets, conversions, scratchpad reads, unknown commands) and ROM codes
    pub fn ds18b20_stats(
        &mut self,
    ) -> Option<(
        u32,
        usize,
        tryboard_soc::devices::ds18b20::OneWireStats,
        Vec<[u8; 8]>,
    )> {
        self.pins().onewire.first().map(|b| {
            let roms = b.devs.iter().map(|d| d.rom).collect();
            (b.pin, b.devs.len(), b.stats.clone(), roms)
        })
    }

    /// DHT11 stats (frames sent, host start pulses that were too short)
    pub fn dht11_stats(&mut self) -> Option<(u64, u64)> {
        self.pins().dhts.first().map(|d| (d.reads, d.short_starts))
    }

    /// Timing-sensitive code report line (D-03), None when nothing was detected; C3 only for now
    pub fn timing_line(&self) -> Option<String> {
        self.hw.timing_line()
    }

    /// The same as JSON for the web: {"line":..,"items":[{"pin","kind","n"}]} or {}
    pub fn timing_json(&self) -> String {
        self.hw.timing_json()
    }

    /// Current count of pulse counter unit u (only S3 has PCNT)
    pub fn pcnt_count(&self, u: usize) -> Option<i16> {
        self.hw.pcnt_count(u)
    }

    /// GPIO level change log (cycle, levels)
    pub fn gpio_log(&self) -> Vec<(u64, u64)> {
        self.hw.gpio_log()
    }

    fn iotrace(&mut self) -> &mut IoTrace {
        self.hw.iotrace()
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

    /// Start a fine capture (D-04) of the pins in `mask` over cycles [t0, t1]; replaces any earlier one
    pub fn vcd_start(&mut self, mask: u64, t0: u64, t1: u64) {
        self.iotrace().vcd = Some(tryboard_soc::vcd::VcdCapture::new(mask, t0, t1));
    }

    /// Triggered fine capture: the window opens at the first edge on `mask` at or after `from` and lasts `len` cycles
    pub fn vcd_arm(&mut self, mask: u64, from: u64, len: u64) {
        self.iotrace().vcd = Some(tryboard_soc::vcd::VcdCapture::armed(mask, from, len));
    }

    /// Fine capture window in cycles (None while still waiting for the trigger)
    pub fn vcd_window(&mut self) -> Option<(u64, u64)> {
        let v = self.iotrace().vcd.as_ref()?;
        v.arm.is_none().then_some((v.t0, v.t1))
    }

    /// The fine capture as VCD text ("" when none was started)
    pub fn vcd_text(&mut self) -> String {
        let now = self.cycles();
        let io = self.iotrace();
        let lv = io.gpio_level();
        io.vcd.as_ref().map(|v| v.text(lv, now)).unwrap_or_default()
    }

    /// Fine capture (edges kept, edges dropped because the buffer was full)
    pub fn vcd_stats(&mut self) -> Option<(usize, u64)> {
        self.iotrace()
            .vcd
            .as_ref()
            .map(|v| (v.edges.len(), v.dropped))
    }

    fn tasktrace(&mut self) -> &mut TaskTrace {
        self.hw.tasktrace()
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
        self.hw.cores()
    }

    /// Pin levels at power-up (gpio_log's starting point)
    pub fn gpio_reset_level(&self) -> u64 {
        self.hw.gpio_reset_level()
    }

    pub fn unimpl(&self) -> Vec<(u32, u64)> {
        let mut v: Vec<_> = self.hw.unimpl().iter().map(|(a, n)| (*a, *n)).collect();
        // Address breaks count ties so reports are identical run to run (HashMap order is random)
        v.sort_by_key(|x| (std::cmp::Reverse(x.1), x.0));
        v
    }

    /// Read a 32-bit word (debug; triggers MMIO read side effects)
    pub fn peek(&mut self, a: u32) -> Option<u32> {
        self.hw.peek(a)
    }

    /// CPU state description at halt (debug); sym maps addresses to symbols
    pub fn debug_state(&self, sym: &dyn Fn(u32) -> String) -> String {
        self.hw.debug_state(sym)
    }

    /// Record accesses to this MMIO range (CLI `--watch`; C3 only for now, other chips ignore it)
    pub fn set_watch(&mut self, range: Option<(u32, u32)>) {
        self.hw.set_watch(range);
    }

    /// Watched accesses so far: (pc, address, value, is write)
    pub fn watch_hits(&self) -> &[(u32, u32, u32, bool)] {
        self.hw.watch_hits()
    }

    /// Raw bytes for CLI `--dump` (C3 only for now; None elsewhere)
    pub fn dump(&mut self, addr: u32, len: u32) -> Option<Vec<u8>> {
        self.hw.dump(addr, len)
    }

    /// Interrupt controller state for CLI `--dump-intc` (C3 only for now)
    pub fn intc_report(&self) -> Option<String> {
        self.hw.intc_report()
    }
}

/// RTCWDT_BROWN_OUT_RESET (esp_rom rtc.h, same on S3 / C3): esp_reset_reason() reads ESP_RST_BROWNOUT
pub const BROWNOUT_RESET: u32 = 15;

pub use tryboard_soc::devices::bme280::Env as SensorEnv;
pub use tryboard_soc::devices::imu::Pose as ImuPose;

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

/// Argument part of action `bat=pct[,usb]` (AXP2101 battery percent, USB plugged)
pub fn parse_battery(s: &str) -> Option<(u8, bool)> {
    let mut it = s.split(',').map(str::trim);
    let pct: f64 = it.next()?.parse().ok()?;
    let usb = match it.next() {
        None | Some("") | Some("bat") => false,
        Some("usb") => true,
        _ => return None,
    };
    Some((pct.round().clamp(0.0, 100.0) as u8, usb))
}

/// One touch coordinate in screen pixels, rounded and clamped to the touch chip's 12-bit range.
/// Shared by the script action and the wasm `tb_touch`; each device model clamps to its own screen
pub fn touch_coord(v: f64) -> u16 {
    if v.is_nan() {
        return 0;
    }
    v.round().clamp(0.0, 4095.0) as u16
}

/// Argument part of script action `touch=x,y` (screen pixels), see `touch_coord`
pub fn parse_touch(s: &str) -> Option<(u16, u16)> {
    let (x, y) = s.split_once(',')?;
    let f = |t: &str| t.trim().parse::<f64>().ok().map(touch_coord);
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
    use tryboard_soc::wifi::world::{LINK_MIN_DBM, SCAN_MIN_DBM};
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
    let mut add = |b: &tryboard_soc::i2c::I2c| {
        for (a, (_, ok)) in &b.addr_acks {
            *acks.entry(*a).or_insert(0) += ok;
        }
    };
    let mut n = 0;
    while let Some(b) = m.hw.i2c(n) {
        add(b);
        n += 1;
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
        // 480x480 AMOLED coordinates pass through; the wasm path shares the helper
        assert_eq!(touch_coord(479.4), 479);
        assert_eq!(touch_coord(-0.6), 0);
        assert_eq!(touch_coord(f64::NAN), 0);
        assert_eq!(touch_coord(1e9), 4095);
        assert_eq!(parse_battery("98,usb"), Some((98, true)));
        assert_eq!(parse_battery("140"), Some((100, false)));
        assert_eq!(parse_battery("5,car"), None);
    }
}
