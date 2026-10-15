//! 原生命令行：跑固件、跑 riscv-tests、出未实现寄存器报告。

use std::io::Write;
use std::time::Instant;
use tryboard_machine::{Chip, Machine, SensorEnv, Stop, CPU_HZ};
use tryboard_rv32::{elf::Elf, Bus, BusFault, Cpu, Exit};

fn usage() -> ! {
    eprintln!(
        "用法:
  tryboard run <flash.bin>（芯片按镜像头自动识别：ESP32-C3 / ESP32-S3）[--rom <rom.elf>] [--seconds <模拟秒数>] [--expect <文本>] [--uart-in <文本>]
               [--script \"0.5:gpio9=0; 0.6:gpio9=z; 1.0:uart=ping\\n\"] [--trace N] [--gpio-log] [--pwm-log PIN] [--ws2812-log]
               [--i2c ssd1306@0x3c,bme280@0x76] [--env 温度,湿度,气压Pa] [--oled]
  tryboard riscv-test <test.elf>..."
    );
    std::process::exit(2)
}

fn default_rom(chip: Chip) -> String {
    let here = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    here.join("../../../third_party/esp-rom-elfs").join(chip.rom_file()).to_string_lossy().into_owned()
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
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

fn run(args: &[String]) {
    let Some(path) = args.first() else { usage() };
    let flash = std::fs::read(path).unwrap_or_else(|e| panic!("读固件 {path}: {e}"));
    let chip = Chip::from_image(&flash).unwrap_or(Chip::Esp32c3);
    let rom_path = opt(args, "--rom").unwrap_or_else(|| default_rom(chip));
    let seconds: f64 = opt(args, "--seconds").and_then(|s| s.parse().ok()).unwrap_or(5.0);
    let expect = opt(args, "--expect");
    let rom = std::fs::read(&rom_path).unwrap_or_else(|e| panic!("读 ROM {rom_path}: {e}"));
    let (mut m, app) = match Machine::boot(&rom, flash) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("启动失败: {e}");
            std::process::exit(1)
        }
    };
    eprintln!("[tryboard] {} app @0x{:x} 入口 0x{:08x}，{} 段", chip.name(), app.offset, app.entry, app.segments);
    if let Some(s) = opt(args, "--uart-in") {
        m.uart_push(s.replace("\\n", "\n").as_bytes());
    }
    // 外接 I2C 器件：--i2c ssd1306@0x3c,bme280@0x76
    if let Some(spec) = opt(args, "--i2c") {
        for item in spec.split(',') {
            let (kind, addr) = item.split_once('@').unwrap_or((item, "0"));
            let addr = u8::from_str_radix(addr.trim_start_matches("0x"), 16).unwrap_or(0);
            if !m.i2c_attach(kind, addr) {
                eprintln!("不认识的 I2C 器件 {kind}");
                std::process::exit(2)
            }
        }
    }
    // 环境：--env 温度,湿度,气压(Pa)
    if let Some(e) = opt(args, "--env") {
        let v: Vec<f64> = e.split(',').filter_map(|x| x.parse().ok()).collect();
        if let [t, h, p] = v.as_slice() {
            m.env_set(SensorEnv { temp_c: *t, humidity: *h, pressure_pa: *p });
        }
    }
    let total = (seconds * CPU_HZ as f64) as u64;
    let t0 = Instant::now();
    let mut out = Vec::new();
    let mut stop = Stop::Budget;
    let mut done = 0u64;
    let stdout = std::io::stdout();
    let mut resets = 0;
    // 定时输入脚本：时间（模拟秒）:动作；动作 gpioN=0|1|z、mvN=毫伏、uart=文本、usbcdc=文本（\\n 为换行）
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
    let pwm_pin: Option<usize> = opt(args, "--pwm-log").and_then(|s| s.parse().ok());
    let mut pwm_trace: Vec<(f64, f32, f32)> = Vec::new();
    // --watch A 或 A-B（十六进制）：记录这段 MMIO 的访问
    let hex = |s: &str| u32::from_str_radix(s.trim().trim_start_matches("0x"), 16).ok();
    let watch = opt(args, "--watch").and_then(|s| match s.split_once('-') {
        Some((a, b)) => Some((hex(a)?, hex(b)?)),
        None => hex(&s).map(|a| (a, a + 4)),
    });
    if let Machine::C3(c) = &mut m {
        c.bus.watch = watch;
    }
    let trace: usize = opt(args, "--trace").and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut ring = std::collections::VecDeque::new();
    let app_elf = std::path::Path::new(path).with_file_name("app.elf").to_string_lossy().into_owned();
    let syms = Syms::load(&[rom_path.clone(), app_elf]);
    while done < total {
        let now_s = m.cycles() as f64 / CPU_HZ as f64;
        while script.last().is_some_and(|e| e.0 <= now_s) {
            let (_, act) = script.pop().unwrap();
            if let Some((pin, lv)) = act.strip_prefix("gpio").and_then(|r| r.split_once('=')) {
                let pin: u32 = pin.parse().unwrap_or(0);
                let level = match lv {
                    "z" => -1,
                    "1" => 1,
                    _ => 0,
                };
                m.gpio_drive(pin, level);
            } else if let Some((pin, mv)) = act.strip_prefix("mv").and_then(|r| r.split_once('=')) {
                // mvN=电压：引脚 N 上的模拟电压（毫伏）
                if let (Ok(p), Ok(v)) = (pin.parse::<usize>(), mv.parse::<f32>()) {
                    m.analog_set(p, v);
                }
            } else if let Some(t) = act.strip_prefix("uart=") {
                m.uart_push(t.replace("\\n", "\n").as_bytes());
            } else if let Some(t) = act.strip_prefix("usbcdc=") {
                // 虚拟电脑往 USB 虚拟串口里写
                if let Some(u) = m.usb_mut() {
                    u.host.cdc_tx.extend_from_slice(t.replace("\\n", "\n").as_bytes());
                }
            }
            eprintln!("[tryboard] {now_s:.3}s 输入: {act}");
        }
        if let Some(p) = pwm_pin {
            if let Some((d, f)) = m.pin_pwm(p) {
                if pwm_trace.last().is_none_or(|l| (l.1 - d).abs() > 0.004 || (l.2 - f).abs() > 0.5) {
                    pwm_trace.push((now_s, d, f));
                }
            }
        }
        let slice = if script.is_empty() && pwm_pin.is_none() { CPU_HZ / 100 } else { CPU_HZ / 1000 };
        let before = m.cycles();
        stop = if trace > 0 {
            m.run_traced(slice.min(total - done), &mut ring, trace)
        } else {
            m.run(slice.min(total - done))
        };
        done += m.cycles() - before;
        let c = m.console_take();
        if !c.is_empty() {
            let mut lock = stdout.lock();
            lock.write_all(&c).ok();
            lock.flush().ok();
            out.extend_from_slice(&c);
        }
        if let Stop::Reset(r) = stop {
            // 软件复位：重新上电（flash / NVS 保留），最多 50 次，防止崩溃重启死循环跑满
            resets += 1;
            eprintln!("[tryboard] 软件复位（原因 {r}），第 {resets} 次重新上电");
            if resets > 50 || m.reboot(r).is_err() {
                break;
            }
            stop = Stop::Budget;
            continue;
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
    let sim = m.cycles() as f64 / CPU_HZ as f64;
    eprintln!(
        "\n[tryboard] 停止: {stop:?}  pc=0x{:08x}  模拟 {sim:.3}s / 实际 {wall:.3}s（{:.1} MIPS）",
        m.pc(),
        m.instret() as f64 / wall / 1e6
    );
    eprintln!("[tryboard] {}", m.debug_state(&|a| syms.name(a)));
    if trace > 0 {
        eprintln!("[tryboard] 最近的跳转目标：");
        for pc in &ring {
            eprintln!("    {}", syms.name(*pc));
        }
    }
    match &stop {
        Stop::Fault(s) => eprintln!("[tryboard] 异常：{s}"),
        Stop::Hle(s) => eprintln!("[tryboard] 未实现的 HLE: {s}"),
        Stop::Reset(r) => eprintln!("[tryboard] 软件复位（原因 {r}）后无法重新上电"),
        Stop::Budget => {}
    }
    let un = m.unimpl();
    eprintln!("[tryboard] 未建模寄存器 {} 个，访问最多的：", un.len());
    for (a, n) in un.iter().take(12) {
        eprintln!("    0x{:08x}  {:>8} 次", a, n);
    }
    if let Machine::C3(c) = &mut m {
        if !c.bus.watch_hits.is_empty() {
            // 顺序日志写文件，终端只给按（地址, 读写, PC）汇总
            if let Some(path) = opt(args, "--watch-log") {
                let mut f = String::new();
                for (pc, a, v, w) in &c.bus.watch_hits {
                    f.push_str(&format!("{} 0x{a:08x} 0x{v:08x} {}\n", if *w { "W" } else { "R" }, syms.name(*pc)));
                }
                std::fs::write(&path, f).ok();
            }
            let mut by: std::collections::BTreeMap<(u32, bool, u32), (u32, u32)> = Default::default();
            for (pc, a, v, w) in &c.bus.watch_hits {
                let e = by.entry((*a, *w, *pc)).or_insert((0, *v));
                e.0 += 1;
                e.1 = *v;
            }
            eprintln!("[tryboard] 监视区间访问 {} 次：", c.bus.watch_hits.len());
            for ((a, w, pc), (n, v)) in by {
                eprintln!("    0x{a:08x} {} {:>6} 次 最后 0x{v:08x}  {}", if w { "写" } else { "读" }, n, syms.name(pc));
            }
        }
        if let Some(spec) = opt(args, "--dump") {
            // --dump 地址:长度（十六进制地址，十进制长度）
            if let Some((a, n)) = spec.split_once(':') {
                if let (Some(a), Ok(n)) = (hex(a), n.parse::<u32>()) {
                    for row in (0..n).step_by(16) {
                        let bytes: Vec<String> = (row..(row + 16).min(n))
                            .map(|i| format!("{:02x}", c.bus.load(a + i, 1).unwrap_or(0)))
                            .collect();
                        eprintln!("    {:08x}: {}", a + row, bytes.join(" "));
                    }
                }
            }
        }
        if args.iter().any(|a| a == "--wifi-log") {
            let w = &c.bus.wifi;
            eprintln!("[tryboard] Wi-Fi 空中日志：发送 {} 帧，接收 {} 帧，丢弃 {} 帧", w.tx_frames, w.rx_frames, w.rx_dropped);
            for l in &w.log {
                eprintln!("    {l}");
            }
        }
        if args.iter().any(|a| a == "--dump-intc") {
            let ic = &c.bus.intc;
            eprintln!("[tryboard] 中断线 使能=0x{:08x} 边沿=0x{:08x} 阈值={} 当前线={}", ic.enable, ic.edge, ic.thresh, c.cpu.irq_line);
            for (src, line) in ic.map.iter().enumerate() {
                if *line != 0 {
                    eprintln!("    源 {src:>2} → 线 {line:>2}（优先级 {}）", ic.pri[*line as usize]);
                }
            }
        }
    }
    if let Some(list) = opt(args, "--peek") {
        for a in list.split(',') {
            if let Ok(a) = u32::from_str_radix(a.trim().trim_start_matches("0x"), 16) {
                let v = m.peek(a).unwrap_or(0xdead_beef);
                eprintln!("[tryboard] peek 0x{a:08x} = 0x{v:08x}");
            }
        }
    }
    if let Some(p) = pwm_pin {
        let duties: Vec<f32> = pwm_trace.iter().map(|x| x.1).collect();
        let (mn, mx) = duties.iter().fold((1f32, 0f32), |(a, b), d| (a.min(*d), b.max(*d)));
        let freq = pwm_trace.last().map(|x| x.2).unwrap_or(0.0);
        if std::env::var("TB_PWM_DUMP").is_ok() {
            for (t, d, f) in pwm_trace.iter().step_by((pwm_trace.len() / 40).max(1)) {
                eprintln!("    {t:.3}s duty={d:.3} {f:.0}Hz");
            }
        }
        eprintln!("[tryboard] PWM GPIO{p}: {} 次变化，占空比 {:.3}..{:.3}，频率 {:.1}Hz", pwm_trace.len(), mn, mx, freq);
    }
    if args.iter().any(|a| a == "--gpio-log") {
        let log = m.gpio_log();
        for pin in 0..chip.npins() {
            let mut n = 0;
            let mut prev = m.gpio_reset_level();
            for (_, lv) in &log {
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
        let mut pins: Vec<_> = m.ws2812().iter().collect();
        pins.sort_by_key(|(p, _)| **p);
        for (pin, d) in pins {
            eprintln!("[tryboard] WS2812 GPIO{pin} 共 {} 帧", d.frames);
            for (t, rgb) in &d.history {
                let cols: Vec<String> = rgb.iter().map(|c| format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])).collect();
                eprintln!("    {:.4}s {}", *t as f64 / CPU_HZ as f64, cols.join(" "));
            }
        }
    }
    if args.iter().any(|a| a == "--usb-log") {
        match m.usb() {
            Some(u) => print_usb(u),
            None => eprintln!("[tryboard] 这颗芯片没有原生 USB OTG"),
        }
    }
    let (tr, nack) = m.i2c_stats();
    if tr > 0 {
        eprintln!("[tryboard] I2C 事务 {tr} 次，NACK {nack} 次");
    }
    let show_oled = args.iter().any(|a| a == "--oled");
    if let Some(o) = m.oled() {
        let n = o.lit_pixels();
        eprintln!(
            "[tryboard] OLED 点亮像素 {n}（显示{}，电荷泵{}）",
            if o.display_on { "开" } else { "关" },
            if o.charge_pump { "开" } else { "关" }
        );
        if show_oled {
            eprint!("{}", o.ascii());
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
        Ok(b.iter()
            .enumerate()
            .fold(0, |v, (i, x)| v | (*x as u32) << (8 * i)))
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
        let mut bus = TestBus {
            ram: vec![0; 1 << 20],
            tohost: elf.symbol("tohost").expect("没有 tohost"),
            result: None,
        };
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
        let name = std::path::Path::new(p)
            .file_name()
            .unwrap()
            .to_string_lossy();
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
