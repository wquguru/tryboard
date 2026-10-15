//! 直接启动（ESP32-S3）：装 ROM（esp-rom-elfs）、解析 flash 镜像、按二级 bootloader 的方式映射 app，
//! 以及启动期需要特定读回值的寄存器。流程与 C3 相同，见 crates/esp32c3/src/boot.rs。

use crate::*;
use tryboard_rv32::elf::Elf;
use tryboard_xtensa::{PS_UM, PS_WOE};

pub use tryboard_esp32c3::boot::find_app;

/// 镜像头里的芯片 ID（esp_app_format.h：ESP_CHIP_ID_ESP32S3）
pub const CHIP_ID: u16 = 9;

/// eFuse 读寄存器（0x60007000 起 0x200 字节），布局与 C3 相同：
/// BLK1（RD_MAC_SPI_SYS_0，偏移 0x44）：MAC、晶圆版本 v0.2（市面上主流的 S3 版本）
pub fn default_efuse() -> [u32; 0x200 / 4] {
    let mut e = [0u32; 0x200 / 4];
    let blk1 = 0x44 / 4;
    // 本地管理地址，避免冒用乐鑫 OUI；与 C3 模拟板区分最后一字节
    let mac = [0x02u8, 0x54, 0x42, 0x00, 0x00, 0x03];
    e[blk1] = u32::from_le_bytes([mac[5], mac[4], mac[3], mac[2]]);
    e[blk1 + 1] = u32::from_le_bytes([mac[1], mac[0], 0, 0]);
    // WAFER_VERSION_MINOR_LO = 2（BLK1 位 114..116）；PSRAM_CAP = 1（8MB，位 131..132）
    e[blk1 + 3] |= 2 << 18;
    e[blk1 + 4] |= 1 << 3;
    e[0x1d0 / 4] = 0x1;
    e[0x1fc / 4] = 0x2003200;
    e
}

/// 启动期必须返回特定值的寄存器（否则轮询死循环）
pub fn special_read(a: u32, now: u64) -> Option<u32> {
    Some(match a {
        // RTC_CNTL_TIME_UPDATE：bit30 TIME_VALID
        0x6000_800c => 1 << 30,
        // RTC 慢时钟计数（RC 慢时钟约 136kHz）
        0x6000_8010 => (now * 136_000 / CPU_HZ) as u32,
        0x6000_8014 => ((now * 136_000 / CPU_HZ) >> 32) as u32,
        // RTC_CNTL_RESET_STATE：两核都是上电复位（1）
        0x6000_8038 => 1 | (1 << 6),
        _ => return None,
    })
}

/// ROM ELF：代码 / 只读数据装进 ROM 区，各 .data* 节初值装进 DRAM（替代被跳过的 ROM 启动代码）
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
    let sym = |n: &str| elf.symbol(n).ok_or(format!("ROM 里没有符号 {n}"));
    // ets_printf 挂到 UART（ets_install_uart_printf 的效果）；ROM 打印走 UART、不走 USB-Serial-JTAG
    m.bus.mem_write(sym("_putc1")?, 4, sym("ets_write_char_uart")?);
    m.bus.mem_write(sym("g_uart_print")?, 1, 1);
    m.bus.mem_write(sym("g_usb_print")?, 1, 0);
    for (name, kind) in crate::hle::TABLE {
        // 有的 ROM 函数在 ELF 里只有跳转表项 __call_<名字>（地址与 ROM 链接脚本里的一致）
        let a = elf.symbol(name).or_else(|| elf.symbol(&format!("__call_{name}"))).ok_or(format!("ROM 里没有符号 {name}"))?;
        m.hle.insert(a, *kind);
    }
    let mut addrs: Vec<u32> = m.hle.keys().copied().collect();
    addrs.sort();
    m.cpu.hle_lo = ROM_LOW;
    m.cpu.hle_hi = ROM_HIGH;
    m.cpu.hle_addrs = addrs;
    // ROM 启动时写进 RTC 存储寄存器的时钟信息（rom/rtc.h：RTC_XTAL_FREQ_REG = STORE4，RTC_APB_FREQ_REG = STORE5，
    // S3 上分别在 RTC_CNTL 0xC0 / 0xC4；高低半字相同）
    m.bus.regs.insert(0x6000_80C0, 0x0028_0028);
    let apb = 80_000_000u32 >> 12;
    m.bus.regs.insert(0x6000_80C4, apb | (apb << 16));
    Ok(())
}

