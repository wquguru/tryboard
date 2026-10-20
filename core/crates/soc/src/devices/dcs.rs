//! MIPI-DCS SPI TFT panel (4-wire SCLK / MOSI / CS / D/C plus RST), one parametric model for GC9A01, GC9107, ST7735S, ST7789, ILI9342C / E.
//! D/C=0 bytes are commands, D/C=1 bytes are parameters or pixels. Frame memory (GRAM) is `mem_w × mem_h`; the glass shows the
//! `w × h` window at (`ox`, `oy`) in GRAM coordinates. Retail IPS modules are normally black (true colours only with INVON) and have
//! BGR subpixels (red/blue right only with MADCTL.BGR=1); M5GFX's per-board `invert` / `rgb_order` settings encode the same facts.
//! Reads (RDDID 04h, RDDST 09h, 0Ah-0Dh, DAh-DCh, ILI9342 D9h-indexed registers) come out as a bit stream clocked by the
//! controller, so a dummy clock made by any means (USR_DUMMY or M5GFX's CK_IDLE_EDGE flip) shifts it the same way. (lint: allow-long-comment)

use std::any::Any;
use std::collections::HashMap;
use std::fmt::Write as _;

/// ILI9342 C vs E behaviour of the D9h-indexed register reads M5GFX uses to tell them apart
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Variant {
    Generic,
    /// D3h (ID4) reads 00 93 42 once the EXTC key C8h FF 93 42 was sent; DDh / CBh are not stored
    Ili9342c,
    /// DDh / CBh writes are stored and read back through D9h
    Ili9342e,
}

/// Static description of one panel kind
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PanelSpec {
    /// Report name ("GC9A01")
    pub name: &'static str,
    /// GRAM size (MADCTL mirroring is relative to it)
    pub mem_w: usize,
    pub mem_h: usize,
    /// Visible glass, at (ox, oy) in GRAM
    pub w: usize,
    pub h: usize,
    pub ox: usize,
    pub oy: usize,
    /// Round glass: pixels outside the inscribed circle are transparent and not counted
    pub round: bool,
    /// Normally-black IPS: colours inverted unless INVON
    pub normally_black: bool,
    /// BGR subpixels: red and blue swap unless MADCTL.BGR=1
    pub bgr_panel: bool,
    /// Glass mounted landscape: the rendered frame is the window turned 90° (h × w), as seen with M5GFX rotation 1
    pub landscape: bool,
    /// RDDID (04h) bytes in wire order
    pub id: [u8; 3],
    pub variant: Variant,
}

impl PanelSpec {
    /// Rendered frame size (width, height)
    pub fn frame_size(&self) -> (usize, usize) {
        if self.landscape {
            (self.h, self.w)
        } else {
            (self.w, self.h)
        }
    }
}

