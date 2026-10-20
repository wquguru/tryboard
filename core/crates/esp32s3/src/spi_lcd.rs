//! Screens on GP-SPI2 / SPI3 (MIPI-DCS TFTs with D/C, CO5300 on QSPI): pin conventions, chip select, and handing
//! transfer bytes to the model and its read-back bits to the controller

use super::*;
use tryboard_soc::devices::lcd::{Lcd, LcdKind, LcdPins};
use tryboard_soc::gpspi::GpSpi;

/// IO_MUX function FUNC_GPIO10_FSPICS0
const IOMUX_FUNC_FSPICS0: u32 = 4;
/// GPIO matrix output signals SPI3_CLK_OUT_IDX / SPI3_CS0_OUT_IDX (gpio_sig_map.h)
const SIG_SPI3_CLK: u32 = 66;
const SIG_SPI3_CS0: u32 = 71;

/// CO5300 AMOLED wiring (Waveshare ESP32-S3-Touch-AMOLED-2.16): QSPI via the GPIO matrix, no D/C or backlight pin
pub mod co5300_pin {
    pub const CS: u32 = 12;
    pub const CLK: u32 = 38;
    pub const D: [u32; 4] = [4, 5, 6, 7];
    pub const RST: u32 = 39;
}
/// Default 4-wire panel wiring (`LcdPins::S3_DEFAULT`: SPI2 IO_MUX direct pins + three GPIOs)
pub mod lcd_pin {
    pub const SCLK: u32 = 12;
    pub const MOSI: u32 = 11;
    pub const CS: u32 = 10;
    pub const DC: u32 = 14;
    pub const RST: u32 = 13;
    pub const BL: u32 = 15;
}

/// GP-SPI host number (2 or 3)
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Host {
    Spi2,
    Spi3,
}

impl SocBus {
    pub(crate) fn spi(&mut self, h: Host) -> &mut GpSpi {
        match h {
            Host::Spi2 => &mut self.spi2,
            Host::Spi3 => &mut self.spi3,
        }
    }

    /// Register write to SPI2 / SPI3: idle-edge dummy clocks, then a transfer if CMD.USR was set
    pub(crate) fn spi_write(&mut self, h: Host, off: u32, v: u32, now: u64) {
        let start = self.spi(h).write(off, v);
        let flips = std::mem::take(&mut self.spi(h).idle_flips);
        if flips > 0 && self.lcd_host() == h && self.lcd_selected() {
            if let Some(Lcd::Dcs(l)) = self.lcd.as_deref_mut() {
                for _ in 0..flips {
                    l.idle_edge();
                }
            }
        }
        if start {
            self.spi_transfer(h, now);
        }
    }

    /// Pin levels changed: screen reset / backlight pins, and a GPIO-driven chip select going high
    pub(crate) fn lcd_pins_changed(&mut self, lv: u64) {
        let cs_gpio_high = self.lcd_cs_gpio_high();
        let pins = self.lcd_pins;
        let en = self.gpio.enable;
        // RST is active low and only resets when firmware really drives it low (module boards have a pull-up)
        let rst_low = |r: u32| en >> r & 1 != 0 && lv >> r & 1 == 0;
        let bl = self.lcd_backlight(lv);
        match self.lcd.as_deref_mut() {
            Some(Lcd::Dcs(d)) => {
                d.set_reset(pins.rst.is_some_and(|r| rst_low(r as u32)));
                d.set_backlight(bl);
                if cs_gpio_high {
                    d.cs_release();
                }
            }
            Some(Lcd::Co5300(d)) => {
                d.set_reset(rst_low(co5300_pin::RST));
                if cs_gpio_high {
                    d.cs_release();
                }
            }
            None => {}
        }
    }

