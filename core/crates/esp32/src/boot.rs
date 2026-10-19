//! 直接启动（经典 ESP32）：装 ROM（esp-rom-elfs 的 esp32_rev300_rom.elf）、解析 flash 镜像、
//! 按二级 bootloader 的方式映射 app。流程与 S3 相同（见 crates/esp32s3/src/boot.rs），差别在地址。

use crate::*;
use tryboard_rv32::elf::Elf;
use tryboard_xtensa::{Variant, PS_UM, PS_WOE};

pub use tryboard_esp32c3::boot::find_app;

/// 镜像头里的芯片 ID（esp_app_format.h：ESP_CHIP_ID_ESP32）
pub const CHIP_ID: u16 = 0;

/// ROM 的 flash 芯片描述 g_rom_flashchip（esp32.rom.ld）
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
    let sym = |n: &str| elf.symbol(n).ok_or(format!("ROM 里没有符号 {n}"));
    // ets_printf 挂到 UART（ets_install_uart_printf 的效果）
    m.bus
        .mem_write(sym("_putc1")?, 4, sym("ets_write_char_uart")?);
    for (name, kind) in crate::hle::TABLE {
        let a = elf
            .symbol(name)
            .or_else(|| elf.symbol(&format!("__call_{name}")))
            .ok_or(format!("ROM 里没有符号 {name}"))?;
        m.hle.insert(a, *kind);
    }
    let mut addrs: Vec<u32> = m.hle.keys().copied().collect();
    addrs.sort();
    m.cpu.hle_lo = ROM_LOW;
    m.cpu.hle_hi = ROM_HIGH;
    m.cpu.hle_addrs = addrs;
    // RTC_XTAL_FREQ_REG = STORE4（0xB0）、RTC_APB_FREQ_REG = STORE5（0xB4），高低半字相同
    m.bus.regs.insert(RTC_CNTL + 0xb0, 0x0028_0028);
    let apb = 80_000_000u32 >> 12;
    m.bus.regs.insert(RTC_CNTL + 0xb4, apb | (apb << 16));
    // ROM 里每核一份的"每微秒周期数"（ets_update_cpu_frequency 写它，esp_rom_delay_us 读它）：二级 bootloader 交接时是 160MHz
    for s in ["g_ticks_per_us_pro", "g_ticks_per_us_app"] {
        if let Some(a) = elf.symbol(s) {
            m.bus.mem_write(a, 4, 160);
        }
    }
    Ok(())
}

/// 二级 bootloader 按镜像头填写 ROM 的 flash 芯片描述（esp_rom_spiflash_chip_t）
fn init_flashchip(m: &mut Esp32, size: usize, jedec: u32) -> Result<(), String> {
    let id = ((jedec & 0xff) << 16) | (jedec & 0xff00) | ((jedec >> 16) & 0xff);
    for (i, v) in [id, size as u32, 64 << 10, 4 << 10, 256, 0xffff]
        .iter()
        .enumerate()
    {
        m.bus
            .mem_write(G_ROM_FLASHCHIP + 4 * i as u32, 4, *v)
            .ok_or("写 g_rom_flashchip 失败")?;
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
        return Err(format!("0x{off:x} 处不是 ESP 镜像（魔数不对）"));
    }
    let nseg = flash[o + 1] as usize;
    let entry = u32at(flash, o + 4);
    let chip_id = u16::from_le_bytes([flash[o + 12], flash[o + 13]]);
    if chip_id != CHIP_ID {
        return Err(format!("镜像芯片 ID 是 {chip_id}，不是 ESP32（{CHIP_ID}）"));
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

/// 入口帧的"调用者 sp"指向的溢出保存区：借 ROM 的 level 5 / level 4 中断栈（_Pri_5_Stack / _Pri_4_Stack）。
/// 它们在 IDF 标成"启动栈"的区域里，调度器起来之后才并入堆，那时入口帧已不会再被溢出
const SPILL_PRO: u32 = 0x3FFE_0DC0 + 64;
const SPILL_APP: u32 = 0x3FFE_0860 + 64;
/// ROM 的 .stack_pro / .stack_app 顶端（__stack / __stack_app）
const STACK_PRO: u32 = 0x3FFE_3F20;
const STACK_APP: u32 = 0x3FFE_7E30;

/// 以 CALLINC=0 进入一个窗口 ABI 函数（理由见 S3 的同名函数）
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
            .ok_or("写入口帧保存区失败")?;
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

    /// 新建一台机器：装 ROM、装 flash、做 bootloader 该做的事，PC 停在 app 入口（call_start_cpu0）
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
                        "段 0x{load:08x} 与 flash 偏移 0x{data:x} 页内偏移不一致"
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
            } else {
                for i in 0..len {
                    let b = flash[(data + i) as usize] as u32;
                    if m.bus.mem_write(load + i, 1, b).is_none() {
                        return Err(format!("段 0x{load:08x} 落在不可写区域"));
                    }
                }
            }
        }
        m.bus.flash = flash;
        let jedec = m.bus.spi1.inner.jedec;
        init_flashchip(&mut m, flash_size(size_code), jedec)?;
        enter_windowed(&mut m.cpu, &mut m.bus, app.entry, STACK_PRO, SPILL_PRO)?;
        Ok((m, app))
    }

    /// 软件复位后重新上电（保留内容与 S3 的 reboot 相同）
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
        bus.gpio_log = std::mem::take(&mut old.gpio_log);
        bus.iotrace = old.iotrace.carry();
        bus.ws2812 = std::mem::take(&mut old.ws2812);
        bus.pins = std::mem::take(&mut old.pins);
        bus.audio = std::mem::take(&mut old.audio);
        let flash = std::mem::take(&mut old.flash);
        let rom = std::mem::take(&mut self.rom_elf);
        let (mut m, _) = Esp32::boot_with(&rom, flash, bus)?;
        let t = self.cpu.cycles;
        m.cpu.cycles = t;
        m.bus.now = t;
        m.bus.next_event = 0;
        *self = m;
        Ok(())
    }
}
