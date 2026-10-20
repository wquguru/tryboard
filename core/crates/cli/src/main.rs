//! Native command line: run firmware, run riscv-tests, report unimplemented registers.

use std::io::Write;
use std::time::Instant;
use tryboard_machine::{
    parse_battery, parse_imu, parse_touch, Chip, Lcd, Machine, PowerMode, SensorEnv, Stop,
    BROWNOUT_RESET, CPU_HZ,
};
use tryboard_rv32::{elf::Elf, Bus, BusFault, Cpu, Exit};

fn usage() -> ! {
    eprintln!(
        "Usage:
  tryboard chips (supported chips as JSON: id, pins, BOOT / RGB GPIO, ROM)
  tryboard run <flash.bin> (chip detected from the image header: ESP32 / ESP32-C3 / ESP32-S3) [--rom <rom.elf>] [--seconds <simulated s>] [--expect <text>] [--uart-in <text>]
               [--script \"0.5:gpio9=0; 0.6:gpio9=z; 1.0:uart=ping\\n; 1.2:env=35,45,101325\"] [--inputs <input log exported from the web.txt>] [--trace N] [--unimpl N] [--gpio-log] [--pwm-log PIN] [--ws2812-log]
               [--trace-io <events.txt>] [--trace-pins all|4,8,…] (logic analyzer events: GPIO / PWM / WS2812 / I2C transactions, cycle-stamped)
               [--trace-tasks <timeline.json>] (FreeRTOS task switches, one track per core, opens in Perfetto; per-task CPU share printed at the end of stderr)
               [--i2c ssd1306@0x3c,bme280@0x76] [--env temp,humidity,pressure Pa] [--oled] [--i2c-log] (acks per address)
               [--i2c-bus sda=N,scl=N[,nopull]:kind@addr,...] (repeatable: bus on fixed pads, reached by the routed I2C0/I2C1 or bit-banged GPIO; external pull-ups unless nopull)
               [--efuse-pkg N] (package version eFuse: S3 0 QFN56 / 1 PICO; ESP32 5 PICO-D4 / 6 PICO-V3-02)
               [--psram MB] (classic ESP32 quad PSRAM: 0 / 2 / 4 / 8; --efuse-pkg 6 implies 2)
               (more I2C devices: mpu6050@0x68, qmi8658@0x6b, cst816s@0x15, ft6236@0x38, cst9220@0x5a, axp2101@0x34, pcf85063@0x51, es8311@0x18, es7210@0x40;
               M5 parts: mpu6886@0x68, bmi270@0x68 (BMM150 on its AUX bus), bmm150@0x10, bm8563@0x51 (= pcf8563), aw9523@0x58, axp192@0x34,
               lp5562@0x30, tca8418@0x34, ft6336@0x38, ft3267@0x38, ina3221@0x40, ltr553@0x23, aw88298@0x36)
               [--battery PCT[,usb]] (AXP2101 / AXP192) [--rtc EPOCH] (PCF85063 / BM8563, UTC) [--touch-int <GPIO>] (touch INT pin: low while pressed)
               script actions imu=pitch,roll,yaw[,their rates in °/s], touch=x,y (screen pixels, press / move), release (lift)
               [--spi gc9a01] (S3: SCLK=12 MOSI=11 CS=10 DC=14 RST=13 BL=15; C3: SCLK=6 MOSI=7 CS=10 DC=5 RST=4 BL=3) [--lcd-ppm <last frame.ppm>]
               [--spi co5300] (S3 QSPI AMOLED 480x480: CS=12 CLK=38 D0..D3=4..7 RST=39)
               [--power usb|ext] (default usb; ext = servo powered from an external 5 V 2 A supply) [--servo <GPIO>] (attach an SG90; its current loads the power net)
               [--elec-report] (per-node minimum voltage, peak current, brownout resets); script action power=usb|ext
               [--i2c-wire <cm>] (total I2C wire length: bus capacitance -> rise time; beyond spec reads go wrong / NACK, estimate)
               [--antenna-loss <dB>] (antenna blocked by metal / battery: virtual AP RSSI drops, too low fails to connect, estimate); script actions i2cwire=cm, antenna=dB
               [--ap-phone [ssid[,pass]]] (virtual phone joins the firmware SoftAP, default open TryBoard-Setup; opens the login page when a captive portal is detected)
               [--ap-post 'ssid=MyHome&pass=12345678'] (auto-submits the login form); with the phone a virtual router MyHome / 12345678 (192.168.5.0/24) appears
               [--adc real|ideal] (default real: calibration curve, end bends, noise; ideal: linear, exact); script action adc=real|ideal
               script actions phone=join,ssid[,pass], phone=open, phone=get,URL, phone=post,URL,form, phone=leave
               script actions realnet=1|0 (the web \"real network\" toggle), netreply=id,status,ms,content type|reason,base64 body (real replies recorded on the web; the CLI never goes online)
               [--seed N] (session seed, default 7: ADC noise and which frames a weak / flaky network loses) [--net normal|weak|flaky|offline]
               [--net-fault reboot|dns|silent@<start s>[,<duration s>]] (repeatable, duration default 8); script actions seed=N, net=preset, netfault=kind[,s] (starts at the action time)
               [--encoder A,B[,SW]] (EC11 rotary encoder; script actions enc=+N / enc=-N turn N detents, encsw=1|0 press / release)
               [--sonar TRIG,ECHO] [--dist cm] (HC-SR04; script action dist=cm, negative = nothing in front)
               [--dht11 GPIO] (DHT11 on an open-drain data pin; readings from --env / script action env=)
               [--vcd <file.vcd>] [--vcd-pins 5[,..]|all] [--vcd-window <start s>..<end s>] (every edge, 1 ps timescale, 1 cycle = 6250 ps)
               [--i2s max98357a,inmp441] (S3: speaker BCLK=16 LRC=17 DIN=18, mic SCK=39 WS=40 SD=41; C3: speaker 0/1/2, mic 0/1/3)
               [--mic <sound.wav>] (INMP441 loops this WAV, attaches the mic automatically) [--audio-wav <speaker output.wav>]
               [--ble-phone] (virtual phone: scan, connect to the first device, read all readable characteristics, subscribe to all notifications; air events on stderr)
               script actions ble=scan|scan off|connect [address|name]|disconnect|read <UUID|0xhandle>|write <UUID|0xhandle> <hex>|sub <UUID>|unsub <UUID>|auto
               [--desk-pc] (virtual desktop, Claude Desktop Buddy protocol over BLE Nordic UART: connects to a device named Claude*, sends time / owner / heartbeats, polls status every 2 s)
               script actions pc=on|off|json,<base64 one-line JSON>|hb,<base64 heartbeat template, {{tokens}} {{tokens_today}} {{running}} {{time}} substituted>
  tryboard elec-net <netlist.cir> [--at s,s...] (DC / transient solve, for comparison with ngspice, see tools/elec)
  tryboard riscv-test <test.elf>..."
    );
    std::process::exit(2)
}

fn default_rom(chip: Chip) -> String {
    let here = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    here.join("../../../third_party/esp-rom-elfs")
        .join(chip.rom_file())
        .to_string_lossy()
        .into_owned()
}

use tryboard_machine::PhoneCmd;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        Some("run") => run(&args[1..]),
        Some("riscv-test") => riscv_tests(&args[1..]),
        Some("elec-net") => elec_net(&args[1..]),
        Some("chips") => chips(),
        _ => usage(),
    }
}