/// Round 1.28" module (ESP-IDF spi_lcd_touch config, M5Dial)
pub const GC9A01: PanelSpec = PanelSpec {
    name: "GC9A01",
    mem_w: 240,
    mem_h: 240,
    w: 240,
    h: 240,
    ox: 0,
    oy: 0,
    round: true,
    normally_black: true,
    bgr_panel: true,
    landscape: false,
    id: [0x00, 0x9a, 0x01],
    variant: Variant::Generic,
};
/// AtomS3 / AtomS3R 0.85": 128×128 glass at row 32 of a 128×160 GRAM; not inverted (M5GFX invert = false)
pub const GC9107: PanelSpec = PanelSpec {
    name: "GC9107",
    mem_w: 128,
    mem_h: 160,
    w: 128,
    h: 128,
    ox: 0,
    oy: 32,
    round: false,
    normally_black: false,
    bgr_panel: true,
    landscape: false,
    id: [0x00, 0x91, 0x07],
    variant: Variant::Generic,
};
/// AtomS3(R) later revision: ST7735S 128×128 at (2, 1) of 132×132
pub const ST7735S: PanelSpec = PanelSpec {
    name: "ST7735S",
    mem_w: 132,
    mem_h: 132,
    w: 128,
    h: 128,
    ox: 2,
    oy: 1,
    round: false,
    normally_black: true,
    bgr_panel: true,
    landscape: false,
    id: [0x7c, 0x89, 0xf0],
    variant: Variant::Generic,
};
/// StickC Plus2 / DinMeter 1.14": 135×240 at (52, 40) of a 240×320 GRAM
pub const ST7789: PanelSpec = PanelSpec {
    name: "ST7789",
    mem_w: 240,
    mem_h: 320,
    w: 135,
    h: 240,
    ox: 52,
    oy: 40,
    round: false,
    normally_black: true,
    bgr_panel: true,
    landscape: false,
    id: [0x85, 0x85, 0x52],
    variant: Variant::Generic,
};
/// Cardputer: the same glass mounted landscape (240×135 frame)
pub const ST7789_LAND: PanelSpec = PanelSpec {
    landscape: true,
    ..ST7789
};
/// CoreS3 / Core2 2.0" 320×240; RDDID low byte E3h is the value M5GFX matches, not a datasheet constant
pub const ILI9342C: PanelSpec = PanelSpec {
    name: "ILI9342C",
    mem_w: 320,
    mem_h: 240,
    w: 320,
    h: 240,
    ox: 0,
    oy: 0,
    round: false,
    normally_black: true,
    bgr_panel: true,
    landscape: false,
    id: [0xe3, 0x00, 0x00],
    variant: Variant::Ili9342c,
};
pub const ILI9342E: PanelSpec = PanelSpec {
    name: "ILI9342E",
    variant: Variant::Ili9342e,
    ..ILI9342C
};
/// Bare 2.4" / 2.8" TN module (F-04b): 240×320 portrait, normally white (no INVON), BGR (the IDF spi_lcd_touch example sets BGR)
pub const ILI9341: PanelSpec = PanelSpec {
    name: "ILI9341",
    mem_w: 240,
    mem_h: 320,
    w: 240,
    h: 320,
    ox: 0,
    oy: 0,
    round: false,
    normally_black: false,
    bgr_panel: true,
    landscape: false,
    id: [0x00, 0x93, 0x41],
    variant: Variant::Generic,
};
/// Bare 1.3" IPS module: 240×240 glass at (0, 0) of the 240×320 GRAM, RGB subpixels (MADCTL mirroring needs a 80-row gap)
pub const ST7789_240: PanelSpec = PanelSpec {
    name: "ST7789_240",
    w: 240,
    h: 240,
    ox: 0,
    oy: 0,
    bgr_panel: false,
    ..ST7789
};
/// Bare 2.0" / 2.4" IPS module: the full 240×320 GRAM, RGB subpixels
pub const ST7789_320: PanelSpec = PanelSpec {
    name: "ST7789_320",
    h: 320,
    ..ST7789_240
};

pub struct DcsPanel {
    pub spec: PanelSpec,
    /// Frame memory, 0xRRGGBB per pixel (as received, before panel transforms)
    pub gram: Vec<u32>,
    pub sleep: bool,
    pub display_on: bool,
    pub inverted: bool,
    pub madctl: u8,
    pub colmod: u8,
    pub backlight: bool,
    /// RST held low: chip in reset, bus ignored
    pub in_reset: bool,
    xs: u16,
    xe: u16,
    ys: u16,
    ye: u16,
    x: u16,
    y: u16,
    cmd: Option<u8>,
    params: Vec<u8>,
    pix: [u8; 3],
    npix: usize,
    /// Writes to vendor init registers (not modelled, only counted)
    pub vendor_cmds: u64,
    pub commands: u64,
    pub pixels: u64,
    /// Read commands answered with data
    pub reads: u64,
    /// Bumped whenever the image may change; the frontend uses it to decide whether to re-upload the texture
    pub version: u32,
    frame: Vec<u8>,
    frame_version: u32,
    /// Reply of the last command: dummy bits, then `rd` MSB first from bit `rd_pos`; past the end the panel sends 0
    rd: Vec<u8>,
    rd_skip: u32,
    rd_pos: usize,
    /// One CK_IDLE_EDGE flip seen; the next one completes a clock
    half_clock: bool,
    /// Parameters last written per vendor command (ILI9342 D9h read-back, EXTC key)
    stored: HashMap<u8, Vec<u8>>,
}

impl Default for DcsPanel {
    fn default() -> Self {
        Self::new(GC9A01)
    }
}

