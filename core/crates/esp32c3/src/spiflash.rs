//! SPI1（SPI_MEM）flash 控制器：用户模式事务 + 预置命令位（RDID / RDSR / PP / SE / BE / CE / READ）。
//! 寄存器见 soc/esp32c3/register/soc/spi_mem_reg.h；命令语义按 JEDEC 通用 SPI NOR。

pub struct SpiFlash {
    pub regs: [u32; 0x100 / 4],
    pub wel: bool,
    /// JEDEC ID：GigaDevice（0xC8）GD25Q32，类型 0x40、容量 0x16（4MB），常见开发板用的就是它
    pub jedec: u32,
    /// 编程 / 擦除次数（给 UI 和磨损统计用）
    pub erases: u64,
    pub programs: u64,
    /// 状态寄存器 SR1–SR3（SR2 位 1 = QE，四线模式要靠它）；SR1 的 WEL 由 wel 单独维护
    pub sr: [u8; 3],
}

impl Default for SpiFlash {
    fn default() -> Self {
        SpiFlash {
            regs: [0; 0x100 / 4],
            wel: false,
            jedec: 0x16_40_c8,
            erases: 0,
            programs: 0,
            sr: [0; 3],
        }
    }
}

const CMD: usize = 0;
const ADDR: usize = 1;
const USER: usize = 0x18 / 4;
const USER2: usize = 0x20 / 4;
const MOSI_DLEN: usize = 0x24 / 4;
const MISO_DLEN: usize = 0x28 / 4;
const RD_STATUS: usize = 0x2c / 4;
const W0: usize = 0x58 / 4;

impl SpiFlash {
    pub fn read(&self, off: u32) -> u32 {
        // CMD 寄存器的命令位在事务完成后由硬件清零；事务是同步完成的，所以读到的永远是 0
        if off == 0 {
            return 0;
        }
        self.regs.get((off / 4) as usize).copied().unwrap_or(0)
    }

    fn sr1(&self) -> u8 {
        self.sr[0] | if self.wel { 2 } else { 0 }
    }

    fn buf_bytes(&self, n: usize) -> Vec<u8> {
        let mut v = Vec::with_capacity(n);
        for i in 0..n.min(64) {
            v.push((self.regs[W0 + i / 4] >> (8 * (i % 4))) as u8);
        }
        v
    }

    fn set_buf(&mut self, data: &[u8]) {
        for w in 0..16 {
            self.regs[W0 + w] = 0;
        }
        for (i, b) in data.iter().take(64).enumerate() {
            self.regs[W0 + i / 4] |= (*b as u32) << (8 * (i % 4));
        }
    }

    fn erase(&mut self, flash: &mut [u8], addr: usize, size: usize) {
        if !self.wel {
            return;
        }
        let start = addr & !(size - 1);
        if let Some(s) = flash.get_mut(start..start + size) {
            s.fill(0xff);
        }
        self.erases += 1;
        self.wel = false;
    }

    fn program(&mut self, flash: &mut [u8], addr: usize, data: &[u8]) {
        if !self.wel {
            return;
        }
        // 页内回绕：PP 不跨 256 字节页
        let page = addr & !0xff;
        for (i, b) in data.iter().enumerate() {
            let a = page | ((addr + i) & 0xff);
            if let Some(x) = flash.get_mut(a) {
                *x &= *b; // NOR 只能把 1 编程成 0
            }
        }
        self.programs += 1;
        self.wel = false;
    }