/// Chip table as JSON: the source of truth web/src/chipid.ts and chips.ts are tested against (R-03)
fn chips() {
    let rows: Vec<String> = tryboard_machine::Chip::ALL
        .iter()
        .map(|c| {
            let rgb = c.rgb_pin().map_or("null".to_string(), |p| p.to_string());
            format!(
                "{{\"name\":\"{}\",\"id\":{},\"npins\":{},\"bootPin\":{},\"rgbPin\":{},\"rom\":\"{}\"}}",
                c.name(), c.id(), c.npins(), c.boot_pin(), rgb, c.rom_file()
            )
        })
        .collect();
    println!("[{}]", rows.join(","));
}

/// Symbols from ROM + app.elf (auto-loaded when next to flash.bin); lookup returns the nearest symbol below an address.
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
    /// Name of the function containing the address (None if unknown)
    fn func(&self, a: u32) -> Option<String> {
        match self.0.partition_point(|(x, _)| *x <= a) {
            0 => None,
            i => Some(self.0[i - 1].1.clone()),
        }
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

/// --trace-tasks: write the Perfetto file and print per-core, per-task CPU share over the whole run
fn task_report(
    m: &mut Machine,
    ev: &[tryboard_machine::TaskEvent],
    path: &str,
    chip: Chip,
    syms: &Syms,
) {
    use tryboard_soc::tasktrace::{report, state};
    let end = m.cycles();
    let cores = m.cores();
    let dropped = m.tasks_dropped();
    let tasks = m.tasks_list().to_vec();
    let sl = report::slices(ev, end);
    // With symbols (ROM / app.elf) the PC a task resumes at becomes a function name
    let func = |a: u32| syms.func(a);
    let json = report::chrome_json(&tasks, &sl, chip.name(), cores, CPU_HZ, &func);
    if let Err(e) = std::fs::write(path, json) {
        eprintln!("[tryboard] failed to write task timeline {path}: {e}");
    }
    let switches = ev
        .iter()
        .filter(|e| e.task != tryboard_soc::tasktrace::NO_TASK)
        .count();
    let waits = sl.iter().filter(|s| s.end == state::WAIT).count();
    eprintln!(
        "[tryboard] task timeline: {switches} switches, {} tasks, {waits} queue / semaphore waits (dropped {dropped}) -> {path}",
        tasks.len()
    );
    // Each core's span starts at its first switch: earlier cycles are startup code owned by no task
    for c in 0..cores as u8 {
        let first = sl.iter().filter(|s| s.core == c).map(|s| s.t0).min();
        let Some(first) = first else {
            eprintln!("[tryboard] task core{c} saw no task switch");
            continue;
        };
        let span = (end - first).max(1) as f64;
        for (core, t, n) in report::usage(&sl) {
            if core != c {
                continue;
            }
            let ti = &tasks[t as usize];
            eprintln!(
                "[tryboard] task core{c} {} {:.1}% (priority {})",
                ti.name,
                n as f64 * 100.0 / span,
                ti.prio
            );
        }
    }
}

/// `kind@0xNN` list item -> (kind, 7-bit address)
fn i2c_item(item: &str) -> (&str, u8) {
    let (kind, addr) = item.split_once('@').unwrap_or((item, "0"));
    (
        kind,
        u8::from_str_radix(addr.trim_start_matches("0x"), 16).unwrap_or(0),
    )
}

/// `--i2c` (legacy, I2C0 without pin check), `--i2c-bus` (pin buses, M5-02, repeatable), `--efuse-pkg`
fn i2c_opts(m: &mut Machine, args: &[String], chip: &str) {
    if let Some(spec) = opt(args, "--i2c") {
        for (kind, addr) in spec.split(',').map(i2c_item) {
            if !m.i2c_attach(kind, addr) {
                eprintln!("unknown I2C device {kind}");
                std::process::exit(2)
            }
        }
    }
    let buses = args.windows(2).filter(|w| w[0] == "--i2c-bus");
    for spec in buses.map(|w| w[1].as_str()) {
        if let Err(e) = i2c_bus_spec(m, spec) {
            eprintln!("--i2c-bus {spec}: {e}");
            std::process::exit(2)
        }
    }
    if let Some(p) = opt(args, "--efuse-pkg") {
        if !p.parse().is_ok_and(|n| m.set_efuse_pkg(n)) {
            eprintln!("--efuse-pkg {p}: unsupported on {chip}");
            std::process::exit(2)
        }
    }
    if let Some(p) = opt(args, "--psram") {
        if !p.parse().is_ok_and(|n| m.set_psram_mb(n)) {
            eprintln!("--psram {p}: unsupported on {chip} (classic ESP32: 0, 2, 4 or 8 MB)");
            std::process::exit(2)
        }
    }
}

/// `sda=11,scl=12[,nopull]:bme280@0x76,...`: add the bus, then its devices
fn i2c_bus_spec(m: &mut Machine, spec: &str) -> Result<(), String> {
    let (pins, devs) = spec.split_once(':').unwrap_or((spec, ""));
    let (mut sda, mut scl, mut pull) = (None, None, true);
    for kv in pins.split(',') {
        match kv.split_once('=') {
            Some(("sda", v)) => sda = v.parse::<u32>().ok(),
            Some(("scl", v)) => scl = v.parse::<u32>().ok(),
            None if kv == "nopull" => pull = false,
            _ => return Err(format!("bad pin item '{kv}'")),
        }
    }
    let (Some(sda), Some(scl)) = (sda, scl) else {
        return Err("needs sda=N,scl=N".into());
    };
    let bus = m
        .i2c_bus_add(sda, scl, pull)
        .ok_or("pad already on a bus, or chip without pin buses")?;
    for item in devs.split(',').filter(|s| !s.is_empty()) {
        let (kind, addr) = i2c_item(item);
        if !m.i2c_attach_bus(bus, kind, addr) {
            return Err(format!("unknown I2C device {kind}"));
        }
    }
    Ok(())
}

fn opt(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

/// Timed input script: `time (simulated s):action`, separated by `;` or newlines, `#` starts a comment.
/// Actions: gpioN=0|1|z, mvN=millivolts, env=temp,humidity,pressure Pa, uart=text, usbcdc=text (\\n = newline)
fn parse_script(s: &str) -> Vec<(f64, String)> {
    s.split([';', '\n'])
        .filter_map(|e| {
            let e = e.trim();
            if e.starts_with('#') {
                return None;
            }
            let (t, a) = e.split_once(':')?;
            Some((t.trim().parse().ok()?, a.trim().to_string()))
        })
        .collect()
}

fn run(args: &[String]) {
    let Some(path) = args.first() else { usage() };
    let flash = std::fs::read(path).unwrap_or_else(|e| panic!("read firmware {path}: {e}"));
    let chip = Chip::from_image(&flash).unwrap_or(Chip::Esp32c3);
    let rom_path = opt(args, "--rom").unwrap_or_else(|| default_rom(chip));
    let seconds: f64 = opt(args, "--seconds")
        .and_then(|s| s.parse().ok())
        .unwrap_or(5.0);
    let expect = opt(args, "--expect");
    let rom = std::fs::read(&rom_path).unwrap_or_else(|e| panic!("read ROM {rom_path}: {e}"));
    let (mut m, app) = match Machine::boot(&rom, flash) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("boot failed: {e}");
            std::process::exit(1)
        }
    };
    eprintln!(
        "[tryboard] {} app @0x{:x} entry 0x{:08x}, {} segments",
        chip.name(),
        app.offset,
        app.entry,
        app.segments
    );
    if let Some(s) = opt(args, "--uart-in") {
        m.uart_push(s.replace("\\n", "\n").as_bytes());
    }
    i2c_opts(&mut m, args, chip.name());
    // Touch INT pin: --touch-int GPIO
    if let Some(pin) = opt(args, "--touch-int").and_then(|s| s.parse().ok()) {
        m.touch_int_attach(pin);
    }
    board_args(&mut m, args);
    // External SPI devices: --spi gc9a01
    if let Some(spec) = opt(args, "--spi") {
        for kind in spec.split(',') {
            if !m.lcd_attach(kind) {
                eprintln!("unsupported SPI device {kind} (gc9a01 on C3 / S3, co5300 on S3)");
                std::process::exit(2)
            }
        }
    }
    // I2S audio devices: --i2s max98357a,inmp441; --mic sound.wav
    if let Some(spec) = opt(args, "--i2s") {
        for kind in spec.split(',') {
            if !m.i2s_attach(kind) {
                eprintln!("unsupported I2S device {kind} (available: max98357a, inmp441)");
                std::process::exit(2)
            }
        }
    }
    if let Some(path) = opt(args, "--mic") {
        let b = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        match tryboard_soc::devices::audio::parse_wav(&b) {
            Ok((rate, x)) => m.mic_wav(rate as f64, x),
            Err(e) => {
                eprintln!("--mic {path}: {e}");
                std::process::exit(2)
            }
        }
    }
    // DHT11: --dht11 DATA (open-drain single wire); attached before --env so it takes the same readings
    let dht11 = opt(args, "--dht11");
    if let Some(spec) = &dht11 {
        match spec.trim().trim_start_matches("GPIO").parse::<u32>() {
            Ok(p) => m.dht11_attach(p),
            Err(_) => {
                eprintln!("--dht11 needs one GPIO number");
                std::process::exit(2)
            }
        }
    }
    // Environment: --env temp,humidity,pressure(Pa)
    if let Some(e) = opt(args, "--env") {
        let v: Vec<f64> = e.split(',').filter_map(|x| x.parse().ok()).collect();
        if let [t, h, p] = v.as_slice() {
            m.env_set(SensorEnv {
                temp_c: *t,
                humidity: *h,
                pressure_pa: *p,
            });
        }
    }
    // Power: --power usb|ext, --servo GPIO (which rail feeds the servo current, see tryboard-elec)
    if let Some(p) = opt(args, "--power") {
        match PowerMode::parse(&p) {
            Some(mode) => m.set_power(mode),
            None => {
                eprintln!("--power accepts only usb / ext");
                std::process::exit(2)
            }
        }
    }
    let servo: Option<u32> = opt(args, "--servo").and_then(|s| s.parse().ok());
    if let Some(pin) = servo {
        m.servo_attach(pin);
    }
    // D-02: ADC model mode (the session seed is applied below with the network options)
    if let Some(mode) = opt(args, "--adc") {
        m.set_adc_ideal(mode == "ideal");
    }
    // Harness (P2-11, estimate): I2C wire length, antenna blockage
    if let Some(cm) = opt(args, "--i2c-wire").and_then(|s| s.parse::<f64>().ok()) {
        m.set_i2c_wire(Some(cm));
    }
    if let Some(db) = opt(args, "--antenna-loss").and_then(|s| s.parse::<i32>().ok()) {
        m.set_antenna_loss(db);
    }
    // Network conditions (D-01): seed first, since the flaky preset draws its first drop when set
    if let Some(v) = opt(args, "--seed") {
        match v.parse::<u32>() {
            Ok(s) => m.set_seed(s),
            Err(_) => usage(),
        }
    }
    if let Some(v) = opt(args, "--net") {
        if !m.net_preset(&v) {
            usage();
        }
    }
    for (i, a) in args.iter().enumerate() {
        if a != "--net-fault" {
            continue;
        }
        let v = args.get(i + 1).cloned().unwrap_or_default();
        let ok = v.split_once('@').is_some_and(|(k, t)| {
            let (st, d) = t.split_once(',').unwrap_or((t, ""));
            let dur = if d.is_empty() { None } else { d.parse().ok() };
            st.parse::<f64>()
                .is_ok_and(|st| (d.is_empty() || dur.is_some()) && m.net_fault(k, Some(st), dur))
        });
        if !ok {
            usage();
        }
    }
    // Virtual phone (C-02): --ap-phone joins the hotspot at 0 s, --ap-post submits once a form shows up
    let ap_post = opt(args, "--ap-post");
    if let Some(i) = args.iter().position(|a| a == "--ap-phone") {
        let v = args
            .get(i + 1)
            .filter(|v| !v.starts_with("--"))
            .cloned()
            .unwrap_or_else(|| "TryBoard-Setup".into());
        let (ssid, pass) = v.split_once(',').unwrap_or((v.as_str(), ""));
        m.phone_enable(true, ap_post.clone());
        m.phone_cmd(PhoneCmd::Join {
            ssid: ssid.into(),
            pass: pass.into(),
        });
    } else if ap_post.is_some() {
        m.phone_enable(false, ap_post.clone());
    }
    let pins_of = |s: &str| {
        s.split(',')
            .map(|x| x.trim().trim_start_matches("GPIO").parse::<u32>())
            .collect::<Result<Vec<_>, _>>()
            .ok()
    };
    // Rotary encoder: --encoder A,B[,SW]
    let encoder = opt(args, "--encoder");
    if let Some(spec) = &encoder {
        match pins_of(spec).as_deref() {
            Some([a, b]) => m.encoder_attach(*a, *b, None),
            Some([a, b, sw]) => m.encoder_attach(*a, *b, Some(*sw)),
            _ => {
                eprintln!("--encoder needs A,B or A,B,SW (GPIO numbers)");
                std::process::exit(2)
            }
        }
    }
    // HC-SR04: --sonar TRIG,ECHO, --dist initial distance (cm)
    let sonar = opt(args, "--sonar");
    if let Some(spec) = &sonar {
        match pins_of(spec).as_deref() {
            Some([t, e]) => m.sonar_attach(*t, *e),
            _ => {
                eprintln!("--sonar needs TRIG,ECHO (GPIO numbers)");
                std::process::exit(2)
            }
        }
        if let Some(d) = opt(args, "--dist").and_then(|s| s.parse::<f64>().ok()) {
            m.sonar_distance(d);
        }
    }
    let total = (seconds * CPU_HZ as f64) as u64;
    let t0 = Instant::now();
    let mut out = Vec::new();
    let mut stop = Stop::Budget;
    let mut done = 0u64;
    let stdout = std::io::stdout();
    let mut resets = 0;
    // Timed inputs: --script and the --inputs file (input log exported by the web) merged, applied in time order
    let mut script = opt(args, "--script")
        .map(|s| parse_script(&s))
        .unwrap_or_default();
    let inputs = opt(args, "--inputs");
    if let Some(p) = &inputs {
        let text = std::fs::read_to_string(p).unwrap_or_else(|e| panic!("read input log {p}: {e}"));
        script.extend(parse_script(&text));
    }
    // Stable sort: inputs at the same instant keep their written order (press before release, as on the web)
    script.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let mut si = 0;
    let pwm_pin: Option<usize> = opt(args, "--pwm-log").and_then(|s| s.parse().ok());
    let mut pwm_trace: Vec<(f64, f32, f32)> = Vec::new();
    // --watch A or A-B (hex): record accesses to this MMIO range
    let hex = |s: &str| u32::from_str_radix(s.trim().trim_start_matches("0x"), 16).ok();
    let watch = opt(args, "--watch").and_then(|s| match s.split_once('-') {
        Some((a, b)) => Some((hex(a)?, hex(b)?)),
        None => hex(&s).map(|a| (a, a + 4)),
    });
    m.set_watch(watch);
    // Fine logic analyzer (D-04): --vcd <file> --vcd-pins 5[,..] --vcd-window <start s>..<end s> (default the whole run)
    let vcd = opt(args, "--vcd");
    if vcd.is_some() {
        let pins = opt(args, "--vcd-pins").unwrap_or_else(|| "all".into());
        let mask = if pins == "all" {
            u64::MAX
        } else {
            pins.split(',')
                .filter_map(|x| x.trim().trim_start_matches("GPIO").parse::<u32>().ok())
                .filter(|p| *p < 64)
                .fold(0u64, |a, p| a | 1 << p)
        };
        let (a, b) = match opt(args, "--vcd-window") {
            Some(w) => {
                let (a, b) = w.split_once("..").unwrap_or((&w, ""));
                (
                    a.trim().parse::<f64>().unwrap_or(0.0),
                    b.trim().parse::<f64>().unwrap_or(seconds),
                )
            }
            None => (0.0, seconds),
        };
        let c = tryboard_soc::vcd::VcdCapture::cycles_of;
        m.vcd_start(mask, c(a), c(b));
    }
    // Logic analyzer events: drained once per slice into the file (format identical to web iotrace.ts eventLine)
    let trace_io = opt(args, "--trace-io").map(|p| {
        let f = std::fs::File::create(&p).unwrap_or_else(|e| panic!("write {p}: {e}"));
        std::io::BufWriter::new(f)
    });
    let mut trace_io = trace_io;
    let mut io_count = 0u64;
    if let Some(w) = trace_io.as_mut() {
        let mask = match opt(args, "--trace-pins").as_deref() {
            None | Some("all") => u64::MAX,
            Some(list) => list
                .split(',')
                .filter_map(|x| x.trim().trim_start_matches("GPIO").parse::<u32>().ok())
                .filter(|p| *p < 64)
                .fold(0u64, |a, p| a | 1 << p),
        };
        m.io_watch(mask);
        writeln!(
            w,
            "# tryboard trace-io v1 · {} · watched GPIO mask 0x{mask:x}",
            chip.name()
        )
        .ok();
    }
    // Task timeline: drained once per slice, written as Chrome Trace Event JSON at the end
    let trace_tasks = opt(args, "--trace-tasks");
    let mut task_ev: Vec<tryboard_machine::TaskEvent> = Vec::new();
    if trace_tasks.is_some() {
        m.tasks_enable(tryboard_soc::tasktrace::DEFAULT_CAP);
    }
    let trace: usize = opt(args, "--trace")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let mut ring = std::collections::VecDeque::new();
    let app_elf = std::path::Path::new(path)
        .with_file_name("app.elf")
        .to_string_lossy()
        .into_owned();
    let syms = Syms::load(&[rom_path.clone(), app_elf]);
    let has_audio = m.audio().is_some();
    // BLE: the virtual controller exists only if the VHCI boundary was found; --ble-phone = input ble=auto at cycle 0
    if let Some(e) = m.ble_error() {
        eprintln!(
            "[tryboard] BLE: firmware uses the Bluetooth controller but the VHCI boundary was not found ({e}); app.elf is needed"
        );
    }
    // --desk-pc = input pc=on at cycle 0 (E-06)
    for (flag, cmd) in [("--ble-phone", "auto"), ("--desk-pc", "pc=on")] {
        if args.iter().any(|a| a == flag) {
            if let Err(e) = m.ble_phone(cmd) {
                eprintln!("[tryboard] {flag}: {e}");
            }
        }
    }
    let mut ble_seq = 0u64;
    let mut audio_wav: Option<(String, Vec<i16>)> =
        opt(args, "--audio-wav").map(|p| (p, Vec::new()));
    let mut audio_rate = 0f32;
    while done < total {
        let now_s = m.cycles() as f64 / CPU_HZ as f64;
        while script.get(si).is_some_and(|e| e.0 <= now_s) {
            let act = script[si].1.clone();
            si += 1;
            if let Some((pin, lv)) = act.strip_prefix("gpio").and_then(|r| r.split_once('=')) {
                let pin: u32 = pin.parse().unwrap_or(0);
                let level = match lv {
                    "z" => -1,
                    "1" => 1,
                    _ => 0,
                };
                m.gpio_drive(pin, level);
            } else if let Some((pin, mv)) = act.strip_prefix("mv").and_then(|r| r.split_once('=')) {
                // mvN=voltage: analog voltage on pin N (millivolts)
                if let (Ok(p), Ok(v)) = (pin.parse::<usize>(), mv.parse::<f32>()) {
                    m.analog_set(p, v);
                }
            } else if let Some(e) = act.strip_prefix("env=") {
                // env=temp,humidity,pressure(Pa): the web's environment sliders
                let v: Vec<f64> = e.split(',').filter_map(|x| x.trim().parse().ok()).collect();
                if let [t, h, p] = v.as_slice() {
                    m.env_set(SensorEnv {
                        temp_c: *t,
                        humidity: *h,
                        pressure_pa: *p,
                    });
                }
            } else if let Some(v) = act.strip_prefix("imu=") {
                // imu=pitch,roll,yaw[,rate]: the web's tilt sliders / rotating the product
                match parse_imu(v) {
                    Some(p) => m.imu_set(p),
                    None => eprintln!("[tryboard] unparsable imu action: {act}"),
                }
            } else if let Some(v) = act.strip_prefix("touch=") {
                if let Some((x, y)) = parse_touch(v) {
                    m.touch(x, y, true);
                }
            } else if act == "release" {
                m.touch(0, 0, false);
            } else if board_action(&mut m, &act, now_s) {
            } else if let Some(p) = act.strip_prefix("power=") {
                // The web quick card's USB <-> external 5 V toggle
                if let Some(mode) = PowerMode::parse(p.trim()) {
                    m.set_power(mode);
                }
            } else if let Some(cm) = act.strip_prefix("i2cwire=") {
                // Lengthening / shortening the I2C wire on the web (negative = ideal bus)
                if let Ok(cm) = cm.trim().parse::<f64>() {
                    m.set_i2c_wire(if cm < 0.0 { None } else { Some(cm) });
                }
            } else if let Some(mode) = act.strip_prefix("adc=") {
                // The web ADC panel's ideal / real toggle
                m.set_adc_ideal(mode.trim() == "ideal");
            } else if let Some(n) = act.strip_prefix("seed=") {
                if let Ok(n) = n.trim().parse::<u32>() {
                    m.set_seed(n);
                }
            } else if let Some(db) = act.strip_prefix("antenna=") {
                if let Ok(db) = db.trim().parse::<i32>() {
                    m.set_antenna_loss(db);
                }
            } else if let Some(n) = act.strip_prefix("enc=") {
                // Dragging / scrolling the encoder knob on the web: N detents (+ = clockwise)
                if let Ok(n) = n.trim().trim_start_matches('+').parse::<i32>() {
                    m.encoder_turn(n);
                }
            } else if let Some(v) = act.strip_prefix("encsw=") {
                m.encoder_press(v.trim() == "1");
            } else if let Some(v) = act.strip_prefix("dist=") {
                // Dragging the obstacle / changing distance on the web
                if let Ok(d) = v.trim().parse::<f64>() {
                    m.sonar_distance(d);
                }
            } else if let Some(c) = act.strip_prefix("phone=") {
                // One step on the web virtual phone (C-02)
                match PhoneCmd::parse(c) {
                    Some(c) => m.phone_cmd(c),
                    None => eprintln!("[tryboard] unknown phone action: {act}"),
                }
            } else if let Some(v) = act.strip_prefix("realnet=") {
                // Web "real network" switch (C-03): the CLI never goes online, replies only come from later netreply=
                m.realnet_set(v.trim() == "1");
            } else if let Some(v) = act.strip_prefix("netreply=") {
                if !m.net_reply(v) {
                    eprintln!("[tryboard] unknown netreply action");
                }
            } else if let Some(ok) = m.net_action(&act) {
                // Network conditions (D-01): seed=, net=, netfault= (faults start at the action time)
                if !ok {
                    eprintln!("[tryboard] unknown network action: {act}");
                }
            } else if let Some(t) = act.strip_prefix("uart=") {
                m.uart_push(t.replace("\\n", "\n").as_bytes());
            } else if let Some(t) = act.strip_prefix("usbcdc=") {
                // The virtual PC writes into the USB virtual serial port
                if let Some(u) = m.usb_mut() {
                    u.host
                        .cdc_tx
                        .extend_from_slice(t.replace("\\n", "\n").as_bytes());
                }
            }
            if act.starts_with("netreply=") && act.len() > 80 {
                // The base64 reply body can be tens of KB; print only the start
                let cut = (0..=80)
                    .rev()
                    .find(|&i| act.is_char_boundary(i))
                    .unwrap_or(0);
                eprintln!("[tryboard] {now_s:.3}s input: {}…", &act[..cut]);
            } else {
                eprintln!("[tryboard] {now_s:.3}s input: {act}");
            }
        }
        if let Some(p) = pwm_pin {
            if let Some((d, f)) = m.pin_pwm(p) {
                if pwm_trace
                    .last()
                    .is_none_or(|l| (l.1 - d).abs() > 0.004 || (l.2 - f).abs() > 0.5)
                {
                    pwm_trace.push((now_s, d, f));
                }
            }
        }
        // 1 ms slices whenever results depend on slice length, matching web worker.ts: --inputs (S3 core interleave),
        // servo / audio (power net steps per slice), --trace-io / --trace-tasks (event-by-event parity with the web)
        let slice = if si >= script.len()
            && pwm_pin.is_none()
            && inputs.is_none()
            && servo.is_none()
            && trace_io.is_none()
            && trace_tasks.is_none()
            && encoder.is_none()
            && sonar.is_none()
            && dht11.is_none()
            && vcd.is_none()
            && !has_audio
        {
            CPU_HZ / 100
        } else {
            CPU_HZ / 1000
        };
        let before = m.cycles();
        stop = if trace > 0 {
            m.run_traced(slice.min(total - done), &mut ring, trace)
        } else {
            m.run(slice.min(total - done))
        };
        done += m.cycles() - before;
        // Real network (C-03): the CLI never goes online, it only reports; replies come from netreply= recorded by the web in --inputs
        for r in m.net_outbox_take() {
            eprintln!(
                "[tryboard] {:.3}s real network request #{} {} {} (CLI stays offline, waiting for netreply={})",
                m.cycles() as f64 / CPU_HZ as f64,
                r.id,
                r.method,
                r.url,
                r.id
            );
        }
        if let Some((_, buf)) = audio_wav.as_mut() {
            for b in m.audio_take() {
                if buf.is_empty() {
                    audio_rate = b.rate;
                }
                buf.extend_from_slice(&b.data);
            }
        }
        if trace_tasks.is_some() {
            task_ev.extend(m.tasks_take());
        }
        if let Some(w) = trace_io.as_mut() {
            for e in m.io_take() {
                writeln!(w, "{}", e.line()).ok();
                io_count += 1;
            }
        }
        if let Some(b) = m.ble() {
            for (n, l) in b.log_since(ble_seq) {
                eprintln!("[ble] {:9.3}s {:5} {}", l.t_us as f64 / 1e6, l.kind, l.text);
                ble_seq = n + 1;
            }
        }
        let c = m.console_take();
        if !c.is_empty() {
            let mut lock = stdout.lock();
            lock.write_all(&c).ok();
            lock.flush().ok();
            out.extend_from_slice(&c);
        }
        if let Stop::Reset(r) = stop {
            // Software reset: power up again (flash / NVS kept), at most 50 times so a crash loop cannot spin forever
            resets += 1;
            if r == BROWNOUT_RESET {
                eprintln!("[tryboard] {now_s:.3}s brownout reset (3V3 below threshold, reason 15), power-up #{resets}");
            } else {
                eprintln!("[tryboard] software reset (reason {r}), power-up #{resets}");
            }
            if resets > 50 {
                break;
            }
            if let Err(e) = m.reboot(r) {
                eprintln!("[tryboard] power-up failed: {e}");
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
    if let Some(mut w) = trace_io.take() {
        w.flush().ok();
        eprintln!(
            "[tryboard] logic analyzer events {io_count} (dropped on buffer overflow {})",
            m.io_dropped()
        );
    }
    if let Some(p) = &trace_tasks {
        task_ev.extend(m.tasks_take());
        task_report(&mut m, &task_ev, p, chip, &syms);
    }
    let wall = t0.elapsed().as_secs_f64();
    let sim = m.cycles() as f64 / CPU_HZ as f64;
    eprintln!(
        "\n[tryboard] stop: {stop:?}  pc=0x{:08x}  simulated {sim:.3}s / wall {wall:.3}s ({:.1} MIPS)",
        m.pc(),
        m.instret() as f64 / wall / 1e6
    );
    eprintln!("[tryboard] {}", m.debug_state(&|a| syms.name(a)));
    if trace > 0 {
        eprintln!("[tryboard] recent jump targets:");
        for pc in &ring {
            eprintln!("    {}", syms.name(*pc));
        }
    }
    match &stop {
        Stop::Fault(s) => eprintln!("[tryboard] exception: {s}"),
        Stop::Hle(s) => eprintln!("[tryboard] unimplemented HLE: {s}"),
        Stop::Reset(r) => {
            eprintln!("[tryboard] could not power up after software reset (reason {r})")
        }
        Stop::Budget => {}
    }
    if m.adc_blocked() > 0 {
        eprintln!(
            "[tryboard] ADC2: {} reads refused while Wi-Fi held the arbiter (firmware sees ESP_ERR_TIMEOUT)",
            m.adc_blocked()
        );
    }
    // Only printed with a PMIC attached, so other cases' output stays byte-identical
    let (pmic, pu) = m.pmic_unimpl();
    if !pu.is_empty() {
        let list: Vec<String> = pu.iter().map(|(r, n)| format!("0x{r:02x}x{n}")).collect();
        eprintln!("[tryboard] {pmic} unmodeled registers: {}", list.join(" "));
    }
    let un = m.unimpl();
    eprintln!(
        "[tryboard] unmodeled registers: {}, most accessed:",
        un.len()
    );
    // --unimpl N: list the top N (default 12)
    let top = opt(args, "--unimpl")
        .and_then(|s| s.parse().ok())
        .unwrap_or(12);
    for (a, n) in un.iter().take(top) {
        eprintln!("    0x{:08x}  {:>8} times", a, n);
    }
    {
        let hits = m.watch_hits();
        if !hits.is_empty() {
            // The ordered log goes to a file; the terminal only gets a summary by (address, R/W, PC)
            if let Some(path) = opt(args, "--watch-log") {
                let mut f = String::new();
                for (pc, a, v, w) in hits {
                    f.push_str(&format!(
                        "{} 0x{a:08x} 0x{v:08x} {}\n",
                        if *w { "W" } else { "R" },
                        syms.name(*pc)
                    ));
                }
                std::fs::write(&path, f).ok();
            }
            let mut by: std::collections::BTreeMap<(u32, bool, u32), (u32, u32)> =
                Default::default();
            for (pc, a, v, w) in hits {
                let e = by.entry((*a, *w, *pc)).or_insert((0, *v));
                e.0 += 1;
                e.1 = *v;
            }
            eprintln!("[tryboard] watched range accesses: {}", hits.len());
            for ((a, w, pc), (n, v)) in by {
                eprintln!(
                    "    0x{a:08x} {} {:>6} times last 0x{v:08x}  {}",
                    if w { "W" } else { "R" },
                    n,
                    syms.name(pc)
                );
            }
        }
        if let Some(spec) = opt(args, "--dump") {
            // --dump addr:len (hex address, decimal length)
            if let Some((a, n)) = spec.split_once(':') {
                if let (Some(a), Ok(n)) = (hex(a), n.parse::<u32>()) {
                    let data = m.dump(a, n).unwrap_or_default();
                    for (row, chunk) in data.chunks(16).enumerate() {
                        let bytes: Vec<String> = chunk.iter().map(|b| format!("{b:02x}")).collect();
                        eprintln!("    {:08x}: {}", a + row as u32 * 16, bytes.join(" "));
                    }
                }
            }
        }
        if args.iter().any(|a| a == "--dump-intc") {
            if let Some(r) = m.intc_report() {
                eprintln!("{r}");
            }
        }
    }
    if args.iter().any(|a| a == "--wifi-log") {
        let w = m.wifi();
        eprintln!(
            "[tryboard] Wi-Fi air log: sent {} frames, received {} frames, dropped {} frames",
            w.tx_frames, w.rx_frames, w.rx_dropped
        );
        for l in &w.log {
            eprintln!("    {l}");
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
        let (mn, mx) = duties
            .iter()
            .fold((1f32, 0f32), |(a, b), d| (a.min(*d), b.max(*d)));
        let freq = pwm_trace.last().map(|x| x.2).unwrap_or(0.0);
        if std::env::var("TB_PWM_DUMP").is_ok() {
            for (t, d, f) in pwm_trace.iter().step_by((pwm_trace.len() / 40).max(1)) {
                eprintln!("    {t:.3}s duty={d:.3} {f:.0}Hz");
            }
        }
        eprintln!(
            "[tryboard] PWM GPIO{p}: {} changes, duty {:.3}..{:.3}, freq {:.1}Hz",
            pwm_trace.len(),
            mn,
            mx,
            freq
        );
        // Steps as duty@time (neighbours equal to 3 decimals merged); level checks read sequences and settled values from it
        let mut steps: Vec<String> = Vec::new();
        let mut last = String::new();
        for (t, d, _) in &pwm_trace {
            let k = format!("{d:.3}");
            if k != last {
                steps.push(format!("{k}@{t:.3}"));
                last = k;
            }
        }
        eprintln!("[tryboard] PWM GPIO{p} steps {}", steps.join(" "));
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
                eprintln!("[tryboard] GPIO{pin} toggled {n} times");
            }
        }
    }
    if args.iter().any(|a| a == "--ws2812-log") {
        let mut pins: Vec<_> = m.ws2812().iter().collect();
        pins.sort_by_key(|(p, _)| **p);
        for (pin, d) in pins {
            eprintln!("[tryboard] WS2812 GPIO{pin} {} frames", d.frames);
            for (t, rgb) in &d.history {
                let cols: Vec<String> = rgb
                    .iter()
                    .map(|c| format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2]))
                    .collect();
                eprintln!("    {:.4}s {}", *t as f64 / CPU_HZ as f64, cols.join(" "));
            }
        }
    }
    if let Some(b) = m.ble() {
        if !b.unknown_cmds.is_empty() {
            let l: Vec<String> = b
                .unknown_cmds
                .iter()
                .map(|(o, n)| format!("0x{o:04x}×{n}"))
                .collect();
            eprintln!(
                "[tryboard] BLE: HCI commands answered with plain success {}",
                l.join(" ")
            );
        }
    }
    if args.iter().any(|a| a == "--usb-log") {
        match m.usb() {
            Some(u) => {
                eprint!("{}", tryboard_machine::usb_report_lines(&m));
                print_usb(u)
            }
            None => eprintln!("[tryboard] this chip has no native USB OTG"),
        }
    }
    if args.iter().any(|a| a == "--elec-report") {
        eprint!("{}", m.elec.report());
    }
    if let Some(p) = m.encoder_position() {
        let c = m
            .pcnt_count(0)
            .map(|c| format!(", PCNT unit 0 count {c}"))
            .unwrap_or_default();
        eprintln!("[tryboard] encoder turned {p} detents (clockwise positive){c}");
    }
    if let Some((pings, echoes, us)) = m.sonar_stats() {
        eprintln!("[tryboard] ultrasonic triggers {pings}, echoes {echoes}, last Echo {us:.1} µs");
    }
    if let Some((reads, short)) = m.dht11_stats() {
        eprintln!("[tryboard] DHT11 frames sent {reads}, start pulses too short {short}");
    }
    if let Some(p) = &vcd {
        let text = m.vcd_text();
        std::fs::write(p, &text).unwrap_or_else(|e| panic!("write {p}: {e}"));
        let (n, dropped) = m.vcd_stats().unwrap_or((0, 0));
        eprintln!("[tryboard] VCD {p}: {n} edges, {dropped} dropped (capture buffer full)");
    }
    if let Some(l) = m.timing_line() {
        eprintln!("{l}");
    }
    let (tr, nack) = m.i2c_stats();
    if tr > 0 {
        eprintln!("[tryboard] I2C transactions {tr}, NACK {nack}");
    }
    // Generated checkpoints' i2c_ack criterion reads this; off by default so older levels' fingerprints stay put
    if args.iter().any(|a| a == "--i2c-log") {
        eprint!("{}", tryboard_machine::i2c_ack_lines(&m));
    }
    if let Some(l) = harness_i2c_line(&mut m) {
        eprintln!("{l}");
    }
    if let Some(l) = harness_wifi_line(&m) {
        eprintln!("{l}");
    }
    if let Some(n) = m.net_summary() {
        eprintln!("{}", n.line());
    }
    if let Some(p) = m.phone() {
        eprintln!(
            "[tryboard] virtual phone: {}, {}, IP {}",
            p.link.name(),
            if p.ssid.is_empty() {
                "not connected".into()
            } else {
                p.ssid.clone()
            },
            p.ip.map_or("none".into(), |i| format!(
                "{}.{}.{}.{}",
                i[0], i[1], i[2], i[3]
            ))
        );
        for (t, l) in &p.log {
            eprintln!("    {:>9.3}s phone {l}", *t as f64 / 1e6);
        }
    }
    let show_oled = args.iter().any(|a| a == "--oled");
    if let Some(o) = m.oled() {
        let n = o.lit_pixels();
        eprintln!(
            "[tryboard] OLED lit pixels {n} (display {}, charge pump {})",
            if o.display_on { "on" } else { "off" },
            if o.charge_pump { "on" } else { "off" }
        );
        if show_oled {
            eprint!("{}", o.ascii());
        }
    }
    let (st, sb) = m.spi_stats();
    if st > 0 {
        eprintln!("[tryboard] SPI2 transfers {st}, MOSI {sb} bytes");
    }
    if let Some(d) = m.lcd() {
        report_lcd(d, args);
    }
    eprint!("{}", m.audio_report());
    if let Some((path, buf)) = audio_wav {
        match std::fs::write(&path, wav16(audio_rate.round() as u32, &buf)) {
            Ok(()) => eprintln!(
                "[tryboard] speaker output saved as {path} ({} samples)",
                buf.len()
            ),
            Err(e) => eprintln!("[tryboard] failed to write {path}: {e}"),
        }
    }
    if let Some(e) = expect {
        let ok = String::from_utf8_lossy(&out).contains(e.as_str());
        eprintln!(
            "[tryboard] expected output {:?}: {}",
            e,
            if ok { "PASS" } else { "FAIL" }
        );
        std::process::exit(if ok { 0 } else { 1 });
    }
}

