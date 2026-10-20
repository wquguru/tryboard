//! USB-Serial-JTAG console routing: drop the copy of UART0 output that IDF's secondary console repeats

use super::*;

/// USJ bytes within 2 ms of a UART0 byte count as the IDF secondary-console mirror (see `usj_route`)
const USJ_MIRROR_WINDOW: u64 = CPU_HZ / 500;
/// Bytes a mirrored USJ packet may run ahead of UART0
const USJ_MIRROR_LAG: usize = 16;

impl SocBus {
    /// Hand bytes the USJ host received to the console. IDF's default secondary console polls USJ (no interrupts)
    /// and repeats what UART0 prints: such packets are dropped so each line shows once.
    pub(crate) fn usj_route(&mut self) {
        if self.usj.flushed.is_empty() {
            return;
        }
        let data = std::mem::take(&mut self.usj.flushed);
        let recent = self
            .last_uart0_tx
            .is_some_and(|t| self.now.saturating_sub(t) < USJ_MIRROR_WINDOW);
        if !(self.usj.int_ena == 0 && recent && self.uart0_echoes(&data)) {
            self.console.extend_from_slice(&data);
        }
    }

    /// UART0 recently printed this packet's text. Line ends are ignored and a few trailing bytes may still be
    /// on their way to UART0 (the ROM putc reaches USJ first when both consoles are on).
    fn uart0_echoes(&self, data: &[u8]) -> bool {
        let d: Vec<u8> = data
            .iter()
            .copied()
            .filter(|b| !matches!(b, b'\r' | b'\n'))
            .collect();
        let head = &d[..d.len() - (d.len() / 2).min(USJ_MIRROR_LAG)];
        head.is_empty() || self.uart0_recent.windows(head.len()).any(|w| w == head)
    }
}
