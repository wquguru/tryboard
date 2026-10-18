//! FT6236 自容触摸控制器（I2C 0x38），3.5″ 320×480 一类电容触摸屏上常见的那颗（FocalTech FT6x36 系列）。
//! 寄存器按 FocalTech《FT6x36 Datasheet》与《FT6x06/FT6x36 Application Note》：
//! 0x00 DEV_MODE（0 = 工作模式）、0x01 GEST_ID、0x02 TD_STATUS（低 4 位 = 触点数 0..2）、
//! 0x03 P1_XH（[7:6] 事件：0 按下、1 抬起、2 接触、3 无事件；[3:0] X 高 4 位）、0x04 P1_XL、
//! 0x05 P1_YH（[7:4] 触点 ID；[3:0] Y 高 4 位）、0x06 P1_YL、0x07 P1_WEIGHT、0x08 P1_MISC（[7:4] 面积）、
//! 0x09..0x0E 第二个触点（同上）、0x80 TH_GROUP、0x86 CTRL、0x88 PERIODACTIVE、0xA1/0xA2 LIB_VER、
//! 0xA3 CIPHER（芯片 ID：0x36 = FT6236）、0xA4 G_MODE（0 轮询、1 触发）、0xA5 PWR_MODE、0xA6 FIRMID、
//! 0xA8 FOCALTECH_ID（0x11）、0xAF RELEASE_CODE。读写自动递增（驱动一般从 0x00 或 0x02 起连读）。
//!
//! 只模拟一根手指：第二个触点区恒为"无事件"。坐标 12 位，不按某块屏的分辨率截断（屏多大由模组决定）。
//! 手势：FT6x36 的 GEST_ID 在多数模组固件里不报（恒 0），这里也恒为 0，手势交给主机自己判。
//! INT 由 Machine 驱动：按着时拉低、抬起回高（G_MODE = 0 轮询模式的电平行为；写成 1 触发模式时真机按扫描周期出低脉冲，
//! 这里不区分、不模拟脉冲宽度——"下降沿中断"和"低电平期间轮询"两种写法都能用）。
//! 没做：休眠 / 唤醒（PWR_MODE 写 3 后真机 I2C 不应答，要靠 RST 唤醒）、多点、按压权重 / 面积随手指变化。

use crate::i2c::I2cDevice;
use std::any::Any;

pub const CHIP_ID: u8 = 0x36;
pub const FOCALTECH_ID: u8 = 0x11;

pub struct Ft6236 {
    pub addr: u8,
    regs: [u8; 256],
    ptr: u8,
    expect_reg: bool,
    /// 按着：(当前 x, y)
    touch: Option<(u16, u16)>,
    /// 按下以后还没被读到过一次（事件位报"按下"，之后报"接触"）
    fresh: bool,
    pub presses: u64,
    pub reads: u64,
}

impl Ft6236 {
    pub fn new(addr: u8) -> Self {
        let mut regs = [0u8; 256];
        // 两个触点区都是"无事件"、ID 0xF（无效）
        regs[0x03] = 0xc0;
        regs[0x05] = 0xf0;
        regs[0x09] = 0xc0;
        regs[0x0b] = 0xf0;
        regs[0x80] = 0x16; // TH_GROUP：出厂触摸阈值（模组固件决定，取常见值）
        regs[0x88] = 0x0e; // PERIODACTIVE：工作模式扫描周期
        regs[0xa1] = 0x30; // LIB_VER_H / L
        regs[0xa2] = 0x03;
        regs[0xa3] = CHIP_ID;
        // G_MODE：0 = 轮询模式（按着期间 INT 保持低），与这里模拟的 INT 行为一致；出厂默认值随模组固件，待真机核对
        regs[0xa4] = 0x00;
        regs[0xa6] = 0x10; // FIRMID
        regs[0xa8] = FOCALTECH_ID;
        regs[0xaf] = 0x01;
        Ft6236 {
            addr,
            regs,
            ptr: 0,
            expect_reg: false,
            touch: None,
            fresh: false,
            presses: 0,
            reads: 0,
        }
    }

    pub fn touching(&self) -> bool {
        self.touch.is_some()
    }

