//! CST816S 自容触摸控制器（I2C 0x15），微雪 1.28″ 圆屏触摸板（GC9A01 + CST816S）上的那颗。
//! 寄存器按海栎创《CST816S 寄存器说明》：0x01 GestureID、0x02 FingerNum、0x03/0x04 X（0x03 高 2 位是事件：
//! 0 按下、1 抬起、2 接触）、0x05/0x06 Y、0xA7 ChipID（0xB5）、0xA8 ProjID、0xA9 FwVersion，
//! 0xEC–0xFE 配置寄存器（MotionMask、IrqPluseWidth、IrqCtl、AutoSleepTime、DisAutoSleep……）只存不解释。读写自动递增。
//!
//! 手势在芯片里判：按下后位移超过 30 像素算滑动（0x01 上、0x02 下、0x03 左、0x04 右，按主方向），
//! 不动且按住满 1 秒报长按 0x0C，抬起时没动过就是单击 0x05；新的一次按下清掉上一个手势。
//! INT 引脚由 Machine 驱动：手指按着时拉低、抬起后回高（真机在按住期间按扫描周期发低脉冲，
//! 这里简化成电平，下降沿和"低电平期间轮询"两种驱动写法都能用）。
//! 没做：自动睡眠（真机无触摸约数秒后睡眠、I2C 不应答，要靠 TP_RST 或触摸唤醒——只能上真机确认）、双击、TP_RST 引脚。

use crate::i2c::I2cDevice;
use crate::periph::CPU_HZ;
use std::any::Any;

pub const CHIP_ID: u8 = 0xb5;
const SWIPE_PX: i32 = 30;

pub mod gesture {
    pub const NONE: u8 = 0x00;
    pub const UP: u8 = 0x01;
    pub const DOWN: u8 = 0x02;
    pub const LEFT: u8 = 0x03;
    pub const RIGHT: u8 = 0x04;
    pub const CLICK: u8 = 0x05;
    pub const LONG: u8 = 0x0c;
}

pub struct Cst816s {
    pub addr: u8,
    regs: [u8; 256],
    ptr: u8,
    expect_reg: bool,
    now: u64,
    /// 按着：(当前 x, y)
    touch: Option<(u16, u16)>,
    /// 这次按下的起点和时刻
    down_at: (u16, u16, u64),
    moved: bool,
    /// 按下以后还没被读到过一次（事件位报"按下"，之后报"接触"）
    fresh: bool,
    pub presses: u64,
    pub reads: u64,
}

impl Cst816s {
    pub fn new(addr: u8) -> Self {
        let mut regs = [0u8; 256];
        regs[0xa7] = CHIP_ID;
        regs[0xa8] = 0x00;
        regs[0xa9] = 0x01;
        regs[0xec] = 0x00;
        regs[0xed] = 10; // IrqPluseWidth：10 × 0.1 ms
        regs[0xee] = 1;
        regs[0xfa] = 0x60; // IrqCtl：EnTouch | EnChange
        regs[0xfb] = 2;
        Cst816s {
            addr,
            regs,
            ptr: 0,
            expect_reg: false,
            now: 0,
            touch: None,
            down_at: (0, 0, 0),
            moved: false,
            fresh: false,
            presses: 0,
            reads: 0,
        }
    }

    pub fn touching(&self) -> bool {
        self.touch.is_some()
    }

    /// 手指按下 / 移动（now = 当前 CPU 周期）
    pub fn press(&mut self, x: u16, y: u16, now: u64) {
        let (x, y) = (x.min(239), y.min(239));
        if self.touch.is_none() {
            self.down_at = (x, y, now);
            self.moved = false;
            self.fresh = true;
            self.presses += 1;
            self.regs[0x01] = gesture::NONE;
        }
        self.touch = Some((x, y));
        let dx = x as i32 - self.down_at.0 as i32;
        let dy = y as i32 - self.down_at.1 as i32;
        if dx.abs() > SWIPE_PX || dy.abs() > SWIPE_PX {
            self.moved = true;
            // 屏幕坐标 y 向下：手指往上划 = y 变小
            self.regs[0x01] = if dx.abs() > dy.abs() {
                if dx > 0 {
                    gesture::RIGHT
                } else {
                    gesture::LEFT
                }
            } else if dy < 0 {
                gesture::UP
            } else {
                gesture::DOWN
            };
        }
        self.latch(now);
    }

