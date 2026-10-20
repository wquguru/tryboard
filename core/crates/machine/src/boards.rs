//! Board presets (M5-05): one id wires every on-board part of a dev board (eFuse package, SPI panel, I2C buses
//! with their devices, touch INT, encoder, buttons). Data only; `Machine::board_preset` applies it. CLI `--board`, wasm `tb_board_preset`.

use crate::keyboard::Keyboard;
use crate::{Chip, Machine};
use tryboard_soc::devices::audio::{Inmp441, Pins as I2sPins};
use tryboard_soc::devices::{bmi270::Bmi270, imu::Mount};

/// An I2C bus on fixed pads with external pull-ups and its devices (kind, 7-bit address), see `Machine::i2c_bus_add`
pub struct I2cBus {
    pub sda: u32,
    pub scl: u32,
    pub pullup: bool,
    pub devices: &'static [(&'static str, u8)],
}

/// A push button; idle level is driven at preset time, `Machine::board_button` presses it
pub struct Button {
    pub name: &'static str,
    pub pin: u32,
    pub active_low: bool,
}

/// On-board I2S microphone; `--mic` / web audio feed it. PDM mics (SPM1423) put the clock on `ws` and need no BCLK
pub struct Mic {
    pub bclk: Option<u32>,
    pub ws: u32,
    pub data: u32,
    pub pdm: bool,
    /// Same sample on both slots: M5Unified reads the right slot by default, the real L/R strap / codec slot is unchecked
    pub both: bool,
}

pub struct BoardPreset {
    pub id: &'static str,
    /// M5Unified / M5GFX `board_t` name the firmware should detect
    pub name: &'static str,
    pub chip: Chip,
    /// eFuse package version (S3: 0 = QFN56, 1 = PICO; ESP32: 5 = PICO-D4, 6 = PICO-V3-02); None keeps the default
    pub efuse_pkg: Option<u32>,
    /// What the real board carries; flash size comes from the image header, PSRAM is applied where the chip models it
    pub flash_mb: u32,
    pub psram_mb: u32,
    /// S3 PSRAM die on the QSPI interface (Arduino `psram_type=qspi`) rather than octal
    pub psram_quad: bool,
    /// Battery sensed on an ADC pin through a divider (pin, ratio) when the board has no PMIC
    pub battery_adc: Option<(usize, f32)>,
    /// `Machine::lcd_attach_spec` string
    pub lcd: Option<&'static str>,
    pub i2c: &'static [I2cBus],
    pub touch_int: Option<u32>,
    /// BMI270 (accel / gyro, then its AUX BMM150) mounting, the inverse of the remap M5Unified applies for this board
    pub imu_mount: Option<(Mount, Mount)>,
    /// Touch INT wired to an AW9523 input (port, bit) whose INTN drives this host GPIO (CoreS3: P1_2 -> G21)
    pub touch_int_aw9523: Option<(usize, u8, u32)>,
    /// Rotary encoder A / B phase pins
    pub encoder: Option<(u32, u32)>,
    /// On-board I2S amplifier input (BCLK, WS, DOUT): the speaker sink listens there
    pub speaker: Option<(u32, u32, u32)>,
    pub buttons: &'static [Button],
    /// Keyboard part (script action `key=<name>,1|0`)
    pub keyboard: Option<Keyboard>,
    pub mic: Option<Mic>,
    /// Pins held at a level by board circuitry that board detection reads (pin, level)
    pub levels: &'static [(u32, i32)],
    /// Driven by the firmware, listed for UI / docs only: (role, pin)
    pub outputs: &'static [(&'static str, u32)],
    /// Checked end to end with an M5Unified firmware (accept.json); false = filled from docs, not yet run
    pub verified: bool,
    pub note: &'static str,
}

const fn btn(name: &'static str, pin: u32) -> Button {
    Button {
        name,
        pin,
        active_low: true,
    }
}

const fn bus(sda: u32, scl: u32, devices: &'static [(&'static str, u8)]) -> I2cBus {
    I2cBus {
        sda,
        scl,
        pullup: true,
        devices,
    }
}

