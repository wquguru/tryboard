//! Runs the self-checking asm tests in tools/xtensa-tests: each ELF loads into 1MB flat RAM at 0x40000000 and runs
//! until semihosting SYS_exit; result 0x600D = pass, 0xBAD00000|n = case n failed. lint: allow-long-comment
//! Differential check: result + dump buffer go out via SYS_write; if Espressif QEMU (~/.espressif/tools/qemu-xtensa) is
//! installed the same ELF runs on `qemu-system-xtensa -M sim -cpu esp32s3` as a separate process and outputs are
//! compared byte by byte (no QEMU code is used). XT_NO_QEMU=1 skips it; XT_ONLY=<name> runs a single test.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tryboard_rv32::elf::Elf;
use tryboard_xtensa::{Bus, BusFault, Cpu, Exit};

const BASE: u32 = 0x4000_0000;

struct Ram(Vec<u8>);

impl Bus for Ram {
    fn load(&mut self, a: u32, s: u32) -> Result<u32, BusFault> {
        let o = a.wrapping_sub(BASE) as usize;
        let b = self.0.get(o..o + s as usize).ok_or(BusFault)?;
        Ok(b.iter()
            .enumerate()
            .fold(0, |v, (i, x)| v | (*x as u32) << (8 * i)))
    }
    fn store(&mut self, a: u32, s: u32, v: u32) -> Result<(), BusFault> {
        let o = a.wrapping_sub(BASE) as usize;
        let b = self.0.get_mut(o..o + s as usize).ok_or(BusFault)?;
        for (i, x) in b.iter_mut().enumerate() {
            *x = (v >> (8 * i)) as u8;
        }
        Ok(())
    }
}

fn test_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tools/xtensa-tests")
}

struct Run {
    instret: u64,
    result: u32,
    /// Hit count of each of the six window vectors
    hits: [u32; 6],
    /// Semihosting output
    out: Vec<u8>,
}

fn run_one(path: &Path) -> Result<Run, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let elf = Elf::parse(&bytes)?;
    let mut ram = Ram(vec![0; 1 << 20]);
    for s in &elf.segments {
        let o = (s.paddr - BASE) as usize;
        ram.0[o..o + s.data.len()].copy_from_slice(&s.data);
    }
    let result = elf.symbol("result").ok_or("no result symbol")?;
    let mut cpu = Cpu::new();
    cpu.pc = elf.entry;
    let mut hits = [0u32; 6];
    let mut out = Vec::new();
    for _ in 0..50_000_000u64 {
        let off = cpu.pc.wrapping_sub(BASE);
        if off < 0x180 && off.is_multiple_of(0x40) {
            hits[(off / 0x40) as usize] += 1;
        }
        match cpu.step(&mut ram) {
            Exit::Simcall => match cpu.a(2) {
                // SYS_write(fd, buf, len)
                4 => {
                    let (buf, len) = (cpu.a(4), cpu.a(5));
                    for i in 0..len {
                        out.push(
                            ram.load(buf + i, 1)
                                .map_err(|_| "SYS_write out of bounds")?
                                as u8,
                        );
                    }
                    cpu.set_a(2, len);
                }
                // SYS_exit
                1 => {
                    let r = ram.load(result, 4).unwrap();
                    return Ok(Run {
                        instret: cpu.instret,
                        result: r,
                        hits,
                        out,
                    });
                }
                n => return Err(format!("unsupported semihosting call {n}")),
            },
            Exit::Break(pc) => {
                return Err(format!(
                    "unexpected BREAK at 0x{pc:08x} (double exception? EXCCAUSE={} EPC1=0x{:08x} DEPC=0x{:08x})",
                    cpu.read_sr(tryboard_xtensa::sr::EXCCAUSE),
                    cpu.read_sr(tryboard_xtensa::sr::EPC1),
                    cpu.read_sr(tryboard_xtensa::sr::DEPC)
                ));
            }
            _ => {}
        }
    }
    Err(format!("timeout, pc=0x{:08x}", cpu.pc))
}

fn qemu_bin() -> Option<PathBuf> {
    if std::env::var("XT_NO_QEMU").is_ok() {
        return None;
    }
    let root = PathBuf::from(std::env::var("HOME").ok()?).join(".espressif/tools/qemu-xtensa");
    let mut v: Vec<_> = std::fs::read_dir(root)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .collect();
    v.sort();
    let p = v.last()?.join("qemu/bin/qemu-system-xtensa");
    p.exists().then_some(p)
}