/// Solve a SPICE-subset netlist and print node voltages as `v(node)@time = value` (.op uses time 0)
fn elec_net(args: &[String]) {
    let Some(path) = args.first() else { usage() };
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read netlist {path}: {e}"));
    let nl = match tryboard_elec::spice::Netlist::parse(&text) {
        Ok(n) => n,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2)
        }
    };
    let at: Vec<f64> = opt(args, "--at")
        .map(|s| {
            s.split(',')
                .filter_map(tryboard_elec::spice::value)
                .collect()
        })
        .unwrap_or_default();
    for (t, v) in nl.run(&at) {
        for (k, name) in nl.names.iter().enumerate().skip(1) {
            println!("v({name})@{t:e} = {:.9e}", v[k]);
        }
    }
}

/// riscv-tests "p" environment: linked at 0x80000000, result written to tohost.
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
        let bytes = std::fs::read(p).expect("read test");
        let elf = Elf::parse(&bytes).expect("parse ELF");
        let mut bus = TestBus {
            ram: vec![0; 1 << 20],
            tohost: elf.symbol("tohost").expect("no tohost"),
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
                println!("FAIL {name} (case {})", v >> 1);
                fail += 1;
            }
            None => {
                println!("FAIL {name} (no result, pc=0x{:08x})", cpu.pc);
                fail += 1;
            }
        }
    }
    println!("{} tests, {} failed", paths.len(), fail);
    std::process::exit(if fail == 0 { 0 } else { 1 });
}

