//! HSPI / VSPI on the classic ESP32 and the screen hanging off them: which host drives the panel, chip select,
//! DMA (inside each SPI block) and handing transfer bytes to the shared `Lcd` model

use super::*;
use tryboard_soc::devices::lcd::{Lcd, LcdKind, LcdPins};
use tryboard_soc::gpspi_classic::ClassicSpi;

/// GPIO matrix output signals (soc/esp32/include/soc/gpio_sig_map.h)
const SIG_HSPICLK: u32 = 8;
const SIG_HSPICS0: u32 = 11;
const SIG_VSPICLK: u32 = 63;
const SIG_VSPICS0: u32 = 68;
/// IO_MUX function 1 on the direct pins (spi_pins.h): HSPI CLK 14 / CS 15, VSPI CLK 18 / CS 5
const IOMUX_FUNC_SPI: u32 = 1;

/// General-purpose SPI host
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Host {
    Hspi,
    Vspi,
}

impl Host {
    fn base(self) -> u32 {
        match self {
            Host::Hspi => 0x3FF6_4000,
            Host::Vspi => 0x3FF6_5000,
        }
    }
}

impl SocBus {
    pub(crate) fn spi(&mut self, h: Host) -> &mut ClassicSpi {
        match h {
            Host::Hspi => &mut self.hspi,
            Host::Vspi => &mut self.vspi,
        }
    }

    pub(crate) fn spi_write(&mut self, h: Host, off: u32, v: u32, now: u64) {
        if !ClassicSpi::known(off) {
            *self.unimpl.entry(h.base() + off).or_insert(0) += 1;
        }
        if self.spi(h).write(off, v) {
            self.spi_transfer(h, now);
        }
    }

    pub(crate) fn spi_read(&mut self, h: Host, off: u32) -> u32 {
        if !ClassicSpi::known(off) {
            *self.unimpl.entry(h.base() + off).or_insert(0) += 1;
        }
        self.spi(h).read(off)
    }

    fn iomux_func(&self, pin: usize) -> u32 {
        self.gpio.iomux.get(pin).map_or(u32::MAX, |r| (r >> 12) & 7)
    }

    fn func_out(&self, pin: usize) -> u32 {
        self.gpio.func_out.get(pin).map_or(u32::MAX, |f| f & 0x1ff)
    }

    /// Host driving the screen, from how SCLK is routed (GPIO matrix signal, else the IO_MUX direct pin)
    pub(crate) fn lcd_host(&self) -> Option<Host> {
        let sclk = self.lcd_pins.sclk as usize;
        match self.func_out(sclk) {
            SIG_HSPICLK => Some(Host::Hspi),
            SIG_VSPICLK => Some(Host::Vspi),
            _ if self.iomux_func(sclk) == IOMUX_FUNC_SPI && sclk == 14 => Some(Host::Hspi),
            _ if self.iomux_func(sclk) == IOMUX_FUNC_SPI && sclk == 18 => Some(Host::Vspi),
            _ => None,
        }
    }

    /// CS driven by the controller (CS0 through the matrix or IO_MUX); otherwise firmware toggles it as a GPIO
    fn lcd_cs_by_spi(&self) -> bool {
        let cs = self.lcd_pins.cs as usize;
        matches!(self.func_out(cs), SIG_HSPICS0 | SIG_VSPICS0)
            || (self.iomux_func(cs) == IOMUX_FUNC_SPI && (cs == 15 || cs == 5))
    }

    fn lcd_selected(&self, h: Host) -> bool {
        let cs = self.lcd_pins.cs as usize;
        if self.lcd_cs_by_spi() {
            match h {
                Host::Hspi => self.hspi.cs0_enabled(),
                Host::Vspi => self.vspi.cs0_enabled(),
            }
        } else {
            self.gpio.enable >> cs & 1 != 0 && self.gpio.level() >> cs & 1 == 0
        }
    }

