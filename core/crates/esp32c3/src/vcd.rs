//! Fine logic-analyzer capture (D-04): every edge of chosen pins inside a time window, stamped in CPU cycles, written as
//! VCD. CLI `--vcd` and the web "export VCD" both call `text()`, so the files are byte-identical for the same run.
//! Timescale 1 ps, time = cycles x 6250 (exact at the 160 MHz CPU clock); absolute run time, not window-relative. (lint: allow-long-comment)

use crate::periph::CPU_HZ;

/// Edge buffer cap (about 16 MB). When full, later edges are dropped and counted: the window start stays correct
pub const VCD_CAP: usize = 1 << 20;

/// Picoseconds per CPU cycle
pub const PS_PER_CYCLE: u64 = 1_000_000_000_000 / CPU_HZ;

#[derive(Clone, Debug)]
pub struct VcdCapture {
    /// Captured pins (bit = pin)
    pub mask: u64,
    /// Window [t0, t1] in cycles
    pub t0: u64,
    pub t1: u64,
    /// Levels of all pins at t0 (taken at the first change at or after t0)
    init: Option<u64>,
    /// (cycle, pin, level)
    pub edges: Vec<(u64, u8, u8)>,
    pub cap: usize,
    pub dropped: u64,
    /// Armed: the window opens at the first edge of a captured pin at or after t0 and lasts this many cycles
    pub arm: Option<u64>,
}

impl VcdCapture {
    pub fn new(mask: u64, t0: u64, t1: u64) -> VcdCapture {
        VcdCapture {
            mask,
            t0,
            t1: t1.max(t0),
            init: None,
            edges: Vec::new(),
            cap: VCD_CAP,
            dropped: 0,
            arm: None,
        }
    }

    /// Triggered capture: wait from `from` for the next edge on a captured pin, then keep `len` cycles
    pub fn armed(mask: u64, from: u64, len: u64) -> VcdCapture {
        VcdCapture {
            t1: u64::MAX,
            arm: Some(len),
            ..VcdCapture::new(mask, from, from)
        }
    }

    /// Window start / end from seconds (rounded to the nearest cycle)
    pub fn cycles_of(s: f64) -> u64 {
        (s.max(0.0) * CPU_HZ as f64).round() as u64
    }

    /// All pin levels go from `prev` to `level` at `now`
    #[inline]
    pub fn on_gpio(&mut self, now: u64, prev: u64, level: u64) {
        if now < self.t0 || now > self.t1 {
            return;
        }
        if let Some(len) = self.arm {
            if (prev ^ level) & self.mask == 0 {
                return;
            }
            self.t0 = now;
            self.t1 = now.saturating_add(len);
            self.arm = None;
        }
        if self.init.is_none() {
            self.init = Some(prev);
        }
        let mut d = (prev ^ level) & self.mask;
        while d != 0 {
            let pin = d.trailing_zeros();
            d &= d - 1;
            if self.edges.len() >= self.cap {
                self.dropped += 1;
                continue;
            }
            self.edges.push((now, pin as u8, (level >> pin & 1) as u8));
        }
    }

    /// VCD text. `now_level` = current pin levels (initial values when nothing changed since t0), `now` = current cycle
    pub fn text(&self, now_level: u64, now: u64) -> String {
        let pins: Vec<u32> = (0..64).filter(|p| self.mask >> p & 1 != 0).collect();
        let id = |i: usize| ((b'!' + i as u8) as char).to_string();
        let init = self.init.unwrap_or(now_level);
        let mut s = String::new();
        s.push_str("$version TryBoard $end\n");
        s.push_str("$comment time unit 1 ps; one CPU cycle = 6250 ps (160 MHz) $end\n");
        s.push_str("$timescale 1 ps $end\n");
        s.push_str("$scope module tryboard $end\n");
        for (i, p) in pins.iter().enumerate() {
            s.push_str(&format!("$var wire 1 {} GPIO{p} $end\n", id(i)));
        }
        s.push_str("$upscope $end\n$enddefinitions $end\n");
        s.push_str(&format!("#{}\n$dumpvars\n", self.t0 * PS_PER_CYCLE));
        for (i, p) in pins.iter().enumerate() {
            s.push_str(&format!("{}{}\n", init >> p & 1, id(i)));
        }
        s.push_str("$end\n");
        let mut last = u64::MAX;
        for &(t, pin, lv) in &self.edges {
            if t != last {
                s.push_str(&format!("#{}\n", t * PS_PER_CYCLE));
                last = t;
            }
            let i = pins.iter().position(|&p| p == pin as u32).unwrap_or(0);
            s.push_str(&format!("{lv}{}\n", id(i)));
        }
        // Window end (or the current time if the run stopped before it)
        let end = self.t1.min(now.max(self.t0));
        if end != last {
            s.push_str(&format!("#{}\n", end * PS_PER_CYCLE));
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vcd_header_and_edges() {
        let mut v = VcdCapture::new(1 << 5 | 1 << 4, 100, 3000);
        v.on_gpio(50, 0, 1 << 5);
        v.on_gpio(200, 1 << 5, 0);
        v.on_gpio(200 + 320, 0, 1 << 5 | 1 << 4);
        v.on_gpio(2000, 1 << 5 | 1 << 4, 1 << 4);
        v.on_gpio(4000, 1 << 4, 0);
        let t = v.text(0, 5000);
        let want = "$version TryBoard $end\n\
$comment time unit 1 ps; one CPU cycle = 6250 ps (160 MHz) $end\n\
$timescale 1 ps $end\n$scope module tryboard $end\n\
$var wire 1 ! GPIO4 $end\n$var wire 1 \" GPIO5 $end\n$upscope $end\n$enddefinitions $end\n\
#625000\n$dumpvars\n0!\n1\"\n$end\n#1250000\n0\"\n";
        assert!(t.starts_with(want), "{t}");
        // 320 cycles later = 2 µs; the edge after the window end is left out, the window end is marked
        assert!(
            t.ends_with("#1250000\n0\"\n#3250000\n1!\n1\"\n#12500000\n0\"\n#18750000\n"),
            "{t}"
        );
        assert_eq!(PS_PER_CYCLE * 4320, 27_000_000);
        v.cap = 4;
        v.on_gpio(900, 0, 1 << 4);
        assert_eq!(v.dropped, 1);
        // Armed: other pins do not open the window, the first GPIO5 edge does
        let mut a = VcdCapture::armed(1 << 5, 100, 1000);
        a.on_gpio(50, 0, 1 << 5);
        a.on_gpio(150, 1 << 5, 1 << 5 | 1 << 4);
        assert_eq!((a.t0, a.arm), (100, Some(1000)));
        a.on_gpio(300, 1 << 5 | 1 << 4, 1 << 4);
        a.on_gpio(1400, 1 << 4, 1 << 5);
        assert_eq!((a.t0, a.t1, a.edges.len()), (300, 1300, 1));
        assert!(a
            .text(0, 2000)
            .contains("#1875000\n$dumpvars\n1!\n$end\n#1875000\n0!\n#8125000\n"));
    }
}