/// I2C wire (P2-11): rise time and verdict (same text as the web's wasm tb_harness_report)
fn harness_i2c_line(m: &mut Machine) -> Option<String> {
    tryboard_machine::harness_i2c_line(m)
}

fn harness_wifi_line(m: &Machine) -> Option<String> {
    tryboard_machine::harness_wifi_line(m)
}

/// What the virtual host saw: enumeration log, device info, keyboard input, mouse, USB serial
fn print_usb(u: &tryboard_soc::usb::Usb) {
    let h = &u.host;
    for l in &h.log {
        eprintln!("[usb] {l}");
    }
    let i = &h.info;
    if i.vid != 0 {
        eprintln!(
            "[tryboard] USB device {:04x}:{:04x} \"{}\" / \"{}\" serial \"{}\"",
            i.vid, i.pid, i.manufacturer, i.product, i.serial
        );
    }
    if h.mouse.3 > 0 {
        eprintln!(
            "[tryboard] USB mouse reports {}, position ({}, {}), buttons {}",
            h.mouse.3, h.mouse.0, h.mouse.1, h.mouse.2
        );
    }
    if !h.cdc_rx.is_empty() {
        eprintln!(
            "[tryboard] USB serial received: {:?}",
            String::from_utf8_lossy(&h.cdc_rx)
        );
    }
}