    /// Pin levels changed: reset / backlight pins, and a GPIO chip select going high ends any read
    pub(crate) fn lcd_pins_changed(&mut self, lv: u64) {
        let pins = self.lcd_pins;
        let en = self.gpio.enable;
        let cs = pins.cs as usize;
        let cs_high = !self.lcd_cs_by_spi() && en >> cs & 1 != 0 && lv >> cs & 1 != 0;
        let rst_low = pins
            .rst
            .is_some_and(|r| en >> r & 1 != 0 && lv >> r & 1 == 0);
        let bl = self.lcd_backlight(lv);
        if let Some(Lcd::Dcs(d)) = self.lcd.as_deref_mut() {
            d.set_reset(rst_low);
            d.set_backlight(bl);
            if cs_high {
                d.cs_release();
            }
        }
    }

    /// Backlight lit: pin high, or an LEDC channel routed to it with non-zero duty; no pin = always on
    fn lcd_backlight(&self, lv: u64) -> bool {
        self.lcd_pins
            .bl
            .is_none_or(|b| match self.pin_pwm(b as usize) {
                Some((duty, _)) => duty > 0.0,
                None => lv >> b & 1 != 0,
            })
    }

    /// LEDC duty changes don't go through `gpio_changed`: refresh a PWM-driven backlight each update
    pub(crate) fn lcd_pwm_backlight(&mut self) {
        let Some(b) = self.lcd_pins.bl else { return };
        if self.lcd.is_none() || self.pin_pwm(b as usize).is_none() {
            return;
        }
        let on = self.lcd_backlight(self.gpio.level());
        if let Some(Lcd::Dcs(d)) = self.lcd.as_deref_mut() {
            d.set_backlight(on);
        }
    }

    /// Firmware set CMD.USR on host `h`: fetch MOSI data (W registers or the block's DMA chain), hand it to the screen,
    /// fill the receive side (all ones when nothing answers), time it by SPI clock
    pub(crate) fn spi_transfer(&mut self, h: Host, now: u64) {
        let p = self.spi(h).plan();
        let mut data = Vec::new();
        if p.mosi_bits > 0 {
            let n = p.mosi_bits.div_ceil(8) as usize;
            data = if p.dma_tx {
                let mut s = std::mem::take(self.spi(h));
                let d = s.dma_take(n, self);
                *self.spi(h) = s;
                d
            } else {
                self.spi(h).tx_buffer(n)
            };
            // DMA supplied too little data: the shift register holds 0
            data.resize(n, 0);
        }
        let selected = self.lcd_host() == Some(h) && self.lcd_selected(h);
        let dc = self.gpio.level() >> self.lcd_pins.dc & 1 != 0;
        let release = self.lcd_cs_by_spi() && !self.spi(h).cs_keep_active();
        let rx = match self.lcd.as_deref_mut() {
            Some(l) if selected => {
                l.spi_transfer(dc, &p.head, p.dummy_bits, &data, p.miso_bits, release)
            }
            _ => None,
        };
        if p.miso_bits > 0 {
            // No slave answering: MISO pull-up reads all 1s
            let rx = rx.unwrap_or_else(|| vec![0xffu8; p.miso_bits.div_ceil(8) as usize]);
            if p.dma_rx {
                let mut s = std::mem::take(self.spi(h));
                s.dma_put(&rx, self);
                *self.spi(h) = s;
            } else {
                self.spi(h).rx_fill(&rx);
            }
        }
        self.spi(h).begin(now, &p);
        self.next_event = self.next_event.min(now);
    }

    /// Attach a DCS panel on the given GPIOs (CO5300 is an S3-only QSPI part)
    pub fn attach_lcd_pins(&mut self, kind: LcdKind, pins: LcdPins) -> bool {
        let fits = |p: u8| (p as usize) < NPINS;
        let all = [
            Some(pins.sclk),
            Some(pins.mosi),
            Some(pins.cs),
            Some(pins.dc),
            pins.rst,
            pins.bl,
            pins.miso,
        ];
        if kind == LcdKind::Co5300 || !all.into_iter().flatten().all(fits) {
            return false;
        }
        self.lcd = Some(Box::new(Lcd::new(kind)));
        self.lcd_pins = pins;
        let now = self.now;
        self.gpio_changed(now);
        true
    }
}
