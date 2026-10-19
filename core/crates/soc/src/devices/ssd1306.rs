//! SSD1306 128x64 monochrome OLED (I2C). Command semantics per the Solomon Systech SSD1306 datasheet.
//! Common 0.96" modules are mounted so the image is upright with segment remap A1 + reversed COM scan C8; orientation here follows that.

use crate::i2c::I2cDevice;
use std::any::Any;

pub const W: usize = 128;
pub const H: usize = 64;

#[derive(PartialEq)]
enum Mode {
    Horizontal,
    Vertical,
    Page,
}

pub struct Ssd1306 {
    pub addr: u8,
    pub gddram: [u8; W * H / 8],
    pub display_on: bool,
    pub charge_pump: bool,
    pub contrast: u8,
    pub inverse: bool,
    pub entire_on: bool,
    pub seg_remap: bool,
    pub com_reverse: bool,
    pub start_line: u8,
    pub offset: u8,
    mode: Mode,
    col: u8,
    page: u8,
    col_start: u8,
    col_end: u8,
    page_start: u8,
    page_end: u8,
    /// I2C control byte state: None = next byte is a control byte
    ctrl: Option<(bool, bool)>, // (Co, D/C)
    cmd_buf: Vec<u8>,
    /// Bumped whenever the image may have changed; the frontend uses it to decide whether to re-upload the texture
    pub version: u32,
    pub frame: Vec<u8>,
    frame_version: u32,
}

impl Ssd1306 {
    pub fn new(addr: u8) -> Self {
        Ssd1306 {
            addr,
            gddram: [0; W * H / 8],
            display_on: false,
            charge_pump: false,
            contrast: 0x7f,
            inverse: false,
            entire_on: false,
            seg_remap: false,
            com_reverse: false,
            start_line: 0,
            offset: 0,
            mode: Mode::Page,
            col: 0,
            page: 0,
            col_start: 0,
            col_end: 127,
            page_start: 0,
            page_end: 7,
            ctrl: None,
            cmd_buf: Vec::new(),
            version: 1,
            frame: vec![0; W * H],
            frame_version: 0,
        }
    }

    /// Number of argument bytes a command takes
    fn args_needed(c: u8) -> usize {
        match c {
            0x81 | 0x8d | 0x20 | 0xa8 | 0xd3 | 0xd5 | 0xd9 | 0xda | 0xdb => 1,
            0x21 | 0x22 | 0xa3 => 2,
            0x29 | 0x2a => 5,
            0x26 | 0x27 => 6,
            _ => 0,
        }
    }

    fn command(&mut self, b: u8) {
        self.cmd_buf.push(b);
        let c = self.cmd_buf[0];
        if self.cmd_buf.len() <= Self::args_needed(c) {
            return;
        }
        let a = self.cmd_buf[1..].to_vec();
        self.cmd_buf.clear();
        self.version += 1;
        match c {
            0xae => self.display_on = false,
            0xaf => self.display_on = true,
            0x81 => self.contrast = a[0],
            0x8d => self.charge_pump = a[0] & 0x04 != 0,
            0x20 => {
                self.mode = match a[0] & 3 {
                    0 => Mode::Horizontal,
                    1 => Mode::Vertical,
                    _ => Mode::Page,
                }
            }
            0x21 => {
                self.col_start = a[0] & 0x7f;
                self.col_end = a[1] & 0x7f;
                self.col = self.col_start;
            }
            0x22 => {
                self.page_start = a[0] & 7;
                self.page_end = a[1] & 7;
                self.page = self.page_start;
            }
            0xb0..=0xb7 => self.page = c & 7,
            0x00..=0x0f => self.col = (self.col & 0xf0) | (c & 0x0f),
            0x10..=0x1f => self.col = (self.col & 0x0f) | ((c & 0x07) << 4),
            0x40..=0x7f => self.start_line = c & 0x3f,
            0xa0 => self.seg_remap = false,
            0xa1 => self.seg_remap = true,
            0xc0 => self.com_reverse = false,
            0xc8 => self.com_reverse = true,
            0xa6 => self.inverse = false,
            0xa7 => self.inverse = true,
            0xa4 => self.entire_on = false,
            0xa5 => self.entire_on = true,
            0xd3 => self.offset = a[0] & 0x3f,
            // The rest (clock, precharge, COM pins, VCOMH, scrolling) doesn't affect a static image
            _ => {}
        }
    }

    fn data(&mut self, b: u8) {
        let i = self.page as usize * W + self.col as usize;
        self.gddram[i] = b;
        self.version += 1;
        match self.mode {
            Mode::Horizontal => {
                if self.col >= self.col_end {
                    self.col = self.col_start;
                    self.page = if self.page >= self.page_end {
                        self.page_start
                    } else {
                        self.page + 1
                    };
                } else {
                    self.col += 1;
                }
            }
            Mode::Vertical => {
                if self.page >= self.page_end {
                    self.page = self.page_start;
                    self.col = if self.col >= self.col_end {
                        self.col_start
                    } else {
                        self.col + 1
                    };
                } else {
                    self.page += 1;
                }
            }
            Mode::Page => {
                if self.col < 127 {
                    self.col += 1;
                }
            }
        }
    }

    /// Whether a pixel is lit in RAM (RAM coordinates)
    pub fn ram_pixel(&self, col: usize, row: usize) -> bool {
        self.gddram[(row / 8) * W + col] >> (row % 8) & 1 != 0
    }

    /// What an observer sees: 128x64, brightness 0..255 per pixel (display on/off, charge pump, contrast, inversion).
    pub fn render(&mut self) -> &[u8] {
        if self.frame_version == self.version {
            return &self.frame;
        }
        self.frame_version = self.version;
        let lit = self.display_on && self.charge_pump;
        // Contrast affects brightness non-linearly; low contrast is still clearly visible
        let level = (110.0 + 145.0 * (self.contrast as f32 / 255.0).sqrt()) as u8;
        for y in 0..H {
            for x in 0..W {
                let col = if self.seg_remap { x } else { W - 1 - x };
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

    /// Text sketch (2x1 pixels per character) for the CLI / acceptance
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

impl I2cDevice for Ssd1306 {
    fn address(&self) -> u8 {
        self.addr
    }
    fn start(&mut self, read: bool) -> bool {
        self.ctrl = None;
        // GDDRAM is not readable over I2C, only the status byte; still ACK
        let _ = read;
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
                // Co=1: only one data byte follows, then another control byte
                if co {
                    self.ctrl = None;
                }
            }
        }
        true
    }
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

    #[test]
    fn horizontal_fill_and_render() {
        let mut d = Ssd1306::new(0x3c);
        d.start(false);
        for b in [
            0x00, 0x8d, 0x14, 0xa1, 0xc8, 0x20, 0x00, 0x21, 0, 127, 0x22, 0, 7, 0xaf,
        ] {
            d.write(b);
        }
        d.stop();
        d.start(false);
        d.write(0x40);
        d.write(0x01); // Column 0, topmost pixel
        d.stop();
        let f = d.render().to_vec();
        assert!(f[0] > 0, "top-left pixel should be lit");
        assert_eq!(f.iter().filter(|&&p| p > 0).count(), 1);
    }
}