/// Mono 16-bit PCM WAV
fn wav16(rate: u32, x: &[i16]) -> Vec<u8> {
    let n = (x.len() * 2) as u32;
    let mut b = Vec::with_capacity(44 + n as usize);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + n).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&[1, 0, 1, 0]);
    b.extend_from_slice(&rate.to_le_bytes());
    b.extend_from_slice(&(rate * 2).to_le_bytes());
    b.extend_from_slice(&[2, 0, 16, 0]);
    b.extend_from_slice(b"data");
    b.extend_from_slice(&n.to_le_bytes());
    for v in x {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b
}

/// Board power / clock chips: --battery PCT[,usb] (AXP2101 / AXP192), --rtc <unix seconds, UTC> (PCF85063 / BM8563)
fn board_args(m: &mut Machine, args: &[String]) {
    if let Some(v) = opt(args, "--battery") {
        match parse_battery(&v) {
            Some((pct, usb)) if m.battery_set(pct, usb) => {}
            Some(_) => eprintln!("[tryboard] --battery needs axp2101 or axp192 on --i2c"),
            None => {
                eprintln!("--battery {v}: expected PCT[,usb]");
                std::process::exit(2)
            }
        }
    }
    if let Some(v) = opt(args, "--rtc") {
        match v.trim().parse::<i64>() {
            Ok(t) if m.rtc_set(t) => {}
            Ok(_) => eprintln!("[tryboard] --rtc needs pcf85063 or bm8563 on --i2c"),
            Err(_) => {
                eprintln!("--rtc {v}: expected unix seconds");
                std::process::exit(2)
            }
        }
    }
}

