//! 原生命令行：跑固件、跑 riscv-tests、出未实现寄存器报告。

use std::io::Write;
use std::time::Instant;
use tryboard_esp32c3::{Esp32c3, Stop};
use tryboard_rv32::{elf::Elf, Bus, BusFault, Cpu, Exit};

fn usage() -> ! {
    eprintln!(
        "用法:
  tryboard run <flash.bin> [--rom <rom.elf>] [--seconds <模拟秒数>] [--expect <文本>] [--uart-in <文本>]
  tryboard riscv-test <test.elf>..."
    );
    std::process::exit(2)
}

fn default_rom() -> String {
    let here = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    here.join("../../../third_party/esp-rom-elfs/esp32c3_rev3_rom.elf").to_string_lossy().into_owned()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        Some("run") => run(&args[1..]),
        Some("riscv-test") => riscv_tests(&args[1..]),
        _ => usage(),
    }
}

/// 符号表：ROM + app.elf（与 flash.bin 同目录时自动加载），按地址找最近的符号。
struct Syms(Vec<(u32, String)>);
impl Syms {
    fn load(paths: &[String]) -> Syms {
        let mut v = Vec::new();
        for p in paths {
            if let Ok(b) = std::fs::read(p) {
                if let Ok(e) = Elf::parse(&b) {
                    for (n, a, _) in e.symbols {
                        if a != 0 && !n.starts_with('$') && !n.starts_with(".L") {
                            v.push((a, n));
                        }
                    }
                }
            }
        }
        v.sort();
        Syms(v)
    }
    fn name(&self, a: u32) -> String {
        match self.0.partition_point(|(x, _)| *x <= a) {
            0 => format!("0x{a:08x}"),
            i => {
                let (b, n) = &self.0[i - 1];
                format!("0x{a:08x} {n}+0x{:x}", a - b)
            }
        }
    }
}

fn opt(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn run(args: &[String]) {
    let Some(path) = args.first() else { usage() };
    let rom_path = opt(args, "--rom").unwrap_or_else(default_rom);
    let seconds: f64 = opt(args, "--seconds").and_then(|s| s.parse().ok()).unwrap_or(5.0);
    let expect = opt(args, "--expect");
    let rom = std::fs::read(&rom_path).unwrap_or_else(|e| panic!("读 ROM {rom_path}: {e}"));
    let flash = std::fs::read(path).unwrap_or_else(|e| panic!("读固件 {path}: {e}"));
    let (mut m, app) = match Esp32c3::boot(&rom, flash) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("启动失败: {e}");
            std::process::exit(1)
        }
    };
    eprintln!("[tryboard] app @0x{:x} 入口 0x{:08x}，{} 段", app.offset, app.entry, app.segments.len());
    if let Some(s) = opt(args, "--uart-in") {
        m.bus.uart0.push_rx(s.replace("\\n", "\n").as_bytes());
    }
    let total = (seconds * tryboard_esp32c3::periph::CPU_HZ as f64) as u64;
    let slice = tryboard_esp32c3::periph::CPU_HZ / 100; // 10ms 一片
    let t0 = Instant::now();
    let mut out = Vec::new();
    let mut stop = Stop::Budget;
    let mut done = 0u64;
    let stdout = std::io::stdout();
    let trace: usize = opt(args, "--trace").and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut ring = std::collections::VecDeque::new();
    let app_elf = std::path::Path::new(path).with_file_name("app.elf").to_string_lossy().into_owned();
    let syms = Syms::load(&[rom_path.clone(), app_elf]);
    while done < total {
        let before = m.cpu.cycles;
        stop = if trace > 0 {
            m.run_traced(slice.min(total - done), &mut ring, trace)
        } else {
            m.run(slice.min(total - done))
        };
        done += m.cpu.cycles - before;
        let c = m.console_take();
        if !c.is_empty() {
            let mut lock = stdout.lock();
            lock.write_all(&c).ok();
            lock.flush().ok();
            out.extend_from_slice(&c);
        }
        if stop != Stop::Budget {
            break;
        }
        if let Some(e) = &expect {
            if String::from_utf8_lossy(&out).contains(e.as_str()) {
                break;
            }
        }
    }
    let wall = t0.elapsed().as_secs_f64();
    let sim = m.cpu.cycles as f64 / tryboard_esp32c3::periph::CPU_HZ as f64;
    eprintln!(
        "\n[tryboard] 停止: {stop:?}  pc=0x{:08x} {}  模拟 {sim:.3}s / 实际 {wall:.3}s（{:.1} MIPS）",
        m.cpu.pc,
        m.symbol_at(m.cpu.pc).unwrap_or(""),
        m.cpu.instret as f64 / wall / 1e6
    );
    eprintln!("[tryboard] pc {}  ra {}", syms.name(m.cpu.pc), syms.name(m.cpu.x[1]));
    if trace > 0 {
        eprintln!("[tryboard] 最近的跳转目标：");
        for pc in &ring {
            eprintln!("    {}", syms.name(*pc));
        }
    }
    if let Stop::Fault { cause, pc, tval } = stop {
        eprintln!("[tryboard] 异常 cause={cause} pc=0x{pc:08x} tval=0x{tval:08x} ra=0x{:08x}", m.cpu.x[1]);
    }
    if let Stop::Hle(pc) = stop {
        eprintln!("[tryboard] 未实现的 HLE: 0x{pc:08x} {}", m.symbol_at(pc).unwrap_or("?"));
    }
    let mut un: Vec<_> = m.bus.unimpl.iter().collect();
    un.sort_by(|a, b| b.1.cmp(a.1));
    eprintln!("[tryboard] 未建模寄存器 {} 个，访问最多的：", un.len());
    for (a, n) in un.iter().take(12) {
        eprintln!("    0x{:08x}  {:>8} 次", a, n);
    }
    if args.iter().any(|a| a == "--gpio-log") {
        let log = &m.bus.gpio_log;
        for pin in 0..22 {
            let mut n = 0;
            let mut prev = 0u32;
            for (_, lv) in log {
                if (lv ^ prev) >> pin & 1 != 0 {
                    n += 1;
                }
                prev = *lv;
            }
            if n > 0 {
                eprintln!("[tryboard] GPIO{pin} 翻转 {n} 次");
            }
        }
    }
    if args.iter().any(|a| a == "--ws2812-log") {
        let mut pins: Vec<_> = m.bus.ws2812.iter().collect();
        pins.sort_by_key(|(p, _)| **p);
        for (pin, d) in pins {
            eprintln!("[tryboard] WS2812 GPIO{pin} 共 {} 帧", d.frames);
            for (t, rgb) in &d.history {
                let cols: Vec<String> = rgb.iter().map(|c| format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])).collect();
                eprintln!("    {:.4}s {}", *t as f64 / tryboard_esp32c3::periph::CPU_HZ as f64, cols.join(" "));
            }
        }
    }
    if let Some(e) = expect {
        let ok = String::from_utf8_lossy(&out).contains(e.as_str());
        eprintln!("[tryboard] 期望输出 {:?}: {}", e, if ok { "PASS" } else { "FAIL" });
        std::process::exit(if ok { 0 } else { 1 });
    }
}