    /// Backlight lit: pin high, or an LEDC channel routed to it with non-zero duty (M5 boards dim it by PWM); no pin = always on
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
        if !matches!(self.lcd.as_deref(), Some(Lcd::Dcs(_))) || self.pin_pwm(b as usize).is_none() {
            return;
        }
        let on = self.lcd_backlight(self.gpio.level());
        if let Some(Lcd::Dcs(d)) = self.lcd.as_deref_mut() {
            d.set_backlight(on);
        }
    }

    /// Host driving the screen: SCLK routed to SPI3_CLK through the GPIO matrix means SPI3, anything else SPI2
    pub(crate) fn lcd_host(&self) -> Host {
        let sclk = match self.lcd.as_deref().map(Lcd::kind) {
            Some(LcdKind::Co5300) => co5300_pin::CLK as usize,
            _ => self.lcd_pins.sclk as usize,
        };
        if self.gpio.func_out[sclk] & 0x1ff == SIG_SPI3_CLK {
            Host::Spi3
        } else {
            Host::Spi2
        }
    }

    /// Screen chip select: if the CS pin is routed via IO_MUX / GPIO matrix to the host's CS0, the controller pulls it
    /// low during transfers; otherwise treat it as a plain GPIO, selected only when firmware drives it low
    fn lcd_selected(&self) -> bool {
        let pin = self.lcd_cs_pin();
        if self.lcd_cs_by_spi() {
            match self.lcd_host() {
                Host::Spi2 => self.spi2.cs0_enabled(),
                Host::Spi3 => self.spi3.cs0_enabled(),
            }
        } else {
            self.gpio.enable >> pin & 1 != 0 && self.gpio.level() >> pin & 1 == 0
        }
    }

    /// Chip-select pin of the attached screen
    fn lcd_cs_pin(&self) -> usize {
        match self.lcd.as_deref().map(Lcd::kind) {
            Some(LcdKind::Co5300) => co5300_pin::CS as usize,
            _ => self.lcd_pins.cs as usize,
        }
    }

    /// CS routed to SPI2 / SPI3 CS0 (IO_MUX or GPIO matrix): the controller drives it per transfer.
    /// The IO_MUX FSPICS0 function only exists on GPIO10; the CO5300 check predates pin configs and stays as it was
    fn lcd_cs_by_spi(&self) -> bool {
        let pin = self.lcd_cs_pin();
        let co5300 = matches!(self.lcd.as_deref(), Some(Lcd::Co5300(_)));
        let sig = self.gpio.func_out[pin] & 0x1ff;
        ((self.gpio.iomux[pin] >> 12) & 7 == IOMUX_FUNC_FSPICS0 && (pin == 10 || co5300))
            || sig == SIG_FSPICS0
            || sig == SIG_SPI3_CS0
    }

    /// CS is a plain GPIO that firmware drives high (ends a CO5300 frame, aborts a panel read)
    fn lcd_cs_gpio_high(&self) -> bool {
        let pin = self.lcd_cs_pin();
        self.lcd.is_some()
            && !self.lcd_cs_by_spi()
            && self.gpio.enable >> pin & 1 != 0
            && self.gpio.level() >> pin & 1 != 0
    }

    /// Firmware wrote CMD.USR on host `h`: fetch data (W registers or GDMA descriptor chain), hand it to the display,
    /// fill the receive side from the display's reply (all ones when nothing answers), time it by SPI clock
    pub(crate) fn spi_transfer(&mut self, h: Host, now: u64) {
        let peri = match h {
            Host::Spi2 => GDMA_PERI_SPI2,
            Host::Spi3 => GDMA_PERI_SPI3,
        };
        let p = self.spi(h).plan();
        let mut out_ch = None;
        // Take GDMA out temporarily so it can borrow the bus for memory access
        let mut g = std::mem::replace(&mut self.gdma, Gdma::placeholder());
        let mut data = Vec::new();
        if p.mosi_bits > 0 {
            let n = p.mosi_bits.div_ceil(8) as usize;
            data = if p.dma_tx {
                match g.out_channel_for(peri) {
                    Some(ch) => {
                        out_ch = Some(ch);
                        g.take_out(ch, n, self)
                    }
                    None => Vec::new(),
                }
            } else {
                self.spi(h).tx_buffer(n)
            };
            // DMA supplied too little data: the shift register holds 0
            data.resize(n, 0);
        }
        let selected = self.lcd_host() == h && self.lcd_selected();
        let dc = self.gpio.level() >> self.lcd_pins.dc & 1 != 0;
        // CO5300 frames span transfers while CS_KEEP_ACTIVE holds CS low; SPI-driven CS rises after the last one
        let release = self.lcd_cs_by_spi() && !self.spi(h).cs_keep_active();
        let mut rx = None;
        match (self.lcd.as_deref_mut(), selected) {
            (Some(Lcd::Dcs(l)), true) => {
                for b in &p.head {
                    l.byte(dc, *b);
                }
                l.clock(p.dummy_bits);
                for b in &data {
                    l.byte(dc, *b);
                }
                // MISO, or the shared SDA line in 3-wire (USER.SIO) mode: the same bit stream either way
                if p.miso_bits > 0 {
                    rx = Some(l.read_bits(p.miso_bits));
                }
                if release {
                    l.cs_release();
                }
            }
            (Some(Lcd::Co5300(l)), true) => {
                for b in p.head.iter().chain(&data) {
                    l.byte(*b);
                }
                if release {
                    l.cs_release();
                }
            }
            _ => {}
        }
        if p.miso_bits > 0 {
            // No slave answering: MISO pull-up reads all 1s
            let rx = rx.unwrap_or_else(|| vec![0xffu8; p.miso_bits.div_ceil(8) as usize]);
            if p.dma_rx {
                if let Some(ch) = g.in_channel_for(peri) {
                    g.put_in(ch, &rx, self);
                }
            } else {
                self.spi(h).rx_fill(&rx);
            }
        }
        self.gdma = g;
        self.spi(h).begin(now, &p, out_ch);
    }

    /// Attach a screen with its default wiring (`lcd_pin` for DCS panels, `co5300_pin` for CO5300)
    pub fn attach_lcd(&mut self, kind: LcdKind) {
        self.attach_lcd_pins(kind, LcdPins::S3_DEFAULT);
    }

    /// Attach a DCS panel on the given GPIOs (CO5300 ignores `pins`; it keeps `co5300_pin`)
    pub fn attach_lcd_pins(&mut self, kind: LcdKind, pins: LcdPins) {
        self.lcd = Some(Box::new(Lcd::new(kind)));
        self.lcd_pins = pins;
        let now = self.now;
        self.gpio_changed(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USR: u32 = 1 << 24;
    const UPDATE: u32 = 1 << 23;
    const USR_MOSI: u32 = 1 << 27;
    const USR_MISO: u32 = 1 << 28;
    const SIO: u32 = 1 << 17;
    const CK_IDLE_EDGE: u32 = 1 << 29;

    /// Drives GP-SPI and GPIO registers the way M5GFX's Bus_SPI does on the S3 (3-wire, CS / D/C as GPIOs)
    struct M5 {
        b: SocBus,
        base: u32,
        pins: LcdPins,
    }

    impl M5 {
        fn new(kind: LcdKind, spec: &str, spi3: bool) -> M5 {
            let pins = LcdPins::parse(LcdPins::S3_DEFAULT, spec).unwrap();
            let mut b = SocBus::default();
            b.attach_lcd_pins(kind, pins);
            let mut m = M5 {
                b,
                base: if spi3 { 0x6002_5000 } else { 0x6002_4000 },
                pins,
            };
            let clk = if spi3 { SIG_SPI3_CLK } else { 101 };
            m.w(0x6000_4554 + 4 * pins.sclk as u32, clk);
            for p in [pins.cs, pins.dc] {
                m.output(p);
            }
            m.spi(0x30, 0);
            m.gpio(pins.cs, true);
            m.gpio(pins.cs, false);
            m
        }
        fn w(&mut self, a: u32, v: u32) {
            Bus::store(&mut self.b, a, 4, v).unwrap();
        }
        fn spi(&mut self, off: u32, v: u32) {
            let a = self.base + off;
            self.w(a, v);
        }
        /// Plain GPIO output (FUNCn_OUT_SEL = GPIO_OUT, ENABLE_W1TS)
        fn output(&mut self, p: u8) {
            self.w(0x6000_4554 + 4 * p as u32, 0x100);
            let en = if p < 32 { 0x6000_4024 } else { 0x6000_4030 };
            self.w(en, 1 << (p % 32));
        }
        fn gpio(&mut self, p: u8, high: bool) {
            let off = match (p < 32, high) {
                (true, true) => 0x08,
                (true, false) => 0x0c,
                (false, true) => 0x14,
                (false, false) => 0x18,
            };
            self.w(0x6000_4000 + off, 1 << (p % 32));
        }
        fn wait(&mut self) {
            while Bus::load(&mut self.b, self.base, 4).unwrap() & USR != 0 {
                self.b.update();
                self.b.now = self
                    .b
                    .next_event
                    .clamp(self.b.now + 1, self.b.now + 100_000);
            }
        }
        fn send(&mut self, dc: bool, b: u8) {
            self.wait();
            self.gpio(self.pins.dc, dc);
            self.spi(0x10, USR_MOSI);
            self.spi(0x1c, 7);
            self.spi(0x98, b as u32);
            self.spi(0, USR | UPDATE);
        }
        fn write_command(&mut self, c: u8) {
            self.send(false, c);
        }
        fn write_data(&mut self, d: &[u8]) {
            for b in d {
                self.send(true, *b);
            }
        }
        /// Bus_SPI::beginRead: a one-bit dummy is made by flipping CK_IDLE_EDGE and syncing it twice
        fn begin_read(&mut self, dummy: u32) {
            self.wait();
            self.gpio(self.pins.dc, true);
            self.spi(0x10, USR_MISO | SIO);
            self.spi(0x20, 0);
            self.spi(0, UPDATE);
            if dummy == 1 {
                self.spi(0x20, CK_IDLE_EDGE);
                self.spi(0, UPDATE);
                self.spi(0x20, 0);
                self.spi(0, UPDATE);
            } else if dummy > 1 {
                self.read_data(dummy);
            }
        }
        fn read_data(&mut self, bits: u32) -> u32 {
            self.spi(0x1c, bits - 1);
            self.spi(0, USR | UPDATE);
            self.wait();
            let v = Bus::load(&mut self.b, self.base + 0x98, 4).unwrap();
            v & ((1u64 << bits) - 1) as u32
        }
        fn end(&mut self) {
            self.wait();
            self.gpio(self.pins.cs, true);
            self.gpio(self.pins.cs, false);
        }
        /// M5GFX `_read_panel_id`: command, one idle-edge dummy bit, 32 bits
        fn read_id(&mut self, cmd: u8) -> u32 {
            self.write_command(cmd);
            self.begin_read(1);
            let id = self.read_data(32);
            self.end();
            id
        }
        /// M5GFX ILI9342 `read_param`: D9h = 0x10 | index, then the command read with one dummy bit
        fn read_param(&mut self, cmd: u8, idx: u8) -> u8 {
            self.write_command(0xd9);
            self.write_data(&[0x10 | idx]);
            self.write_command(cmd);
            self.begin_read(1);
            let v = self.read_data(8);
            self.end();
            ((v >> 1) & 0x7f) as u8
        }
    }

    const ATOMS3: &str = "sclk=17,mosi=21,cs=15,dc=33,rst=34,bl=16";
    const CORES3: &str = "sclk=36,mosi=37,miso=35,cs=3,dc=35,rst=-1,bl=-1";
    const CARDPUTER: &str = "sclk=36,mosi=35,cs=37,dc=34,rst=33,bl=38";

    #[test]
    fn rddid_matches_m5gfx_autodetect() {
        let id = M5::new(LcdKind::Gc9107, ATOMS3, false).read_id(0x04);
        assert_eq!(id & 0xff_ffff, 0x07_9100);
        let id = M5::new(LcdKind::St7735, ATOMS3, false).read_id(0x04);
        assert_eq!(id & 0xff, 0x7c);
        // AtomS3 / Cardputer are probed on SPI2 and re-initialised on SPI3; both hosts answer
        let id = M5::new(LcdKind::St7789Land, CARDPUTER, true).read_id(0x04);
        assert_eq!(id & 0xfb, 0x81);
        let id = M5::new(LcdKind::St7789, CARDPUTER, false).read_id(0x04);
        assert_eq!(id & 0xfb, 0x81);
        let dial = "sclk=6,mosi=5,cs=7,dc=4,rst=8";
        let id = M5::new(LcdKind::Gc9a01, dial, false).read_id(0x04);
        assert_eq!(id & 0xff_ffff, 0x01_9a00);
        for k in [LcdKind::Ili9342c, LcdKind::Ili9342e] {
            assert_eq!(M5::new(k, CORES3, false).read_id(0x04) & 0xff, 0xe3);
        }
        // Without the dummy clock the panel's own dummy bit leads: everything arrives one bit late
        let mut m = M5::new(LcdKind::Gc9107, ATOMS3, false);
        m.write_command(0x04);
        m.begin_read(0);
        assert_eq!(m.read_data(32), 0x8083_4800);
    }

    #[test]
    fn ili9342_c_and_e_told_apart() {
        for (kind, is_e) in [(LcdKind::Ili9342c, false), (LcdKind::Ili9342e, true)] {
            let mut m = M5::new(kind, CORES3, false);
            // M5GFX writes D9 00, DD 01, CB 1C; only the E stores DD / CB and reads them back through D9h
            for (c, d) in [(0xd9, 0x00), (0xdd, 0x01), (0xcb, 0x1c)] {
                m.write_command(c);
                m.write_data(&[d]);
            }
            m.end();
            let e = m.read_param(0xdd, 1) == 0x01 && m.read_param(0xcb, 1) == 0x1c;
            assert_eq!(e, is_e, "{kind:?}");
            if !is_e {
                // The EXTC key unlocks ID4 (D3h): 00 93 42
                m.write_command(0xc8);
                m.write_data(&[0xff, 0x93, 0x42]);
                m.end();
                assert_eq!(m.read_param(0xd3, 2), 0x93 & 0x7f);
                assert_eq!(m.read_param(0xd3, 3), 0x42);
            }
        }
    }

    #[test]
    fn window_write_lands_at_panel_offset() {
        let mut m = M5::new(LcdKind::Gc9107, ATOMS3, true);
        // AtomS3's backlight is PWM on GPIO16; a plain high level is enough here
        m.output(16);
        m.gpio(16, true);
        for (c, d) in [
            (0x11, &[][..]),
            (0x29, &[]),
            (0x36, &[0x08]),
            (0x3a, &[0x55]),
            // Glass row 0 is GRAM row 32 (M5GFX offset_y)
            (0x2a, &[0, 3, 0, 4]),
            (0x2b, &[0, 32, 0, 32]),
            (0x2c, &[0xf8, 0x00, 0x07, 0xe0]),
        ] {
            m.write_command(c);
            m.write_data(d);
        }
        m.end();
        assert!(m.b.spi3.transfers > 0);
        assert_eq!(m.b.spi2.transfers, 0);
        let Some(Lcd::Dcs(d)) = m.b.lcd.as_deref_mut() else {
            panic!("no panel")
        };
        assert_eq!(d.size(), (128, 128));
        assert_eq!(d.pixels, 2);
        let f = d.render();
        assert_eq!(&f[3 * 4..4 * 4], &[255, 0, 0, 255]);
        assert_eq!(&f[4 * 4..5 * 4], &[0, 255, 0, 255]);
        assert_eq!(d.lit_pixels(), 2);
    }
}