    /// 手指抬起
    pub fn release(&mut self, now: u64) {
        if self.touch.take().is_none() {
            return;
        }
        self.now = now;
        if !self.moved {
            self.regs[0x01] = if now.saturating_sub(self.down_at.2) >= CPU_HZ {
                gesture::LONG
            } else {
                gesture::CLICK
            };
        }
        self.regs[0x02] = 0;
        self.regs[0x03] = (self.regs[0x03] & 0x0f) | 0x40; // 事件 = 抬起
    }

    /// 刷新手势（长按要看时间）和坐标寄存器
    fn latch(&mut self, now: u64) {
        self.now = now;
        let Some((x, y)) = self.touch else { return };
        if !self.moved && now.saturating_sub(self.down_at.2) >= CPU_HZ {
            self.regs[0x01] = gesture::LONG;
        }
        let ev = if self.fresh { 0x00 } else { 0x80 };
        self.regs[0x02] = 1;
        self.regs[0x03] = ev | ((x >> 8) as u8 & 0x0f);
        self.regs[0x04] = x as u8;
        self.regs[0x05] = (y >> 8) as u8 & 0x0f;
        self.regs[0x06] = y as u8;
    }
}

impl I2cDevice for Cst816s {
    fn address(&self) -> u8 {
        self.addr
    }
    fn set_time(&mut self, now: u64) {
        self.latch(now);
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
            // 0x00..0x06 是报告区（只读），其它按配置寄存器保存
            if self.ptr >= 0xec {
                self.regs[self.ptr as usize] = b;
            }
            self.ptr = self.ptr.wrapping_add(1);
        }
        true
    }
    fn read(&mut self) -> u8 {
        let v = self.regs[self.ptr as usize];
        if self.ptr == 0x03 && self.touch.is_some() {
            // 主机读到过"按下"之后就报"接触"
            self.fresh = false;
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

    fn rd(d: &mut Cst816s, reg: u8, n: usize, now: u64) -> Vec<u8> {
        d.set_time(now);
        d.start(false);
        d.write(reg);
        d.start(true);
        (0..n).map(|_| d.read()).collect()
    }

    #[test]
    fn report_and_gestures() {
        let mut d = Cst816s::new(0x15);
        assert_eq!(rd(&mut d, 0xa7, 1, 0), [0xb5]);
        assert_eq!(rd(&mut d, 0x01, 6, 0), [0, 0, 0, 0, 0, 0]);
        d.press(200, 37, 100);
        assert_eq!(rd(&mut d, 0x01, 6, 200), [0, 1, 0x00, 200, 0, 37]);
        // 第二次读：事件变"接触"
        assert_eq!(rd(&mut d, 0x03, 1, 300)[0] >> 6, 2);
        d.release(400);
        let r = rd(&mut d, 0x01, 3, 500);
        assert_eq!((r[0], r[1], r[2] >> 6), (gesture::CLICK, 0, 1));
        // 往左划
        d.press(150, 120, 1000);
        d.press(90, 125, 2000);
        d.release(3000);
        assert_eq!(rd(&mut d, 0x01, 1, 3100), [gesture::LEFT]);
        // 长按 1 秒
        d.press(120, 120, 10_000);
        assert_eq!(rd(&mut d, 0x01, 1, 10_000 + CPU_HZ), [gesture::LONG]);
        d.release(20_000 + CPU_HZ);
        assert_eq!(rd(&mut d, 0x01, 1, 30_000 + CPU_HZ), [gesture::LONG]);
    }
}
