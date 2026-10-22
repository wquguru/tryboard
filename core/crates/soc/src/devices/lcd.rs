//! Screen on an SPI host: one of the supported display models behind a single type (Chip trait / machine / wasm see only `Lcd`).
//! An enum rather than a trait object: two models, matched in the SoC's SPI path where wiring differs (D/C pin vs QSPI frames)

use super::co5300::Co5300;
use super::dcs::{self, DcsPanel, PanelSpec};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LcdKind {
    /// 240x240 round TFT, 4-wire SPI with D/C
    Gc9a01,
    /// 128x128 TFT (AtomS3 / AtomS3R)
    Gc9107,
    /// 128x128 TFT (AtomS3 later revision)
    St7735,
    /// 135x240 TFT (StickC Plus2), portrait
    St7789,
    /// The same glass mounted landscape, 240x135 (Cardputer)
    St7789Land,
    /// 320x240 TFT (CoreS3 / Core2); C and E differ only in vendor register read-back
    Ili9342c,
    Ili9342e,
    /// 480x480 AMOLED, QSPI
    Co5300,
    /// Bare SPI modules (F-04b): ILI9341 240x320, ST7789 240x240 and 240x320
    Ili9341,
    St7789Sq,
    St7789Tall,
}

impl LcdKind {
    /// CLI / wasm name ("gc9a01", "co5300", ...); "ili9342" means the C revision
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "gc9a01" => Some(LcdKind::Gc9a01),
            "gc9107" => Some(LcdKind::Gc9107),
            "st7735" => Some(LcdKind::St7735),
            "st7789" => Some(LcdKind::St7789),
            "st7789l" => Some(LcdKind::St7789Land),
            "ili9342" | "ili9342c" => Some(LcdKind::Ili9342c),
            "ili9342e" => Some(LcdKind::Ili9342e),
            "co5300" => Some(LcdKind::Co5300),
            "ili9341" => Some(LcdKind::Ili9341),
            "st7789-240x240" => Some(LcdKind::St7789Sq),
            "st7789-240x320" => Some(LcdKind::St7789Tall),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            LcdKind::Gc9a01 => "gc9a01",
            LcdKind::Gc9107 => "gc9107",
            LcdKind::St7735 => "st7735",
            LcdKind::St7789 => "st7789",
            LcdKind::St7789Land => "st7789l",
            LcdKind::Ili9342c => "ili9342c",
            LcdKind::Ili9342e => "ili9342e",
            LcdKind::Co5300 => "co5300",
            LcdKind::Ili9341 => "ili9341",
            LcdKind::St7789Sq => "st7789-240x240",
            LcdKind::St7789Tall => "st7789-240x320",
        }
    }

    /// Panel description of the MIPI-DCS kinds (None for the QSPI AMOLED)
    pub fn spec(self) -> Option<PanelSpec> {
        Some(match self {
            LcdKind::Gc9a01 => dcs::GC9A01,
            LcdKind::Gc9107 => dcs::GC9107,
            LcdKind::St7735 => dcs::ST7735S,
            LcdKind::St7789 => dcs::ST7789,
            LcdKind::St7789Land => dcs::ST7789_LAND,
            LcdKind::Ili9342c => dcs::ILI9342C,
            LcdKind::Ili9342e => dcs::ILI9342E,
            LcdKind::Ili9341 => dcs::ILI9341,
            LcdKind::St7789Sq => dcs::ST7789_240,
            LcdKind::St7789Tall => dcs::ST7789_320,
            LcdKind::Co5300 => return None,
        })
    }
}

const DCS_KINDS: [LcdKind; 10] = [
    LcdKind::Gc9a01,
    LcdKind::Gc9107,
    LcdKind::St7735,
    LcdKind::St7789,
    LcdKind::St7789Land,
    LcdKind::Ili9342c,
    LcdKind::Ili9342e,
    LcdKind::Ili9341,
    LcdKind::St7789Sq,
    LcdKind::St7789Tall,
];

/// GPIO numbers of a 4-wire SPI panel. `miso` may equal `dc` (CoreS3 shares GPIO35); `bl: None` = backlight always on
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LcdPins {
    pub sclk: u8,
    pub mosi: u8,
    pub miso: Option<u8>,
    pub cs: u8,
    pub dc: u8,
    pub rst: Option<u8>,
    pub bl: Option<u8>,
}

