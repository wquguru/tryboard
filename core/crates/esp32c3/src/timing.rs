//! Timing-sensitive code detection (D-03): busy-wait delays, cycle-counter spins and software GPIO bit-banging.
//! Firmware that times pulses in software works here because the simulator is cycle-exact and interrupt-free when
//! asked; on silicon caches, interrupts and Wi-Fi can stretch the loops, so these places need a real-hardware check.
//! Only pins that show bit-banging (CPU edges or polled edges under 100 µs apart) are reported. (lint: allow-long-comment)

use crate::periph::CPU_HZ;

/// Two GPIO events closer than this (100 µs) count as software pulse timing
pub const NEAR_CYCLES: u64 = CPU_HZ / 10_000;
/// A delay / spin within this long (1 ms) of a pin's activity is attributed to that pin
pub const ATTRIB_CYCLES: u64 = CPU_HZ / 1000;
/// Back-to-back cycle-counter reads closer than this are a spin loop
pub const SPIN_CYCLES: u64 = 200;

pub const NPINS: usize = 64;

/// Per-pin counters, one per kind of evidence
#[derive(Clone, Debug)]
pub struct Timing {
    pub delays: [u64; NPINS],
    pub spins: [u64; NPINS],
    pub toggles: [u64; NPINS],
    pub polls: [u64; NPINS],
    last_edge: [u64; NPINS],
    last_in: Option<(u64, u64)>,
    last_pin: Option<u32>,
    last_activity: u64,
    last_cycle_read: u64,
}

impl Default for Timing {
    fn default() -> Timing {
        Timing {
            delays: [0; NPINS],
            spins: [0; NPINS],
            toggles: [0; NPINS],
            polls: [0; NPINS],
            last_edge: [u64::MAX; NPINS],
            last_in: None,
            last_pin: None,
            last_activity: u64::MAX,
            last_cycle_read: u64::MAX,
        }
    }
}

fn near(now: u64, then: u64, window: u64) -> bool {
    then != u64::MAX && now >= then && now - then < window
}

impl Timing {
    /// A CPU register write changed these pins (bit = pin)
    pub fn cpu_edges(&mut self, now: u64, changed: u64) {
        for p in 0..NPINS {
            if changed >> p & 1 == 0 {
                continue;
            }
            if near(now, self.last_edge[p], NEAR_CYCLES) {
                self.toggles[p] += 1;
            }
            self.last_edge[p] = now;
            self.last_pin = Some(p as u32);
        }
        self.last_activity = now;
    }

    /// Firmware read the input register; `inputs` = pins it can sense (not push-pull outputs)
    pub fn in_read(&mut self, now: u64, level: u64, inputs: u64) {
        if let Some((t, prev)) = self.last_in {
            let changed = (prev ^ level) & inputs;
            if changed != 0 && now - t < NEAR_CYCLES {
                for p in 0..NPINS {
                    if changed >> p & 1 != 0 {
                        self.polls[p] += 1;
                        self.last_pin = Some(p as u32);
                    }
                }
            }
        }
        self.last_in = Some((now, level));
        self.last_activity = now;
    }

    fn attributed(&self, now: u64) -> Option<usize> {
        let p = self.last_pin? as usize;
        near(now, self.last_activity, ATTRIB_CYCLES).then_some(p)
    }

    /// esp_rom_delay_us / ets_delay_us entered
    pub fn delay(&mut self, now: u64) {
        if let Some(p) = self.attributed(now) {
            self.delays[p] += 1;
        }
    }

    /// Firmware (not ROM) read a cycle counter
    pub fn cycle_read(&mut self, now: u64) {
        if near(now, self.last_cycle_read, SPIN_CYCLES) {
            if let Some(p) = self.attributed(now) {
                self.spins[p] += 1;
            }
        }
        self.last_cycle_read = now;
    }

    /// (pin, kind, count) for pins that showed bit-banging, in pin order then delay / spin / toggle / poll
    pub fn items(&self) -> Vec<(u32, &'static str, u64)> {
        let mut v = Vec::new();
        for p in 0..NPINS {
            if self.toggles[p] == 0 && self.polls[p] == 0 {
                continue;
            }
            for (kind, n) in [
                ("delay", self.delays[p]),
                ("spin", self.spins[p]),
                ("toggle", self.toggles[p]),
                ("poll", self.polls[p]),
            ] {
                if n > 0 {
                    v.push((p as u32, kind, n));
                }
            }
        }
        v
    }

    /// The single stderr line (without trailing newline), None when nothing was detected
    pub fn line(&self) -> Option<String> {
        let items = self.items();
        if items.is_empty() {
            return None;
        }
        let parts: Vec<String> = items
            .iter()
            .map(|(p, kind, n)| {
                let what = match *kind {
                    "delay" => "busy-wait esp_rom_delay_us",
                    "spin" => "cycle-counter spin",
                    "toggle" => "bit-bang toggle",
                    _ => "bit-bang poll",
                };
                format!("GPIO{p} {what} ×{n}")
            })
            .collect();
        Some(format!("[tryboard] timing-sensitive: {}", parts.join(", ")))
    }

    /// Same data for the web: {"line":"...","items":[{"pin":5,"kind":"delay","n":N}]}; empty object when nothing
    pub fn json(&self) -> String {
        let Some(line) = self.line() else {
            return "{}".into();
        };
        let items: Vec<String> = self
            .items()
            .iter()
            .map(|(p, k, n)| format!("{{\"pin\":{p},\"kind\":\"{k}\",\"n\":{n}}}"))
            .collect();
        format!(
            "{{\"line\":\"{}\",\"items\":[{}]}}",
            line.replace('\\', "\\\\").replace('"', "\\\""),
            items.join(",")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bit_bang_detected_slow_blink_not() {
        let us = CPU_HZ / 1_000_000;
        let mut t = Timing::default();
        // 500 ms blink on GPIO8: no report
        for i in 0..4 {
            t.cpu_edges(i * 500_000 * us, 1 << 8);
            t.delay(i * 500_000 * us + 10);
        }
        assert_eq!(t.line(), None);
        // 10 µs trigger on GPIO4, then a delay right after the rising edge
        t.cpu_edges(3_000_000 * us, 1 << 4);
        t.delay(3_000_000 * us + 5);
        t.cpu_edges(3_000_010 * us, 1 << 4);
        // Polling GPIO5 every µs catches an edge
        t.in_read(3_000_100 * us, 0, 1 << 5);
        t.in_read(3_000_101 * us, 1 << 5, 1 << 5);
        t.cycle_read(3_000_102 * us);
        t.cycle_read(3_000_102 * us + 50);
        assert_eq!(
            t.line().unwrap(),
            "[tryboard] timing-sensitive: GPIO4 busy-wait esp_rom_delay_us ×1, GPIO4 bit-bang toggle ×1, GPIO5 cycle-counter spin ×1, GPIO5 bit-bang poll ×1"
        );
        assert!(t.json().contains("{\"pin\":5,\"kind\":\"poll\",\"n\":1}"));
    }
}
