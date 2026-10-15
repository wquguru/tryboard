//! `tryboard run` 的 ESP32-S3 分支（镜像头芯片 ID = 9 时走这里）。参数与 C3 相同的子集：
//! --rom --seconds --expect --uart-in --script（gpioN / uart / usbcdc）--trace --peek --gpio-log --usb-log

use super::{opt, Syms};
use std::io::Write;
use std::time::Instant;
use tryboard_esp32s3::{Esp32s3, Stop, CPU_HZ};
use tryboard_xtensa::{sr, Bus};

pub fn default_rom() -> String {
    let here = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    here.join("../../../third_party/esp-rom-elfs/esp32s3_rev0_rom.elf").to_string_lossy().into_owned()
}

pub fn run(args: &[String], path: &str, flash: Vec<u8>) {
    let rom_path = opt(args, "--rom").unwrap_or_else(default_rom);
    let seconds: f64 = opt(args, "--seconds").and_then(|s| s.parse().ok()).unwrap_or(5.0);
    let expect = opt(args, "--expect");
    let rom = std::fs::read(&rom_path).unwrap_or_else(|e| panic!("读 ROM {rom_path}: {e}"));
    let (mut m, app) = match Esp32s3::boot(&rom, flash) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("启动失败: {e}");
            std::process::exit(1)
        }
    };
    eprintln!("[tryboard] ESP32-S3 app @0x{:x} 入口 0x{:08x}，{} 段", app.offset, app.entry, app.segments.len());
    if let Some(s) = opt(args, "--uart-in") {
        m.bus.uart0.push_rx(s.replace("\\n", "\n").as_bytes());
    }
    let mut script: Vec<(f64, String)> = opt(args, "--script")
        .map(|s| {
            s.split(';')
                .filter_map(|e| {
                    let (t, a) = e.trim().split_once(':')?;
                    Some((t.trim().parse().ok()?, a.trim().to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    script.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    let total = (seconds * CPU_HZ as f64) as u64;
    let trace: usize = opt(args, "--trace").and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut ring = std::collections::VecDeque::new();
    let app_elf = std::path::Path::new(path).with_file_name("app.elf").to_string_lossy().into_owned();
    let syms = Syms::load(&[rom_path.clone(), app_elf]);
    let t0 = Instant::now();
    let mut out = Vec::new();
    let mut stop = Stop::Budget;
    let mut done = 0u64;
    let stdout = std::io::stdout();
    while done < total {
        let now_s = m.cpu.cycles as f64 / CPU_HZ as f64;
        while script.last().is_some_and(|e| e.0 <= now_s) {
            let (_, act) = script.pop().unwrap();
            if let Some((pin, lv)) = act.strip_prefix("gpio").and_then(|r| r.split_once('=')) {
                let bit = 1u64 << pin.parse::<u32>().unwrap_or(0);
                match lv {
                    "z" => m.bus.gpio.ext_driven &= !bit,
                    _ => {
                        m.bus.gpio.ext_driven |= bit;
                        if lv == "1" {
                            m.bus.gpio.ext_in |= bit;
                        } else {
                            m.bus.gpio.ext_in &= !bit;
                        }
                    }
                }
                let now = m.cpu.cycles;
                m.bus.gpio_changed(now);
            } else if let Some(t) = act.strip_prefix("uart=") {
                m.bus.uart0.push_rx(t.replace("\\n", "\n").as_bytes());
                m.bus.irq_dirty = true;
            } else if let Some(t) = act.strip_prefix("usbcdc=") {
                // 虚拟电脑往 USB 虚拟串口里写
                m.bus.usb.as_mut().unwrap().host.cdc_tx.extend_from_slice(t.replace("\\n", "\n").as_bytes());
            }
            eprintln!("[tryboard] {now_s:.3}s 输入: {act}");
        }
        let slice = if script.is_empty() { CPU_HZ / 100 } else { CPU_HZ / 1000 };
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
    let sim = m.cpu.cycles as f64 / CPU_HZ as f64;
    eprintln!(
        "\n[tryboard] 停止: {stop:?}  pc=0x{:08x}  模拟 {sim:.3}s / 实际 {wall:.3}s（{:.1} MIPS）",
        m.cpu.pc,
        m.cpu.instret as f64 / wall / 1e6
    );
    eprintln!(
        "[tryboard] pc {}  PS=0x{:08x} WB={} WS=0x{:04x} INTENABLE=0x{:08x} INTERRUPT=0x{:08x} VECBASE=0x{:08x}",
        syms.name(m.cpu.pc),
        m.cpu.ps(),
        m.cpu.windowbase,
        m.cpu.windowstart,
        m.cpu.read_sr(sr::INTENABLE),
        m.cpu.read_sr(sr::INTERRUPT),
        m.cpu.read_sr(sr::VECBASE)
    );
    eprintln!(
        "[tryboard] EXCCAUSE={} EXCVADDR=0x{:08x} EPC1={} DEPC={}",
        m.cpu.read_sr(sr::EXCCAUSE),
        m.cpu.read_sr(sr::EXCVADDR),
        syms.name(m.cpu.read_sr(sr::EPC1)),
        syms.name(m.cpu.read_sr(sr::DEPC))
    );
    if std::env::var("TB_REGS").is_ok() {
        let regs: Vec<String> = (0..16).map(|i| format!("a{i}={:08x}", m.cpu.a(i))).collect();
        eprintln!("[tryboard] {}", regs.join(" "));
        let ar: Vec<String> = m.cpu.ar.iter().map(|v| format!("{v:08x}")).collect();
        eprintln!("[tryboard] AR {}", ar.join(" "));
    }
    if let Stop::Fault { cause, epc, vaddr } = stop {
        eprintln!("[tryboard] 异常 EXCCAUSE={cause} EPC1={} EXCVADDR=0x{vaddr:08x}", syms.name(epc));
    }
    if let Stop::Hle(pc) = stop {
        eprintln!("[tryboard] 未实现的 HLE: 0x{pc:08x} {}", m.symbol_at(pc).unwrap_or("?"));
    }
    if trace > 0 {
        eprintln!("[tryboard] 最近的跳转目标：");
        for pc in &ring {
            eprintln!("    {}", syms.name(*pc));
        }
    }
    let mut un: Vec<_> = m.bus.unimpl.iter().collect();
    un.sort_by(|a, b| b.1.cmp(a.1));
    eprintln!("[tryboard] 未建模寄存器 {} 个，访问最多的：", un.len());
    for (a, n) in un.iter().take(12) {
        eprintln!("    0x{:08x}  {:>8} 次", a, n);
    }
    if let Some(list) = opt(args, "--peek") {
        for a in list.split(',') {
            if let Ok(a) = u32::from_str_radix(a.trim().trim_start_matches("0x"), 16) {
                let v = m.bus.load(a, 4).unwrap_or(0xdead_beef);
                eprintln!("[tryboard] peek 0x{a:08x} = 0x{v:08x}");
            }
        }
    }
    if args.iter().any(|a| a == "--gpio-log") {
        for pin in 0..tryboard_esp32s3::periph::NPINS {
            let mut n = 0;
            let mut prev = 1u64;
            for (_, lv) in &m.bus.gpio_log {
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
    if args.iter().any(|a| a == "--usb-log") {
        print_usb(m.bus.usb.as_ref().unwrap());
    }
    if let Some(e) = expect {
        let ok = String::from_utf8_lossy(&out).contains(e.as_str());
        eprintln!("[tryboard] 期望输出 {:?}: {}", e, if ok { "PASS" } else { "FAIL" });
        std::process::exit(if ok { 0 } else { 1 });
    }
}

/// 虚拟主机看到的情况：枚举日志、设备信息、键盘输入、鼠标、USB 串口
fn print_usb(u: &tryboard_esp32s3::usb::Usb) {
    let h = &u.host;
    eprintln!("[tryboard] USB 主机：{}", h.state_name());
    for l in &h.log {
        eprintln!("[usb] {l}");
    }
    let i = &h.info;
    if i.vid != 0 {
        eprintln!("[tryboard] USB 设备 {:04x}:{:04x} \"{}\" / \"{}\" 序列号 \"{}\"", i.vid, i.pid, i.manufacturer, i.product, i.serial);
    }
    if !h.typed.is_empty() {
        eprintln!("[tryboard] USB 键盘输入: {:?}", h.typed);
    }
    if h.mouse.3 > 0 {
        eprintln!("[tryboard] USB 鼠标报告 {} 次，位置 ({}, {})，按键 {}", h.mouse.3, h.mouse.0, h.mouse.1, h.mouse.2);
    }
    if !h.cdc_rx.is_empty() {
        eprintln!("[tryboard] USB 串口收到: {:?}", String::from_utf8_lossy(&h.cdc_rx));
    }
}
