//! F-04d tutorial parts on the machine: HC-SR501 PIR, relay module, photoresistor, RC522 reader

use super::*;
use tryboard_soc::devices::gpio_parts::{Ldr, Pir, Relay};
use tryboard_soc::devices::rc522::{parse_uid, uid_text, Rc522};

/// Default RC522 chip select: the Arduino core's SS pin (C3 GPIO7, S3 GPIO10)
pub fn rc522_default_cs(chip: Chip) -> u32 {
    match chip {
        Chip::Esp32c3 => 7,
        _ => 10,
    }
}

impl Machine {
    /// Attach an HC-SR501 output to `pin` (hold time in seconds, the module's delay pot); 5 V powered
    pub fn pir_attach(&mut self, pin: u32, hold_s: f64) {
        let now = self.cycles();
        self.pins().parts.pirs.push(Pir::new(pin, hold_s, now));
        self.elec.add_module("pir");
        self.pins_kick();
    }

    /// Motion in front of the first PIR (script action pir=1 / pir=0)
    pub fn pir_motion(&mut self, on: bool) {
        let now = self.cycles();
        if let Some(p) = self.pins().parts.pirs.first_mut() {
            p.set_motion(now, on);
        }
        self.pins_kick();
    }

    /// Attach a relay module's IN to `pin`; `active_high` = closes on a high input
    pub fn relay_attach(&mut self, pin: u32, active_high: bool) {
        self.pins().parts.relays.push(Relay::new(pin, active_high));
        self.elec.add_module("relay");
    }

    /// Relay switch events since the last call: (seconds, GPIO, closed)
    pub fn relay_events_take(&mut self) -> Vec<(f64, u32, bool)> {
        let mut out = Vec::new();
        for r in &mut self.pins().parts.relays {
            for (t, on) in r.events.drain(..) {
                out.push((t as f64 / CPU_HZ as f64, r.pin, on));
            }
        }
        out
    }

    /// Photoresistor divider on ADC pad `pin`; Err when the pin has no ADC on this chip
    pub fn ldr_attach(&mut self, pin: u32, lux: f64) -> Result<(), String> {
        let ok = match self.chip {
            Chip::Esp32c3 => pin <= 5,
            Chip::Esp32s3 => (1..=20).contains(&pin),
            Chip::Esp32 => true,
        };
        if !ok {
            return Err(format!("GPIO{pin} is not an ADC pin on this chip"));
        }
        self.pins().parts.ldrs.push(Ldr { pin, lux });
        self.elec.add_module("ldr");
        self.analog_set(pin as usize, Ldr::mv(lux));
        Ok(())
    }

    /// Light level on every photoresistor (script action lux=<n>)
    pub fn ldr_lux(&mut self, lux: f64) {
        let pins: Vec<u32> = self.pins().parts.ldrs.iter().map(|l| l.pin).collect();
        for l in &mut self.pins().parts.ldrs {
            l.lux = lux;
        }
        for p in pins {
            self.analog_set(p as usize, Ldr::mv(lux));
        }
    }

    /// `--spi rc522[@cs=N]` (the part after "rc522"); C3 / S3 SPI2 only
    pub fn rc522_attach_spec(&mut self, rest: &str) -> Result<(), String> {
        if self.chip == Chip::Esp32 {
            return Err("rc522 is not supported on the classic ESP32 yet".into());
        }
        let mut cs = rc522_default_cs(self.chip);
        if let Some(p) = rest.strip_prefix('@') {
            for kv in p.split(',') {
                match kv.split_once('=') {
                    Some(("cs", v)) => cs = v.trim().parse().map_err(|_| format!("bad cs {v}"))?,
                    _ => return Err(format!("rc522 takes only cs=<gpio>, got {kv}")),
                }
            }
        } else if !rest.is_empty() {
            return Err(format!("unknown SPI device rc522{rest}"));
        }
        self.pins().parts.rc522 = Some(Box::new(Rc522::new(cs)));
        self.elec.add_module("rc522");
        Ok(())
    }

    /// Put a card on the reader (`card=<uid hex>`, 4 or 7 bytes) or take it away (`card=none` / empty)
    pub fn rc522_card(&mut self, spec: &str) -> Result<(), String> {
        let s = spec.trim();
        let uid = if s.is_empty() || s == "none" {
            None
        } else {
            Some(parse_uid(s).ok_or_else(|| format!("card UID must be 4 or 7 hex bytes: {s}"))?)
        };
        let r = self
            .pins()
            .parts
            .rc522
            .as_mut()
            .ok_or("no RC522 attached (--spi rc522)")?;
        r.set_card(uid);
        Ok(())
    }

    /// End-of-run lines for the parts above (empty when none attached)
    pub fn parts_report(&mut self) -> Vec<String> {
        let now = self.cycles();
        let parts = &self.pins().parts;
        let mut out = Vec::new();
        for p in &parts.pirs {
            out.push(format!(
                "PIR GPIO{}: {} triggers, output high {:.2} s, now {}",
                p.pin,
                p.triggers,
                p.high_s(now),
                if p.high { "HIGH" } else { "LOW" }
            ));
        }
        for r in &parts.relays {
            out.push(format!(
                "relay GPIO{} (active {}): {} switches, energized {:.2} s, final {}",
                r.pin,
                if r.active_high { "high" } else { "low" },
                r.switches,
                r.on_s(now),
                if r.on { "ON" } else { "OFF" }
            ));
        }
        for l in &parts.ldrs {
            out.push(format!(
                "LDR GPIO{}: {} lux -> {:.0} mV",
                l.pin,
                l.lux,
                Ldr::mv(l.lux)
            ));
        }
        if let Some(r) = &parts.rc522 {
            let card = r
                .card
                .as_ref()
                .map(|c| uid_text(&c.uid))
                .unwrap_or_else(|| "none".into());
            out.push(format!("{}, card on reader {card}", r.report()));
        }
        out
    }
}
