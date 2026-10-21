//! XPT2046 touch controller on HSPI / VSPI (F-10a2, CYD wires it to VSPI on 25 / 32 / 39 / 33): chip select and
//! the bit exchange with the model kept in `PinDevices::parts`

use super::*;
use spi_lcd::Host;
use tryboard_soc::gpspi::Plan;
use tryboard_soc::gpspi_classic::reg;

/// GPIO matrix CS0 output signals (gpio_sig_map.h) and IO_MUX function 1 on the direct CS pins 15 / 5
const SIG_HSPICS0: u32 = 11;
const SIG_VSPICS0: u32 = 68;
const IOMUX_FUNC_SPI: u32 = 1;
/// SPI_USER_REG.DOUTDIN: MISO is sampled during the MOSI phase
const USER_DOUTDIN: u32 = 1;

impl SocBus {
    /// Bits clocked on host `h` go to an attached, selected XPT2046; returns its DOUT bytes (None = not selected).
    /// CS routed to the host's CS0 follows CS0_DIS; a plain GPIO CS must be driven low
    pub(crate) fn xpt2046_exchange(&mut self, h: Host, p: &Plan, data: &[u8]) -> Option<Vec<u8>> {
        let pin = self.pins.parts.xpt2046.as_ref()?.cs as usize;
        let sig = self.gpio.func_out.get(pin).map_or(u32::MAX, |f| f & 0x1ff);
        let iomux = self.gpio.iomux.get(pin).map_or(u32::MAX, |r| (r >> 12) & 7);
        let (hw_host, direct) = match h {
            Host::Hspi => (SIG_HSPICS0, 15),
            Host::Vspi => (SIG_VSPICS0, 5),
        };
        let by_spi = sig == hw_host || (pin == direct && iomux == IOMUX_FUNC_SPI);
        if [SIG_HSPICS0, SIG_VSPICS0].contains(&sig) && !by_spi {
            return None;
        }
        let selected = if by_spi {
            self.spi(h).cs0_enabled()
        } else {
            self.gpio.enable >> pin & 1 != 0 && self.gpio.level() >> pin & 1 == 0
        };
        if !selected {
            return None;
        }
        let release = by_spi && !self.spi(h).cs_keep_active();
        let full = self.spi(h).regs[(reg::USER / 4) as usize] & USER_DOUTDIN != 0;
        let t = self.pins.parts.xpt2046.as_mut()?;
        let n = p.miso_bits.div_ceil(8) as usize;
        let rx = t.transfer(&p.head, p.head_bits, p.dummy_bits, data, n, full);
        if release {
            t.cs_release();
        }
        Some(rx)
    }
}