    /// 手指按下 / 移动（坐标 12 位）
    pub fn press(&mut self, x: u16, y: u16) {
        let (x, y) = (x.min(0xfff), y.min(0xfff));
        if self.touch.is_none() {
            self.fresh = true;
            self.presses += 1;
        }
        self.touch = Some((x, y));
        self.latch();
    }

    /// 手指抬起：触点数清零，事件位报"抬起"，坐标保留最后一次
    pub fn release(&mut self) {
        if self.touch.take().is_none() {
            return;
        }
        self.regs[0x02] = 0;
        self.regs[0x03] = (self.regs[0x03] & 0x0f) | 0x40;
    }

    fn latch(&mut self) {
        let Some((x, y)) = self.touch else { return };
        let ev = if self.fresh { 0x00 } else { 0x80 };
        self.regs[0x02] = 1;
        self.regs[0x03] = ev | (x >> 8) as u8;
        self.regs[0x04] = x as u8;
        self.regs[0x05] = (y >> 8) as u8; // 触点 ID 0
        self.regs[0x06] = y as u8;
        self.regs[0x07] = 0x20;
        self.regs[0x08] = 0x10;
    }
}

impl I2cDevice for Ft6236 {
    fn address(&self) -> u8 {
        self.addr
    }
    fn start(&mut self, read: bool) -> bool {
        self.expect_reg = !read;
        if read {
            self.reads += 1;
        }
        true
    }
    fn write(&mut self, b: u8) -> bool {
        if self.expect_reg {
            self.ptr = b;
            self.expect_reg = false;
        } else {
            // 0x00 与 0x80 起的配置区可写；0x01..0x0E 报告区和 0xA1.. 的 ID 区只读
            if self.ptr == 0x00
                || (0x80..0xa0).contains(&self.ptr)
                || (0xa4..=0xa5).contains(&self.ptr)
            {
                self.regs[self.ptr as usize] = b;
            }
            self.ptr = self.ptr.wrapping_add(1);
        }
        true
    }
    fn read(&mut self) -> u8 {
        let v = self.regs[self.ptr as usize];
        if self.ptr == 0x03 && self.touch.is_some() && self.fresh {
            // 主机读到过"按下"之后就报"接触"
            self.fresh = false;
            self.regs[0x03] = (self.regs[0x03] & 0x0f) | 0x80;
        }
        self.ptr = self.ptr.wrapping_add(1);
        v
    }
    fn stop(&mut self) {}
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rd(d: &mut Ft6236, reg: u8, n: usize) -> Vec<u8> {
        d.start(false);
        d.write(reg);
        d.start(true);
        (0..n).map(|_| d.read()).collect()
    }

    #[test]
    fn ids_and_report() {
        let mut d = Ft6236::new(0x38);
        assert_eq!(rd(&mut d, 0xa3, 1), [0x36]);
        assert_eq!(rd(&mut d, 0xa8, 1), [0x11]);
        // 没按：触点数 0，事件"无"
        assert_eq!(rd(&mut d, 0x02, 2), [0, 0xc0]);
        // 按下 (300, 450)：12 位坐标拆成高 4 位 + 低 8 位
        d.press(300, 450);
        assert_eq!(
            rd(&mut d, 0x00, 7),
            [0, 0, 1, 0x01, (300 & 0xff) as u8, 0x01, (450 & 0xff) as u8]
        );
        // 第二次读：事件变"接触"
        assert_eq!(rd(&mut d, 0x03, 1)[0] >> 6, 2);
        d.press(310, 440);
        assert_eq!(
            rd(&mut d, 0x03, 4),
            [0x81, (310 & 0xff) as u8, 0x01, (440 & 0xff) as u8]
        );
        d.release();
        let r = rd(&mut d, 0x02, 2);
        assert_eq!((r[0], r[1] >> 6), (0, 1));
        // 再按：又是"按下"
        d.press(5, 6);
        assert_eq!(rd(&mut d, 0x03, 1)[0] >> 6, 0);
        // 写 G_MODE / 阈值能读回，ID 区写不进
        d.start(false);
        d.write(0xa3);
        d.write(0x00);
        d.write(0x01);
        assert_eq!(rd(&mut d, 0xa3, 2), [0x36, 0x01]);
        d.start(false);
        d.write(0x80);
        d.write(0x28);
        assert_eq!(rd(&mut d, 0x80, 1), [0x28]);
    }
}