impl DcsPanel {
    pub fn new(spec: PanelSpec) -> Self {
        let mut d = DcsPanel {
            spec,
            gram: vec![0; spec.mem_w * spec.mem_h],
            sleep: true,
            display_on: false,
            inverted: false,
            madctl: 0,
            colmod: 0x66,
            backlight: false,
            in_reset: false,
            xs: 0,
            xe: 0,
            ys: 0,
            ye: 0,
            x: 0,
            y: 0,
            cmd: None,
            params: Vec::new(),
            pix: [0; 3],
            npix: 0,
            vendor_cmds: 0,
            commands: 0,
            pixels: 0,
            reads: 0,
            version: 1,
            frame: vec![0; spec.w * spec.h * 4],
            frame_version: 0,
            rd: Vec::new(),
            rd_skip: 0,
            rd_pos: 0,
            half_clock: false,
            stored: HashMap::new(),
        };
        d.reset();
        d
    }

    /// Frame size (width, height) of `render`
    pub fn size(&self) -> (usize, usize) {
        self.spec.frame_size()
    }

    /// Whether frame pixel (x, y) is on the glass (round panels: inside the inscribed circle)
    pub fn visible(&self, x: usize, y: usize) -> bool {
        if !self.spec.round {
            return true;
        }
        let (w, h) = (self.spec.w as f32, self.spec.h as f32);
        let dx = x as f32 + 0.5 - w / 2.0;
        let dy = y as f32 + 0.5 - h / 2.0;
        dx * dx + dy * dy <= (w / 2.0) * (w / 2.0)
    }

    /// Hardware reset (RST low) or SWRESET: registers to defaults, sleep, display off; frame memory kept (undefined on real chips)
    pub fn reset(&mut self) {
        self.sleep = true;
        self.display_on = false;
        self.inverted = false;
        self.madctl = 0;
        self.colmod = 0x66;
        self.xs = 0;
        self.xe = (self.spec.mem_w - 1) as u16;
        self.ys = 0;
        self.ye = (self.spec.mem_h - 1) as u16;
        self.x = 0;
        self.y = 0;
        self.cmd = None;
        self.params.clear();
        self.npix = 0;
        self.stored.clear();
        self.cs_release();
        self.version = self.version.wrapping_add(1);
    }

    /// RST pin level (active low). Resets at the moment it goes low
    pub fn set_reset(&mut self, active: bool) {
        if active && !self.in_reset {
            self.reset();
        }
        self.in_reset = active;
    }

    pub fn set_backlight(&mut self, on: bool) {
        if on != self.backlight {
            self.backlight = on;
            self.version = self.version.wrapping_add(1);
        }
    }

    /// CS went high: the serial interface drops any read in progress
    pub fn cs_release(&mut self) {
        self.rd.clear();
        self.rd_skip = 0;
        self.rd_pos = 0;
        self.half_clock = false;
    }

    /// One byte received while selected; dc = D/C pin level (1 = data)
    pub fn byte(&mut self, dc: bool, b: u8) {
        if self.in_reset {
            return;
        }
        if dc {
            self.data(b);
        } else {
            self.command(b);
            self.prepare_read(b);
        }
    }

    /// SCLK cycles without data in or out (dummy phase): the read stream moves on
    pub fn clock(&mut self, bits: u32) {
        for _ in 0..bits {
            self.next_bit();
        }
    }

    /// The controller flipped its idle clock level (M5GFX's one-bit dummy on C3 / S3): two flips make one clock
    pub fn idle_edge(&mut self) {
        if self.half_clock {
            self.clock(1);
        }
        self.half_clock = !self.half_clock;
    }

    /// Clock `bits` out of the panel (on MISO, or on the shared SDA line in 3-wire mode); packed MSB first, first byte first
    pub fn read_bits(&mut self, bits: u32) -> Vec<u8> {
        let mut out = vec![0u8; bits.div_ceil(8) as usize];
        for i in 0..bits as usize {
            if self.next_bit() {
                out[i / 8] |= 0x80 >> (i % 8);
            }
        }
        out
    }

    fn next_bit(&mut self) -> bool {
        if self.in_reset {
            return false;
        }
        if self.rd_skip > 0 {
            self.rd_skip -= 1;
            return false;
        }
        let i = self.rd_pos;
        self.rd_pos += 1;
        self.rd
            .get(i / 8)
            .is_some_and(|b| b & (0x80 >> (i % 8)) != 0)
    }

