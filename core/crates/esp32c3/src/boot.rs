//! Direct boot: load the ROM (esp-rom-elfs), parse the flash image, map the app the way the 2nd-stage bootloader does,
//! plus registers that must read back specific values during boot.

use crate::*;
use tryboard_rv32::elf::Elf;
pub use tryboard_soc::boot::find_app;
use tryboard_soc::boot::u32at;

/// eFuse read registers (0x200 bytes from 0x60008800).
/// BLK1 (from RD_MAC_SPI_SYS_0): MAC, wafer version v0.4 (field positions in esp_efuse_table.csv).
pub fn default_efuse() -> [u32; 0x200 / 4] {
    let mut e = [0u32; 0x200 / 4];
    let blk1 = 0x44 / 4;
    // MAC 02:54:42:00:00:01 (locally administered, so we don't borrow Espressif's OUI); stored byte-reversed in eFuse
    let mac = [0x02u8, 0x54, 0x42, 0x00, 0x00, 0x01];
    e[blk1] = u32::from_le_bytes([mac[5], mac[4], mac[3], mac[2]]);
    e[blk1 + 1] = u32::from_le_bytes([mac[1], mac[0], 0, 0]);
    // WAFER_VERSION_MINOR_LO = 4 (BLK1 bits 114..116 -> word 3 bits 18..20); FLASH_CAP left empty
    e[blk1 + 3] |= 4 << 18;
    // STATUS: read done, idle
    e[0x1d0 / 4] = 0x1;
    e[0x1fc / 4] = 0x2007200;
    // Typical-chip ADC calibration (BLK2 v1) so curve-fitting cali works like on a real board
    tryboard_soc::adc::burn_efuse(tryboard_soc::adc::AdcChip::C3, &mut e);
    e
}

/// Registers that must return specific values during boot (or polling loops spin forever). None = generic readback.
pub fn special_read(a: u32, now: u64) -> Option<u32> {
    Some(match a {
        // RTC_CNTL_TIME_UPDATE: bit30 TIME_VALID
        0x6000_800c => 1 << 30,
        // RTC slow clock counter (about 136kHz)
        0x6000_8010 => (now * 136_000 / CPU_HZ) as u32,
        0x6000_8014 => ((now * 136_000 / CPU_HZ) >> 32) as u32,
        // RTC_CNTL_RESET_STATE: power-on reset (1)
        _ => return None,
    })
}

/// Writes with side effects that need no stored value. true = handled (not counted as unimpl).
pub fn special_write(_a: u32, _v: u32) -> bool {
    false
}

/// Load the ROM ELF into ROM space and ROM .data initial values into DRAM (replaces the copy the ROM startup code does).
pub fn load_rom(m: &mut Esp32c3, elf_bytes: &[u8]) -> Result<(), String> {
    let elf = Elf::parse(elf_bytes)?;
    for s in &elf.sections {
        if s.kind != 1 || s.addr == 0 || s.data.is_empty() {
            continue;
        }
        let a = s.addr;
        if (ROM_LOW..ROM_HIGH).contains(&a) {
            let o = (a - ROM_LOW) as usize;
            m.bus.rom[o..o + s.data.len()].copy_from_slice(&s.data);
        } else if (DROM_MASK_LOW..DROM_MASK_HIGH).contains(&a) {
            let o = (a + DROM_MASK_TO_ROM - ROM_LOW) as usize;
            m.bus.rom[o..o + s.data.len()].copy_from_slice(&s.data);
        } else if (DRAM_LOW..DRAM_HIGH).contains(&a) {
            for (i, b) in s.data.iter().enumerate() {
                m.bus.mem_write(a + i as u32, 1, *b as u32);
            }
        }
    }
    for (name, addr, _) in &elf.symbols {
        if (ROM_LOW..ROM_HIGH).contains(addr) {
            m.rom_symbols.entry(*addr).or_insert_with(|| name.clone());
        }
    }
    // Init the (skipped) ROM startup code would do:
    // 1. hook ets_printf output to the UART (equivalent to ets_install_uart_printf)
    let sym = |n: &str| elf.symbol(n).ok_or(format!("symbol {n} not found in ROM"));
    m.bus
        .mem_write(sym("_putc1")?, 4, sym("ets_write_char_uart")?);
    // 2. ROM prints go to UART (g_uart_print=1), not USB-Serial-JTAG (g_usb_print=0, only enabled when USB is plugged in)
    m.bus.mem_write(sym("g_uart_print")?, 1, 1);
    m.bus.mem_write(sym("g_usb_print")?, 1, 0);
    // HLE intercept table
    for (name, kind) in crate::hle::TABLE {
        m.hle.insert(sym(name)?, *kind);
    }
    let mut addrs: Vec<u32> = m.hle.keys().copied().collect();
    addrs.sort();
    m.cpu.hle_lo = ROM_LOW;
    m.cpu.hle_hi = ROM_HIGH;
    m.cpu.hle_addrs = addrs;
    // Clock info the ROM writes into RTC store registers at boot (rom/rtc.h: RTC_XTAL_FREQ_REG = STORE4, RTC_APB_FREQ_REG = STORE5, both halfwords equal)
    m.bus.regs.insert(0x6000_80B8, 0x0028_0028);
    let apb = 80_000_000u32 >> 12;
    m.bus.regs.insert(0x6000_80BC, apb | (apb << 16));
    Ok(())
}

