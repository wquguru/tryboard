//! F-04d tutorial parts on the machine: HC-SR501 PIR, relay module, photoresistor, RC522 reader

use super::*;
use tryboard_soc::devices::gpio_parts::{Ldr, Pir, Relay};
use tryboard_soc::devices::rc522::{parse_uid, uid_text, Rc522};
use tryboard_soc::devices::xpt2046::Xpt2046;

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
        if let Some(t) = &parts.xpt2046 {
            out.push(format!(
                "XPT2046 CS GPIO{}: {} conversions, {}",
                t.cs,
                t.conversions,
                if t.touched() { "touched" } else { "idle" }
            ));
        }
        out
    }
}

impl Machine {
    /// `--spi xpt2046[@cs=N,irq=N]` (the part after "xpt2046"), CYD wiring by default (CS 33, PENIRQ 36); classic
    /// ESP32 only. The touch area takes an attached panel's size, else 240 x 320
    pub fn xpt2046_attach_spec(&mut self, rest: &str) -> Result<(), String> {
        if self.chip != Chip::Esp32 {
            return Err("xpt2046 is only wired up on the classic ESP32".into());
        }
        let (mut cs, mut irq) = (33u32, Some(36u32));
        if let Some(p) = rest.strip_prefix('@') {
            for kv in p.split(',') {
                let (k, v) = kv
                    .split_once('=')
                    .ok_or_else(|| format!("bad xpt2046 pin {kv}"))?;
                let n: i64 = v.trim().parse().map_err(|_| format!("bad {k} {v}"))?;
                match k.trim() {
                    "cs" if n >= 0 => cs = n as u32,
                    "irq" => irq = (n >= 0).then_some(n as u32),
                    _ => return Err(format!("xpt2046 takes cs=<gpio>, irq=<gpio|-1>, got {kv}")),
                }
            }
        } else if !rest.is_empty() {
            return Err(format!("unknown SPI device xpt2046{rest}"));
        }
        let mut t = Xpt2046::new(cs, irq);
        if let Some(l) = self.hw.lcd() {
            let (w, h) = l.size();
            t.width = w as u16;
            t.height = h as u16;
        }
        self.pins().parts.xpt2046 = Some(Box::new(t));
        if let Some(pin) = irq {
            self.gpio_drive(pin, 1);
        }
        self.elec.add_module("xpt2046");
        Ok(())
    }
}

/// IR remote link (F-10c): receiver module output on rx, IR LED eye on tx (classic ESP32 only: its RMT has the carrier)
impl Machine {
    pub fn ir_attach(&mut self, rx: Option<u32>, tx: Option<u32>) -> Result<(), String> {
        if tx.is_some() && self.chip != Chip::Esp32 {
            return Err(
                "the IR LED eye needs the classic ESP32 RMT carrier (C3 / S3 not modelled)".into(),
            );
        }
        let now = self.cycles();
        let l = tryboard_soc::devices::ir::IrLink::new(rx, tx, true, now);
        self.pins().ir.push(l);
        self.pins_kick();
        Ok(())
    }

    /// The remote sends one code (script action ir=ADDR,CMD | 32-bit hex | repeat)
    pub fn ir_press(&mut self, code: &str) -> Result<(), String> {
        let c = tryboard_soc::devices::ir::IrCode::parse(code)?;
        let now = self.cycles();
        let l = self
            .pins()
            .ir
            .iter_mut()
            .find(|l| l.rx_pin.is_some())
            .ok_or("no IR receiver attached (--ir RX[,TX])")?;
        l.press(now, c);
        self.pins_kick();
        Ok(())
    }

    /// Frames the eye decoded since the last call: (seconds, LED GPIO, text)
    pub fn ir_events_take(&mut self) -> Vec<(f64, u32, String)> {
        let mut out = Vec::new();
        for l in &mut self.pins().ir {
            let pin = l.tx_pin.unwrap_or(0);
            for s in l.seen.drain(..) {
                let code = s
                    .code
                    .map(|c| c.text())
                    .unwrap_or_else(|| format!("{} bursts, not NEC", s.bursts));
                let txt = format!("{code} ({:.1} kHz carrier)", s.carrier_hz / 1000.0);
                out.push((s.t as f64 / CPU_HZ as f64, pin, txt));
            }
        }
        out
    }

    /// End-of-run IR lines
    pub fn ir_report(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        for l in &self.pins().ir {
            if let Some(p) = l.rx_pin {
                out.push(format!(
                    "IR receiver GPIO{p}: remote sent {} frames",
                    l.sent
                ));
            }
            if let Some(p) = l.tx_pin {
                let lb = if l.loopback {
                    ", aimed at the receiver"
                } else {
                    ""
                };
                out.push(format!(
                    "IR LED GPIO{p}: {} NEC frames decoded, {} unmodulated pulses ignored{lb}",
                    l.decoded, l.unmodulated
                ));
            }
        }
        out
    }
}