    /// What the panel would shift out after command `c`. Multi-byte reads (04h, 09h) start with one dummy clock, 8-bit ones don't
    fn prepare_read(&mut self, c: u8) {
        self.cs_release();
        let d9 = self.stored.get(&0xd9).and_then(|v| v.first().copied());
        let (skip, data) = match (self.spec.variant, d9) {
            (Variant::Ili9342c | Variant::Ili9342e, Some(i)) if i & 0x10 != 0 && c != 0xd9 => {
                (0, vec![self.indexed_param(c, (i & 0xf) as usize)])
            }
            _ => match c {
                0x04 => (1, self.spec.id.to_vec()),
                0x09 => (1, self.status().to_be_bytes().to_vec()),
                0x0a => (0, vec![self.power_mode()]),
                0x0b => (0, vec![self.madctl]),
                0x0c => (0, vec![self.colmod]),
                0x0d => (0, vec![(self.inverted as u8) << 5]),
                0xda..=0xdc => (0, vec![self.spec.id[(c - 0xda) as usize]]),
                _ => return,
            },
        };
        self.reads += 1;
        self.rd = data;
        self.rd_skip = skip;
    }

    /// ILI9342 register parameter `idx` through D9h (index 0 is the dummy byte)
    fn indexed_param(&self, c: u8, idx: usize) -> u8 {
        match self.spec.variant {
            Variant::Ili9342e => match self.stored.get(&c) {
                Some(v) if idx > 0 => v.get(idx - 1).copied().unwrap_or(0),
                _ => 0,
            },
            Variant::Ili9342c
                if c == 0xd3
                    && self.stored.get(&0xc8).map(Vec::as_slice) == Some(&[0xff, 0x93, 0x42]) =>
            {
                [0x00, 0x00, 0x93, 0x42].get(idx).copied().unwrap_or(0)
            }
            _ => 0,
        }
    }

    /// RDDPM: booster on (bit 7) and sleep out (bit 4) together, normal mode (bit 3), display on (bit 2)
    fn power_mode(&self) -> u8 {
        let awake = !self.sleep as u8;
        awake << 7 | awake << 4 | 1 << 3 | (self.display_on as u8) << 2
    }

    /// RDDST 32 bits: MADCTL in the top byte, pixel format, sleep out / normal mode, inversion, display on
    fn status(&self) -> u32 {
        let awake = !self.sleep as u32;
        let ifpf = match self.colmod & 7 {
            5 => 0b101,
            6 => 0b110,
            o => o as u32,
        };
        awake << 31
            | ((self.madctl as u32) & 0x7c) << 24
            | ifpf << 20
            | awake << 17
            | 1 << 16
            | (self.inverted as u32) << 13
            | (self.display_on as u32) << 10
    }

    fn command(&mut self, c: u8) {
        self.commands += 1;
        self.cmd = Some(c);
        self.params.clear();
        self.npix = 0;
        let before = (self.sleep, self.display_on, self.inverted);
        match c {
            0x00 => {}
            0x01 => self.reset(),
            0x10 => self.sleep = true,
            0x11 => self.sleep = false,
            0x20 => self.inverted = false,
            0x21 => self.inverted = true,
            0x28 => self.display_on = false,
            0x29 => self.display_on = true,
            0x2c => {
                self.x = self.xs;
                self.y = self.ys;
            }
            // RAMWRC: continue from where the last write stopped
            0x3c => {}
            0x2a | 0x2b | 0x36 | 0x3a => {}
            // NORON / IDMOFF / IDMON / TEOFF / TEON: no effect on the image
            0x13 | 0x34 | 0x35 | 0x38 | 0x39 => {}
            _ => self.vendor_cmds += 1,
        }
        if before != (self.sleep, self.display_on, self.inverted) {
            self.version = self.version.wrapping_add(1);
        }
    }

    fn data(&mut self, b: u8) {
        let Some(c) = self.cmd else { return };
        match c {
            0x2c | 0x3c => self.pixel_byte(b),
            0x2a | 0x2b => {
                self.params.push(b);
                if self.params.len() == 4 {
                    let s = u16::from_be_bytes([self.params[0], self.params[1]]);
                    let e = u16::from_be_bytes([self.params[2], self.params[3]]);
                    if c == 0x2a {
                        self.xs = s;
                        self.xe = e;
                    } else {
                        self.ys = s;
                        self.ye = e;
                    }
                }
            }
            0x36 => {
                self.madctl = b;
                self.version = self.version.wrapping_add(1);
            }
            0x3a => self.colmod = b,
            _ => self.store_param(c, b),
        }
    }

