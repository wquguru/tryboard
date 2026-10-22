use super::*;

#[test]
fn mmu_flash_and_psram() {
    let mut b = SocBus {
        flash: vec![0; 1 << 20],
        ..Default::default()
    };
    b.flash[0x2_0004] = 0xab;
    b.psram[0x1_0008] = 0xcd;
    // DROM 0x3C010000 -> flash page 2; DROM 0x3C800000 (linear page 128) -> PSRAM page 1
    b.mmu[1] = 2;
    b.mmu[128] = MMU_PSRAM | 1;
    assert_eq!(b.mem_read(0x3C01_0004, 1), Some(0xab));
    assert_eq!(b.mem_read(0x3C80_0008, 1), Some(0xcd));
    // PSRAM writable, flash mapping not
    assert!(b.mem_write(0x3C80_0000, 4, 0x1234_5678).is_some());
    assert!(b.mem_write(0x3C01_0000, 4, 1).is_none());
    // Invalid page
    assert_eq!(b.mem_read(0x3C02_0000, 4), None);
}

#[test]
fn software_reset_bits() {
    let mut b = SocBus::default();
    // Core 1 reset: only set a flag; the stored value has no reset bit (read-modify-write won't retrigger)
    Bus::store(&mut b, 0x6000_8000, 4, 0x10 | 0x4).unwrap();
    assert!(b.appcpu_reset && b.reset_request.is_none());
    assert_eq!(Bus::load(&mut b, 0x6000_8000, 4).unwrap(), 0x4);
    // Core 0 reset = full power-up, reason 12 (RTC_SW_CPU_RST); system reset reason 3
    Bus::store(&mut b, 0x6000_8000, 4, 0x20).unwrap();
    assert_eq!(b.reset_request, Some(12));
    Bus::store(&mut b, 0x6000_8000, 4, 1 << 31).unwrap();
    assert_eq!(b.reset_request, Some(3));
    b.reset_reason = 12;
    assert_eq!(
        Bus::load(&mut b, RTC_CNTL_RESET_STATE, 4).unwrap() & 0xfff,
        12 | (12 << 6)
    );
}

#[test]
fn psram_via_spi1_cs1() {
    let mut b = SocBus::default();
    // MISC: CS0 off, CS1 on; read MR1 (vendor ID)
    Bus::store(&mut b, 0x6000_2034, 4, 1).unwrap();
    Bus::store(&mut b, 0x6000_2018, 4, (1 << 31) | (1 << 30) | (1 << 28)).unwrap();
    Bus::store(&mut b, 0x6000_2020, 4, (15 << 28) | 0x4040).unwrap();
    Bus::store(&mut b, 0x6000_2004, 4, 0).unwrap();
    Bus::store(&mut b, 0x6000_2028, 4, 15).unwrap();
    Bus::store(&mut b, 0x6000_2000, 4, 1 << 18).unwrap();
    assert_eq!(
        (Bus::load(&mut b, 0x6000_2058, 4).unwrap() >> 8) & 0xff,
        0x0d
    );
    // Chip select back to CS0: the same command goes to flash, PSRAM untouched
    let n = b.psram_chip.commands;
    Bus::store(&mut b, 0x6000_2034, 4, 2).unwrap();
    Bus::store(&mut b, 0x6000_2000, 4, 1 << 18).unwrap();
    assert_eq!(b.psram_chip.commands, n);
}

#[test]
fn sram_aliases() {
    let mut b = SocBus::default();
    b.mem_write(0x3FC8_8000, 4, 0xdead_beef).unwrap();
    assert_eq!(b.mem_read(0x4037_8000, 4), Some(0xdead_beef));
    // SRAM2 is on the D bus only
    b.mem_write(0x3FCF_0000, 4, 7).unwrap();
    assert_eq!(b.mem_read(0x3FCF_0000, 4), Some(7));
}

