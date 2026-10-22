//! Direct boot (classic ESP32): load ROM (esp32_rev300_rom.elf from esp-rom-elfs), parse the flash image and map
//! the app like the 2nd-stage bootloader. Same flow as S3 (see crates/esp32s3/src/boot.rs); only addresses differ.

use crate::*;
use tryboard_rv32::elf::Elf;
use tryboard_xtensa::{Variant, PS_UM, PS_WOE};

pub use tryboard_soc::boot::find_app;

/// Chip ID in the image header (esp_app_format.h: ESP_CHIP_ID_ESP32)
pub const CHIP_ID: u16 = 0;

/// ROM's flash chip descriptor g_rom_flashchip (esp32.rom.ld)
const G_ROM_FLASHCHIP: u32 = 0x3FFA_E270;

pub fn load_rom(m: &mut Esp32, elf_bytes: &[u8]) -> Result<(), String> {
    let elf = Elf::parse(elf_bytes)?;
    for s in &elf.sections {
        if s.kind != 1 || s.addr == 0 || s.data.is_empty() {
            continue;
        }
        let a = s.addr;
        if (ROM_LOW..ROM_HIGH).contains(&a) {
            let o = (a - ROM_LOW) as usize;
            m.bus.rom[o..o + s.data.len()].copy_from_slice(&s.data);
        } else if (DROM1_LOW..DROM1_HIGH).contains(&a) {
            let o = 0x70000 + (a - DROM1_LOW) as usize;
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
    let sym = |n: &str| elf.symbol(n).ok_or(format!("ROM has no symbol {n}"));
    // Route ets_printf to UART (what ets_install_uart_printf does)
    m.bus
        .mem_write(sym("_putc1")?, 4, sym("ets_write_char_uart")?);
    for (name, kind) in crate::hle::TABLE {
        let a = elf
            .symbol(name)
            .or_else(|| elf.symbol(&format!("__call_{name}")))
            .ok_or(format!("ROM has no symbol {name}"))?;
        m.hle.insert(a, *kind);
    }
    let mut addrs: Vec<u32> = m.hle.keys().copied().collect();
    addrs.sort();
    m.cpu.hle_lo = ROM_LOW;
    m.cpu.hle_hi = ROM_HIGH;
    m.cpu.hle_addrs = addrs;
    // RTC_XTAL_FREQ_REG = STORE4 (0xB0), RTC_APB_FREQ_REG = STORE5 (0xB4); high and low halfwords equal, as IDF expects
    m.bus.regs.insert(RTC_CNTL + 0xb0, 0x0028_0028);
    let apb = 80_000_000u32 >> 12;
    m.bus.regs.insert(RTC_CNTL + 0xb4, apb | (apb << 16));
    // Per-core ROM "ticks per us" (written by ets_update_cpu_frequency, read by esp_rom_delay_us): 160 MHz at bootloader handoff
    for s in ["g_ticks_per_us_pro", "g_ticks_per_us_app"] {
        if let Some(a) = elf.symbol(s) {
            m.bus.mem_write(a, 4, 160);
        }
    }
    Ok(())
}

/// The 2nd-stage bootloader fills ROM's flash chip descriptor (esp_rom_spiflash_chip_t) from the image header
fn init_flashchip(m: &mut Esp32, size: usize, jedec: u32) -> Result<(), String> {
    let id = ((jedec & 0xff) << 16) | (jedec & 0xff00) | ((jedec >> 16) & 0xff);
    for (i, v) in [id, size as u32, 64 << 10, 4 << 10, 256, 0xffff]
        .iter()
        .enumerate()
    {
        m.bus
            .mem_write(G_ROM_FLASHCHIP + 4 * i as u32, 4, *v)
            .ok_or("failed to write g_rom_flashchip")?;
    }
    Ok(())
}

#[derive(Debug)]
pub struct AppInfo {
    pub offset: u32,
    pub entry: u32,
    pub segments: Vec<(u32, u32, u32)>,
}

fn u32at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

pub fn parse_app(flash: &[u8], off: u32) -> Result<AppInfo, String> {
    let o = off as usize;
    if flash.get(o) != Some(&0xE9) {
        return Err(format!("no ESP image at 0x{off:x} (bad magic)"));
    }
    let nseg = flash[o + 1] as usize;
    let entry = u32at(flash, o + 4);
    let chip_id = u16::from_le_bytes([flash[o + 12], flash[o + 13]]);
    if chip_id != CHIP_ID {
        return Err(format!("image chip ID is {chip_id}, not ESP32 ({CHIP_ID})"));
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

/// The app's esp_flash probe compares the JEDEC capacity byte (log2 of bytes) with the image header size,
/// so the modelled part grows with the header (never below the 4MB the flash buffer is padded to)
pub fn jedec_for_size(jedec: u32, size: usize) -> u32 {
    (jedec & 0xffff) | size.max(4 << 20).trailing_zeros() << 16
}

fn flash_size(code: u8) -> usize {
    match code {
        0 => 1 << 20,
        1 => 2 << 20,
        2 => 4 << 20,
        3 => 8 << 20,
        4 => 16 << 20,
        _ => 4 << 20,
    }
}

/// Overflow save area the entry frame's "caller sp" points at: borrows ROM's level 5 / 4 interrupt stacks (_Pri_5_Stack /
/// _Pri_4_Stack). IDF marks them as startup stack and only adds them to the heap once the scheduler runs, when the entry frame can no longer spill
const SPILL_PRO: u32 = 0x3FFE_0DC0 + 64;
const SPILL_APP: u32 = 0x3FFE_0860 + 64;
/// Tops of ROM's .stack_pro / .stack_app (__stack / __stack_app)
const STACK_PRO: u32 = 0x3FFE_3F20;
const STACK_APP: u32 = 0x3FFE_7E30;

/// Enter a windowed-ABI function with CALLINC=0 (see the S3 function of the same name for why)
fn enter_windowed(
    c: &mut Cpu,
    bus: &mut SocBus,
    entry: u32,
    stack: u32,
    spill: u32,
) -> Result<(), String> {
    c.windowbase = 0;
    c.windowstart = 1;
    c.set_a(1, stack);
    c.set_a(0, 0);
    c.write_sr(sr::PS, PS_WOE | PS_UM);
    c.pc = entry;
    let first = bus.fetch(entry).unwrap_or(0);
    if first & 0xff == 0x36 {
        c.step(bus);
        let sp = c.a(1);
        bus.mem_write(sp.wrapping_sub(12), 4, spill)
            .ok_or("failed to write entry frame save area")?;
    }
    Ok(())
}

impl Esp32 {
    pub fn start_app_cpu(&mut self, entry: u32) {
        let mut c = Cpu::with_variant(Variant::Lx6Esp32);
        c.prid = 0xabab;
        c.cycles = self.cpu.cycles;
        if enter_windowed(&mut c, &mut self.bus, entry, STACK_APP, SPILL_APP).is_ok() {
            c.hle_lo = self.cpu.hle_lo;
            c.hle_hi = self.cpu.hle_hi;
            c.hle_addrs = self.cpu.hle_addrs.clone();
            self.cpu1 = c;
            self.cpu1_on = true;
        }
    }

    /// Build a machine: load ROM and flash, do the bootloader's job, and stop with PC at the app entry (call_start_cpu0)
    pub fn boot(rom_elf: &[u8], flash: Vec<u8>) -> Result<(Esp32, AppInfo), String> {
        Self::boot_with(rom_elf, flash, SocBus::default())
    }

    fn boot_with(rom_elf: &[u8], flash: Vec<u8>, bus: SocBus) -> Result<(Esp32, AppInfo), String> {
        let mut cpu = Cpu::with_variant(Variant::Lx6Esp32);
        cpu.prid = 0xcdcd;
        let mut cpu1 = Cpu::with_variant(Variant::Lx6Esp32);
        cpu1.prid = 0xabab;
        let mut m = Esp32 {
            cpu,
            cpu1,
            cpu1_on: false,
            bus,
            rom_symbols: HashMap::new(),
            hle: HashMap::new(),
            rom_elf: rom_elf.to_vec(),
        };
        load_rom(&mut m, rom_elf)?;
        let mut flash = flash;
        let off = find_app(&flash)?;
        let size_code = flash.get(off as usize + 3).map(|b| b >> 4).unwrap_or(2);
        let size = flash_size(size_code).max(4 << 20);
        if flash.len() < size {
            flash.resize(size, 0xff);
        }
        let app = parse_app(&flash, off)?;
        for &(load, data, len) in &app.segments {
            let in_cache =
                (IROM_LOW..IROM_HIGH).contains(&load) || (DROM_LOW..DROM_HIGH).contains(&load);
            if in_cache {
                if load & 0xffff != data & 0xffff {
                    return Err(format!(
                        "segment 0x{load:08x} and flash offset 0x{data:x} differ within the page"
                    ));
                }
                let entry_of = |v: u32| {
                    if v < DROM_HIGH {
                        ((v - DROM_LOW) >> 16) as usize
                    } else {
                        64 + ((v - ROM_LOW) >> 16) as usize
                    }
                };
                let (first, last) = (entry_of(load), entry_of(load + len - 1));
                for (i, e) in (first..=last).enumerate() {
                    m.bus.mmu[e] = (data >> 16) + i as u32;
                    m.bus.mmu_app[e] = (data >> 16) + i as u32;
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
        m.bus.flash = flash;
        let jedec = jedec_for_size(m.bus.spi1.inner.jedec, size);
        m.bus.spi1.inner.jedec = jedec;
        init_flashchip(&mut m, flash_size(size_code), jedec)?;
        install_ble(&mut m, &app);
        enter_windowed(&mut m.cpu, &mut m.bus, app.entry, STACK_PRO, SPILL_PRO)?;
        Ok((m, app))
    }

    /// Power back up after a software reset (keeps the same state as S3's reboot)
    pub fn reboot(&mut self, reason: u32) -> Result<(), String> {
        let old = &mut self.bus;
        let mut bus = SocBus {
            rtc_slow: std::mem::take(&mut old.rtc_slow),
            rtc_fast: std::mem::take(&mut old.rtc_fast),
            reset_reason: reason,
            ..SocBus::default()
        };
        for a in RTC_STORE_KEEP {
            if let Some(v) = old.regs.get(&a) {
                bus.regs.insert(a, *v);
            }
        }
        bus.gpio.ext_in = old.gpio.ext_in;
        bus.gpio.ext_driven = old.gpio.ext_driven;
        bus.adc.pin_mv = old.adc.pin_mv;
        bus.i2c0.devices = std::mem::take(&mut old.i2c0.devices);
        bus.i2c1.devices = std::mem::take(&mut old.i2c1.devices);
        // Pin buses (bench wiring, M5-02) are outside world too; their pull-ups rejoin the board's
        bus.i2c_pins = old.i2c_pins.carry();
        bus.gpio.board_pullup |= bus.i2c_pins.pullups();
        bus.gpio_log = std::mem::take(&mut old.gpio_log);
        bus.iotrace = old.iotrace.carry();
        bus.ws2812 = std::mem::take(&mut old.ws2812);
        bus.pins = std::mem::take(&mut old.pins);
        bus.audio = std::mem::take(&mut old.audio);
        // Board facts survive a reset: package eFuse, revision marker, PSRAM chip (its contents stay powered)
        bus.efuse = old.efuse;
        bus.chip_v3 = old.chip_v3;
        bus.spi1.psram = std::mem::take(&mut old.spi1.psram);
        let flash = std::mem::take(&mut old.flash);
        let rom = std::mem::take(&mut self.rom_elf);
        let (mut m, _) = Esp32::boot_with(&rom, flash, bus)?;
        // The virtual phone is outside world: survives reset (connection drops with the chip), air log continues
        if let (Some(old), Some(new)) = (self.bus.ble.hle.as_mut(), m.bus.ble.hle.as_mut()) {
            std::mem::swap(&mut old.world, &mut new.world);
            new.world.chip_reset(crate::ble::now_us(&self.cpu));
        }
        let t = self.cpu.cycles;
        m.cpu.cycles = t;
        m.bus.now = t;
        m.bus.next_event = 0;
        *self = m;
        Ok(())
    }
}

/// BLE (E-09): find the VHCI boundary by signature and, if found, intercept its entries and the magic return slots
fn install_ble(m: &mut Esp32, app: &AppInfo) {
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
            // BT address = base MAC + 2 (ESP_MAC_BT); MAC_FACTORY keeps mac[5] in the lowest byte of BLK0 word 1
            let (lo, hi) = (m.bus.efuse[1], m.bus.efuse[2] & 0xffff);
            let v = ((hi as u64) << 32 | lo as u64) + 2;
            // HCI byte order is little-endian (least significant byte first)
            let mut addr = [0u8; 6];
            addr.copy_from_slice(&v.to_le_bytes()[..6]);
            let b = crate::ble::BleHle::with_osi(hooks, addr, &crate::ble::OSI_ESP32);
            let addrs = b.hle_addrs();
            // Hooked entries are in flash, above the ROM range the HLE check normally covers
            let top = addrs.iter().copied().max().unwrap_or(0) + 1;
            m.cpu.hle_hi = m.cpu.hle_hi.max(top);
            m.cpu.hle_addrs.extend(addrs);
            m.cpu.hle_addrs.sort_unstable();
            m.bus.ble.hle = Some(Box::new(b));
        }
        Err(e) => m.bus.ble.error = Some(e),
    }
}