/// The 2nd-stage bootloader fills the ROM's flash chip descriptor (esp_rom_spiflash_chip_t) from the image header.
fn init_flashchip(m: &mut Esp32c3, size_code: u8, jedec: u32) -> Result<(), String> {
    // rom_spiflash_legacy_data (esp32c3.rom.ld) is a pointer to a struct in ROM .data
    let p = m
        .bus
        .mem_read(0x3FCD_FFF0, 4)
        .ok_or("cannot read rom_spiflash_legacy_data")?;
    let size = match size_code {
        0 => 1 << 20,
        1 => 2 << 20,
        2 => 4 << 20,
        3 => 8 << 20,
        4 => 16 << 20,
        _ => 4 << 20,
    };
    let id = ((jedec & 0xff) << 16) | (jedec & 0xff00) | ((jedec >> 16) & 0xff);
    for (i, v) in [id, size, 64 << 10, 4 << 10, 256, 0xffff]
        .iter()
        .enumerate()
    {
        m.bus
            .mem_write(p + 4 * i as u32, 4, *v)
            .ok_or("failed to write g_rom_flashchip")?;
    }
    Ok(())
}

#[derive(Debug)]
pub struct AppInfo {
    pub offset: u32,
    pub entry: u32,
    pub segments: Vec<(u32, u32, u32)>, // (load addr, flash offset of data, len)
}

pub fn parse_app(flash: &[u8], off: u32) -> Result<AppInfo, String> {
    let o = off as usize;
    if flash.get(o) != Some(&0xE9) {
        return Err(format!("no ESP image at 0x{off:x} (bad magic)"));
    }
    let nseg = flash[o + 1] as usize;
    let entry = u32at(flash, o + 4);
    let chip_id = u16::from_le_bytes([flash[o + 12], flash[o + 13]]);
    if chip_id != 5 {
        return Err(format!("image chip ID is {chip_id}, not ESP32-C3 (5)"));
    }
    let mut p = o + 24;
    let mut segments = Vec::new();
    for _ in 0..nseg {
        let load = u32at(flash, p);
        let len = u32at(flash, p + 4);
        segments.push((load, (p + 8) as u32, len));
        p += 8 + len as usize;
    }
    Ok(AppInfo {
        offset: off,
        entry,
        segments,
    })
}