const NONE: BoardPreset = BoardPreset {
    id: "",
    name: "",
    chip: Chip::Esp32s3,
    efuse_pkg: None,
    flash_mb: 8,
    psram_mb: 0,
    psram_quad: false,
    battery_adc: None,
    lcd: None,
    i2c: &[],
    touch_int: None,
    imu_mount: None,
    touch_int_aw9523: None,
    encoder: None,
    speaker: None,
    buttons: &[],
    keyboard: None,
    mic: None,
    levels: &[],
    outputs: &[],
    verified: false,
    note: "",
};

/// CoreS3 / CoreS3-SE: MISO shares G35 with D/C (3-wire read-back); reset and backlight through AW9523 / AXP2101
const CORES3_LCD: &str = "ili9342@sclk=36,mosi=37,miso=35,cs=3,dc=35,rst=-1,bl=-1";
/// AW88298 amp: BCK G34, WS G33, DOUT G13 (I2S MCK G0 unused by the amp)
const CORES3_SPEAKER: Option<(u32, u32, u32)> = Some((34, 33, 13));
const CORES3_OUTPUTS: &[(&str, u32)] = &[("i2s_mck", 0)];

/// Pins and addresses: Reviews/m5/boards.md (docs.m5stack.com) and M5Unified / M5GFX autodetect (read, not copied)
pub const BOARDS: &[BoardPreset] = &[
    BoardPreset {
        id: "m5dial",
        name: "M5Dial",
        efuse_pkg: Some(0),
        lcd: Some("gc9a01@sclk=6,mosi=5,cs=7,dc=4,rst=8,bl=9"),
        i2c: &[bus(11, 12, &[("ft3267", 0x38), ("bm8563", 0x51)])],
        touch_int: Some(14),
        encoder: Some((40, 41)),
        buttons: &[btn("A", 42)],
        outputs: &[("buzzer", 3), ("backlight", 9), ("power_hold", 46)],
        verified: true,
        note: "encoder A/B order inferred; WS1850S RFID (0x28) not modelled; buzzer is I2S 1-bit on G3 (no model)",
        ..NONE
    },
    BoardPreset {
        id: "m5atoms3",
        name: "M5AtomS3",
        efuse_pkg: Some(0),
        lcd: Some("gc9107@sclk=17,mosi=21,cs=15,dc=33,rst=34,bl=16"),
        i2c: &[bus(38, 39, &[("mpu6886", 0x68)])],
        buttons: &[btn("A", 41)],
        outputs: &[("ir", 4), ("backlight", 16)],
        verified: true,
        note: "M5GFX finds the GC9107 by its ID; MPU6886 axes need no remap",
        ..NONE
    },
    BoardPreset {
        id: "m5atoms3lite",
        name: "M5AtomS3Lite",
        efuse_pkg: Some(0),
        buttons: &[btn("A", 41)],
        // M5Unified's fallback heuristic tells AtomS3 Lite by G4 reading 0 even with a pull-up
        levels: &[(4, 0)],
        outputs: &[("rgb", 35), ("ir", 4)],
        verified: true,
        note: "no panel answers; G4 level from the M5Unified heuristic, not the schematic; WS2812 on G35",
        ..NONE
    },
    BoardPreset {
        id: "m5atoms3r",
        name: "M5AtomS3R",
        efuse_pkg: Some(1),
        psram_mb: 8,
        lcd: Some("gc9107@sclk=15,mosi=21,cs=14,dc=42,rst=48,bl=-1"),
        i2c: &[bus(45, 0, &[("bmi270", 0x68), ("lp5562", 0x30)])],
        // M5Unified reads accel / gyro as (y, -x, z) and the magnetometer as (-x, y, -z)
        imu_mount: Some(([(1, -1), (0, 1), (2, 1)], [(0, -1), (1, 1), (2, -1)])),
        buttons: &[btn("A", 41)],
        outputs: &[("ir", 47)],
        verified: true,
        note: "backlight is LP5562 W but the panel model keeps it on; 8 MB octal PSRAM (PICO-1-N8R8)",
        ..NONE
    },
    BoardPreset {
        id: "m5cores3",
        name: "M5StackCoreS3",
        efuse_pkg: Some(0),
        flash_mb: 16,
        psram_mb: 8,
        psram_quad: true,
        lcd: Some(CORES3_LCD),
        i2c: &[bus(
            12,
            11,
            &[
                ("axp2101", 0x34),
                ("aw9523", 0x58),
                ("ft6336", 0x38),
                ("bmi270", 0x69),
                ("bm8563", 0x51),
                ("ltr553", 0x23),
                ("es7210", 0x40),
                ("aw88298", 0x36),
                ("gc0308", 0x21),
            ],
        )],
        touch_int_aw9523: Some((1, 2, 21)),
        speaker: CORES3_SPEAKER,
        outputs: CORES3_OUTPUTS,
        note: "GC0308 camera answers its chip ID only (no image); touch INT and LCD reset behind AW9523",
        verified: true,
        ..NONE
    },
    BoardPreset {
        id: "m5cores3se",
        name: "M5StackCoreS3SE",
        efuse_pkg: Some(0),
        flash_mb: 16,
        psram_mb: 8,
        psram_quad: true,
        lcd: Some(CORES3_LCD),
        // SE drops camera, IMU, magnetometer and proximity sensor (docs.m5stack.com CoreS3-SE)
        i2c: &[bus(
            12,
            11,
            &[
                ("axp2101", 0x34),
                ("aw9523", 0x58),
                ("ft6336", 0x38),
                ("bm8563", 0x51),
                ("es7210", 0x40),
                ("aw88298", 0x36),
            ],
        )],
        touch_int_aw9523: Some((1, 2, 21)),
        speaker: CORES3_SPEAKER,
        outputs: CORES3_OUTPUTS,
        note: "told apart from CoreS3 by the GC0308 camera (0x21) not answering",
        verified: true,
        ..NONE
    },
    BoardPreset {
        id: "m5cardputer",
        name: "M5Cardputer",
        efuse_pkg: Some(0),
        lcd: Some("st7789l@sclk=36,mosi=35,cs=37,dc=34,rst=33,bl=38"),
        buttons: &[btn("A", 0)],
        keyboard: Some(Keyboard::Hc138 {
            select: [8, 9, 11],
            cols: [13, 15, 3, 4, 5, 6, 7],
        }),
        mic: Some(Mic {
            bclk: None,
            ws: 43,
            data: 46,
            pdm: true,
            both: true,
        }),
        outputs: &[("ir", 44), ("backlight", 38), ("speaker", 42)],
        verified: true,
        note: "key legend map from the M5Cardputer scan convention (unchecked); NS4168 speaker shares WS G43",
        ..NONE
    },
    BoardPreset {
        id: "m5cardputeradv",
        name: "M5CardputerADV",
        efuse_pkg: Some(0),
        lcd: Some("st7789l@sclk=36,mosi=35,cs=37,dc=34,rst=33,bl=38"),
        i2c: &[bus(
            8,
            9,
            &[("tca8418", 0x34), ("bmi270", 0x68), ("es8311", 0x18)],
        )],
        buttons: &[btn("A", 0)],
        keyboard: Some(Keyboard::Tca8418),
        // ES8311 ADC output on ASDOUT G46: the mic stream stands in for the codec's analog path
        mic: Some(Mic {
            bclk: Some(41),
            ws: 43,
            data: 46,
            pdm: false,
            both: true,
        }),
        outputs: &[("ir", 44), ("backlight", 38), ("speaker", 42)],
        verified: true,
        note: "BMI270 address assumed 0x68; TCA8418 key map assumed; ES8311 analog path not modelled",
        ..NONE
    },
    BoardPreset {
        id: "m5stickcplus2",
        name: "M5StickCPlus2",
        chip: Chip::Esp32,
        efuse_pkg: Some(6),
        psram_mb: 2,
        lcd: Some("st7789@sclk=13,mosi=15,cs=5,dc=14,rst=12,bl=27"),
        i2c: &[bus(21, 22, &[("mpu6886", 0x68), ("bm8563", 0x51)])],
        buttons: &[btn("A", 37), btn("B", 39), btn("C", 35)],
        battery_adc: Some((38, 2.0)),
        outputs: &[("buzzer", 2), ("led", 19), ("power_hold", 4)],
        verified: true,
        note: "button C = power key G35; PDM mic CLK G0 / DATA G34 (--mic); IR G19 shares the LED",
        ..NONE
    },
    BoardPreset {
        id: "m5core2",
        name: "M5StackCore2",
        chip: Chip::Esp32,
        efuse_pkg: Some(0),
        flash_mb: 16,
        psram_mb: 8,
        lcd: Some("ili9342@sclk=18,mosi=23,miso=38,cs=5,dc=15,rst=-1,bl=-1"),
        i2c: &[bus(
            21,
            22,
            &[
                ("axp192", 0x34),
                ("ft6336", 0x38),
                ("mpu6886", 0x68),
                ("bm8563", 0x51),
            ],
        )],
        touch_int: Some(39),
        verified: true,
        note: "buttons A/B/C are touch zones below the panel; LCD reset / backlight via AXP192; NS4168 I2S speaker",
        ..NONE
    },
    BoardPreset {
        id: "m5core2v11",
        name: "M5StackCore2",
        chip: Chip::Esp32,
        efuse_pkg: Some(0),
        flash_mb: 16,
        psram_mb: 8,
        lcd: Some("ili9342e@sclk=18,mosi=23,miso=38,cs=5,dc=15,rst=-1,bl=-1"),
        i2c: &[bus(
            21,
            22,
            &[
                ("axp2101", 0x34),
                ("ina3221", 0x40),
                ("ft6336", 0x38),
                ("mpu6886", 0x68),
                ("bm8563", 0x51),
            ],
        )],
        touch_int: Some(39),
        verified: true,
        note: "v1.1 = AXP2101 + INA3221; same Arduino build as v1.0, M5Unified tells them apart by the PMIC",
        ..NONE
    },
    BoardPreset {
        id: "m5atomlite",
        name: "M5AtomLite",
        chip: Chip::Esp32,
        efuse_pkg: Some(5),
        flash_mb: 4,
        buttons: &[btn("A", 39)],
        outputs: &[("rgb", 27), ("ir", 12)],
        verified: true,
        note: "Lite vs Matrix is told by touch pads 4 / 7 (G13 / G27): equal idle counts read as Lite",
        ..NONE
    },
];

