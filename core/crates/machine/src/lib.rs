//! 芯片无关的机器外壳：按镜像头芯片 ID 选 ESP32-C3 或 ESP32-S3，给 CLI 和 wasm 一套统一接口。
//! 新加芯片时在这里加一个分支，CLI / 网页不用改。

use std::collections::{HashMap, VecDeque};
use tryboard_esp32c3::devices::{
    bme280::{Bme280, Env},
    ssd1306::Ssd1306,
};
use tryboard_esp32c3::rmt::Ws2812;
use tryboard_esp32c3::Esp32c3;
use tryboard_esp32s3::Esp32s3;

pub use tryboard_esp32c3::periph::CPU_HZ;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Chip {
    Esp32c3,
    Esp32s3,
}

impl Chip {
    /// 镜像头里的芯片 ID（esp_app_format.h）
    pub fn from_image(flash: &[u8]) -> Option<Chip> {
        match tryboard_esp32s3::boot::image_chip_id(flash)? {
            5 => Some(Chip::Esp32c3),
            9 => Some(Chip::Esp32s3),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Chip::Esp32c3 => "esp32c3",
            Chip::Esp32s3 => "esp32s3",
        }
    }
    /// esp-rom-elfs 里该芯片 ROM 的文件名
    pub fn rom_file(self) -> &'static str {
        match self {
            Chip::Esp32c3 => "esp32c3_rev3_rom.elf",
            Chip::Esp32s3 => "esp32s3_rev0_rom.elf",
        }
    }
    pub fn npins(self) -> usize {
        match self {
            Chip::Esp32c3 => 22,
            Chip::Esp32s3 => tryboard_esp32s3::periph::NPINS,
        }
    }
    /// 网页 / tb_chip 用的数字编号，与镜像头芯片 ID 一致
    pub fn id(self) -> u32 {
        match self {
            Chip::Esp32c3 => 5,
            Chip::Esp32s3 => 9,
        }
    }
}

/// 一次运行的停止原因（芯片无关）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stop {
    Budget,
    /// 固件崩溃，文字说明
    Fault(String),
    /// 碰到没实现的 HLE 函数
    Hle(String),
    /// 固件请求软件复位（esp_restart / panic 后重启），值为复位原因；调用 reboot() 重新上电
    Reset(u32),
}

#[allow(clippy::large_enum_variant)]
pub enum Machine {
    C3(Esp32c3),
    S3(Esp32s3),
}

pub struct BootInfo {
    pub offset: u32,
    pub entry: u32,
    pub segments: usize,
}

impl Machine {
    pub fn boot(rom: &[u8], flash: Vec<u8>) -> Result<(Machine, BootInfo), String> {
        match Chip::from_image(&flash) {
            Some(Chip::Esp32s3) => {
                let (m, a) = Esp32s3::boot(rom, flash)?;
                Ok((Machine::S3(m), BootInfo { offset: a.offset, entry: a.entry, segments: a.segments.len() }))
            }
            Some(Chip::Esp32c3) | None => {
                let (m, a) = Esp32c3::boot(rom, flash)?;
                Ok((Machine::C3(m), BootInfo { offset: a.offset, entry: a.entry, segments: a.segments.len() }))
            }
        }
    }

    /// 软件复位后重新上电：flash（含 NVS）保留，模拟时间继续。
    /// S3 另外保留 RTC 内存与 RTC_CNTL 存储寄存器（RTC_NOINIT、复位原因提示），见 Esp32s3::reboot
    pub fn reboot(&mut self, reason: u32) -> Result<(), String> {
        match self {
            Machine::C3(m) => m.reboot(reason),
            Machine::S3(m) => m.reboot(reason),
        }
    }

    /// 原生 USB（只有 S3 有）
    pub fn usb(&self) -> Option<&tryboard_esp32s3::usb::Usb> {
        match self {
            Machine::S3(m) => m.bus.usb.as_deref(),
            Machine::C3(_) => None,
        }
    }

    pub fn usb_mut(&mut self) -> Option<&mut tryboard_esp32s3::usb::Usb> {
        match self {
            Machine::S3(m) => m.bus.usb.as_deref_mut(),
            Machine::C3(_) => None,
        }
    }

    pub fn chip(&self) -> Chip {
        match self {
            Machine::C3(_) => Chip::Esp32c3,
            Machine::S3(_) => Chip::Esp32s3,
        }
    }

    pub fn run(&mut self, cycles: u64) -> Stop {
        match self {
            Machine::C3(m) => {
                let r = m.run(cycles);
                c3_stop(m, r)
            }
            Machine::S3(m) => {
                let r = m.run(cycles);
                s3_stop(m, r)
            }
        }
    }

