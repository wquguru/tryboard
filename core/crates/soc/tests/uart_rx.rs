//! UART RX with more bytes than one hardware FIFO (F-07a): MicroPython raw-paste and long REPL lines.

use tryboard_soc::periph::{Uart, UART_FIFO_LEN};

const RXFIFO_FULL: u32 = 1;
const RXFIFO_TOUT: u32 = 1 << 8;

fn uart() -> Uart {
    let mut u = Uart::default();
    u.write(0x0c, RXFIFO_FULL | RXFIFO_TOUT);
    u
}

/// One ISR pass as IDF / MicroPython do it: read STATUS once, drain that many, clear the RX bits
fn isr_pass(u: &mut Uart) -> Vec<u8> {
    let n = u.read(0x1c) & 0x3ff;
    let got = (0..n).map(|_| u.read(0x00) as u8).collect();
    u.write(0x10, RXFIFO_FULL | RXFIFO_TOUT);
    got
}

#[test]
fn status_count_is_capped_at_fifo_depth() {
    let mut u = uart();
    u.push_rx(&[b'a'; 300]);
    assert_eq!(u.read(0x1c) & 0x3ff, UART_FIFO_LEN as u32);
    let mut small = uart();
    small.push_rx(b"ping\n");
    assert_eq!(small.read(0x1c) & 0x3ff, 5);
}

#[test]
fn clear_with_bytes_left_raises_the_interrupt_again() {
    let mut u = uart();
    let data: Vec<u8> = (0..300u32).map(|i| i as u8).collect();
    u.push_rx(&data);
    let mut got = Vec::new();
    let mut passes = 0;
    while u.irq() {
        got.extend(isr_pass(&mut u));
        passes += 1;
        assert!(passes < 10, "interrupt never settles");
    }
    assert_eq!(got, data);
    assert_eq!(passes, 3); // 128 + 128 + 44
    assert_eq!(u.int_raw & (RXFIFO_FULL | RXFIFO_TOUT), 0);
}

#[test]
fn clear_on_empty_fifo_stays_clear() {
    let mut u = uart();
    u.write(0x10, 0xffff_ffff);
    assert!(!u.irq());
    u.push_rx(b"x");
    assert!(u.irq());
    assert_eq!(isr_pass(&mut u), b"x");
    assert!(!u.irq());
}
