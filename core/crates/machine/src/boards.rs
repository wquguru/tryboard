//! Board presets (M5-05): one id wires every on-board part of a dev board (eFuse package, SPI panel, I2C buses
//! with their devices, touch INT, encoder, buttons). Data only; `Machine::board_preset` applies it. CLI `--board`, wasm `tb_board_preset`.

use crate::{Chip, Machine};

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
    /// Battery sensed on an ADC pin through a divider (pin, ratio) when the board has no PMIC
    pub battery_adc: Option<(usize, f32)>,
    /// `Machine::lcd_attach_spec` string
    pub lcd: Option<&'static str>,
    pub i2c: &'static [I2cBus],
    pub touch_int: Option<u32>,
    /// Rotary encoder A / B phase pins
    pub encoder: Option<(u32, u32)>,
    pub buttons: &'static [Button],
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
    battery_adc: None,
    lcd: None,
    i2c: &[],
    touch_int: None,
    encoder: None,
    buttons: &[],
    levels: &[],
    outputs: &[],
    verified: false,
    note: "",
};

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
        note: "M5-06 verifies",
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
        note: "M5-06 verifies; G4 level from the M5Unified heuristic, not the schematic",
        ..NONE
    },
    BoardPreset {
        id: "m5atoms3r",
        name: "M5AtomS3R",
        efuse_pkg: Some(1),
        psram_mb: 8,
        lcd: Some("gc9107@sclk=15,mosi=21,cs=14,dc=42,rst=48,bl=-1"),
        i2c: &[bus(45, 0, &[("bmi270", 0x68), ("lp5562", 0x30)])],
        buttons: &[btn("A", 41)],
        outputs: &[("ir", 47)],
        note: "M5-06 verifies; backlight via LP5562 W channel; octal PSRAM not modelled",
        ..NONE
    },
    BoardPreset {
        id: "m5cores3",
        name: "M5StackCoreS3",
        efuse_pkg: Some(0),
        flash_mb: 16,
        psram_mb: 8,
        lcd: Some("ili9342@sclk=36,mosi=37,miso=35,cs=3,dc=35,rst=-1,bl=-1"),
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
            ],
        )],
        note: "M5-07 verifies; boot stops at PSRAM init (not modelled); touch INT and LCD reset behind AW9523",
        ..NONE
    },
    BoardPreset {
        id: "m5cardputer",
        name: "M5Cardputer",
        efuse_pkg: Some(0),
        lcd: Some("st7789l@sclk=36,mosi=35,cs=37,dc=34,rst=33,bl=38"),
        buttons: &[btn("A", 0)],
        outputs: &[("ir", 44), ("backlight", 38)],
        note: "M5-08 verifies; 74HC138 key matrix not modelled",
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
        outputs: &[("ir", 44), ("backlight", 38)],
        note: "M5-08 verifies; BMI270 address assumed 0x68",
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
        if let Some(pin) = b.touch_int {
            self.touch_int_attach(pin);
        }
        if let Some((a, p)) = b.encoder {
            self.encoder_attach(a, p, None);
        }
        for k in b.buttons {
            self.gpio_drive(k.pin, k.active_low as i32);
        }
        for &(pin, lv) in b.levels {
            self.gpio_drive(pin, lv);
        }
        if b.verified && !warn.is_empty() {
            return Err(format!("board {id}: {}", warn.join("; ")));
        }
        // Classic ESP32 quad PSRAM is modelled (M5-14); S3 octal / quad PSRAM is not
        if b.psram_mb > 0 && !self.set_psram_mb(b.psram_mb) {
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
