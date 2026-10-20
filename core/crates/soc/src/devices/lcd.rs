//! Screen on SPI2: one of the supported display models behind a single type (Chip trait / machine / wasm see only `Lcd`).
//! An enum rather than a trait object: two models, matched in the SoC's SPI path where wiring differs (D/C pin vs QSPI frames)

use super::co5300::Co5300;
use super::gc9a01::Gc9a01;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LcdKind {
    /// 240x240 round TFT, 4-wire SPI with D/C
    Gc9a01,
    /// 480x480 AMOLED, QSPI
    Co5300,
}

impl LcdKind {
    /// CLI / wasm name ("gc9a01", "co5300")
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "gc9a01" => Some(LcdKind::Gc9a01),
            "co5300" => Some(LcdKind::Co5300),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            LcdKind::Gc9a01 => "gc9a01",
            LcdKind::Co5300 => "co5300",
        }
    }
}

pub enum Lcd {
    Gc9a01(Gc9a01),
    Co5300(Co5300),
}

impl Lcd {
    pub fn new(kind: LcdKind) -> Self {
        match kind {
            LcdKind::Gc9a01 => Lcd::Gc9a01(Gc9a01::new()),
            LcdKind::Co5300 => Lcd::Co5300(Co5300::new()),
        }
    }

    pub fn kind(&self) -> LcdKind {
        match self {
            Lcd::Gc9a01(_) => LcdKind::Gc9a01,
            Lcd::Co5300(_) => LcdKind::Co5300,
        }
    }

    /// Report name ("GC9A01", "CO5300")
    pub fn name(&self) -> &'static str {
        match self {
            Lcd::Gc9a01(_) => "GC9A01",
            Lcd::Co5300(_) => "CO5300",
        }
    }

    /// Frame size in pixels (width, height); `render` returns width × height × 4 RGBA
    pub fn size(&self) -> (usize, usize) {
        match self {
            Lcd::Gc9a01(_) => (super::gc9a01::W, super::gc9a01::H),
            Lcd::Co5300(_) => (super::co5300::W, super::co5300::H),
        }
    }

    pub fn version(&self) -> u32 {
        match self {
            Lcd::Gc9a01(d) => d.version,
            Lcd::Co5300(d) => d.version,
        }
    }

    pub fn render(&mut self) -> &[u8] {
        match self {
            Lcd::Gc9a01(d) => d.render(),
            Lcd::Co5300(d) => d.render(),
        }
    }

    pub fn lit_pixels(&mut self) -> usize {
        match self {
            Lcd::Gc9a01(d) => d.lit_pixels(),
            Lcd::Co5300(d) => d.lit_pixels(),
        }
    }

    /// Colour stats lines (`[tryboard] LCD color #rrggbb N px, centroid x,y`), top 12 colours with >= 50 px
    pub fn color_report(&mut self) -> String {
        match self {
            Lcd::Gc9a01(d) => d.color_report(),
            Lcd::Co5300(d) => color_report(d.render(), super::co5300::W),
        }
    }

    pub fn showing(&self) -> bool {
        match self {
            Lcd::Gc9a01(d) => d.showing(),
            Lcd::Co5300(d) => d.showing(),
        }
    }

    pub fn ppm(&mut self) -> Vec<u8> {
        match self {
            Lcd::Gc9a01(d) => d.ppm(),
            Lcd::Co5300(d) => d.ppm(),
        }
    }

    pub fn set_reset(&mut self, active: bool) {
        match self {
            Lcd::Gc9a01(d) => d.set_reset(active),
            Lcd::Co5300(d) => d.set_reset(active),
        }
    }

    /// Backlight pin level; AMOLED panels have none and ignore it
    pub fn set_backlight(&mut self, on: bool) {
        if let Lcd::Gc9a01(d) = self {
            d.set_backlight(on);
        }
    }
}

/// Same rules as `Gc9a01::color_report` (transparent and black skipped, ties by colour value) for any frame width
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