    pub fn write(&mut self, off: u32, v: u32, flash: &mut [u8]) {
        let i = (off / 4) as usize;
        if i >= self.regs.len() {
            return;
        }
        if i != CMD {
            self.regs[i] = v;
            return;
        }
        let addr = self.regs[ADDR] as usize;
        if v & (1 << 18) != 0 {
            self.user_transaction(flash);
        } else if v & (1 << 30) != 0 {
            self.wel = true;
        } else if v & (1 << 29) != 0 {
            self.wel = false;
        } else if v & (1 << 28) != 0 {
            let id = self.jedec;
            self.set_buf(&id.to_le_bytes()[..3]);
        } else if v & (1 << 27) != 0 {
            self.regs[RD_STATUS] = self.sr1() as u32;
        } else if v & (1 << 26) != 0 {
            // WRSR：写入值取自 RD_STATUS 寄存器（低字节 SR1，次字节 SR2）
            if self.wel {
                let st = self.regs[RD_STATUS];
                self.sr[0] = st as u8 & !3;
                self.sr[1] = (st >> 8) as u8;
                self.wel = false;
            }
        } else if v & (1 << 25) != 0 {
            let len = (addr >> 24).max(1);
            let data = self.buf_bytes(len);
            self.program(flash, addr & 0xff_ffff, &data);
        } else if v & (1 << 24) != 0 {
            self.erase(flash, addr & 0xff_ffff, 4096);
        } else if v & (1 << 23) != 0 {
            self.erase(flash, addr & 0xff_ffff, 65536);
        } else if v & (1 << 22) != 0 {
            if self.wel {
                flash.fill(0xff);
                self.erases += 1;
                self.wel = false;
            }
        } else if v & (1 << 31) != 0 {
            let len = ((self.regs[MISO_DLEN] & 0x3ff) as usize + 1) / 8;
            let a = addr & 0xff_ffff;
            let data: Vec<u8> = (0..len)
                .map(|k| flash.get(a + k).copied().unwrap_or(0xff))
                .collect();
            self.set_buf(&data);
        }
    }

    fn user_transaction(&mut self, flash: &mut [u8]) {
        let user = self.regs[USER];
        let cmd = self.regs[USER2] & 0xffff;
        let has_cmd = user & (1 << 31) != 0;
        let has_addr = user & (1 << 30) != 0;
        let miso = user & (1 << 28) != 0;
        let mosi = user & (1 << 27) != 0;
        let addr = (self.regs[ADDR] & 0xff_ffff) as usize;
        let miso_len = ((self.regs[MISO_DLEN] & 0x3ff) as usize + 1) / 8;
        let mosi_len = ((self.regs[MOSI_DLEN] & 0x3ff) as usize + 1) / 8;
        if !has_cmd {
            return;
        }
        let reply: Option<Vec<u8>> = match cmd as u8 {
            0x9f => Some(self.jedec.to_le_bytes()[..3].to_vec()),
            0x05 => Some(vec![self.sr1()]),
            0x35 => Some(vec![self.sr[1]]),
            0x15 => Some(vec![self.sr[2]]),
            // 写状态寄存器：0x01 写 SR1（可带 SR2），0x31 写 SR2，0x11 写 SR3
            0x01 | 0x31 | 0x11 if mosi => {
                if self.wel {
                    let d = self.buf_bytes(mosi_len.max(1));
                    match cmd as u8 {
                        0x01 => {
                            self.sr[0] = d[0] & !3;
                            if d.len() > 1 {
                                self.sr[1] = d[1];
                            }
                        }
                        0x31 => self.sr[1] = d[0],
                        _ => self.sr[2] = d[0],
                    }
                    self.wel = false;
                }
                None
            }
            // 易失写使能（0x50）：允许随后写状态寄存器
            0x50 => {
                self.wel = true;
                None
            }
            0x06 => {
                self.wel = true;
                None
            }
            0x04 => {
                self.wel = false;
                None
            }
            0x03 | 0x0b | 0x3b | 0x6b | 0xbb | 0xeb if has_addr => Some(
                (0..miso_len)
                    .map(|k| flash.get(addr + k).copied().unwrap_or(0xff))
                    .collect(),
            ),
            0x02 if mosi => {
                let data = self.buf_bytes(mosi_len);
                self.program(flash, addr, &data);
                None
            }
            0x20 => {
                self.erase(flash, addr, 4096);
                None
            }
            0x52 => {
                self.erase(flash, addr, 32768);
                None
            }
            0xd8 => {
                self.erase(flash, addr, 65536);
                None
            }
            0x60 | 0xc7 => {
                if self.wel {
                    flash.fill(0xff);
                    self.wel = false;
                }
                None
            }
            // SFDP 不支持：返回全 1，IDF 会退回通用芯片驱动
            0x5a => Some(vec![0xff; miso_len]),
            _ => None,
        };
        if miso {
            let mut r = reply.unwrap_or_default();
            r.resize(miso_len.max(r.len()), 0);
            self.set_buf(&r);
        }
    }
}
