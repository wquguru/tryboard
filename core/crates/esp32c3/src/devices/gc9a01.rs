//! GC9A01 240×240 圆形 TFT（4 线 SPI：SCLK / MOSI / CS / D/C，另有 RST）。命令语义按 GC9A01 数据手册
//! （与 MIPI DCS 的 ST77xx 系一致）：D/C=0 的字节是命令，D/C=1 的字节是该命令的参数或像素数据。
//!
//! 面板按市售 1.28" 圆屏模组的实际表现建模（与 ESP-IDF spi_lcd_touch 示例的配置对应）：
//! - IPS 常黑面板：不开 INVON 时颜色是反的，示例里固件都要调 `esp_lcd_panel_invert_color(true)`；
//! - 子像素按 BGR 排列：MADCTL.BGR=1（`LCD_RGB_ELEMENT_ORDER_BGR`）时红蓝才正确。
//!
//! 圆形可视区之外的像素看不见，不计入点亮统计，渲染为透明。

use std::any::Any;
use std::fmt::Write as _;

pub const W: usize = 240;
pub const H: usize = 240;

pub struct Gc9a01 {
    /// 显存，每像素 0xRRGGBB（按接收到的数据，未经面板换算）
    pub gram: Vec<u32>,
    pub sleep: bool,
    pub display_on: bool,
    pub inverted: bool,
    pub madctl: u8,
    pub colmod: u8,
    pub backlight: bool,
    /// RST 脚被拉低：芯片处于复位，忽略总线
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
    /// 厂商初始化寄存器（未建模，只计数）写入次数
    pub vendor_cmds: u64,
    pub commands: u64,
    pub pixels: u64,
    /// 画面可能变化时递增，前端据此决定是否重传纹理
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

/// 圆形可视区：以屏幕中心为圆心、半径 120 像素
pub fn visible(x: usize, y: usize) -> bool {
    let dx = x as f32 + 0.5 - W as f32 / 2.0;
    let dy = y as f32 + 0.5 - H as f32 / 2.0;
    dx * dx + dy * dy <= (W as f32 / 2.0) * (W as f32 / 2.0)
}

impl Gc9a01 {
    pub fn new() -> Self {
        Self::default()
    }

    /// 硬件复位（RST 拉低）或 SWRESET：寄存器回到默认值，睡眠、显示关；显存内容保留（真机为不确定值）
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

    /// RST 脚电平（低有效）。拉低的那一刻复位
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

    /// 片选期间收到一个字节；dc = D/C 脚电平（1 = 数据）
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
            // RAMWRC：从上次写到的位置接着写
            0x3c => {}
            0x2a | 0x2b | 0x36 | 0x3a => {}
            // NORON / IDMOFF / IDMON / TEOFF / TEON：不影响画面
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

    /// 每像素字节数：COLMOD 低 3 位 5 = 16 位 RGB565，6 = 18 位（每色一字节，取高 6 位）
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
            // 5/6/5 位扩展到 8 位：高位复制到低位
            let r = (v >> 11) & 0x1f;
            let g = (v >> 5) & 0x3f;
            let bl = v & 0x1f;
            ((r << 3 | r >> 2) << 16) | ((g << 2 | g >> 4) << 8) | (bl << 3 | bl >> 2)
        } else {
            ((self.pix[0] as u32 & 0xfc) << 16)
                | ((self.pix[1] as u32 & 0xfc) << 8)
                | (self.pix[2] as u32 & 0xfc)
        };
        // MADCTL：MV（行列互换）→ MX（列反向）→ MY（行反向），把窗口坐标换成显存坐标
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
        // 窗口内按列推进，到右边界换行，到底回到窗口起点
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

    /// 观察者看到的画面：240×240 RGBA。圆外透明；睡眠 / 显示关 / 背光灭时圆内全黑。
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
                // 常黑 IPS 面板：INVON 时才是原色
                if !self.inverted {
                    c ^= 0xff_ffff;
                }
                let (mut r, g, mut b) = ((c >> 16) as u8, (c >> 8) as u8, c as u8);
                // 子像素 BGR 排列：控制器不换序（BGR=0）时红蓝互换
                if !bgr {
                    std::mem::swap(&mut r, &mut b);
                }
                let px = if lit { [r, g, b, 255] } else { [0, 0, 0, 255] };
                self.frame[o..o + 4].copy_from_slice(&px);
            }
        }
        &self.frame
    }

    /// 圆形可视区内非黑像素数
    pub fn lit_pixels(&mut self) -> usize {
        self.render()
            .chunks(4)
            .filter(|p| p[3] != 0 && (p[0] | p[1] | p[2]) != 0)
            .count()
    }

    /// 观察记录里的颜色统计：圆形可视区内每种非黑颜色的像素数与重心，取像素数最多的前 12 种
    /// （且 ≥ 50 像素，过滤零星噪点）。检查点用它判"画了什么颜色、画在哪"（levels.json 的 lcd_colors）。
    /// 命令行与 wasm 的观察记录都调这一个函数，逐字节一致才能对指纹。
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
        // 像素数从多到少，同数按颜色值排，保证顺序确定
        v.sort_by(|a, b| b.1 .0.cmp(&a.1 .0).then(a.0.cmp(&b.0)));
        let mut o = String::new();
        for (c, (n, sx, sy)) in v.into_iter().take(12) {
            let _ = writeln!(o, "[tryboard] LCD 颜色 #{c:06x} {n} 像素，重心 {:.1},{:.1}", sx as f64 / n as f64, sy as f64 / n as f64);
        }
        o
    }

    /// 显示是否开着（DISPON 且退出睡眠）
    pub fn showing(&self) -> bool {
        self.display_on && !self.sleep
    }

    /// 二进制 PPM（P6），圆外为黑
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
        send(&mut d, 0xef, &[]); // 厂商命令
        send(&mut d, 0x11, &[]);
        send(&mut d, 0x36, &[0x08]); // BGR
        send(&mut d, 0x3a, &[0x05]);
        send(&mut d, 0x21, &[]);
        send(&mut d, 0x29, &[]);
        // 中心 2×2 窗口写红色（RGB565 0xF800）
        send(&mut d, 0x2a, &[0, 119, 0, 120]);
        send(&mut d, 0x2b, &[0, 119, 0, 120]);
        send(&mut d, 0x2c, &[0xf8, 0, 0xf8, 0, 0xf8, 0, 0xf8, 0]);
        assert_eq!(d.vendor_cmds, 1);
        assert_eq!(d.lit_pixels(), 4);
        let f = d.render();
        let o = (120 * W + 120) * 4;
        assert_eq!(&f[o..o + 4], &[255, 0, 0, 255]);
        // 角落在圆外：透明
        assert_eq!(f[3], 0);
        // 不开反色：其余黑色像素在常黑面板上显示成白
        send(&mut d, 0x20, &[]);
        assert!(d.lit_pixels() > 40000);
        // 显示关：全黑
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
        // 窗口只有一行两列：第三个像素回到窗口起点
        assert_eq!(d.gram[20 * W + 10], 0xffffff);
        assert_eq!(d.pixels, 3);
        // 复位脚：拉低期间忽略总线
        d.set_reset(true);
        send(&mut d, 0x29, &[]);
        assert!(!d.display_on);
    }
}
