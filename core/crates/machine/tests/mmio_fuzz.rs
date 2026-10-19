//! R-04: firmware-reachable bus paths must never panic the simulator. Boots a real image per chip, then hammers the
//! peripheral window with random reads / writes (and scribbles RAM so DMA descriptors point anywhere) while running.
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;
use tryboard_machine::{Machine, Stop};

static SITES: Mutex<Vec<String>> = Mutex::new(Vec::new());
// The panic hook and SITES are process-wide: chips take turns
static TURN: Mutex<()> = Mutex::new(());

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../..");

/// xorshift64*: deterministic, so a failing seed can be replayed
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u32) -> u32 {
        (self.next() >> 33) as u32 % n
    }
}

fn fuzz(fw: &str, rom: &str, ram: (u32, u32), seed: u64, ops: u32) {
    // FUZZ_FW=c3-i2s-tone narrows a deep hunt to one image
    if std::env::var("FUZZ_FW").is_ok_and(|f| f != fw) {
        return;
    }
    let (fw, rom) = (
        format!("{ROOT}/firmware/build/{fw}/flash.bin"),
        format!("{ROOT}/third_party/esp-rom-elfs/{rom}"),
    );
    let (Ok(flash), Ok(rom)) = (std::fs::read(&fw), std::fs::read(&rom)) else {
        eprintln!("skip: {fw} or {rom} missing (tools/build_fw.sh, tools/fetch_third_party.sh)");
        return;
    };
    let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
    let (mut m, _) = Machine::boot(&rom, flash).expect("boot");
    let boot = m.run(80_000_000);
    let (lo, hi) = m.mmio_window();
    eprintln!(
        "{fw}: boot {boot:?} at {} cycles, MMIO {lo:#x}..{hi:#x}",
        m.cycles()
    );
    let mut r = Rng(seed);
    // Keep going after a panic so one run lists every distinct site (the machine may be inconsistent afterwards)
    std::panic::set_hook(Box::new(|info| {
        let at = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let mut s = SITES.lock().unwrap_or_else(|e| e.into_inner());
        if !s.iter().any(|x| x.starts_with(&at)) {
            s.push(format!("{at} {info}"));
        }
    }));
    SITES.lock().unwrap_or_else(|e| e.into_inner()).clear();
    let mut panics = 0;
    // FUZZ_OPS=2000000 for a deeper one-off hunt; the default keeps `cargo test` quick
    let ops = std::env::var("FUZZ_OPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(ops);
    for i in 0..ops {
        if panics > 20_000 {
            break;
        }
        // Values skew towards RAM pointers and small counts: that is what reaches DMA and FIFO indexing
        let val = match r.below(4) {
            0 => r.next() as u32,
            1 => ram.0 + r.below(ram.1 - ram.0),
            2 => r.below(64),
            _ => u32::MAX >> r.below(32),
        };
        let size = [1, 2, 4][r.below(3) as usize];
        let addr = (lo + r.below(hi - lo)) & !(size - 1);
        let write = r.below(4) != 0;
        let scribble =
            (r.below(16) == 0).then(|| ((ram.0 + r.below(ram.1 - ram.0)) & !3, r.next() as u32));
        if std::env::var("FUZZ_FROM").is_ok_and(|v| v.parse::<u32>().is_ok_and(|n| i >= n)) {
            eprintln!(
                "  op {i}: {} {addr:#x}/{size} = {val:#x} scribble {scribble:x?}",
                if write { "W" } else { "R" }
            );
        }
        let ok = catch_unwind(AssertUnwindSafe(|| {
            m.bus_poke(addr, size, val, write);
            if let Some((a, v)) = scribble {
                m.bus_poke(a, 4, v, true);
            }
            if i % 512 == 511 {
                if let Stop::Reset(why) = m.run(4_000) {
                    let _ = m.reboot(why);
                }
            }
        }));
        panics += ok.is_err() as u32;
        if i % 20_000 == 0 && std::env::var("FUZZ_RSS").is_ok() {
            let ps = std::process::Command::new("ps")
                .args(["-o", "rss=", "-p", &std::process::id().to_string()])
                .output();
            eprintln!(
                "  op {i}: rss {} KB",
                ps.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                    .unwrap_or_default()
            );
        }
    }
    let _ = std::panic::take_hook();
    eprintln!("  after fuzz: {} cycles, {panics} panics", m.cycles());
    let sites = SITES.lock().unwrap_or_else(|e| e.into_inner());
    assert!(
        sites.is_empty(),
        "{fw}: {} panic site(s):\n{}",
        sites.len(),
        sites.join("\n")
    );
}

// Firmware that brings up DMA / I2S / SPI / USB / radio, so random pokes land on live state machines
#[test]
fn c3_mmio_fuzz() {
    for (i, fw) in ["blink", "c3-lcd", "c3-i2s-tone", "c3-ble-hr", "wifi-http"]
        .iter()
        .enumerate()
    {
        fuzz(
            fw,
            "esp32c3_rev3_rom.elf",
            (0x3FC8_0000, 0x3FCE_0000),
            0xC3 + i as u64,
            100_000,
        );
    }
}

#[test]
fn s3_mmio_fuzz() {
    for (i, fw) in [
        "s3-blink",
        "s3-lvgl",
        "s3-i2s-mic",
        "s3-usb-cdc",
        "s3-wifi-http",
    ]
    .iter()
    .enumerate()
    {
        fuzz(
            fw,
            "esp32s3_rev0_rom.elf",
            (0x3FC8_8000, 0x3FD0_0000),
            0x53 + i as u64,
            100_000,
        );
    }
}

#[test]
fn esp32_mmio_fuzz() {
    for (i, fw) in ["esp32-blink", "esp32-i2c", "esp32-wifi"]
        .iter()
        .enumerate()
    {
        fuzz(
            fw,
            "esp32_rev300_rom.elf",
            (0x3FFB_0000, 0x3FFE_0000),
            0x32 + i as u64,
            100_000,
        );
    }
}
