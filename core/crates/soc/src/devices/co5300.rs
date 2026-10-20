//! CO5300 480x480 AMOLED driver on QSPI (CS / CLK / D0..D3, plus RST; no D/C pin). Per the CO5300 datasheet and the
//! Apache-2.0 esp_lcd_co5300 driver, each CS-low frame starts with 4 bytes `opcode, 0x00, cmd, 0x00`: opcode 0x02 = write
//! command + single-line parameters, 0x32 = write pixels on four lines, 0x03 = read. Commands are MIPI DCS (lint: allow-long-comment)

use std::collections::BTreeMap;
use std::fmt::Write as _;

pub const W: usize = 480;
pub const H: usize = 480;

pub struct Co5300 {
    /// Frame memory, 0xRRGGBB per pixel (as received, before panel transforms)
    pub gram: Vec<u32>,
    pub sleep: bool,
    pub display_on: bool,
    pub inverted: bool,
    pub madctl: u8,
    pub colmod: u8,
    /// 0x51 display brightness and 0x53 control (BCTRL bit 5 enables the brightness register)
    pub brightness: u8,
    pub ctrl_display: u8,
    pub in_reset: bool,
    xs: u16,
    xe: u16,
    ys: u16,
    ye: u16,
    x: u16,
    y: u16,
    head: [u8; 4],
    nhead: usize,
    cmd: Option<u8>,
    params: Vec<u8>,
    pix: [u8; 3],
    npix: usize,
    pub commands: u64,
    pub pixels: u64,
    /// Read frames (opcode 0x03 / 0x0B): no data model, MISO reads all ones
    pub reads: u64,
    /// Commands or opcodes not modelled: code -> count (AGENTS §6.4, listed by the CLI)
    pub unimpl: BTreeMap<u16, u64>,
    pub version: u32,
    frame: Vec<u8>,
    frame_version: u32,
}

impl Default for Co5300 {
    fn default() -> Self {
        let mut d = Co5300 {
            gram: vec![0; W * H],
            sleep: true,
            display_on: false,
            inverted: false,
            madctl: 0,
            colmod: 0x77,
            brightness: 0,
            ctrl_display: 0,
            in_reset: false,
            xs: 0,
            xe: 0,
            ys: 0,
            ye: 0,
            x: 0,
            y: 0,
            head: [0; 4],
            nhead: 0,
            cmd: None,
            params: Vec::new(),
            pix: [0; 3],
            npix: 0,
            commands: 0,
            pixels: 0,
            reads: 0,
            unimpl: BTreeMap::new(),
            version: 1,
            frame: vec![0; W * H * 4],
            frame_version: 0,
        };
        d.reset();
        d
    }
}

/// Opcodes that carry a write: 0x02 single-line, 0x32 / 0x12 pixel data on four lines
fn write_op(op: u8) -> bool {
    matches!(op, 0x02 | 0x12 | 0x32)
}

impl Co5300 {
    pub fn new() -> Self {
        Self::default()
    }

    /// Hardware reset or SWRESET: registers to defaults, sleep, display off; frame memory kept
    pub fn reset(&mut self) {
        self.sleep = true;
        self.display_on = false;
        self.inverted = false;
        self.madctl = 0;
        self.colmod = 0x77;
        self.brightness = 0;
        self.ctrl_display = 0;
        self.xs = 0;
        self.xe = (W - 1) as u16;
        self.ys = 0;
        self.ye = (H - 1) as u16;
        self.x = 0;
        self.y = 0;
        self.nhead = 0;
        self.cmd = None;
        self.params.clear();
        self.npix = 0;
        self.version = self.version.wrapping_add(1);
    }

    /// RST pin level (active low). Resets at the moment it goes low
    pub fn set_reset(&mut self, active: bool) {
        if active && !self.in_reset {
            self.reset();
        }
        self.in_reset = active;
    }

