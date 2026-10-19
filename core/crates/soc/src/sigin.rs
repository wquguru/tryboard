//! Glitch filter on peripheral inputs (shared by PCNT and RMT RX). The hardware only accepts a level stable for N clocks,
//! so output lags input by N and shorter pulses vanish. Lazy here: a pending edge commits at (edge + threshold) unless
//! cancelled by an opposite edge. Both edges lag equally, so pulse width (what RMT RX measures) is unchanged. (lint: allow-long-comment)

#[derive(Clone, Copy, Debug, Default)]
pub struct Deglitch {
    /// Filtered level (what the peripheral sees)
    pub level: bool,
    /// Raw pin level and the time of its last edge
    raw: bool,
    raw_t: u64,
}

impl Deglitch {
    pub fn new(level: bool) -> Deglitch {
        Deglitch {
            level,
            raw: level,
            raw_t: 0,
        }
    }

    /// When the pending edge takes effect (None if none pending)
    pub fn due(&self, thres: u64) -> Option<u64> {
        (self.raw != self.level).then_some(self.raw_t + thres)
    }

    /// Pending edge due by now: returns (effective time, new level) if it commits
    pub fn flush(&mut self, now: u64, thres: u64) -> Option<(u64, bool)> {
        let t = self.due(thres)?;
        if t > now {
            return None;
        }
        self.level = self.raw;
        Some((t, self.level))
    }

    /// Raw level is raw at time t (caller flushes up to t first). With threshold 0 it commits immediately and is returned
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
        // 50-cycle glitch, threshold 100: swallowed
        assert_eq!(d.input(1000, true, 100), None);
        assert_eq!(d.flush(1049, 100), None);
        assert_eq!(d.input(1050, false, 100), None);
        assert_eq!(d.flush(2000, 100), None);
        assert!(!d.level);
        // 500-cycle pulse: both edges delayed by 100
        d.input(3000, true, 100);
        assert_eq!(d.flush(3500, 100), Some((3100, true)));
        d.input(3500, false, 100);
        assert_eq!(d.flush(4000, 100), Some((3600, false)));
        // Threshold 0: immediate
        assert_eq!(d.input(5000, true, 0), Some((5000, true)));
    }
}
