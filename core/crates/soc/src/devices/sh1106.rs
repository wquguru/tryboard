//! SH1106 132x64 monochrome OLED controller (I2C), as on common 1.3" 128x64 modules. Command set per the Sino Wealth SH1106 datasheet.
//! Differences from SSD1306 that matter to firmware: 132-column RAM with the glass on columns 2..129, page addressing only (no 20h-22h,
//! the column stops at 131 instead of wrapping), DC-DC via ADh with power-on default on, no 8Dh charge pump. (lint: allow-long-comment)

use crate::i2c::I2cDevice;
use std::any::Any;

/// Visible glass, same as SSD1306 so frontends can share the 128x64 frame
pub const W: usize = 128;
pub const H: usize = 64;
/// Display RAM columns and the first one the glass shows
pub const RAM_W: usize = 132;
pub const GLASS_X0: usize = 2;

pub struct Sh1106 {
    pub addr: u8,
    pub ram: [u8; RAM_W * H / 8],
    pub display_on: bool,
    /// Internal DC-DC (ADh); the datasheet reset value is on (8Bh)
    pub dc_dc: bool,
    pub contrast: u8,
    pub inverse: bool,
    pub entire_on: bool,
    pub seg_remap: bool,
    pub com_reverse: bool,
    pub start_line: u8,
    pub offset: u8,
    col: u8,
    page: u8,
    /// I2C control byte state: None = next byte is a control byte
    ctrl: Option<(bool, bool)>,
    cmd_buf: Vec<u8>,
    /// Commands SH1106 doesn't have (an SSD1306 driver's 20h / 21h / 22h / 8Dh); firmware written for SSD1306 shows up here
    pub foreign_cmds: u64,
    /// Bumped whenever the image may have changed; the frontend uses it to decide whether to re-upload the texture
    pub version: u32,
    pub frame: Vec<u8>,
    frame_version: u32,
}

impl Sh1106 {
    pub fn new(addr: u8) -> Self {
        Sh1106 {
            addr,
            ram: [0; RAM_W * H / 8],
            display_on: false,
            dc_dc: true,
            contrast: 0x80,
            inverse: false,
            entire_on: false,
            seg_remap: false,
            com_reverse: false,
            start_line: 0,
            offset: 0,
            col: 0,
            page: 0,
            ctrl: None,
            cmd_buf: Vec::new(),
            foreign_cmds: 0,
            version: 1,
            frame: vec![0; W * H],
            frame_version: 0,
        }
    }

    /// Double-byte commands: the second byte is the argument
    fn args_needed(c: u8) -> usize {
        match c {
            0x81 | 0xa8 | 0xad | 0xd3 | 0xd5 | 0xd9 | 0xda | 0xdb => 1,
            _ => 0,
        }
    }

    fn command(&mut self, b: u8) {
        self.cmd_buf.push(b);
        let c = self.cmd_buf[0];
        if self.cmd_buf.len() <= Self::args_needed(c) {
            return;
        }
        let a = self.cmd_buf.get(1).copied().unwrap_or(0);
        self.cmd_buf.clear();
        self.version += 1;
        match c {
            0x00..=0x0f => self.col = (self.col & 0xf0) | (c & 0x0f),
            0x10..=0x1f => self.col = (self.col & 0x0f) | ((c & 0x0f) << 4),
            // Pump voltage 30h-33h: no effect on the image
            0x30..=0x33 => {}
            0x40..=0x7f => self.start_line = c & 0x3f,
            0x81 => self.contrast = a,
            0xa0 => self.seg_remap = false,
            0xa1 => self.seg_remap = true,
            0xa4 => self.entire_on = false,
            0xa5 => self.entire_on = true,
            0xa6 => self.inverse = false,
            0xa7 => self.inverse = true,
            0xad => self.dc_dc = a & 1 != 0,
            0xae => self.display_on = false,
            0xaf => self.display_on = true,
            0xb0..=0xbf => self.page = c & 7,
            0xc0..=0xc7 => self.com_reverse = false,
            0xc8..=0xcf => self.com_reverse = true,
            0xd3 => self.offset = a & 0x3f,
            // Mux ratio, clock, precharge, COM pads, VCOM deselect, read-modify-write / end, NOP
            0xa8 | 0xd5 | 0xd9 | 0xda | 0xdb | 0xe0 | 0xee | 0xe3 => {}
            // Not an SH1106 command (SSD1306 addressing mode / window / charge pump, scrolling): ignored by the chip
            _ => self.foreign_cmds += 1,
        }
    }

    fn data(&mut self, b: u8) {
        if (self.col as usize) < RAM_W {
            self.ram[self.page as usize * RAM_W + self.col as usize] = b;
        }
        self.version += 1;
        // The column counter stops at 131; no wrap to the next page
        if (self.col as usize) < RAM_W - 1 {
            self.col += 1;
        }
    }

    /// Whether a pixel is lit in RAM (RAM coordinates, col 0..131)
    pub fn ram_pixel(&self, col: usize, row: usize) -> bool {
        self.ram[(row / 8) * RAM_W + col] >> (row % 8) & 1 != 0
    }

    /// What an observer sees: 128x64, brightness 0..255 per pixel. Orientation follows the SSD1306 model (A1 + C8 is upright);
    /// segment remap mirrors the whole 132-column RAM, so the glass shows columns 2..129 either way
    pub fn render(&mut self) -> &[u8] {
        if self.frame_version == self.version {
            return &self.frame;
        }
        self.frame_version = self.version;
        let lit = self.display_on && self.dc_dc;
        let level = (110.0 + 145.0 * (self.contrast as f32 / 255.0).sqrt()) as u8;
        for y in 0..H {
            for x in 0..W {
                let seg = if self.seg_remap { x } else { W - 1 - x };
                let col = seg + GLASS_X0;
                let com = if self.com_reverse { y } else { H - 1 - y };
                let row = (com + self.start_line as usize + self.offset as usize) % H;
                let mut on = self.entire_on || self.ram_pixel(col, row);
                if self.inverse {
                    on = !on;
                }
                self.frame[y * W + x] = if lit && on { level } else { 0 };
            }
        }
        &self.frame
    }