    /// One byte clocked in while CS is low (any line count; the bus model hands bytes in wire order)
    pub fn byte(&mut self, b: u8) {
        if self.in_reset {
            return;
        }
        if self.nhead < 4 {
            self.head[self.nhead] = b;
            self.nhead += 1;
            if self.nhead == 4 {
                self.start();
            }
            return;
        }
        let Some(c) = self.cmd else { return };
        match c {
            0x2c | 0x3c => self.pixel_byte(b),
            0x2a | 0x2b => {
                self.params.push(b);
                if self.params.len() == 4 {
                    let s = u16::from_be_bytes([self.params[0], self.params[1]]);
                    let e = u16::from_be_bytes([self.params[2], self.params[3]]);
                    if c == 0x2a {
                        (self.xs, self.xe) = (s, e);
                    } else {
                        (self.ys, self.ye) = (s, e);
                    }
                }
            }
            0x36 => self.set(|d| d.madctl = b),
            0x3a => self.colmod = b,
            0x51 => self.set(|d| d.brightness = b),
            0x53 => self.set(|d| d.ctrl_display = b),
            _ => {}
        }
    }

    /// CS went high: the frame ends, the next byte starts a new 4-byte header
    pub fn cs_release(&mut self) {
        self.nhead = 0;
        self.cmd = None;
        self.params.clear();
        self.npix = 0;
    }

    fn set(&mut self, f: impl FnOnce(&mut Self)) {
        f(self);
        self.version = self.version.wrapping_add(1);
    }

