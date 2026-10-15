//! 最小 ELF32 小端解析：取可加载段与符号表，够测试和加载固件用。

pub struct Segment {
    pub paddr: u32,
    pub vaddr: u32,
    pub data: Vec<u8>,
    pub memsz: u32,
}

pub struct Section {
    pub name: String,
    pub kind: u32,
    pub addr: u32,
    pub data: Vec<u8>,
}

pub struct Elf {
    pub entry: u32,
    pub segments: Vec<Segment>,
    pub sections: Vec<Section>,
    pub symbols: Vec<(String, u32, u32)>,
}

fn u16le(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn u32le(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

impl Elf {
    pub fn parse(b: &[u8]) -> Result<Elf, String> {
        if b.len() < 52 || &b[0..4] != b"\x7fELF" {
            return Err("不是 ELF".into());
        }
        if b[4] != 1 || b[5] != 1 {
            return Err("只支持 ELF32 小端".into());
        }
        let entry = u32le(b, 24);
        let phoff = u32le(b, 28) as usize;
        let shoff = u32le(b, 32) as usize;
        let phentsize = u16le(b, 42) as usize;
        let phnum = u16le(b, 44) as usize;
        let shentsize = u16le(b, 46) as usize;
        let shnum = u16le(b, 48) as usize;
        let mut segments = Vec::new();
        for i in 0..phnum {
            let o = phoff + i * phentsize;
            if u32le(b, o) != 1 {
                continue; // PT_LOAD
            }
            let off = u32le(b, o + 4) as usize;
            let vaddr = u32le(b, o + 8);
            let paddr = u32le(b, o + 12);
            let filesz = u32le(b, o + 16) as usize;
            let memsz = u32le(b, o + 20);
            segments.push(Segment {
                paddr,
                vaddr,
                data: b.get(off..off + filesz).ok_or("段越界")?.to_vec(),
                memsz,
            });
        }
        let mut symbols = Vec::new();
        let mut sections = Vec::new();
        if shoff != 0 && shnum > 0 {
            let shstrndx = u16le(b, 50) as usize;
            let strtab = u32le(b, shoff + shstrndx * shentsize + 16) as usize;
            for i in 0..shnum {
                let o = shoff + i * shentsize;
                let kind = u32le(b, o + 4);
                let addr = u32le(b, o + 12);
                let off = u32le(b, o + 16) as usize;
                let size = u32le(b, o + 20) as usize;
                let name_off = strtab + u32le(b, o) as usize;
                let end = b[name_off..].iter().position(|&c| c == 0).map(|p| name_off + p).unwrap_or(name_off);
                let data = if kind == 1 { b.get(off..off + size).ok_or("节越界")?.to_vec() } else { Vec::new() };
                sections.push(Section {
                    name: String::from_utf8_lossy(&b[name_off..end]).into_owned(),
                    kind,
                    addr,
                    data,
                });
            }
        }
        if shoff != 0 {
            for i in 0..shnum {
                let o = shoff + i * shentsize;
                if u32le(b, o + 4) != 2 {
                    continue; // SHT_SYMTAB
                }
                let off = u32le(b, o + 16) as usize;
                let size = u32le(b, o + 20) as usize;
                let link = u32le(b, o + 24) as usize;
                let so = shoff + link * shentsize;
                let stroff = u32le(b, so + 16) as usize;
                for s in (off..off + size).step_by(16) {
                    let name = u32le(b, s) as usize;
                    let value = u32le(b, s + 4);
                    let sz = u32le(b, s + 8);
                    let start = stroff + name;
                    let end = b[start..].iter().position(|&c| c == 0).map(|p| start + p).unwrap_or(start);
                    let n = String::from_utf8_lossy(&b[start..end]).into_owned();
                    if !n.is_empty() {
                        symbols.push((n, value, sz));
                    }
                }
            }
        }
        Ok(Elf { entry, segments, sections, symbols })
    }

    pub fn symbol(&self, name: &str) -> Option<u32> {
        self.symbols.iter().find(|s| s.0 == name).map(|s| s.1)
    }
}
