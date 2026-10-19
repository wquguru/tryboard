//! GC9A01 240x240 round TFT (4-wire SPI: SCLK / MOSI / CS / D/C, plus RST). Commands per the GC9A01 datasheet (MIPI DCS like ST77xx):
//! D/C=0 bytes are commands, D/C=1 bytes are parameters or pixels. Panel modelled on retail 1.28" modules (ESP-IDF spi_lcd_touch config):
//! normally-black IPS, so colours are inverted unless INVON (`esp_lcd_panel_invert_color(true)`); BGR subpixels, so red/blue are right
//! only with MADCTL.BGR=1 (`LCD_RGB_ELEMENT_ORDER_BGR`). Pixels outside the round area are invisible, not counted, rendered transparent. (lint: allow-long-comment)

use std::any::Any;
use std::fmt::Write as _;

pub const W: usize = 240;
pub const H: usize = 240;

pub struct Gc9a01 {
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
    /// Bumped whenever the image may change; the frontend uses it to decide whether to re-upload the texture
    pub version: u32,
    frame: Vec<u8>,
    frame_version: u32,
}

impl Default for Gc9a01 {
    fn default() -> Self {
        let mut d = Gc9a01 {
            gram: vec![0; W * H],
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
            version: 1,
            frame: vec![0; W * H * 4],
            frame_version: 0,
        };
        d.reset();
        d
    }
}

/// Round visible area: centred on the screen, radius 120 px
pub fn visible(x: usize, y: usize) -> bool {
    let dx = x as f32 + 0.5 - W as f32 / 2.0;
    let dy = y as f32 + 0.5 - H as f32 / 2.0;
    dx * dx + dy * dy <= (W as f32 / 2.0) * (W as f32 / 2.0)
}

impl Gc9a01 {
    pub fn new() -> Self {
        Self::default()
    }

    /// Hardware reset (RST low) or SWRESET: registers to defaults, sleep, display off; frame memory kept (undefined on real chips)
    pub fn reset(&mut self) {
        self.sleep = true;
        self.display_on = false;
        self.inverted = false;
        self.madctl = 0;
        self.colmod = 0x66;
        self.xs = 0;
        self.xe = (W - 1) as u16;
        self.ys = 0;
        self.ye = (H - 1) as u16;
        self.x = 0;
        self.y = 0;
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

    pub fn set_backlight(&mut self, on: bool) {
        if on != self.backlight {
            self.backlight = on;
            self.version = self.version.wrapping_add(1);
        }
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
        }
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
            _ => {}
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

    /// What an observer sees: 240x240 RGBA. Transparent outside the circle; all black inside when asleep / display off / backlight off.
    pub fn render(&mut self) -> &[u8] {
        if self.frame_version == self.version {
            return &self.frame;
        }
        self.frame_version = self.version;
        let lit = self.display_on && !self.sleep && self.backlight;
        let bgr = self.madctl & 0x08 != 0;
        for y in 0..H {
            for x in 0..W {
                let o = (y * W + x) * 4;
                if !visible(x, y) {
                    self.frame[o..o + 4].copy_from_slice(&[0, 0, 0, 0]);
                    continue;
                }
                let mut c = self.gram[y * W + x];
                // Normally-black IPS panel: true colours only with INVON
                if !self.inverted {
                    c ^= 0xff_ffff;
                }
                let (mut r, g, mut b) = ((c >> 16) as u8, (c >> 8) as u8, c as u8);
                // BGR subpixels: red and blue swap when the controller doesn't reorder (BGR=0)
                if !bgr {
                    std::mem::swap(&mut r, &mut b);
                }
                let px = if lit { [r, g, b, 255] } else { [0, 0, 0, 255] };
                self.frame[o..o + 4].copy_from_slice(&px);
            }
        }
        &self.frame
    }

    /// Non-black pixels inside the round visible area
    pub fn lit_pixels(&mut self) -> usize {
        self.render()
            .chunks(4)
            .filter(|p| p[3] != 0 && (p[0] | p[1] | p[2]) != 0)
            .count()
    }

    /// Colour stats for the observation record: pixel count and centroid of each non-black colour in the circle, top 12, >= 50 px (drops noise).
    /// Checkpoints judge "what colour, where" with it (lcd_colors in levels.json); CLI and wasm both call it so fingerprints match byte for byte.
    pub fn color_report(&mut self) -> String {
        use std::collections::HashMap;
        let mut m: HashMap<u32, (u64, u64, u64)> = HashMap::new();
        for (i, p) in self.render().chunks(4).enumerate() {
            if p[3] == 0 || (p[0] | p[1] | p[2]) == 0 {
                continue;
            }
            let c = (p[0] as u32) << 16 | (p[1] as u32) << 8 | p[2] as u32;
            let e = m.entry(c).or_default();
            e.0 += 1;
            e.1 += (i % W) as u64;
            e.2 += (i / W) as u64;
        }
        let mut v: Vec<_> = m.into_iter().filter(|e| e.1 .0 >= 50).collect();
        // Most pixels first, ties by colour value, so the order is deterministic
        v.sort_by(|a, b| b.1 .0.cmp(&a.1 .0).then(a.0.cmp(&b.0)));
        let mut o = String::new();
        for (c, (n, sx, sy)) in v.into_iter().take(12) {
            let _ = writeln!(
                o,
                "[tryboard] LCD 颜色 #{c:06x} {n} 像素，重心 {:.1},{:.1}", // lint: allow-cjk
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

    /// Binary PPM (P6), black outside the circle
    pub fn ppm(&mut self) -> Vec<u8> {
        let mut v = format!("P6\n{W} {H}\n255\n").into_bytes();
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

    fn send(d: &mut Gc9a01, cmd: u8, data: &[u8]) {
        d.byte(false, cmd);
        for b in data {
            d.byte(true, *b);
        }
    }

    #[test]
    fn window_write_and_render() {
        let mut d = Gc9a01::new();
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
        let mut d = Gc9a01::new();
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
}