    pub fn run_traced(&mut self, cycles: u64, ring: &mut VecDeque<u32>, cap: usize) -> Stop {
        match self {
            Machine::C3(m) => {
                let r = m.run_traced(cycles, ring, cap);
                c3_stop(m, r)
            }
            Machine::S3(m) => {
                let r = m.run_traced(cycles, ring, cap);
                s3_stop(m, r)
            }
        }
    }

    /// 核 0 的周期数（模拟时间）
    pub fn cycles(&self) -> u64 {
        match self {
            Machine::C3(m) => m.cpu.cycles,
            Machine::S3(m) => m.cpu.cycles,
        }
    }

    pub fn instret(&self) -> u64 {
        match self {
            Machine::C3(m) => m.cpu.instret,
            Machine::S3(m) => m.cpu.instret + if m.cpu1_on { m.cpu1.instret } else { 0 },
        }
    }

    pub fn pc(&self) -> u32 {
        match self {
            Machine::C3(m) => m.cpu.pc,
            Machine::S3(m) => m.cpu.pc,
        }
    }

    pub fn console_take(&mut self) -> Vec<u8> {
        match self {
            Machine::C3(m) => m.console_take(),
            Machine::S3(m) => m.console_take(),
        }
    }

    pub fn gpio_level(&self) -> u64 {
        match self {
            Machine::C3(m) => m.bus.gpio.level() as u64,
            Machine::S3(m) => m.bus.gpio.level(),
        }
    }

    pub fn gpio_enable(&self) -> u64 {
        match self {
            Machine::C3(m) => m.bus.gpio.enable as u64,
            Machine::S3(m) => m.bus.gpio.enable,
        }
    }

    /// 外部驱动一个引脚（按键等）。level < 0 表示松开（不驱动）
    pub fn gpio_drive(&mut self, pin: u32, level: i32) {
        macro_rules! drive {
            ($m:expr, $one:expr) => {{
                let bit = $one << pin;
                let g = &mut $m.bus.gpio;
                if level < 0 {
                    g.ext_driven &= !bit;
                } else {
                    g.ext_driven |= bit;
                    if level > 0 {
                        g.ext_in |= bit;
                    } else {
                        g.ext_in &= !bit;
                    }
                }
                let now = $m.cpu.cycles;
                $m.bus.gpio_changed(now);
            }};
        }
        match self {
            Machine::C3(m) => drive!(m, 1u32),
            Machine::S3(m) => drive!(m, 1u64),
        }
    }

    /// 板载 BOOT 键所在引脚（C3：GPIO9，S3：GPIO0）
    pub fn boot_pin(&self) -> u32 {
        match self {
            Machine::C3(_) => 9,
            Machine::S3(_) => 0,
        }
    }

    pub fn uart_push(&mut self, data: &[u8]) {
        match self {
            Machine::C3(m) => {
                m.bus.uart0.push_rx(data);
                m.bus.irq_dirty = true;
            }
            Machine::S3(m) => {
                m.bus.uart0.push_rx(data);
                m.bus.irq_dirty = true;
            }
        }
    }

    pub fn pin_pwm(&self, pin: usize) -> Option<(f32, f32)> {
        match self {
            Machine::C3(m) => m.bus.pin_pwm(pin),
            Machine::S3(m) => m.bus.pin_pwm(pin),
        }
    }

    /// 引脚上的模拟电压（毫伏），给 ADC 读
    pub fn analog_set(&mut self, pin: usize, mv: f32) {
        let slot = match self {
            Machine::C3(m) => m.bus.adc.pin_mv.get_mut(pin),
            Machine::S3(m) => m.bus.adc.pin_mv.get_mut(pin),
        };
        if let Some(p) = slot {
            *p = mv;
        }
    }

    pub fn ws2812(&self) -> &HashMap<u32, Ws2812> {
        match self {
            Machine::C3(m) => &m.bus.ws2812,
            Machine::S3(m) => &m.bus.ws2812,
        }
    }

    fn i2c0(&mut self) -> &mut tryboard_esp32c3::i2c::I2c {
        match self {
            Machine::C3(m) => &mut m.bus.i2c0,
            Machine::S3(m) => &mut m.bus.i2c0,
        }
    }

    /// 在 I2C0 总线上接一个器件（"ssd1306" / "bme280"）
    pub fn i2c_attach(&mut self, kind: &str, addr: u8) -> bool {
        match tryboard_esp32c3::devices::make_i2c(kind, addr) {
            Some(d) => {
                self.i2c0().attach(d);
                true
            }
            None => false,
        }
    }