    pub fn lit_pixels(&mut self) -> usize {
        self.render().iter().filter(|&&p| p > 0).count()
    }

    /// Text sketch (2x1 pixels per character) for the CLI / acceptance, same format as `Ssd1306::ascii`
    pub fn ascii(&mut self) -> String {
        let f = self.render().to_vec();
        let mut s = String::new();
        for y in (0..H).step_by(2) {
            for x in 0..W {
                let a = f[y * W + x] > 0;
                let b = f[(y + 1) * W + x] > 0;
                s.push(match (a, b) {
                    (true, true) => '█',
                    (true, false) => '▀',
                    (false, true) => '▄',
                    _ => ' ',
                });
            }
            s.push('\n');
        }
        s
    }
}

impl I2cDevice for Sh1106 {
    fn address(&self) -> u8 {
        self.addr
    }
    fn start(&mut self, _read: bool) -> bool {
        self.ctrl = None;
        true
    }
    fn write(&mut self, b: u8) -> bool {
        match self.ctrl {
            None => self.ctrl = Some((b & 0x80 != 0, b & 0x40 != 0)),
            Some((co, dc)) => {
                if dc {
                    self.data(b);
                } else {
                    self.command(b);
                }
                if co {
                    self.ctrl = None;
                }
            }
        }
        true
    }
    /// Status read: bit 6 = display off (RAM read-back through read-modify-write is not modelled)
    fn read(&mut self) -> u8 {
        if self.display_on {
            0x00
        } else {
            0x40
        }
    }
    fn stop(&mut self) {
        self.ctrl = None;
    }
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmds(d: &mut Sh1106, c: &[u8]) {
        d.start(false);
        d.write(0x00);
        for b in c {
            d.write(*b);
        }
        d.stop();
    }

    fn data(d: &mut Sh1106, v: &[u8]) {
        d.start(false);
        d.write(0x40);
        for b in v {
            d.write(*b);
        }
        d.stop();
    }

    /// Typical 1.3" init (no 8Dh), then fill each page from column 2 the way SH1106 drivers do
    #[test]
    fn page_writes_with_column_offset() {
        let mut d = Sh1106::new(0x3c);
        cmds(
            &mut d,
            &[
                0xae, 0xd5, 0x80, 0xa8, 0x3f, 0xd3, 0x00, 0x40, 0xad, 0x8b, 0xa1, 0xc8, 0x81, 0xff,
                0xaf,
            ],
        );
        assert!(d.display_on && d.dc_dc);
        for p in 0..8u8 {
            cmds(&mut d, &[0xb0 | p, 0x02, 0x10]);
            data(&mut d, &[0xff; 128]);
        }
        assert_eq!(d.lit_pixels(), W * H);
        // RAM columns 0, 1, 130, 131 are off the glass and were never written
        assert!(!d.ram_pixel(0, 0) && !d.ram_pixel(131, 63));
        assert!(d.ram_pixel(2, 0) && d.ram_pixel(129, 63));
    }

    /// An SSD1306 driver (horizontal mode from column 0, one 1 KB burst) leaves a 2-column shift and only one page drawn
    #[test]
    fn ssd1306_driver_shows_shift() {
        let mut d = Sh1106::new(0x3c);
        cmds(&mut d, &[0x8d, 0x14, 0x20, 0x00, 0xa1, 0xc8, 0xaf]);
        assert!(d.foreign_cmds >= 2);
        // 21h / 22h windows would be misread as column / start-line commands; start at page 0 column 0 instead
        cmds(&mut d, &[0xb0, 0x00, 0x10]);
        let mut fb = [0u8; 1024];
        fb[0] = 0xff; // leftmost column of page 0
        fb[128] = 0xff; // leftmost column of page 1 (lands in page 0, column 128 here)
        data(&mut d, &fb);
        // RAM column 0 is off the glass: the SSD1306 driver's leftmost column is invisible
        assert!(d.ram_pixel(0, 0) && !d.ram_pixel(0, 8));
        d.render();
        assert_eq!(d.frame[0], 0);
        // Page 1's leftmost column landed at RAM column 128 of page 0 = glass x 126
        assert!(d.frame[126] > 0);
        // Writes past column 131 pile up on the last column, nothing reaches page 1
        assert!(!d.ram_pixel(2, 8));
    }

    #[test]
    fn dc_dc_off_and_inverse() {
        let mut d = Sh1106::new(0x3c);
        cmds(&mut d, &[0xaf, 0xa7]);
        assert_eq!(d.lit_pixels(), W * H);
        cmds(&mut d, &[0xad, 0x8a]);
        assert_eq!(d.lit_pixels(), 0);
    }

    #[test]
    fn seg_remap_mirrors_ram() {
        let mut d = Sh1106::new(0x3c);
        cmds(&mut d, &[0xc8, 0xaf, 0xb0, 0x02, 0x10]);
        data(&mut d, &[0x01]);
        // A0 (no remap): RAM column 2 shows at the right edge
        d.render();
        assert!(d.frame[W - 1] > 0);
        cmds(&mut d, &[0xa1]);
        d.render();
        assert!(d.frame[0] > 0 && d.frame[W - 1] == 0);
    }
}