/// Runs the same ELF on the QEMU sim machine (esp32s3 core config) and returns its semihosting output
fn run_qemu(qemu: &Path, elf: &Path) -> Result<Vec<u8>, String> {
    let mut child = Command::new(qemu)
        .args([
            "-M",
            "sim",
            "-cpu",
            "esp32s3",
            "-nographic",
            "-monitor",
            "none",
        ])
        // icount makes timers fire deterministically by instruction count (else CCOMPARE IRQs arrive async from the host clock)
        .args(["-icount", "shift=0,sleep=off"])
        .args(["-semihosting-config", "enable=on,target=native"])
        .arg("-device")
        .arg(format!("loader,file={},cpu-num=0", elf.display()))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let t0 = Instant::now();
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if t0.elapsed() > Duration::from_secs(20) {
            let _ = child.kill();
            return Err("QEMU timeout".into());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let mut out = Vec::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

fn words(b: &[u8]) -> Vec<u32> {
    b.chunks(4)
        .map(|c| {
            c.iter()
                .enumerate()
                .fold(0, |v, (i, x)| v | (*x as u32) << (8 * i))
        })
        .collect()
}

/// Compares both outputs word by word; returns the number of differing words (prints the first few)
fn diff(name: &str, ours: &[u8], qemu: &[u8]) -> usize {
    let (a, b) = (words(ours), words(qemu));
    let mut bad = 0;
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i), b.get(i));
        if x != y {
            if bad < 12 {
                // The first two words are result and dump length, then dump[i-2]
                let what = match i {
                    0 => "result".to_string(),
                    1 => "dump_len".to_string(),
                    _ => format!("dump[{}]", i - 2),
                };
                eprintln!("  DIFF {name} {what}: ours {:08x?}  QEMU {:08x?}", x, y);
            }
            bad += 1;
        }
    }
    bad
}

#[test]
fn xtensa_selfcheck() {
    let dir = test_dir();
    let build = dir.join("build");
    let ok = Command::new(dir.join("build.sh"))
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok && !build.exists() {
        eprintln!(
            "skipped: no Xtensa toolchain, cannot build {}",
            build.display()
        );
        return;
    }
    let only = std::env::var("XT_ONLY").ok();
    let mut elfs: Vec<_> = std::fs::read_dir(&build)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "elf"))
        .filter(|p| {
            only.as_ref()
                .is_none_or(|o| p.file_stem().unwrap().to_string_lossy() == *o)
        })
        .collect();
    elfs.sort();
    assert!(!elfs.is_empty(), "no tests in the build directory");
    let qemu = qemu_bin();
    if qemu.is_none() {
        eprintln!("(no QEMU: self-checks only, no differential check)");
    }
    let mut failed = Vec::new();
    let (mut diff_words, mut compared_words) = (0usize, 0usize);
    for p in &elfs {
        let name = p.file_stem().unwrap().to_string_lossy().into_owned();
        match run_one(p) {
            Ok(r) => {
                let mut msg = String::new();
                let mut fail = false;
                if r.result != 0x600d {
                    msg = format!("case {}", r.result & 0xfffff);
                    fail = true;
                }
                // The deep-recursion test must actually exercise all six overflow / underflow handlers
                if name == "window" && r.hits.contains(&0) {
                    msg += " some window vector never fired";
                    fail = true;
                }
                if let Some(q) = &qemu {
                    match run_qemu(q, p) {
                        Ok(qo) => {
                            // XT_SAVE=1: save both raw outputs to build/<name>.{ours,qemu}.bin for offline analysis
                            if std::env::var("XT_SAVE").is_ok() {
                                let _ =
                                    std::fs::write(build.join(format!("{name}.ours.bin")), &r.out);
                                let _ = std::fs::write(build.join(format!("{name}.qemu.bin")), &qo);
                            }
                            compared_words += r.out.len().max(qo.len()) / 4;
                            let n = diff(&name, &r.out, &qo);
                            if n > 0 {
                                msg += &format!(" differs from QEMU in {n} words");
                                diff_words += n;
                                fail = true;
                            }
                        }
                        Err(e) => {
                            msg += &format!(" QEMU failed: {e}");
                            fail = true;
                        }
                    }
                }
                if fail {
                    eprintln!("FAIL {name}: {msg}");
                    failed.push(name);
                } else {
                    eprintln!(
                        "PASS {name} ({} instructions, dump {} words, window vectors OF4/UF4/OF8/UF8/OF12/UF12 = {:?})",
                        r.instret,
                        r.out.len().saturating_sub(8) / 4,
                        r.hits
                    );
                }
            }
            Err(e) => {
                eprintln!("FAIL {name}: {e}");
                failed.push(name);
            }
        }
    }
    if qemu.is_some() {
        eprintln!("QEMU diff: compared {compared_words} words, {diff_words} differ");
    }
    eprintln!("{} tests, {} failed", elfs.len(), failed.len());
    assert!(failed.is_empty(), "failed: {failed:?}");
}