    pub fn i2c_stats(&mut self) -> (u64, u64) {
        let b = self.i2c0();
        (b.transactions, b.nacks)
    }

    pub fn env_set(&mut self, env: Env) {
        if let Some(b) = self.i2c0().device::<Bme280>() {
            b.env = env;
        }
    }

    pub fn oled(&mut self) -> Option<&mut Ssd1306> {
        self.i2c0().device::<Ssd1306>()
    }

    /// GPIO 电平变化记录（周期, 电平）
    pub fn gpio_log(&self) -> Vec<(u64, u64)> {
        match self {
            Machine::C3(m) => m.bus.gpio_log.iter().map(|(t, l)| (*t, *l as u64)).collect(),
            Machine::S3(m) => m.bus.gpio_log.clone(),
        }
    }

    /// 上电时的引脚电平（gpio_log 的起点）
    pub fn gpio_reset_level(&self) -> u64 {
        match self {
            Machine::C3(_) => 0,
            Machine::S3(_) => 1,
        }
    }

    pub fn unimpl(&self) -> Vec<(u32, u64)> {
        let m = match self {
            Machine::C3(m) => &m.bus.unimpl,
            Machine::S3(m) => &m.bus.unimpl,
        };
        let mut v: Vec<_> = m.iter().map(|(a, n)| (*a, *n)).collect();
        v.sort_by_key(|x| std::cmp::Reverse(x.1));
        v
    }

    /// 读一个 32 位字（调试用，会触发 MMIO 读副作用）
    pub fn peek(&mut self, a: u32) -> Option<u32> {
        match self {
            Machine::C3(m) => tryboard_rv32::Bus::load(&mut m.bus, a, 4).ok(),
            Machine::S3(m) => tryboard_xtensa::Bus::load(&mut m.bus, a, 4).ok(),
        }
    }

    /// 停机时的 CPU 状态说明（调试用），sym 把地址翻成符号
    pub fn debug_state(&self, sym: &dyn Fn(u32) -> String) -> String {
        match self {
            Machine::C3(m) => format!("pc {}  ra {}", sym(m.cpu.pc), sym(m.cpu.x[1])),
            Machine::S3(m) => {
                use tryboard_xtensa::sr;
                let core = |c: &tryboard_xtensa::Cpu, k: usize| {
                    format!(
                        "核{k} pc {}  PS=0x{:08x} WB={} WS=0x{:04x} INTENABLE=0x{:08x} INTERRUPT=0x{:08x} EXCCAUSE={} EPC1={}",
                        sym(c.pc),
                        c.ps(),
                        c.windowbase,
                        c.windowstart,
                        c.read_sr(sr::INTENABLE),
                        c.read_sr(sr::INTERRUPT),
                        c.read_sr(sr::EXCCAUSE),
                        sym(c.read_sr(sr::EPC1)),
                    )
                };
                let mut s = core(&m.cpu, 0);
                if m.cpu1_on {
                    s += "\n[tryboard] ";
                    s += &core(&m.cpu1, 1);
                }
                s
            }
        }
    }
}

fn c3_stop(m: &Esp32c3, r: tryboard_esp32c3::Stop) -> Stop {
    use tryboard_esp32c3::Stop as S;
    match r {
        S::Budget => Stop::Budget,
        S::Fault { cause, pc, tval } => Stop::Fault(format!("CPU 异常 cause={cause} pc=0x{pc:08x} tval=0x{tval:08x}")),
        S::Hle(pc) => Stop::Hle(format!("0x{pc:08x} {}", m.symbol_at(pc).unwrap_or(""))),
        S::Reset(r) => Stop::Reset(r),
    }
}

fn s3_stop(m: &Esp32s3, r: tryboard_esp32s3::Stop) -> Stop {
    use tryboard_esp32s3::Stop as S;
    match r {
        S::Budget => Stop::Budget,
        S::Fault { cause, epc, vaddr } => Stop::Fault(format!("CPU 异常 EXCCAUSE={cause} EPC1=0x{epc:08x} EXCVADDR=0x{vaddr:08x}")),
        S::Break(v) => Stop::Fault(format!("BREAK 0x{v:x}")),
        S::Hle(pc) => Stop::Hle(format!("0x{pc:08x} {}", m.symbol_at(pc).unwrap_or(""))),
        S::Reset(r) => Stop::Reset(r),
    }
}

pub use tryboard_esp32c3::devices::bme280::Env as SensorEnv;