/// 二级 bootloader 按镜像头填写 ROM 的 flash 芯片描述（esp_rom_spiflash_chip_t）
fn init_flashchip(m: &mut Esp32s3, size_code: u8, jedec: u32) -> Result<(), String> {
    // rom_spiflash_legacy_data（esp32s3.rom.ld，0x3FCEFFE4）是指针，指向 ROM .data 里的结构体
    let p = m.bus.mem_read(0x3FCE_FFE4, 4).ok_or("读不到 rom_spiflash_legacy_data")?;
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
    for (i, v) in [id, size, 64 << 10, 4 << 10, 256, 0xffff].iter().enumerate() {
        m.bus.mem_write(p + 4 * i as u32, 4, *v).ok_or("写 g_rom_flashchip 失败")?;
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

/// 镜像头的芯片 ID（偏移 12）。镜像开头不是 0xE9 时先找分区表里的 app。
pub fn image_chip_id(flash: &[u8]) -> Option<u16> {
    let off = find_app(flash).ok()? as usize;
    flash.get(off + 13).map(|_| u16::from_le_bytes([flash[off + 12], flash[off + 13]]))
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
        return Err(format!("镜像芯片 ID 是 {chip_id}，不是 ESP32-S3（{CHIP_ID}）"));
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

/// 板上 flash 容量：镜像头 byte3 高 4 位（0=1MB … 4=16MB），模拟 flash 至少这么大
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

/// 入口帧"调用者 sp"指向的溢出保存区：借用 ROM 的 level 5 / level 4 中断栈（_Pri_5_Stack / _Pri_4_Stack），
/// app 装了自己的向量表后 ROM 不再用它们
const SPILL_PRO: u32 = 0x3FCE_E8E0 + 64;
const SPILL_APP: u32 = 0x3FCE_E380 + 64;

/// 以 CALLINC=0 进入一个窗口 ABI 函数：ENTRY 不转窗口，入口帧就是最老的一帧（WINDOWSTART 只有它），
/// 以后窗口溢出不会去溢出一个并不存在的调用者帧。
/// 溢出处理程序溢出最老一帧时会读 [该帧 sp - 12] 当作"调用者的 sp"、把 a4..a11 存到它下面；
/// 真机上那里是调用者帧溢出时写下的值，我们没有调用者，所以先执行入口的 ENTRY，再在 [sp-12] 填一个空闲区的指针。
fn enter_windowed(c: &mut Cpu, bus: &mut SocBus, entry: u32, stack: u32, spill: u32) -> Result<(), String> {
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
        bus.mem_write(sp.wrapping_sub(12), 4, spill).ok_or("写入口帧保存区失败")?;
    }
    Ok(())
}

impl Esp32s3 {
    /// 启动核 1（真机：ROM 里核 1 的复位代码拿到 ets_set_appcpu_boot_addr 设的地址后跳过去）。
    /// 栈用 ROM 的 .stack_app 顶端（__stack_app，0x3FCED710）；时间与核 0 对齐。
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

    /// 新建一台机器：装 ROM、装 flash、做 bootloader 该做的事，PC 停在 app 入口（call_start_cpu0）
    pub fn boot(rom_elf: &[u8], flash: Vec<u8>) -> Result<(Esp32s3, AppInfo), String> {
        let mut cpu1 = Cpu::new();
        // PRID：核 0 0xCDCD、核 1 0xABAB（IDF 用位 13 区分核号）
        cpu1.prid = 0xabab;
        let mut m = Esp32s3 { cpu: Cpu::new(), cpu1, cpu1_on: false, bus: SocBus::default(), rom_symbols: HashMap::new(), hle: HashMap::new() };
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
            let in_cache = (IROM_LOW..IROM_HIGH).contains(&load) || (DROM_LOW..DROM_HIGH).contains(&load);
            if in_cache {
                if load & 0xffff != data & 0xffff {
                    return Err(format!("段 0x{load:08x} 与 flash 偏移 0x{data:x} 页内偏移不一致"));
                }
                let first = ((load & 0x1ff_ffff) >> 16) as usize;
                let last = (((load + len - 1) & 0x1ff_ffff) >> 16) as usize;
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
        let jedec = m.bus.spi1.jedec;
        init_flashchip(&mut m, size_code, jedec)?;

        // 栈用 ROM 的 .stack_pro 顶端（__stack，0x3FCEB710），与真 bootloader 跳入 app 时一致
        let entry = app.entry;
        enter_windowed(&mut m.cpu, &mut m.bus, entry, 0x3FCE_B710, SPILL_PRO)?;
        Ok((m, app))
    }
}