impl LcdPins {
    /// C3 default wiring (same as the C3 crate's `lcd_pin`, what `--spi gc9a01` means on C3)
    pub const C3_DEFAULT: LcdPins = LcdPins {
        sclk: 6,
        mosi: 7,
        miso: None,
        cs: 10,
        dc: 5,
        rst: Some(4),
        bl: Some(3),
    };

    /// Pin-compatible with the ESP-IDF spi_lcd_touch example (what `--spi gc9a01` means on S3)
    pub const S3_DEFAULT: LcdPins = LcdPins {
        sclk: 12,
        mosi: 11,
        miso: None,
        cs: 10,
        dc: 14,
        rst: Some(13),
        bl: Some(15),
    };

    /// Classic ESP32 default: M5StickC Plus2 wiring (ST7789 on the GPIO matrix, backlight on GPIO27)
    pub const ESP32_DEFAULT: LcdPins = LcdPins {
        sclk: 13,
        mosi: 15,
        miso: None,
        cs: 5,
        dc: 14,
        rst: Some(12),
        bl: Some(27),
    };

    /// Override fields from "sclk=36,mosi=37,miso=35,cs=3,dc=35,rst=-1,bl=-1" (-1 = not connected)
    pub fn parse(base: LcdPins, spec: &str) -> Result<LcdPins, String> {
        let mut p = base;
        for item in spec.split(',').filter(|s| !s.is_empty()) {
            let (k, v) = item
                .split_once('=')
                .ok_or_else(|| format!("bad pin item '{item}' (expected name=gpio)"))?;
            let n: i32 = v
                .trim()
                .parse()
                .map_err(|_| format!("bad GPIO number in '{item}'"))?;
            if !(-1..=48).contains(&n) {
                return Err(format!("GPIO out of range in '{item}'"));
            }
            let opt = (n >= 0).then_some(n as u8);
            let need = || opt.ok_or_else(|| format!("pin '{k}' is required"));
            match k.trim() {
                "sclk" | "sck" | "clk" => p.sclk = need()?,
                "mosi" | "sda" => p.mosi = need()?,
                "cs" => p.cs = need()?,
                "dc" => p.dc = need()?,
                "miso" => p.miso = opt,
                "rst" => p.rst = opt,
                "bl" => p.bl = opt,
                _ => {
                    return Err(format!(
                        "unknown pin '{k}' (sclk, mosi, miso, cs, dc, rst, bl)"
                    ))
                }
            }
        }
        Ok(p)
    }
}

pub enum Lcd {
    /// Any MIPI-DCS SPI TFT (GC9A01, GC9107, ST7735S, ST7789, ILI9342C / E)
    Dcs(DcsPanel),
    Co5300(Co5300),
}

impl Lcd {
    pub fn new(kind: LcdKind) -> Self {
        match kind {
            LcdKind::Co5300 => Lcd::Co5300(Co5300::new()),
            k => Lcd::Dcs(DcsPanel::new(k.spec().expect("DCS kind"))),
        }
    }

    /// One SPI transfer while selected: command / address bytes, dummy clocks and MOSI data in, then `miso_bits`
    /// read back (MISO, or SDA in 3-wire mode; None for CO5300). `release` = the controller raises CS afterwards
    pub fn spi_transfer(
        &mut self,
        dc: bool,
        head: &[u8],
        dummy_bits: u32,
        data: &[u8],
        miso_bits: u32,
        release: bool,
    ) -> Option<Vec<u8>> {
        let mut rx = None;
        match self {
            Lcd::Dcs(l) => {
                for b in head {
                    l.byte(dc, *b);
                }
                l.clock(dummy_bits);
                for b in data {
                    l.byte(dc, *b);
                }
                if miso_bits > 0 {
                    rx = Some(l.read_bits(miso_bits));
                }
                if release {
                    l.cs_release();
                }
            }
            Lcd::Co5300(l) => {
                for b in head.iter().chain(data) {
                    l.byte(*b);
                }
                if release {
                    l.cs_release();
                }
            }
        }
        rx
    }