/// Input-log actions for the AXP2101 (bat=pct[,usb], pwrkey=short|long) and the virtual BLE phone
/// (ble=…) / desktop (pc=…, E-06). Returns false when `act` is not one of them.
fn board_action(m: &mut Machine, act: &str, now_s: f64) -> bool {
    let ble = act
        .strip_prefix("ble=")
        .or(act.starts_with("pc=").then_some(act));
    if let Some(c) = ble {
        if let Err(e) = m.ble_phone(c.trim()) {
            eprintln!("[tryboard] {now_s:.3}s BLE action failed: {e}");
        }
    } else if let Some(v) = act.strip_prefix("bat=") {
        match parse_battery(v) {
            Some((pct, usb)) => {
                m.battery_set(pct, usb);
            }
            None => eprintln!("[tryboard] unparsable bat action: {act}"),
        }
    } else if let Some(v) = act.strip_prefix("pwrkey=") {
        match v.trim() {
            "short" | "long" => {
                m.pwrkey(v.trim() == "long");
            }
            _ => eprintln!("[tryboard] unparsable pwrkey action: {act}"),
        }
    } else {
        return false;
    }
    true
}

/// Screen summary on stderr (pixel count, per-model counters) and optional PPM dump
fn report_lcd(d: &mut Lcd, args: &[String]) {
    let n = d.lit_pixels();
    let name = d.name();
    eprintln!(
        "[tryboard] LCD {name} non-black pixels {n} (display {})",
        if d.showing() { "on" } else { "off" }
    );
    eprint!("{}", d.color_report());
    match d {
        Lcd::Gc9a01(d) => eprintln!(
            "[tryboard] LCD GC9A01 commands {} (vendor registers {}), pixels written {}, backlight {}",
            d.commands,
            d.vendor_cmds,
            d.pixels,
            if d.backlight { "on" } else { "off" }
        ),
        Lcd::Co5300(d) => eprintln!(
            "[tryboard] LCD CO5300 commands {}, reads {}, pixels written {}, brightness {} (BCTRL {}), unimplemented: {}",
            d.commands,
            d.reads,
            d.pixels,
            d.brightness,
            if d.ctrl_display & 0x20 != 0 { "on" } else { "off" },
            if d.unimpl.is_empty() { "none".to_string() } else { d.unimpl_report() }
        ),
    }
    if let Some(path) = opt(args, "--lcd-ppm") {
        match std::fs::write(&path, d.ppm()) {
            Ok(()) => eprintln!("[tryboard] LCD frame saved as {path}"),
            Err(e) => eprintln!("[tryboard] failed to write {path}: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_script;

    #[test]
    fn script_old_and_file_syntax() {
        let v = parse_script("0.5:gpio9=0; 0.6:gpio9=z");
        assert_eq!(v, vec![(0.5, "gpio9=0".into()), (0.6, "gpio9=z".into())]);
        let f = parse_script("# TryBoard input log\n0.000000:env=23.5,45,101325\n1.25:env=35,45,101325\n2:gpio0=0;2:gpio0=z\n");
        assert_eq!(f.len(), 4);
        assert_eq!(f[1], (1.25, "env=35,45,101325".into()));
        assert_eq!(f[3], (2.0, "gpio0=z".into()));
    }
}