pub fn find(id: &str) -> Option<&'static BoardPreset> {
    BOARDS.iter().find(|b| b.id == id)
}

/// `--board list`: one line per preset
pub fn list() -> String {
    BOARDS
        .iter()
        .map(|b| {
            let v = if b.verified { "verified" } else { "UNVERIFIED" };
            format!(
                "{:<15} {:<15} {:<9} {v:<10} {}\n",
                b.id,
                b.name,
                b.chip.name(),
                b.note
            )
        })
        .collect()
}

impl Machine {
    /// Wire every on-board part of preset `id`. Err on unknown id / wrong chip, or when a part of a verified preset
    /// fails to attach; Ok carries warnings (parts an unverified preset could not attach, unmodelled PSRAM)
    pub fn board_preset(&mut self, id: &str) -> Result<Vec<String>, String> {
        let b = find(id).ok_or_else(|| {
            let ids: Vec<_> = BOARDS.iter().map(|b| b.id).collect();
            format!("unknown board {id} (known: {})", ids.join(", "))
        })?;
        if b.chip != self.chip() {
            return Err(format!(
                "board {id} is an {} board but the firmware is built for {}",
                b.chip.name(),
                self.chip().name()
            ));
        }
        let mut warn = Vec::new();
        if let Some(p) = b.efuse_pkg {
            if !self.set_efuse_pkg(p) {
                warn.push(format!("eFuse package {p} unsupported"));
            }
        }
        if let Some(spec) = b.lcd {
            if let Err(e) = self.lcd_attach_spec(spec) {
                warn.push(e);
            }
        }
        for bus in b.i2c {
            let Some(n) = self.i2c_bus_add(bus.sda, bus.scl, bus.pullup) else {
                warn.push(format!("I2C pads {}/{} unavailable", bus.sda, bus.scl));
                continue;
            };
            for (kind, addr) in bus.devices {
                if !self.i2c_attach_bus(n, kind, *addr) {
                    warn.push(format!("I2C device {kind} unknown"));
                }
            }
        }
        if let Some((ag, mag)) = b.imu_mount {
            match self.i2c_dev::<Bmi270>() {
                Some(d) => {
                    d.mount = ag;
                    if let Some(m) = d.aux.as_mut() {
                        m.mount = mag;
                    }
                }
                None => warn.push("IMU mount set but no BMI270 attached".into()),
            }
        }
        if let Some(pin) = b.touch_int {
            self.touch_int_attach(pin);
        }
        if let Some((_, _, pin)) = b.touch_int_aw9523 {
            self.gpio_drive(pin, 1);
        }
        if let Some((a, p)) = b.encoder {
            self.encoder_attach(a, p, None);
        }
        if let Some((bclk, ws, data)) = b.speaker {
            let pins = tryboard_soc::devices::audio::Pins { bclk, ws, data };
            if !self.hw.attach_speaker_at(pins) {
                warn.push("speaker sink unsupported".into());
            }
        }
        for k in b.buttons {
            self.gpio_drive(k.pin, k.active_low as i32);
        }
        if let Some(k) = b.keyboard {
            if !self.keyboard_attach(k) {
                warn.push("keyboard part unavailable".into());
            }
        }
        if let Some(m) = &b.mic {
            let pins = I2sPins {
                bclk: m.bclk.unwrap_or(m.ws),
                ws: m.ws,
                data: m.data,
            };
            let mut d = Inmp441::new(pins);
            d.pdm = m.pdm;
            // A codec stand-in (ES8311) has one ADC; M5Unified reads the right slot by default
            d.both = m.both;
            self.hw.audio_mut().mic = Some(Box::new(d));
        }
        for &(pin, lv) in b.levels {
            self.gpio_drive(pin, lv);
        }
        if b.verified && !warn.is_empty() {
            return Err(format!("board {id}: {}", warn.join("; ")));
        }
        if b.psram_quad {
            self.set_psram_quad(true);
        }
        // S3 always carries the 8 MB die; classic ESP32 quad PSRAM is sized here (M5-14)
        if b.psram_mb > 0
            && !(b.chip == Chip::Esp32s3 && b.psram_mb == 8)
            && !self.set_psram_mb(b.psram_mb)
        {
            warn.push(format!("{} MB PSRAM not modelled", b.psram_mb));
        }
        if let Some((pin, div)) = b.battery_adc {
            self.analog_set(pin, tryboard_soc::devices::axp2101::ocv_mv(80) as f32 / div);
        }
        self.board = Some(b);
        Ok(warn)
    }

