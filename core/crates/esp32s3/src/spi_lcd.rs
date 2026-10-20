//! Screens on GP-SPI2 (GC9A01 with D/C, CO5300 on QSPI): pin conventions, chip select, and handing transfer bytes to the model

use super::*;
use tryboard_soc::devices::lcd::{Lcd, LcdKind};

/// GPIO matrix output signal FSPICS0_OUT_IDX (gpio_sig_map.h) and IO_MUX function FUNC_GPIO10_FSPICS0
const IOMUX_FUNC_FSPICS0: u32 = 4;

/// CO5300 AMOLED wiring (Waveshare ESP32-S3-Touch-AMOLED-2.16): QSPI via the GPIO matrix, no D/C or backlight pin
pub mod co5300_pin {
    pub const CS: u32 = 12;
    pub const CLK: u32 = 38;
    pub const D: [u32; 4] = [4, 5, 6, 7];
    pub const RST: u32 = 39;
}
/// GC9A01 round display wiring convention (SPI2 IO_MUX direct pins + three GPIOs)
pub mod lcd_pin {
    pub const SCLK: u32 = 12;
    pub const MOSI: u32 = 11;
    pub const CS: u32 = 10;
    pub const DC: u32 = 14;
    pub const RST: u32 = 13;
    pub const BL: u32 = 15;
}

impl SocBus {
    /// Pin levels changed: screen reset / backlight pins, and a GPIO-driven CO5300 chip select going high
    pub(crate) fn lcd_pins_changed(&mut self, lv: u64) {
        let cs_gpio_high = self.lcd_cs_gpio_high();
        if let Some(l) = self.lcd.as_deref_mut() {
            // RST is active low and only resets when firmware really drives it low (module boards have a pull-up); backlight on when high
            let en = self.gpio.enable;
            let rst = match l.kind() {
                LcdKind::Gc9a01 => lcd_pin::RST,
                LcdKind::Co5300 => co5300_pin::RST,
            };
            l.set_reset(en >> rst & 1 != 0 && lv >> rst & 1 == 0);
            l.set_backlight(lv >> lcd_pin::BL & 1 != 0);
            if let (Lcd::Co5300(d), true) = (l, cs_gpio_high) {
                d.cs_release();
            }
        }
    }

    /// Round display chip select: if the CS pin is routed via IO_MUX / GPIO matrix to SPI2 CS0, the controller pulls it low
    /// during transfers; otherwise treat it as a plain GPIO, selected only when firmware drives it low
    fn lcd_selected(&self) -> bool {
        let pin = self.lcd_cs_pin();
        if self.lcd_cs_by_spi() {
            self.spi2.cs0_enabled()
        } else {
            self.gpio.enable >> pin & 1 != 0 && self.gpio.level() >> pin & 1 == 0
        }
    }

    /// Chip-select pin of the attached screen
    fn lcd_cs_pin(&self) -> usize {
        match self.lcd.as_deref().map(Lcd::kind) {
            Some(LcdKind::Co5300) => co5300_pin::CS as usize,
            _ => lcd_pin::CS as usize,
        }
    }

    /// CS routed to SPI2 CS0 (IO_MUX or GPIO matrix): the controller drives it per transfer
    fn lcd_cs_by_spi(&self) -> bool {
        let pin = self.lcd_cs_pin();
        (self.gpio.iomux[pin] >> 12) & 7 == IOMUX_FUNC_FSPICS0
            || self.gpio.func_out[pin] & 0x1ff == SIG_FSPICS0
    }

    /// CS is a plain GPIO that firmware drives high (ends a CO5300 frame)
    fn lcd_cs_gpio_high(&self) -> bool {
        let pin = self.lcd_cs_pin();
        self.lcd.is_some()
            && !self.lcd_cs_by_spi()
            && self.gpio.enable >> pin & 1 != 0
            && self.gpio.level() >> pin & 1 != 0
    }

    /// Firmware wrote SPI2 CMD.USR: fetch data (W registers or GDMA descriptor chain), hand it to the display, time it by SPI clock
    pub(crate) fn spi2_transfer(&mut self, now: u64) {
        let p = self.spi2.plan();
        let mut bytes = p.head.clone();
        let mut out_ch = None;
        // Take GDMA out temporarily so it can borrow the bus for memory access
        let mut g = std::mem::replace(&mut self.gdma, Gdma::placeholder());
        if p.mosi_bits > 0 {
            let n = p.mosi_bits.div_ceil(8) as usize;
            let mut data = if p.dma_tx {
                match g.out_channel_for(GDMA_PERI_SPI2) {
                    Some(ch) => {
                        out_ch = Some(ch);
                        g.take_out(ch, n, self)
                    }
                    None => Vec::new(),
                }
            } else {
                self.spi2.tx_buffer(n)
            };
            // DMA supplied too little data: the shift register holds 0
            data.resize(n, 0);
            bytes.extend_from_slice(&data);
        }
        if p.miso_bits > 0 {
            // No slave would answer; MISO pull-up reads all 1s
            let rx = vec![0xffu8; p.miso_bits.div_ceil(8) as usize];
            if p.dma_rx {
                if let Some(ch) = g.in_channel_for(GDMA_PERI_SPI2) {
                    g.put_in(ch, &rx, self);
                }
            } else {
                self.spi2.rx_fill(&rx);
            }
        }
        self.gdma = g;
        let selected = self.lcd_selected();
        let dc = self.gpio.level() >> lcd_pin::DC & 1 != 0;
        // CO5300 frames span transfers while CS_KEEP_ACTIVE holds CS low; SPI-driven CS rises after the last one
        let release = self.lcd_cs_by_spi() && !self.spi2.cs_keep_active();
        match (self.lcd.as_deref_mut(), selected) {
            (Some(Lcd::Gc9a01(l)), true) => {
                for b in bytes {
                    l.byte(dc, b);
                }
            }
            (Some(Lcd::Co5300(l)), true) => {
                for b in bytes {
                    l.byte(b);
                }
                if release {
                    l.cs_release();
                }
            }
            _ => {}
        }
        self.spi2.begin(now, &p, out_ch);
    }

    /// Attach a screen on SPI2 (pins: `lcd_pin` for GC9A01, `co5300_pin` for CO5300)
    pub fn attach_lcd(&mut self, kind: LcdKind) {
        self.lcd = Some(Box::new(Lcd::new(kind)));
        let now = self.now;
        self.gpio_changed(now);
    }
}