    /// Keep vendor parameters for read-back. The C has no DDh / CBh (undefined commands store nothing)
    fn store_param(&mut self, c: u8, b: u8) {
        let keep = match self.spec.variant {
            Variant::Generic => false,
            Variant::Ili9342c => !matches!(c, 0xdd | 0xcb),
            Variant::Ili9342e => true,
        };
        if keep && self.params.len() < 16 {
            // The first parameter after the command replaces what was stored before
            self.params.push(b);
            self.stored.insert(c, self.params.clone());
        }
    }

    /// Bytes per pixel: COLMOD low 3 bits 5 = 16-bit RGB565, 6 = 18-bit (one byte per colour, top 6 bits used)
    fn bytes_per_pixel(&self) -> usize {
        if self.colmod & 7 == 5 {
            2
        } else {
            3
        }
    }

    fn pixel_byte(&mut self, b: u8) {
        self.pix[self.npix] = b;
        self.npix += 1;
        if self.npix < self.bytes_per_pixel() {
            return;
        }
        self.npix = 0;
        let rgb = if self.bytes_per_pixel() == 2 {
            let v = u16::from_be_bytes([self.pix[0], self.pix[1]]) as u32;
            // Expand 5/6/5 bits to 8: replicate high bits into low bits
            let r = (v >> 11) & 0x1f;
            let g = (v >> 5) & 0x3f;
            let bl = v & 0x1f;
            ((r << 3 | r >> 2) << 16) | ((g << 2 | g >> 4) << 8) | (bl << 3 | bl >> 2)
        } else {
            ((self.pix[0] as u32 & 0xfc) << 16)
                | ((self.pix[1] as u32 & 0xfc) << 8)
                | (self.pix[2] as u32 & 0xfc)
        };
        // MADCTL: MV (swap rows/cols) -> MX (mirror cols) -> MY (mirror rows), window coords to frame memory coords
        let (mw, mh) = (self.spec.mem_w, self.spec.mem_h);
        let (mut col, mut row) = (self.x as usize, self.y as usize);
        if self.madctl & 0x20 != 0 {
            std::mem::swap(&mut col, &mut row);
        }
        if self.madctl & 0x40 != 0 {
            col = (mw - 1).wrapping_sub(col);
        }
        if self.madctl & 0x80 != 0 {
            row = (mh - 1).wrapping_sub(row);
        }
        if col < mw && row < mh {
            self.gram[row * mw + col] = rgb;
        }
        self.pixels += 1;
        self.version = self.version.wrapping_add(1);
        // Advance by column inside the window, wrap at the right edge, back to the window start at the bottom
        if self.x >= self.xe {
            self.x = self.xs;
            self.y = if self.y >= self.ye {
                self.ys
            } else {
                self.y + 1
            };
        } else {
            self.x += 1;
        }
    }

    /// What an observer sees: frame_size() RGBA. Transparent off the glass; all black inside when asleep / display off / backlight off.
    pub fn render(&mut self) -> &[u8] {
        if self.frame_version == self.version {
            return &self.frame;
        }
        self.frame_version = self.version;
        let lit = self.display_on && !self.sleep && self.backlight;
        let bgr = self.madctl & 0x08 != 0;
        let s = self.spec;
        let (fw, fh) = s.frame_size();
        for y in 0..fh {
            for x in 0..fw {
                let o = (y * fw + x) * 4;
                // Landscape glass: frame (x, y) shows window (w-1-y, x), the image M5GFX draws upright at rotation 1
                let (wx, wy) = if s.landscape {
                    (s.w - 1 - y, x)
                } else {
                    (x, y)
                };
                if !self.visible(wx, wy) {
                    self.frame[o..o + 4].copy_from_slice(&[0, 0, 0, 0]);
                    continue;
                }
                let mut c = self.gram[(wy + s.oy) * s.mem_w + wx + s.ox];
                // Normally-black IPS panel: true colours only with INVON
                if s.normally_black != self.inverted {
                    c ^= 0xff_ffff;
                }
                let (mut r, g, mut b) = ((c >> 16) as u8, (c >> 8) as u8, c as u8);
                // BGR subpixels: red and blue swap when the controller doesn't reorder (BGR=0)
                if s.bgr_panel != bgr {
                    std::mem::swap(&mut r, &mut b);
                }
                let px = if lit { [r, g, b, 255] } else { [0, 0, 0, 255] };
                self.frame[o..o + 4].copy_from_slice(&px);
            }
        }
        &self.frame
    }

