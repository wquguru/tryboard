//! 机器模式 CSR。未知地址照样可读写（存进表里），并记下来供验收报告列出。

use std::collections::BTreeMap;

pub const MSTATUS: u32 = 0x300;
pub const MISA: u32 = 0x301;
pub const MIE: u32 = 0x304;
pub const MTVEC: u32 = 0x305;
pub const MSCRATCH: u32 = 0x340;
pub const MEPC: u32 = 0x341;
pub const MCAUSE: u32 = 0x342;
pub const MTVAL: u32 = 0x343;
pub const MIP: u32 = 0x344;
pub const MHARTID: u32 = 0xf14;
pub const MVENDORID: u32 = 0xf11;
pub const MARCHID: u32 = 0xf12;
pub const MIMPID: u32 = 0xf13;
pub const MCYCLE: u32 = 0xb00;
pub const MINSTRET: u32 = 0xb02;
pub const MCYCLEH: u32 = 0xb80;
pub const MINSTRETH: u32 = 0xb82;
pub const CYCLE: u32 = 0xc00;
pub const TIME: u32 = 0xc01;
pub const INSTRET: u32 = 0xc02;
pub const CYCLEH: u32 = 0xc80;
pub const TIMEH: u32 = 0xc81;
pub const INSTRETH: u32 = 0xc82;
/// ESP32-C3 自定义性能计数器：mpcer / mpcmr / mpccr（IDF 的 esp_cpu_get_cycle_count 读 mpccr）。
pub const MPCER: u32 = 0x7e0;
pub const MPCMR: u32 = 0x7e1;
pub const MPCCR: u32 = 0x7e2;

pub struct Csrs {
    pub mstatus: u32,
    pub mie: u32,
    pub mtvec: u32,
    pub mscratch: u32,
    pub mepc: u32,
    pub mcause: u32,
    pub mtval: u32,
    pub misa: u32,
    pub other: BTreeMap<u32, u32>,
}

impl Default for Csrs {
    fn default() -> Self {
        Csrs {
            mstatus: 0,
            mie: 0,
            mtvec: 0,
            mscratch: 0,
            mepc: 0,
            mcause: 0,
            mtval: 0,
            // MXL=1 (32 位)，I M C
            misa: (1 << 30) | (1 << 8) | (1 << 12) | (1 << 2),
            other: BTreeMap::new(),
        }
    }
}

impl Csrs {
    pub fn read(&self, addr: u32) -> Option<u32> {
        Some(match addr {
            MSTATUS => self.mstatus,
            MISA => self.misa,
            MIE => self.mie,
            MTVEC => self.mtvec,
            MSCRATCH => self.mscratch,
            MEPC => self.mepc,
            MCAUSE => self.mcause,
            MTVAL => self.mtval,
            MIP => 0,
            MHARTID | MVENDORID | MARCHID | MIMPID => 0,
            _ => *self.other.get(&addr).unwrap_or(&0),
        })
    }

    pub fn write(&mut self, addr: u32, v: u32) {
        match addr {
            // 只保留 M 模式相关位：MIE MPIE MPP；MPP 固定为 M
            MSTATUS => self.mstatus = (v & (1 << 3 | 1 << 7)) | (3 << 11),
            MISA => {}
            MIE => self.mie = v,
            MTVEC => self.mtvec = v,
            MSCRATCH => self.mscratch = v,
            MEPC => self.mepc = v & !1,
            MCAUSE => self.mcause = v,
            MTVAL => self.mtval = v,
            MIP | MHARTID | MVENDORID | MARCHID | MIMPID => {}
            _ => {
                self.other.insert(addr, v);
            }
        }
    }
}
