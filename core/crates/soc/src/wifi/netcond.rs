//! Network conditions (D-01): presets (normal / weak / flaky / offline) and scheduled faults (router reboot,
//! DNS failure, silent server), all keyed to simulated time. Random choices come from a PRNG seeded by the run seed,
//! so `--inputs` replays reproduce every lost frame. Normal with no faults never draws and changes nothing.

/// Network stream of the run seed (DECISIONS 2026-10-19 D batch: `seed ^ 0x4E45_5400`)
pub const SEED_XOR: u32 = 0x4E45_5400;
pub const DEFAULT_SEED: u32 = 7;
/// Default fault length (s) when the action gives none
pub const DEFAULT_FAULT_S: f64 = 8.0;
/// Signal of every AP under the weak preset (dBm): right at the link threshold
pub const WEAK_DBM: i8 = -82;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Preset {
    #[default]
    Normal,
    Weak,
    Flaky,
    Offline,
}

impl Preset {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s.trim() {
            "normal" => Preset::Normal,
            "weak" => Preset::Weak,
            "flaky" => Preset::Flaky,
            "offline" => Preset::Offline,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Preset::Normal => "normal",
            Preset::Weak => "weak",
            Preset::Flaky => "flaky",
            Preset::Offline => "offline",
        }
    }

    /// Network-tab label (English token, translated by the web)
    pub fn label(self) -> &'static str {
        match self {
            Preset::Normal => "Normal",
            Preset::Weak => "Weak signal",
            Preset::Flaky => "Flaky",
            Preset::Offline => "Offline",
        }
    }

    /// Frame loss per mille on the chip -> AP direction
    fn loss_permille(self) -> u64 {
        match self {
            Preset::Weak => 100,
            Preset::Flaky => 50,
            _ => 0,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FaultKind {
    Reboot,
    Dns,
    Silent,
}

impl FaultKind {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s.trim() {
            "reboot" => FaultKind::Reboot,
            "dns" => FaultKind::Dns,
            "silent" => FaultKind::Silent,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            FaultKind::Reboot => "reboot",
            FaultKind::Dns => "dns",
            FaultKind::Silent => "silent",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            FaultKind::Reboot => "Router reboot",
            FaultKind::Dns => "DNS failure",
            FaultKind::Silent => "Server not responding",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    Pending,
    Active,
    Over,
}

#[derive(Clone, Debug)]
pub struct Fault {
    pub kind: FaultKind,
    pub start_us: u64,
    pub end_us: u64,
    /// Drawn by the flaky preset (not asked for by the user)
    pub auto: bool,
    phase: Phase,
}

/// A fault boundary crossed by `advance` (the world turns it into AP state changes and network-tab rows)
#[derive(Clone, Debug)]
pub enum Change {
    Start(Fault),
    End(Fault),
}

#[derive(Clone, Default, Debug)]
pub struct Stats {
    /// Times the AP lost the station (fault / offline / station deauth while conditions are active)
    pub disconnects: u32,
    /// Since when the station is off the network (None = connected or never connected)
    pub lost_at: Option<u64>,
    /// Reconnect durations (us): loss -> next DHCP ACK
    pub reconnects: Vec<u64>,
    /// Chip frames the AP "did not hear" because of the preset
    pub lost_frames: u64,
}

#[derive(Clone, Debug)]
pub struct NetCond {
    pub preset: Preset,
    pub seed: u32,
    rng: u64,
    pub faults: Vec<Fault>,
    /// Flaky preset: when the next random drop starts
    next_drop_us: Option<u64>,
    /// Latest delivery time handed out under latency (keeps downlink frames in order)
    last_rx_us: u64,
    pub stats: Stats,
    /// Bumped on every visible change (preset, fault, stats): the web refetches when it moves
    pub rev: u64,
}

impl Default for NetCond {
    fn default() -> Self {
        let mut c = NetCond {
            preset: Preset::Normal,
            seed: DEFAULT_SEED,
            rng: 0,
            faults: Vec::new(),
            next_drop_us: None,
            last_rx_us: 0,
            stats: Stats::default(),
            rev: 0,
        };
        c.set_seed(DEFAULT_SEED);
        c
    }
}

impl NetCond {
    /// Anything other than the untouched default: only then are rows, stats and summary produced
    pub fn active(&self) -> bool {
        self.preset != Preset::Normal || !self.faults.is_empty()
    }

    pub fn set_seed(&mut self, seed: u32) {
        self.seed = seed;
        // splitmix64 of the network stream, never zero (xorshift would stick at 0)
        let mut z = (seed ^ SEED_XOR) as u64 ^ 0x9E37_79B9_7F4A_7C15;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        self.rng = (z ^ (z >> 31)) | 1;
    }

    fn next(&mut self) -> u64 {
        // xorshift64*
        let mut x = self.rng;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.rng = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11
    }

    /// Uniform in [lo, hi]
    fn uniform(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next() % (hi - lo + 1)
    }

    pub fn set_preset(&mut self, p: Preset, now_us: u64) {
        self.preset = p;
        self.next_drop_us = None;
        if p == Preset::Flaky {
            self.next_drop_us = Some(now_us + self.uniform(40_000_000, 90_000_000));
        }
        self.rev += 1;
    }

    pub fn add_fault(&mut self, kind: FaultKind, start_us: u64, dur_us: u64) {
        self.faults.push(Fault {
            kind,
            start_us,
            end_us: start_us + dur_us.max(1),
            auto: false,
            phase: Phase::Pending,
        });
        self.rev += 1;
    }

    /// Next time `advance` has work (TSF us)
    pub fn next_boundary(&self) -> Option<u64> {
        let f = self
            .faults
            .iter()
            .filter_map(|f| match f.phase {
                Phase::Pending => Some(f.start_us),
                Phase::Active => Some(f.end_us),
                Phase::Over => None,
            })
            .min();
        match (f, self.next_drop_us) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// Cross every boundary up to now: flaky drops become reboot faults, faults start / end
    pub fn advance(&mut self, now_us: u64) -> Vec<Change> {
        let mut out = Vec::new();
        while let Some(t) = self.next_drop_us.filter(|t| *t <= now_us) {
            let dur = self.uniform(3_000_000, 8_000_000);
            self.faults.push(Fault {
                kind: FaultKind::Reboot,
                start_us: t,
                end_us: t + dur,
                auto: true,
                phase: Phase::Pending,
            });
            self.next_drop_us = Some(t + dur + self.uniform(40_000_000, 90_000_000));
        }
        // Process boundaries in time order so a start and end crossed together come out in sequence
        loop {
            let pick = self
                .faults
                .iter()
                .enumerate()
                .filter_map(|(i, f)| match f.phase {
                    Phase::Pending if f.start_us <= now_us => Some((f.start_us, i)),
                    Phase::Active if f.end_us <= now_us => Some((f.end_us, i)),
                    _ => None,
                })
                .min();
            let Some((_, i)) = pick else { break };
            let f = &mut self.faults[i];
            if f.phase == Phase::Pending {
                f.phase = Phase::Active;
                out.push(Change::Start(f.clone()));
            } else {
                f.phase = Phase::Over;
                out.push(Change::End(f.clone()));
            }
        }
        if !out.is_empty() {
            self.rev += 1;
        }
        out
    }

    fn on(&self, kind: FaultKind) -> bool {
        self.faults
            .iter()
            .any(|f| f.kind == kind && f.phase == Phase::Active)
    }

    /// The AP is gone: offline preset, or a router reboot in progress
    pub fn down(&self) -> bool {
        self.preset == Preset::Offline || self.on(FaultKind::Reboot)
    }

    pub fn dns_fail(&self) -> bool {
        self.on(FaultKind::Dns)
    }

    pub fn silent(&self) -> bool {
        self.on(FaultKind::Silent)
    }

    /// Cap on AP signal (weak preset)
    pub fn rssi_cap(&self) -> Option<i8> {
        (self.preset == Preset::Weak).then_some(WEAK_DBM)
    }

    /// Whether the AP misses this chip frame (one draw only under weak / flaky)
    pub fn uplink_lost(&mut self) -> bool {
        let p = self.preset.loss_permille();
        if p == 0 {
            return false;
        }
        let lost = self.next() % 1000 < p;
        if lost {
            self.stats.lost_frames += 1;
        }
        lost
    }

    /// Extra delay (us) for a batch of replies arriving at now + base (flaky: 300 ± 200 ms, kept in order)
    pub fn latency_us(&mut self, now_us: u64, base_us: u64) -> u64 {
        if self.preset != Preset::Flaky {
            return 0;
        }
        let want = now_us + base_us + self.uniform(100_000, 500_000);
        // Never overtake an earlier batch: the virtual servers do not retransmit
        let at = want.max(self.last_rx_us + 1000);
        self.last_rx_us = at;
        at - now_us - base_us
    }

    /// The AP dropped the station
    pub fn lose(&mut self, now_us: u64) -> bool {
        if self.stats.lost_at.is_some() {
            return false;
        }
        self.stats.disconnects += 1;
        self.stats.lost_at = Some(now_us);
        self.rev += 1;
        true
    }

    /// DHCP ACK after a loss: returns the reconnect duration
    pub fn regained(&mut self, now_us: u64) -> Option<u64> {
        let t = self.stats.lost_at.take()?;
        let d = now_us.saturating_sub(t);
        self.stats.reconnects.push(d);
        self.rev += 1;
        Some(d)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_never_draws() {
        let mut c = NetCond::default();
        let r = c.rng;
        for _ in 0..100 {
            assert!(!c.uplink_lost());
            assert_eq!(c.latency_us(1000, 0), 0);
        }
        assert_eq!(c.rng, r);
        assert!(!c.active());
        assert_eq!(c.next_boundary(), None);
    }

    #[test]
    fn same_seed_same_drops() {
        let run = |seed| {
            let mut c = NetCond::default();
            c.set_seed(seed);
            c.set_preset(Preset::Weak, 0);
            (0..200).map(|_| c.uplink_lost()).collect::<Vec<_>>()
        };
        assert_eq!(run(7), run(7));
        assert_ne!(run(7), run(8));
        let lost = run(7).iter().filter(|x| **x).count();
        assert!((5..=40).contains(&lost), "weak loss {lost}/200");
    }

    #[test]
    fn fault_window() {
        let mut c = NetCond::default();
        c.add_fault(FaultKind::Reboot, 10_000_000, 8_000_000);
        assert_eq!(c.next_boundary(), Some(10_000_000));
        assert!(c.advance(9_999_999).is_empty());
        assert!(!c.down());
        assert!(matches!(c.advance(10_000_000)[..], [Change::Start(_)]));
        assert!(c.down());
        assert_eq!(c.next_boundary(), Some(18_000_000));
        assert!(matches!(c.advance(20_000_000)[..], [Change::End(_)]));
        assert!(!c.down());
        assert_eq!(c.next_boundary(), None);
    }

    #[test]
    fn flaky_latency_in_order() {
        let mut c = NetCond::default();
        c.set_preset(Preset::Flaky, 0);
        let mut last = 0;
        for k in 0..50 {
            let now = k * 10_000;
            let d = c.latency_us(now, 300);
            assert!(d >= 100_000 || now + 300 + d > last);
            assert!(now + 300 + d > last);
            last = now + 300 + d;
        }
        // First random drop 40-90 s in
        let t = c.next_boundary().unwrap();
        assert!((40_000_000..=90_000_000).contains(&t));
        let ch = c.advance(t);
        assert!(matches!(&ch[..], [Change::Start(f)] if f.auto));
    }
}