impl Esp32c3 {
    /// Create a machine: load ROM and flash, do the bootloader's job, PC stops at the app entry.
    pub fn boot(rom_elf: &[u8], flash: Vec<u8>) -> Result<(Esp32c3, AppInfo), String> {
        let mut m = Esp32c3 {
            cpu: Cpu::new(),
            bus: SocBus::default(),
            rom_symbols: HashMap::new(),
            hle: HashMap::new(),
            rom_elf: rom_elf.to_vec(),
        };
        load_rom(&mut m, rom_elf)?;
        let mut flash = flash;
        // Pad to 4MB so the app probing flash size / reading partitions doesn't go out of bounds
        if flash.len() < 4 << 20 {
            flash.resize(4 << 20, 0xff);
        }
        let off = find_app(&flash)?;
        let app = parse_app(&flash, off)?;
        for &(load, data, len) in &app.segments {
            let in_flash =
                (IROM_LOW..IROM_HIGH).contains(&load) || (DROM_LOW..DROM_HIGH).contains(&load);
            if in_flash {
                // 64KB page mapping: vaddr and flash offset share the in-page offset
                if load & 0xffff != data & 0xffff {
                    return Err(format!(
                        "segment 0x{load:08x} and flash offset 0x{data:x} differ in page offset"
                    ));
                }
                let first = ((load & 0x7f_ffff) >> 16) as usize;
                let last = (((load + len - 1) & 0x7f_ffff) >> 16) as usize;
                for (i, page) in (first..=last).enumerate() {
                    m.bus.mmu[page] = (data >> 16) + i as u32;
                }
            } else if load < 0x1000_0000 {
                // esptool padding segments use load address 0; the bootloader skips anything below 0x1000_0000
                continue;
            } else {
                for i in 0..len {
                    let b = flash[(data + i) as usize] as u32;
                    if m.bus.mem_write(load + i, 1, b).is_none() {
                        return Err(format!(
                            "segment 0x{load:08x} lands in a non-writable region"
                        ));
                    }
                }
            }
        }
        let size_code = flash[off as usize + 3] >> 4;
        m.bus.flash = flash;
        let jedec = m.bus.spi1.jedec;
        init_flashchip(&mut m, size_code, jedec)?;
        install_ble(&mut m, &app);
        m.cpu.pc = app.entry;
        // The C3 handles misaligned accesses in hardware (the Wi-Fi library writes 32-bit sentinels to misaligned addresses)
        m.cpu.misaligned_ok = true;
        // Top of the ROM's .stack_pro: the stack the bootloader uses when jumping into the app
        m.cpu.x[2] = 0x3FCD_E710;
        Ok((m, app))
    }
}

/// BLE (C-01): find the VHCI boundary by signature and, if found, install fetch trampolines and magic addresses
fn install_ble(m: &mut Esp32c3, app: &AppInfo) {
    let flash = &m.bus.flash;
    let segs: Vec<(u32, &[u8])> = app
        .segments
        .iter()
        .filter_map(|&(load, data, len)| {
            flash
                .get(data as usize..(data + len) as usize)
                .map(|b| (load, b))
        })
        .collect();
    match crate::ble::locate(&segs) {
        Ok(None) => {}
        Ok(Some(hooks)) => {
            // BT address = base MAC + 2 (esp_read_mac's ESP_MAC_BT rule); HCI byte order is little-endian
            let blk1 = 0x44 / 4;
            let (lo, hi) = (m.bus.efuse[blk1], m.bus.efuse[blk1 + 1]);
            let mut mac = [0u8; 6];
            mac[..4].copy_from_slice(&lo.to_le_bytes());
            mac[4..].copy_from_slice(&hi.to_le_bytes()[..2]);
            let v = u64::from_le_bytes([mac[0], mac[1], mac[2], mac[3], mac[4], mac[5], 0, 0]) + 2;
            let mut addr = [0u8; 6];
            addr.copy_from_slice(&v.to_le_bytes()[..6]);
            let b = crate::ble::BleHle::new(hooks, addr);
            m.bus.code_patch = b.patches();
            m.bus.ble = Some(Box::new(b));
            m.cpu.hle_hi = crate::ble::MAGIC_END;
            m.cpu.hle_addrs.extend(crate::ble::BleHle::magic_addrs());
            m.cpu.hle_addrs.sort_unstable();
        }
        Err(e) => m.bus.ble_error = Some(e),
    }
}
