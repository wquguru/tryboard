//! 外设输入端的毛刺滤波（PCNT、RMT 接收共用）。
//!
//! 硬件滤波器的效果是"电平稳定满 N 个时钟才认"：输出比输入晚 N 个时钟，短于 N 的脉冲整个被吞掉。
//! 这里按事件惰性实现：输入跳变先挂起，到期（跳变时刻 + 门限）还没被反向跳变取消就提交。
//! 两个沿都晚同样的时间，所以脉宽不变——RMT 接收量出来的时长与没开滤波时一致。

#[derive(Clone, Copy, Debug, Default)]
pub struct Deglitch {
    /// 滤波后的电平（外设看到的）
    pub level: bool,
    /// 引脚上的原始电平与它最近一次跳变的时刻
    raw: bool,
    raw_t: u64,
}

impl Deglitch {
    pub fn new(level: bool) -> Deglitch {
        Deglitch { level, raw: level, raw_t: 0 }
    }

    /// 挂起的跳变何时生效（没有挂起的为 None）
    pub fn due(&self, thres: u64) -> Option<u64> {
        (self.raw != self.level).then_some(self.raw_t + thres)
    }

    /// 到 now 为止该生效的挂起跳变：生效就返回 (生效时刻, 新电平)
    pub fn flush(&mut self, now: u64, thres: u64) -> Option<(u64, bool)> {
        let t = self.due(thres)?;
        if t > now {
            return None;
        }
        self.level = self.raw;
        Some((t, self.level))
    }

    /// 时刻 t 原始电平为 raw（调用方保证先 flush 到 t）。门限为 0 时立即生效并返回
    pub fn input(&mut self, t: u64, raw: bool, thres: u64) -> Option<(u64, bool)> {
        if raw == self.raw {
            return None;
        }
        self.raw = raw;
        self.raw_t = t;
        if thres == 0 && raw != self.level {
            self.level = raw;
            return Some((t, raw));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_pulse_swallowed_long_pulse_delayed() {
        let mut d = Deglitch::new(false);
        // 50 周期的毛刺，门限 100：被吞掉
        assert_eq!(d.input(1000, true, 100), None);
        assert_eq!(d.flush(1049, 100), None);
        assert_eq!(d.input(1050, false, 100), None);
        assert_eq!(d.flush(2000, 100), None);
        assert!(!d.level);
        // 500 周期的脉冲：两个沿都晚 100
        d.input(3000, true, 100);
        assert_eq!(d.flush(3500, 100), Some((3100, true)));
        d.input(3500, false, 100);
        assert_eq!(d.flush(4000, 100), Some((3600, false)));
        // 门限 0：立即生效
        assert_eq!(d.input(5000, true, 0), Some((5000, true)));
    }
}