    /// Preset applied by `board_preset`
    pub fn board(&self) -> Option<&'static BoardPreset> {
        self.board
    }

    /// Press / release a preset button by name (script action `btn=A,1`); false if the board has no such button
    pub fn board_button(&mut self, name: &str, down: bool) -> bool {
        let Some(k) = self
            .board
            .and_then(|b| b.buttons.iter().find(|k| k.name.eq_ignore_ascii_case(name)))
        else {
            return false;
        };
        self.gpio_drive(k.pin, (down != k.active_low) as i32);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_is_consistent() {
        for (i, b) in BOARDS.iter().enumerate() {
            assert!(
                BOARDS[..i].iter().all(|o| o.id != b.id),
                "duplicate {}",
                b.id
            );
            for bus in b.i2c {
                for (kind, addr) in bus.devices {
                    assert!(
                        tryboard_soc::devices::make_i2c(kind, *addr).is_some(),
                        "{}: {kind}",
                        b.id
                    );
                }
            }
            if let Some(spec) = b.lcd {
                let (k, p) = spec.split_once('@').unwrap();
                assert!(crate::LcdKind::parse(k).is_some(), "{}: {k}", b.id);
                crate::LcdPins::parse(crate::LcdPins::S3_DEFAULT, p).unwrap();
            }
        }
        assert!(list().contains("m5dial"));
    }
}