/// riscv-tests 的 "p" 环境：程序链接在 0x80000000，结果写到 tohost。
struct TestBus {
    ram: Vec<u8>,
    tohost: u32,
    result: Option<u32>,
}

const TEST_BASE: u32 = 0x8000_0000;

impl Bus for TestBus {
    fn load(&mut self, a: u32, s: u32) -> Result<u32, BusFault> {
        let o = a.wrapping_sub(TEST_BASE) as usize;
        let b = self.ram.get(o..o + s as usize).ok_or(BusFault)?;
        Ok(b.iter().enumerate().fold(0, |v, (i, x)| v | (*x as u32) << (8 * i)))
    }
    fn store(&mut self, a: u32, s: u32, v: u32) -> Result<(), BusFault> {
        if a == self.tohost && v != 0 {
            self.result = Some(v);
        }
        let o = a.wrapping_sub(TEST_BASE) as usize;
        let b = self.ram.get_mut(o..o + s as usize).ok_or(BusFault)?;
        for (i, x) in b.iter_mut().enumerate() {
            *x = (v >> (8 * i)) as u8;
        }
        Ok(())
    }
}

fn riscv_tests(paths: &[String]) {
    let mut fail = 0;
    for p in paths {
        let bytes = std::fs::read(p).expect("读测试");
        let elf = Elf::parse(&bytes).expect("解析 ELF");
        let mut bus = TestBus { ram: vec![0; 1 << 20], tohost: elf.symbol("tohost").expect("没有 tohost"), result: None };
        for s in &elf.segments {
            let o = (s.paddr - TEST_BASE) as usize;
            bus.ram[o..o + s.data.len()].copy_from_slice(&s.data);
        }
        let mut cpu = Cpu::new();
        cpu.pc = elf.entry;
        for _ in 0..2_000_000 {
            if let Exit::DoubleFault { .. } = cpu.step(&mut bus) {
                break;
            }
            if bus.result.is_some() {
                break;
            }
        }
        let name = std::path::Path::new(p).file_name().unwrap().to_string_lossy();
        match bus.result {
            Some(1) => println!("PASS {name}"),
            Some(v) => {
                println!("FAIL {name}（第 {} 个用例）", v >> 1);
                fail += 1;
            }
            None => {
                println!("FAIL {name}（没有结果，pc=0x{:08x}）", cpu.pc);
                fail += 1;
            }
        }
    }
    println!("{} 个测试，失败 {}", paths.len(), fail);
    std::process::exit(if fail == 0 { 0 } else { 1 });
}