#[test]
fn intmatrix_routes_level_and_edge() {
    let mut m = Intmatrix::default();
    let mut lv = [0u64; 2];
    lv[(src::SYSTIMER_TARGET0 / 64) as usize] |= 1 << (src::SYSTIMER_TARGET0 % 64);
    // Map to level line 9
    m.map[src::SYSTIMER_TARGET0 as usize] = 9;
    assert_eq!(m.lines(&lv), (1 << 9, 0));
    // Map to edge line 10: rising edge reported only on first appearance
    m.map[src::SYSTIMER_TARGET0 as usize] = 10;
    assert_eq!(m.lines(&lv), (0, 1 << 10));
    assert_eq!(m.lines(&lv), (0, 0));
    // Reset-value mapping to line 16 (timer line) means unconnected
    assert_eq!(Intmatrix::default().lines(&lv), (0, 0));
}

/// Encoder -> GPIO6/7 -> GPIO matrix -> PCNT unit 0 (same config as IDF rotary_encoder); HC-SR04 -> GPIO18 -> RMT RX channel 0
#[test]
fn encoder_into_pcnt_and_sonar_into_rmt_rx() {
    let mut b = SocBus::default();
    let w = |b: &mut SocBus, a: u32, v: u32| Bus::store(b, a, 4, v).unwrap();
    // FUNCn_IN_SEL_CFG (0x60004154 + 4n): signals 33..36 = A, B, B, A, via matrix
    for (sig, pin) in [(33, 6), (34, 7), (35, 7), (36, 6)] {
        w(&mut b, 0x6000_4154 + 4 * sig, pin | 1 << 7);
    }
    let ch0 = 1 | (2 << 2) | (1 << 6);
    let ch1 = 2 | (1 << 2) | (1 << 6);
    w(
        &mut b,
        0x6001_7000,
        (1 << 10) | 80 | (7 << 11) | (ch0 << 16) | (ch1 << 24),
    );
    w(&mut b, 0x6001_7060, 0);
    let now = b.now;
    b.pins
        .encoders
        .push(tryboard_soc::devices::pins::Encoder::new(6, 7, None, now));
    let run = |b: &mut SocBus, until: u64| {
        while b.now < until {
            b.update();
            b.now = b.next_event.min(until).max(b.now + 1);
        }
    };
    run(&mut b, 1000);
    b.pins.encoders[0].turn(b.now, 3);
    run(&mut b, CPU_HZ / 50);
    assert_eq!(Bus::load(&mut b, 0x6001_7030, 4).unwrap(), 12);
    b.pins.encoders[0].turn(b.now, -5);
    run(&mut b, CPU_HZ / 20);
    assert_eq!(Bus::load(&mut b, 0x6001_7030, 4).unwrap() as u16 as i16, -8);

    // Ultrasonic: signal 81 = GPIO18; 1 MHz resolution, 25 ms idle
    w(&mut b, 0x6000_4154 + 4 * 81, 18 | 1 << 7);
    w(&mut b, 0x6001_60c0, 0x0500_0000);
    w(&mut b, 0x6001_6030, 80 | (25000 << 8) | (1 << 24));
    w(&mut b, 0x6001_6034, 1 | 2 | (1 << 3));
    let now = b.now;
    b.pins
        .sonars
        .push(tryboard_soc::devices::pins::Hcsr04::new(17, 18, now));
    b.pins.sonars[0].distance_cm = Some(40.0);
    // Trig: GPIO17 outputs a 12 us high pulse
    w(&mut b, 0x6000_4020, 1 << 17);
    w(&mut b, 0x6000_4008, 1 << 17);
    let t = b.now + 12 * CPU_HZ / 1_000_000;
    run(&mut b, t);
    w(&mut b, 0x6000_400c, 1 << 17);
    let t = b.now + CPU_HZ / 20;
    run(&mut b, t);
    assert!(
        Bus::load(&mut b, 0x6001_6070, 4).unwrap() & (1 << 16) != 0,
        "RX_END"
    );
    let item = Bus::load(&mut b, 0x6001_6800 + 4 * 4 * 48, 4).unwrap();
    // 40 cm → 2332.4 µs
    assert_eq!(item & 0x7fff, 2332);
    assert_eq!(item >> 15 & 1, 1);
}