    /// Non-black pixels on the glass
    pub fn lit_pixels(&mut self) -> usize {
        self.render()
            .chunks(4)
            .filter(|p| p[3] != 0 && (p[0] | p[1] | p[2]) != 0)
            .count()
    }

    /// Colour stats for the observation record: pixel count and centroid of each non-black colour on the glass, top 12, >= 50 px (drops noise).
    /// Checkpoints judge "what colour, where" with it (lcd_colors in levels.json); CLI and wasm both call it so fingerprints match byte for byte.
    pub fn color_report(&mut self) -> String {
        let w = self.size().0;
        let mut m: HashMap<u32, (u64, u64, u64)> = HashMap::new();
        for (i, p) in self.render().chunks(4).enumerate() {
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
        // Most pixels first, ties by colour value, so the order is deterministic
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

    /// Whether the display is on (DISPON and out of sleep)
    pub fn showing(&self) -> bool {
        self.display_on && !self.sleep
    }

    /// Binary PPM (P6), black off the glass
    pub fn ppm(&mut self) -> Vec<u8> {
        let (w, h) = self.size();
        let mut v = format!("P6\n{w} {h}\n255\n").into_bytes();
        for p in self.render().chunks(4) {
            v.extend_from_slice(&p[..3]);
        }
        v
    }

    pub fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 240;

    fn send(d: &mut DcsPanel, cmd: u8, data: &[u8]) {
        d.byte(false, cmd);
        for b in data {
            d.byte(true, *b);
        }
    }

    #[test]
    fn window_write_and_render() {
        let mut d = DcsPanel::new(GC9A01);
        d.set_backlight(true);
        send(&mut d, 0xef, &[]); // vendor command
        send(&mut d, 0x11, &[]);
        send(&mut d, 0x36, &[0x08]); // BGR
        send(&mut d, 0x3a, &[0x05]);
        send(&mut d, 0x21, &[]);
        send(&mut d, 0x29, &[]);
        // Write red into the centre 2x2 window (RGB565 0xF800)
        send(&mut d, 0x2a, &[0, 119, 0, 120]);
        send(&mut d, 0x2b, &[0, 119, 0, 120]);
        send(&mut d, 0x2c, &[0xf8, 0, 0xf8, 0, 0xf8, 0, 0xf8, 0]);
        assert_eq!(d.vendor_cmds, 1);
        assert_eq!(d.lit_pixels(), 4);
        let f = d.render();
        let o = (120 * W + 120) * 4;
        assert_eq!(&f[o..o + 4], &[255, 0, 0, 255]);
        // Corner is outside the circle: transparent
        assert_eq!(f[3], 0);
        // Without inversion the remaining black pixels show as white on a normally-black panel
        send(&mut d, 0x20, &[]);
        assert!(d.lit_pixels() > 40000);
        // Display off: all black
        send(&mut d, 0x21, &[]);
        send(&mut d, 0x28, &[]);
        assert_eq!(d.lit_pixels(), 0);
    }

    #[test]
    fn ramwrc_continues_and_wraps() {
        let mut d = DcsPanel::new(GC9A01);
        send(&mut d, 0x3a, &[0x55]);
        send(&mut d, 0x2a, &[0, 10, 0, 11]);
        send(&mut d, 0x2b, &[0, 20, 0, 20]);
        send(&mut d, 0x2c, &[0x00, 0x1f]);
        assert_eq!(d.gram[20 * W + 10], 0x0000ff);
        send(&mut d, 0x3c, &[0x07, 0xe0, 0xff, 0xff]);
        assert_eq!(d.gram[20 * W + 11], 0x00ff00);
        // Window is one row, two columns: the third pixel wraps back to the window start
        assert_eq!(d.gram[20 * W + 10], 0xffffff);
        assert_eq!(d.pixels, 3);
        // Reset pin: bus ignored while held low
        d.set_reset(true);
        send(&mut d, 0x29, &[]);
        assert!(!d.display_on);
    }

    #[test]
    fn rddid_with_dummy_bit() {
        for (spec, id) in [
            (GC9107, 0x079100u32),
            (GC9A01, 0x019a00),
            (ST7789, 0x528585),
        ] {
            let mut d = DcsPanel::new(spec);
            d.byte(false, 0x04);
            // One dummy clock, then 24 ID bits
            d.idle_edge();
            d.idle_edge();
            let b = d.read_bits(32);
            assert_eq!(
                u32::from_le_bytes([b[0], b[1], b[2], b[3]]),
                id,
                "{}",
                spec.name
            );
        }
        // Without the dummy clock the panel's own dummy bit leads: data arrives one bit late
        let mut d = DcsPanel::new(ST7735S);
        d.byte(false, 0x04);
        assert_eq!(d.read_bits(8), vec![0x7c >> 1]);
        // CS high drops the reply
        d.cs_release();
        assert_eq!(d.read_bits(8), vec![0]);
    }

    #[test]
    fn offset_window_and_landscape() {
        let mut d = DcsPanel::new(ST7789);
        d.set_backlight(true);
        send(&mut d, 0x11, &[]);
        send(&mut d, 0x21, &[]);
        send(&mut d, 0x29, &[]);
        send(&mut d, 0x36, &[0x08]);
        send(&mut d, 0x3a, &[0x55]);
        // GRAM column 52, row 40 is the glass's top-left pixel
        send(&mut d, 0x2a, &[0, 52, 0, 52]);
        send(&mut d, 0x2b, &[0, 40, 0, 40]);
        send(&mut d, 0x2c, &[0xf8, 0x00]);
        assert_eq!(d.size(), (135, 240));
        assert_eq!(&d.render()[..4], &[255, 0, 0, 255]);
        assert_eq!(d.lit_pixels(), 1);
        // Outside the glass: kept in GRAM, not shown
        send(&mut d, 0x2a, &[0, 10, 0, 10]);
        send(&mut d, 0x2c, &[0xf8, 0x00]);
        assert_eq!(d.lit_pixels(), 1);
        let mut l = DcsPanel::new(ST7789_LAND);
        assert_eq!(l.size(), (240, 135));
        assert_eq!(l.render().len(), 240 * 135 * 4);
    }

    /// F-04b bare modules: ILI9341 is normally white (true colours without INVON) and needs BGR=1 like the IDF example
    #[test]
    fn ili9341_normally_white_bgr() {
        let mut d = DcsPanel::new(ILI9341);
        d.set_backlight(true);
        send(&mut d, 0x11, &[]);
        send(&mut d, 0x29, &[]);
        send(&mut d, 0x36, &[0x08]);
        send(&mut d, 0x3a, &[0x55]);
        send(&mut d, 0x2a, &[0, 0, 0, 0]);
        send(&mut d, 0x2b, &[0x01, 0x3f, 0x01, 0x3f]);
        send(&mut d, 0x2c, &[0xf8, 0x00]);
        assert_eq!(d.size(), (240, 320));
        let o = (319 * 240) * 4;
        assert_eq!(&d.render()[o..o + 4], &[255, 0, 0, 255]);
        // The rest of GRAM is black and shows black: only one lit pixel
        assert_eq!(d.lit_pixels(), 1);
        // Without BGR the red pixel comes out blue
        send(&mut d, 0x36, &[0x00]);
        assert_eq!(&d.render()[o..o + 4], &[0, 0, 255, 255]);
    }

    /// 240x240 ST7789: glass is GRAM rows 0..239, so MY mirroring moves row 0 to GRAM row 319, off the glass,
    /// until the driver adds the 80-row gap (esp_lcd_panel_set_gap); RGB panel, normally black
    #[test]
    fn st7789_240_mirror_needs_gap() {
        let mut d = DcsPanel::new(ST7789_240);
        d.set_backlight(true);
        send(&mut d, 0x11, &[]);
        send(&mut d, 0x21, &[]);
        send(&mut d, 0x29, &[]);
        send(&mut d, 0x36, &[0x80]);
        send(&mut d, 0x3a, &[0x55]);
        send(&mut d, 0x2a, &[0, 0, 0, 0]);
        send(&mut d, 0x2b, &[0, 0, 0, 0]);
        send(&mut d, 0x2c, &[0xf8, 0x00]);
        assert_eq!(d.size(), (240, 240));
        assert_eq!(d.lit_pixels(), 0);
        send(&mut d, 0x2b, &[0, 80, 0, 80]);
        send(&mut d, 0x2c, &[0xf8, 0x00]);
        let o = (239 * 240) * 4;
        assert_eq!(&d.render()[o..o + 4], &[255, 0, 0, 255]);
        let t = DcsPanel::new(ST7789_320);
        assert_eq!(t.size(), (240, 320));
    }
}
