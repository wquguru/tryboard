//! Direct boot (ESP32-S3): load ROM (esp-rom-elfs), parse the flash image, map the app as the 2nd-stage bootloader
//! would, plus registers that must read back specific values during boot. Same flow as C3 (crates/esp32c3/src/boot.rs).

use crate::*;
use tryboard_rv32::elf::Elf;
use tryboard_xtensa::{PS_UM, PS_WOE};

pub use tryboard_soc::boot::find_app;

/// Chip ID in the image header (esp_app_format.h: ESP_CHIP_ID_ESP32S3)
pub const CHIP_ID: u16 = 9;

/// eFuse read registers (0x200 bytes from 0x60007000), same layout as C3:
/// BLK1 (RD_MAC_SPI_SYS_0, offset 0x44): MAC, wafer version v0.2 (the common S3 revision on the market)
pub fn default_efuse() -> [u32; 0x200 / 4] {
    let mut e = [0u32; 0x200 / 4];
    let blk1 = 0x44 / 4;
    // Locally administered address so we don't borrow Espressif's OUI; last byte differs from the C3 board
    let mac = [0x02u8, 0x54, 0x42, 0x00, 0x00, 0x03];
    e[blk1] = u32::from_le_bytes([mac[5], mac[4], mac[3], mac[2]]);
    e[blk1 + 1] = u32::from_le_bytes([mac[1], mac[0], 0, 0]);
    // WAFER_VERSION_MINOR_LO = 2 (BLK1 bits 114..116); PSRAM_CAP = 1 (8MB, bits 131..132)
    e[blk1 + 3] |= 2 << 18;
    e[blk1 + 4] |= 1 << 3;
    e[0x1d0 / 4] = 0x1;
    e[0x1fc / 4] = 0x2003200;
    // Typical-chip ADC calibration (BLK2 v1) so curve-fitting cali works like on a real board
    tryboard_soc::adc::burn_efuse(tryboard_soc::adc::AdcChip::S3, &mut e);
    e
}

/// Registers that must return specific values during boot (otherwise polling loops spin forever)
pub fn special_read(a: u32, now: u64) -> Option<u32> {
    Some(match a {
        // RTC_CNTL_TIME_UPDATE: bit30 TIME_VALID
        0x6000_800c => 1 << 30,
        // RTC slow clock counter (RC slow clock ~136kHz)
        0x6000_8010 => (now * 136_000 / CPU_HZ) as u32,
        0x6000_8014 => ((now * 136_000 / CPU_HZ) >> 32) as u32,
        _ => return None,
    })
}

