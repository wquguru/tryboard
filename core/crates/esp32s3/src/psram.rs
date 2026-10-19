//! Octal (OPI DTR) PSRAM chip: the 8MB AP Memory die in N16R8 modules.
//! Models only the protocol IDF init uses (esp_psram_impl_octal.c): SPI1 user commands sent via CS1 -- mode register
//! read / write (0x4040 / 0xC0C0) and sync read / write (0x0000 / 0x8080). Afterwards the cache reaches
//! `SocBus::psram` through the MMU directly (see ext_addr in lib.rs), bypassing this.
//! Line timing is not modelled: dummy cycles, DTR sample phase and drive strength are stored but unused, so every
//! MSPI timing-tuning candidate point reads correctly. lint: allow-long-comment

/// SPI_MEM register indices (same as tryboard_esp32c3::spiflash, soc/esp32s3/register/soc/spi_mem_reg.h)
/// Offset 0x04
const ADDR: usize = 1;
const USER: usize = 0x18 / 4;
const USER2: usize = 0x20 / 4;
const MOSI_DLEN: usize = 0x24 / 4;
const MISO_DLEN: usize = 0x28 / 4;
pub const MISC: usize = 0x34 / 4;
const W0: usize = 0x58 / 4;
/// W0..W15: 64-byte data buffer
const BUF_BYTES: usize = 64;

/// Octal PSRAM commands (16-bit; under DTR both half-cycles carry the same byte)
const SYNC_READ: u32 = 0x0000;
const SYNC_WRITE: u32 = 0x8080;
const REG_READ: u32 = 0x4040;
const REG_WRITE: u32 = 0xC0C0;

pub struct OctalPsram {
    /// Mode registers MR0..MR8 (indexed by address)
    pub mr: [u8; 9],
    /// Command count (debug / stats)
    pub commands: u64,
}

impl Default for OctalPsram {
    fn default() -> Self {
        let mut mr = [0u8; 9];
        // MR0: drive strength 1/2, read latency code 2, variable latency (power-on default; IDF switches to fixed)
        mr[0] = 0x09;
        // MR1: vendor ID 0x0D (AP Memory)
        mr[1] = 0x0d;
        // MR2: density 3 (64Mbit = 8MB), dev_id 2 (gen 3), good-die 1
        mr[2] = 0x03 | (2 << 3) | (1 << 7);
        // MR3: VCC bit = 1 (3V die, R8 module; only R8V is 1.8V)
        mr[3] = 1 << 6;
        // MR4: write latency code 0, default refresh rate
        mr[4] = 0x00;
        // MR8: burst length 1024B wrap (bl = 3)
        mr[8] = 0x03;
        OctalPsram { mr, commands: 0 }
    }
}

impl OctalPsram {
    /// SPI_MEM_MISC chip select: CS0 off, CS1 on = this user command targets the PSRAM
    pub fn selected(spi_regs: &[u32]) -> bool {
        spi_regs[MISC] & 3 == 1
    }

    /// Run one SPI1 user command (called when the USR bit is written to CMD). Data goes via W0..W15; storage is `mem`
    pub fn user_transaction(&mut self, regs: &mut [u32], mem: &mut [u8]) {
        self.commands += 1;
        let user = regs[USER];
        let has_cmd = user & (1 << 31) != 0;
        let miso = user & (1 << 28) != 0;
        let mosi = user & (1 << 27) != 0;
        if !has_cmd {
            return;
        }
        let cmd = regs[USER2] & 0xffff;
        let addr = regs[ADDR] as usize;
        let mosi_len = (((regs[MOSI_DLEN] & 0x3ff) as usize + 1) / 8).min(BUF_BYTES);
        let miso_len = (((regs[MISO_DLEN] & 0x3ff) as usize + 1) / 8).min(BUF_BYTES);
        let buf_get = |regs: &[u32], i: usize| (regs[W0 + i / 4] >> (8 * (i % 4))) as u8;
        match cmd {
            REG_READ if miso => {
                let mut out = [0u8; BUF_BYTES];
                for (i, b) in out.iter_mut().enumerate().take(miso_len) {
                    *b = self.mr.get(addr + i).copied().unwrap_or(0);
                }
                set_buf(regs, &out[..miso_len]);
            }
            REG_WRITE if mosi => {
                // Under DTR a write carries two bytes, only the first lands in the addressed register; MR1 / MR2 / MR3 are read-only
                let v = buf_get(regs, 0);
                if matches!(addr, 0 | 4 | 8) {
                    self.mr[addr] = v;
                }
            }
            SYNC_WRITE if mosi => {
                for i in 0..mosi_len {
                    let a = (addr + i) % mem.len();
                    mem[a] = buf_get(regs, i);
                }
            }
            SYNC_READ if miso => {
                let mut out = [0u8; BUF_BYTES];
                for (i, b) in out.iter_mut().enumerate().take(miso_len) {
                    *b = mem[(addr + i) % mem.len()];
                }
                set_buf(regs, &out[..miso_len]);
            }
            _ => {}
        }
    }
}

fn set_buf(regs: &mut [u32], data: &[u8]) {
    for w in 0..BUF_BYTES / 4 {
        regs[W0 + w] = 0;
    }
    for (i, b) in data.iter().enumerate() {
        regs[W0 + i / 4] |= (*b as u32) << (8 * (i % 4));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(regs: &mut [u32], c: u32, addr: u32, mosi_bits: u32, miso_bits: u32) {
        regs[USER] = (1 << 31)
            | (1 << 30)
            | if mosi_bits > 0 { 1 << 27 } else { 0 }
            | if miso_bits > 0 { 1 << 28 } else { 0 };
        regs[USER2] = (15 << 28) | c;
        regs[ADDR] = addr;
        regs[MOSI_DLEN] = mosi_bits.saturating_sub(1);
        regs[MISO_DLEN] = miso_bits.saturating_sub(1);
    }

    #[test]
    fn mode_registers_and_data() {
        let mut p = OctalPsram::default();
        let mut regs = [0u32; 64];
        let mut mem = vec![0u8; 8 << 20];
        regs[MISC] = 1;
        assert!(OctalPsram::selected(&regs));
        // Read MR0 / MR1
        cmd(&mut regs, REG_READ, 0, 0, 16);
        p.user_transaction(&mut regs, &mut mem);
        assert_eq!(regs[W0] & 0xffff, 0x0d09);
        // Read MR2: 8MB
        cmd(&mut regs, REG_READ, 2, 0, 16);
        p.user_transaction(&mut regs, &mut mem);
        assert_eq!(regs[W0] & 7, 3);
        // Write MR0 (fixed latency); MR1 unaffected
        regs[W0] = 0xffff_0022;
        cmd(&mut regs, REG_WRITE, 0, 16, 0);
        p.user_transaction(&mut regs, &mut mem);
        assert_eq!(p.mr[0], 0x22);
        assert_eq!(p.mr[1], 0x0d);
        // Sync write / read 32 bits
        regs[W0] = 0x5a6b_7c8d;
        cmd(&mut regs, SYNC_WRITE, 0x100, 32, 0);
        p.user_transaction(&mut regs, &mut mem);
        regs[W0] = 0;
        cmd(&mut regs, SYNC_READ, 0x100, 0, 32);
        p.user_transaction(&mut regs, &mut mem);
        assert_eq!(regs[W0], 0x5a6b_7c8d);
        assert_eq!(mem[0x100], 0x8d);
    }
}
