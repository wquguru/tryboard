//! RC522 reader on SPI2 (F-04d): its chip select and the byte exchange with the model kept in `PinDevices::parts`

use super::*;
use tryboard_soc::gpspi::Plan;

impl SocBus {
    /// Bytes clocked out this transfer go to an attached, selected RC522; returns its MISO bytes (None = not selected).
    /// CS routed to FSPICSn (IO_MUX on GPIO10 or the GPIO matrix) follows CSn_DIS; a plain GPIO CS must be driven low
    pub(crate) fn rc522_exchange(&mut self, p: &Plan, bytes: &[u8]) -> Option<Vec<u8>> {
        let pin = self.pins.parts.rc522.as_ref()?.cs as usize;
        let sig = self.gpio.func_out[pin] & 0xff;
        let line = if pin == 10 && (self.gpio.iomux[pin] >> 12) & 7 == IOMUX_FUNC_FSPICS0 {
            Some(0)
        } else {
            (SIG_FSPICS0..SIG_FSPICS0 + 6)
                .contains(&sig)
                .then(|| sig - SIG_FSPICS0)
        };
        let selected = match line {
            Some(n) => self.spi2.cs_enabled(n),
            None => self.gpio.enable >> pin & 1 != 0 && self.gpio.level() >> pin & 1 == 0,
        };
        if !selected {
            return None;
        }
        let release = line.is_some() && !self.spi2.cs_keep_active();
        let r = self.pins.parts.rc522.as_mut()?;
        let n = p.head.len().min(bytes.len());
        let rx = r.transfer(&bytes[..n], &bytes[n..], p.miso_bits.div_ceil(8) as usize);
        if release {
            r.cs_release();
        }
        Some(rx)
    }
}
