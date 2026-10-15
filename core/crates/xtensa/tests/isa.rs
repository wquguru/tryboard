//! 跑 tools/xtensa-tests 下的自检汇编测试：每个 ELF 装进 0x40000000 起 1MB 的平坦 RAM，
//! 跑到 BREAK，读 `result`：0x600D 通过，0xBAD00000|n 表示第 n 个用例失败。
//! ELF 不在时先调用 build.sh（需要 xtensa-esp32s3-elf-gcc）；工具链也没有就跳过并提示。

use std::path::PathBuf;
use std::process::Command;
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

/// 返回（指令数, result, 六个窗口向量各自命中次数）
fn run_one(path: &PathBuf) -> Result<(u64, u32, [u32; 6]), String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let elf = Elf::parse(&bytes)?;
    let mut ram = Ram(vec![0; 1 << 20]);
    for s in &elf.segments {
        let o = (s.paddr - BASE) as usize;
        ram.0[o..o + s.data.len()].copy_from_slice(&s.data);
    }
    let result = elf.symbol("result").ok_or("没有 result 符号")?;
    let mut cpu = Cpu::new();
    cpu.pc = elf.entry;
    let mut hits = [0u32; 6];
    for _ in 0..20_000_000u64 {
        let off = cpu.pc.wrapping_sub(BASE);
        if off < 0x180 && off.is_multiple_of(0x40) {
            hits[(off / 0x40) as usize] += 1;
        }
        match cpu.step(&mut ram) {
            Exit::Break(pc) => {
                let r = ram.load(result, 4).unwrap();
                if r == 0 {
                    return Err(format!("在 0x{pc:08x} 意外 BREAK（双重异常？EXCCAUSE={} EPC1=0x{:08x} DEPC=0x{:08x}）",
                        cpu.read_sr(tryboard_xtensa::sr::EXCCAUSE), cpu.read_sr(tryboard_xtensa::sr::EPC1), cpu.read_sr(tryboard_xtensa::sr::DEPC)));
                }
                return Ok((cpu.instret, r, hits));
            }
            Exit::Waiti => return Err("意外 WAITI".into()),
            _ => {}
        }
    }
    Err(format!("超时，pc=0x{:08x}", cpu.pc))
}

#[test]
fn xtensa_selfcheck() {
    let dir = test_dir();
    let build = dir.join("build");
    if !build.exists() {
        let ok = Command::new(dir.join("build.sh"))
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            eprintln!("跳过：没有 Xtensa 工具链，无法构建 {}", build.display());
            return;
        }
    }
    let mut elfs: Vec<_> = std::fs::read_dir(&build)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "elf"))
        .collect();
    elfs.sort();
    assert!(!elfs.is_empty(), "build 目录里没有测试");
    let mut failed = Vec::new();
    for p in &elfs {
        let name = p.file_stem().unwrap().to_string_lossy().into_owned();
        match run_one(p) {
            Ok((n, 0x600d, hits)) => {
                eprintln!(
                    "PASS {name}（{n} 条指令，窗口向量 OF4/UF4/OF8/UF8/OF12/UF12 = {hits:?}）"
                );
                // 深递归测试必须真的把六种溢出 / 下溢处理程序都跑到
                if name == "window" && hits.contains(&0) {
                    eprintln!("FAIL window：有窗口向量没被触发");
                    failed.push(name);
                }
            }
            Ok((_, r, _)) => {
                eprintln!("FAIL {name}：用例 {}", r & 0xfffff);
                failed.push(name);
            }
            Err(e) => {
                eprintln!("FAIL {name}：{e}");
                failed.push(name);
            }
        }
    }
    eprintln!("{} 个测试，失败 {}", elfs.len(), failed.len());
    assert!(failed.is_empty(), "失败：{failed:?}");
}