    pub fn kind(&self) -> LcdKind {
        match self {
            Lcd::Dcs(d) => DCS_KINDS
                .into_iter()
                .find(|k| k.spec() == Some(d.spec))
                .unwrap_or(LcdKind::Gc9a01),
            Lcd::Co5300(_) => LcdKind::Co5300,
        }
    }

    /// Report name ("GC9A01", "CO5300")
    pub fn name(&self) -> &'static str {
        match self {
            Lcd::Dcs(d) => d.spec.name,
            Lcd::Co5300(_) => "CO5300",
        }
    }

    /// Frame size in pixels (width, height); `render` returns width × height × 4 RGBA
    pub fn size(&self) -> (usize, usize) {
        match self {
            Lcd::Dcs(d) => d.size(),
            Lcd::Co5300(_) => (super::co5300::W, super::co5300::H),
        }
    }

    pub fn version(&self) -> u32 {
        match self {
            Lcd::Dcs(d) => d.version,
            Lcd::Co5300(d) => d.version,
        }
    }

    pub fn render(&mut self) -> &[u8] {
        match self {
            Lcd::Dcs(d) => d.render(),
            Lcd::Co5300(d) => d.render(),
        }
    }

    pub fn lit_pixels(&mut self) -> usize {
        match self {
            Lcd::Dcs(d) => d.lit_pixels(),
            Lcd::Co5300(d) => d.lit_pixels(),
        }
    }

    /// Colour stats lines (`[tryboard] LCD color #rrggbb N px, centroid x,y`), top 12 colours with >= 50 px
    pub fn color_report(&mut self) -> String {
        match self {
            Lcd::Dcs(d) => d.color_report(),
            Lcd::Co5300(d) => color_report(d.render(), super::co5300::W),
        }
    }

    pub fn showing(&self) -> bool {
        match self {
            Lcd::Dcs(d) => d.showing(),
            Lcd::Co5300(d) => d.showing(),
        }
    }

    pub fn ppm(&mut self) -> Vec<u8> {
        match self {
            Lcd::Dcs(d) => d.ppm(),
            Lcd::Co5300(d) => d.ppm(),
        }
    }

    pub fn set_reset(&mut self, active: bool) {
        match self {
            Lcd::Dcs(d) => d.set_reset(active),
            Lcd::Co5300(d) => d.set_reset(active),
        }
    }

    /// Backlight pin level; AMOLED panels have none and ignore it
    pub fn set_backlight(&mut self, on: bool) {
        if let Lcd::Dcs(d) = self {
            d.set_backlight(on);
        }
    }
}

/// Same rules as `DcsPanel::color_report` (transparent and black skipped, ties by colour value) for any frame width
fn color_report(frame: &[u8], w: usize) -> String {
    use std::collections::HashMap;
    use std::fmt::Write as _;
    let mut m: HashMap<u32, (u64, u64, u64)> = HashMap::new();
    for (i, p) in frame.chunks(4).enumerate() {
        if p[3] == 0 || (p[0] | p[1] | p[2]) == 0 {
            continue;
        }
        let c = (p[0] as u32) << 16 | (p[1] as u32) << 8 | p[2] as u32;
        let e = m.entry(c).or_default();
        e.0 += 1;
        e.1 += (i % w) as u64;
        e.2 += (i / w) as u64;
    }
    let mut v: Vec<_> = m.into_iter().filter(|e| e.1 .0 >= 50).collect();
    v.sort_by(|a, b| b.1 .0.cmp(&a.1 .0).then(a.0.cmp(&b.0)));
    let mut o = String::new();
    for (c, (n, sx, sy)) in v.into_iter().take(12) {
        let _ = writeln!(
            o,
            "[tryboard] LCD color #{c:06x} {n} px, centroid {:.1},{:.1}",
            sx as f64 / n as f64,
            sy as f64 / n as f64
        );
    }
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every DCS kind round-trips name -> kind -> spec -> kind (Lcd::kind matches on the spec)
    #[test]
    fn dcs_kinds_round_trip() {
        for k in DCS_KINDS {
            assert_eq!(LcdKind::parse(k.id()), Some(k));
            assert_eq!(Lcd::new(k).kind(), k);
        }
        assert_eq!(LcdKind::parse("ili9341"), Some(LcdKind::Ili9341));
    }
}
