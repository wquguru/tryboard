//! 直接启动：装 ROM（esp-rom-elfs）、解析 flash 镜像、按二级 bootloader 的方式映射 app，
//! 以及启动期需要特定读回值的寄存器。

use crate::*;
use tryboard_rv32::elf::Elf;

/// eFuse 读寄存器（0x60008800 起 0x200 字节）。
/// BLK1（RD_MAC_SPI_SYS_0 起）：MAC、晶圆版本 v0.4（字段位置见 esp_efuse_table.csv）。
pub fn default_efuse() -> [u32; 0x200 / 4] {
    let mut e = [0u32; 0x200 / 4];
    let blk1 = 0x44 / 4;
    // MAC 02:54:42:00:00:01（本地管理地址，避免冒用乐鑫 OUI）；eFuse 中按小端倒序存放
    let mac = [0x02u8, 0x54, 0x42, 0x00, 0x00, 0x01];
    e[blk1] = u32::from_le_bytes([mac[5], mac[4], mac[3], mac[2]]);
    e[blk1 + 1] = u32::from_le_bytes([mac[1], mac[0], 0, 0]);
    // WAFER_VERSION_MINOR_LO = 4（BLK1 位 114..116 → 第 3 字的位 18..20）；FLASH_CAP 不填
    e[blk1 + 3] |= 4 << 18;
    // STATUS：读完成、空闲
    e[0x1d0 / 4] = 0x1;
    e[0x1fc / 4] = 0x2007200;
    e
}

/// 启动期必须返回特定值的寄存器（否则轮询死循环）。返回 None 走通用读回。
pub fn special_read(a: u32, now: u64) -> Option<u32> {
    Some(match a {
        // RTC_CNTL_TIME_UPDATE：bit30 TIME_VALID
        0x6000_800c => 1 << 30,
        // RTC 慢时钟计数（约 136kHz）
        0x6000_8010 => (now * 136_000 / CPU_HZ) as u32,
        0x6000_8014 => ((now * 136_000 / CPU_HZ) >> 32) as u32,
        // RTC_CNTL_RESET_STATE：上电复位（1）
        0x6000_8038 => 1 | (1 << 6),
        _ => return None,
    })
}

/// 有副作用、但不需要存值的写。返回 true 表示已处理（不计入 unimpl）。
pub fn special_write(_a: u32, _v: u32) -> bool {
    false
}

/// 把 ROM ELF 装进 ROM 区与 ROM 的 .data 初值装进 DRAM（替代 ROM 启动代码做的拷贝）。
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

/// 在 flash 镜像里找 app：分区表（0x8000）里的 factory 或 ota_0；
/// 镜像开头直接就是 app（0xE9 且不是 bootloader）时按 app 处理。
pub fn find_app(flash: &[u8]) -> Result<u32, String> {
    let pt = 0x8000;
    if flash.len() > pt + 32 && flash[pt] == 0xAA && flash[pt + 1] == 0x50 {
        let mut ota0 = None;
        for i in 0..95 {
            let o = pt + i * 32;
            if flash[o] != 0xAA || flash[o + 1] != 0x50 {
                break;
            }
            let (ty, sub, off) = (flash[o + 2], flash[o + 3], u32at(flash, o + 4));
            if ty == 0 && sub == 0 {
                return Ok(off);
            }
            if ty == 0 && sub == 0x10 && ota0.is_none() {
                ota0 = Some(off);
            }
        }
        if let Some(o) = ota0 {
            return Ok(o);
        }
        return Err("分区表里没有 app 分区".into());
    }
    if flash.first() == Some(&0xE9) {
        return Ok(0);
    }
    Err("不认识的 flash 镜像：没有分区表，也不是 app 镜像".into())
}

pub fn parse_app(flash: &[u8], off: u32) -> Result<AppInfo, String> {
    let o = off as usize;
    if flash.get(o) != Some(&0xE9) {
        return Err(format!("0x{off:x} 处不是 ESP 镜像（魔数不对）"));
    }
    let nseg = flash[o + 1] as usize;
    let entry = u32at(flash, o + 4);
    let chip_id = u16::from_le_bytes([flash[o + 12], flash[o + 13]]);
    if chip_id != 5 {
        return Err(format!("镜像芯片 ID 是 {chip_id}，不是 ESP32-C3（5）"));
    }
    let mut p = o + 24;
    let mut segments = Vec::new();
    for _ in 0..nseg {
        let load = u32at(flash, p);
        let len = u32at(flash, p + 4);
        segments.push((load, (p + 8) as u32, len));
        p += 8 + len as usize;
    }
    Ok(AppInfo { offset: off, entry, segments })
}

impl Esp32c3 {
    /// 新建一台机器：装 ROM、装 flash、做 bootloader 该做的事，PC 停在 app 入口。
    pub fn boot(rom_elf: &[u8], flash: Vec<u8>) -> Result<(Esp32c3, AppInfo), String> {
        let mut m = Esp32c3 { cpu: Cpu::new(), bus: SocBus::default(), rom_symbols: HashMap::new() };
        load_rom(&mut m, rom_elf)?;
        let mut flash = flash;
        // 补齐到 4MB，避免 app 探测 flash 大小 / 读分区时越界
        if flash.len() < 4 << 20 {
            flash.resize(4 << 20, 0xff);
        }
        let off = find_app(&flash)?;
        let app = parse_app(&flash, off)?;
        for &(load, data, len) in &app.segments {
            let in_flash = (IROM_LOW..IROM_HIGH).contains(&load) || (DROM_LOW..DROM_HIGH).contains(&load);
            if in_flash {
                // 64KB 页映射：vaddr 与 flash 偏移的页内偏移相同
                if load & 0xffff != data & 0xffff {
                    return Err(format!("段 0x{load:08x} 与 flash 偏移 0x{data:x} 页内偏移不一致"));
                }
                let first = ((load & 0x7f_ffff) >> 16) as usize;
                let last = (((load + len - 1) & 0x7f_ffff) >> 16) as usize;
                for (i, page) in (first..=last).enumerate() {
                    m.bus.mmu[page] = (data >> 16) + i as u32;
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
        m.cpu.pc = app.entry;
        // ROM 的 .stack_pro 顶端，bootloader 跳进 app 时用的就是这个栈
        m.cpu.x[2] = 0x3FCD_E710;
        Ok((m, app))
    }
}