    fn start(&mut self) {
        let (op, c) = (self.head[0], self.head[2]);
        if matches!(op, 0x03 | 0x0b) {
            self.reads += 1;
            return;
        }
        if !write_op(op) {
            *self.unimpl.entry(0x100 | op as u16).or_default() += 1;
            return;
        }
        self.commands += 1;
        self.cmd = Some(c);
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
            // RAMWRC continues where the last write stopped; parameter commands take their bytes in `byte`
            0x3c | 0x2a | 0x2b | 0x36 | 0x3a | 0x51 | 0x53 => {}
            // NORON / TEOFF / TEON / IDMOFF / IDMON / TE scanline: no effect on the image
            0x13 | 0x34 | 0x35 | 0x38 | 0x39 | 0x44 => {}
            _ => *self.unimpl.entry(c as u16).or_default() += 1,
        }
        if before != (self.sleep, self.display_on, self.inverted) {
            self.version = self.version.wrapping_add(1);
        }
    }

    /// COLMOD low 3 bits: 5 = RGB565 (2 bytes), 6 = RGB666 (top 6 bits of 3 bytes), 7 = RGB888
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
            let r = (v >> 11) & 0x1f;
            let g = (v >> 5) & 0x3f;
            let bl = v & 0x1f;
            ((r << 3 | r >> 2) << 16) | ((g << 2 | g >> 4) << 8) | (bl << 3 | bl >> 2)
        } else {
            let m = if self.colmod & 7 == 6 { 0xfc } else { 0xff };
            ((self.pix[0] & m) as u32) << 16
                | ((self.pix[1] & m) as u32) << 8
                | (self.pix[2] & m) as u32
        };
        // MADCTL: MV (swap) -> MX (mirror cols) -> MY (mirror rows), window coords to frame memory coords
        let (mut col, mut row) = (self.x as usize, self.y as usize);
        if self.madctl & 0x20 != 0 {
            std::mem::swap(&mut col, &mut row);
        }
        if self.madctl & 0x40 != 0 {
            col = (W - 1).wrapping_sub(col);
        }
        if self.madctl & 0x80 != 0 {
            row = (H - 1).wrapping_sub(row);
        }
        if col < W && row < H {
            self.gram[row * W + col] = rgb;
        }
        self.pixels += 1;
        self.version = self.version.wrapping_add(1);
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

    /// What an observer sees: 480x480 RGBA, black when asleep / display off. AMOLED has no backlight;
    /// the 0x51 brightness scales colours only when 0x53 BCTRL is set (otherwise full brightness)
    pub fn render(&mut self) -> &[u8] {
        if self.frame_version == self.version {
            return &self.frame;
        }
        self.frame_version = self.version;
        let lit = self.showing();
        let bgr = self.madctl & 0x08 != 0;
        let k = if self.ctrl_display & 0x20 != 0 {
            self.brightness as u32
        } else {
            255
        };
        for (i, px) in self.frame.chunks_mut(4).enumerate() {
            let mut c = self.gram[i];
            if self.inverted {
                c ^= 0xff_ffff;
            }
            let (mut r, g, mut b) = ((c >> 16) as u8, (c >> 8) as u8, c as u8);
            if bgr {
                std::mem::swap(&mut r, &mut b);
            }
            let s = |v: u8| ((v as u32 * k + 127) / 255) as u8;
            let out = if lit {
                [s(r), s(g), s(b), 255]
            } else {
                [0, 0, 0, 255]
            };
            px.copy_from_slice(&out);
        }
        &self.frame
    }

    pub fn showing(&self) -> bool {
        self.display_on && !self.sleep
    }

    pub fn lit_pixels(&mut self) -> usize {
        self.render()
            .chunks(4)
            .filter(|p| (p[0] | p[1] | p[2]) != 0)
            .count()
    }

    /// Unimplemented commands for the report: `0xfe×1 0xc4×1`, opcodes as `op0x42×3`
    pub fn unimpl_report(&self) -> String {
        let mut o = String::new();
        for (k, n) in &self.unimpl {
            if !o.is_empty() {
                o.push(' ');
            }
            if k & 0x100 != 0 {
                let _ = write!(o, "op{:#04x}×{n}", k & 0xff);
            } else {
                let _ = write!(o, "{k:#04x}×{n}");
            }
        }
        o
    }

    pub fn ppm(&mut self) -> Vec<u8> {
        let mut v = format!("P6\n{W} {H}\n255\n").into_bytes();
        for p in self.render().chunks(4) {
            v.extend_from_slice(&p[..3]);
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(d: &mut Co5300, op: u8, cmd: u8, data: &[u8]) {
        for b in [op, 0, cmd, 0].iter().chain(data) {
            d.byte(*b);
        }
        d.cs_release();
    }

    #[test]
    fn qspi_frames_draw_pixels() {
        let mut d = Co5300::new();
        frame(&mut d, 0x02, 0x11, &[]);
        frame(&mut d, 0x02, 0x3a, &[0x55]);
        frame(&mut d, 0x02, 0x2a, &[0, 10, 0, 11]);
        frame(&mut d, 0x02, 0x2b, &[0, 20, 0, 20]);
        frame(&mut d, 0x02, 0x29, &[]);
        // Pixel data split across two transfers under one CS-low frame (CS_KEEP_ACTIVE between chunks)
        for b in [0x32, 0, 0x2c, 0, 0xf8, 0x00] {
            d.byte(b);
        }
        for b in [0x07, 0xe0] {
            d.byte(b);
        }
        d.cs_release();
        assert_eq!(d.gram[20 * W + 10], 0xff0000);
        assert_eq!(d.gram[20 * W + 11], 0x00ff00);
        assert_eq!(d.pixels, 2);
        assert_eq!(d.lit_pixels(), 2);
        frame(&mut d, 0x02, 0xfe, &[0]);
        frame(&mut d, 0x42, 0x00, &[]);
        assert_eq!(d.unimpl_report(), "0xfe×1 op0x42×1");
        // Brightness applies only with BCTRL
        frame(&mut d, 0x02, 0x51, &[0x80]);
        assert_eq!(d.render()[(20 * W + 10) * 4], 255);
        frame(&mut d, 0x02, 0x53, &[0x20]);
        assert_eq!(d.render()[(20 * W + 10) * 4], 128);
    }
}