/// ROM ELF: code / rodata into the ROM region, .data* initial values into DRAM (replacing the skipped ROM startup code)
pub fn load_rom(m: &mut Esp32s3, elf_bytes: &[u8]) -> Result<(), String> {
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
    let sym = |n: &str| elf.symbol(n).ok_or(format!("ROM has no symbol {n}"));
    // Hook ets_printf to UART (what ets_install_uart_printf does); ROM prints go to UART, not USB-Serial-JTAG
    m.bus
        .mem_write(sym("_putc1")?, 4, sym("ets_write_char_uart")?);
    m.bus.mem_write(sym("g_uart_print")?, 1, 1);
    m.bus.mem_write(sym("g_usb_print")?, 1, 0);
    for (name, kind) in crate::hle::TABLE {
        // Some ROM functions only have a jump table entry __call_<name> in the ELF (same address as in the ROM linker script)
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
    // Clock info the ROM stores in RTC store regs at boot (rom/rtc.h: RTC_XTAL_FREQ_REG = STORE4, RTC_APB_FREQ_REG = STORE5,
    // at RTC_CNTL 0xC0 / 0xC4 on S3; high and low halfwords equal)
    m.bus.regs.insert(0x6000_80C0, 0x0028_0028);
    let apb = 80_000_000u32 >> 12;
    m.bus.regs.insert(0x6000_80C4, apb | (apb << 16));
    Ok(())
}

/// The 2nd-stage bootloader fills ROM's flash chip descriptor (esp_rom_spiflash_chip_t) from the image header
fn init_flashchip(m: &mut Esp32s3, size_code: u8, jedec: u32) -> Result<(), String> {
    // rom_spiflash_legacy_data (esp32s3.rom.ld, 0x3FCEFFE4) is a pointer to a struct in ROM .data
    let p = m
        .bus
        .mem_read(0x3FCE_FFE4, 4)
        .ok_or("cannot read rom_spiflash_legacy_data")?;
    let size = match size_code {
        0 => 1 << 20,
        1 => 2 << 20,
        2 => 4 << 20,
        3 => 8 << 20,
        4 => 16 << 20,
        5 => 32 << 20,
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
        return Err(format!(
            "image chip ID is {chip_id}, not ESP32-S3 ({CHIP_ID})"
        ));
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

/// Board flash size: high nibble of header byte3 (0=1MB ... 4=16MB); the emulated flash is at least this big
fn flash_size(code: u8) -> usize {
    match code {
        0 => 1 << 20,
        1 => 2 << 20,
        2 => 4 << 20,
        3 => 8 << 20,
        4 => 16 << 20,
        5 => 32 << 20,
        _ => 4 << 20,
    }
}

/// Overflow save area that the entry frame's "caller sp" points at: borrows ROM's level 5 / level 4 interrupt stacks
/// (_Pri_5_Stack / _Pri_4_Stack), which ROM stops using once the app installs its own vector table
const SPILL_PRO: u32 = 0x3FCE_E8E0 + 64;
const SPILL_APP: u32 = 0x3FCE_E380 + 64;

/// Enter a windowed function with CALLINC=0 so its frame is the oldest and overflows never spill a nonexistent caller.
/// Spilling that frame reads [sp-12] as the caller's sp, which no caller wrote: run ENTRY, then point [sp-12] at free RAM.
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

impl Esp32s3 {
    /// Start core 1 (silicon: core 1's ROM reset code jumps to the address set by ets_set_appcpu_boot_addr).
    /// Stack is the top of ROM's .stack_app (__stack_app, 0x3FCED710); time aligned with core 0.
    pub fn start_app_cpu(&mut self, entry: u32) {
        let mut c = Cpu::new();
        c.prid = 0xabab;
        c.cycles = self.cpu.cycles;
        if enter_windowed(&mut c, &mut self.bus, entry, 0x3FCE_D710, SPILL_APP).is_ok() {
            c.hle_lo = self.cpu.hle_lo;
            c.hle_hi = self.cpu.hle_hi;
            c.hle_addrs = self.cpu.hle_addrs.clone();
            self.cpu1 = c;
            self.cpu1_on = true;
        }
    }

    /// Build a machine: load ROM and flash, do the bootloader's job, PC parked at the app entry (call_start_cpu0)
    pub fn boot(rom_elf: &[u8], flash: Vec<u8>) -> Result<(Esp32s3, AppInfo), String> {
        Self::boot_with(rom_elf, flash, SocBus::default())
    }

    /// Boot on a given bus (power-cycle after reset passes in a bus that kept RTC memory)
    fn boot_with(
        rom_elf: &[u8],
        flash: Vec<u8>,
        bus: SocBus,
    ) -> Result<(Esp32s3, AppInfo), String> {
        let mut cpu1 = Cpu::new();
        // PRID: core 0 0xCDCD, core 1 0xABAB (IDF uses bit 13 to tell cores apart)
        cpu1.prid = 0xabab;
        let mut m = Esp32s3 {
            cpu: Cpu::new(),
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
                let first = ((load & 0x1ff_ffff) >> 16) as usize;
                let last = (((load + len - 1) & 0x1ff_ffff) >> 16) as usize;
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
        m.bus.flash = flash;
        let jedec = m.bus.spi1.jedec;
        init_flashchip(&mut m, size_code, jedec)?;
        install_ble(&mut m, &app);

        // Stack is the top of ROM's .stack_pro (__stack, 0x3FCEB710), matching the real bootloader's jump into the app
        let entry = app.entry;
        enter_windowed(&mut m.cpu, &mut m.bus, entry, 0x3FCE_B710, SPILL_PRO)?;
        Ok((m, app))
    }
}

/// BLE (E-04): find the VHCI boundary by signature and, if found, intercept its entries and the magic return slots
fn install_ble(m: &mut Esp32s3, app: &AppInfo) {
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

impl Esp32s3 {
    /// Software reset, booting the app directly. Keeps flash/NVS, RTC memory, RTC_CNTL store regs and the outside world;
    /// clears SRAM, PSRAM, other peripherals and both cores (core 1 restarts via ets_set_appcpu_boot_addr); time keeps running.
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
        bus.adc.model = old.adc.model.clone();
        bus.i2c0.devices = std::mem::take(&mut old.i2c0.devices);
        bus.i2c1.devices = std::mem::take(&mut old.i2c1.devices);
        bus.gpio_log = std::mem::take(&mut old.gpio_log);
        bus.iotrace = old.iotrace.carry();
        bus.tasks = old.tasks.carry(self.cpu.cycles);
        bus.ws2812 = std::mem::take(&mut old.ws2812);
        // Encoders and ultrasonic sensors are the outside world: still attached after reset (queued waveforms still happen)
        bus.pins = std::mem::take(&mut old.pins);
        // The external round display is part of the outside world: it survives reset (new firmware redraws it)
        bus.lcd = old.lcd.take();
        bus.audio = std::mem::take(&mut old.audio);
        let flash = std::mem::take(&mut old.flash);
        let rom = std::mem::take(&mut self.rom_elf);
        let (mut m, _) = Esp32s3::boot_with(&rom, flash, bus)?;
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
