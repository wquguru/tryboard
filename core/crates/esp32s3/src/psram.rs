//! PSRAM chip on SPI1 CS1: the 8MB AP Memory die, octal (OPI DTR, N16R8 modules, default) or quad (QSPI, e.g. M5 CoreS3).
//! Models only the protocol IDF init uses. Octal (esp_psram_impl_octal.c): mode register read / write
//! (0x4040 / 0xC0C0) and sync read / write (0x0000 / 0x8080). Quad (device/esp_psram_impl_ap_quad.c): 8-bit commands,
//! 0x9F read ID, 0x03 / 0x0B / 0xEB read, 0x02 / 0x38 write, mode / reset / burst commands accepted.
//! Afterwards the cache reaches `SocBus::psram` through the MMU directly (see ext_addr in lib.rs), bypassing this.
//! Line timing is not modelled: dummy cycles, DTR sample phase and drive strength are stored but unused, so every
//! MSPI timing-tuning candidate point reads correctly. lint: allow-long-comment

/// SPI_MEM register indices (same as tryboard_soc::spiflash, soc/esp32s3/register/soc/spi_mem_reg.h)
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

/// Quad PSRAM commands (8-bit, SPI mode until 0x35 enters QPI)
const Q_READ: u32 = 0x03;
const Q_FAST_READ: u32 = 0x0B;
const Q_FAST_READ_QUAD: u32 = 0xEB;
const Q_WRITE: u32 = 0x02;
const Q_WRITE_QUAD: u32 = 0x38;
const Q_READ_ID: u32 = 0x9F;
/// Enter / exit QPI, reset enable / reset, set wrap burst length: no state the model needs
const Q_NOP_CMDS: [u32; 5] = [0x35, 0xF5, 0x66, 0x99, 0xC0];

pub struct Psram {
    /// Interface the die is wired for; a firmware built for the other one fails its probe, as on hardware
    pub quad: bool,
    /// Mode registers MR0..MR8 (indexed by address)
    pub mr: [u8; 9],
    /// Command count (debug / stats)
    pub commands: u64,
}

impl Default for Psram {
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
        Psram {
            quad: false,
            mr,
            commands: 0,
        }
    }
}

impl Psram {
    /// Quad die ID: MFID 0x0D (AP), KGD 0x5D, EID[47:40] with density in bits 7..5 (2 = 64 Mbit) and EID[41] = 1
    /// (not 2T mode, else IDF halves the size); remaining EID bytes 0. Same layout as the classic ESP32 model.
    const QUAD_ID: [u8; 6] = [0x0d, 0x5d, 2 << 5 | 0x12, 0, 0, 0];

    /// SPI_MEM_MISC chip select: CS0 off, CS1 on = this user command targets the PSRAM
    pub fn selected(spi_regs: &[u32]) -> bool {
        spi_regs[MISC] & 3 == 1
    }

    /// Run one SPI1 user command (called when the USR bit is written to CMD). Data goes via W0..W15; storage is `mem`.
    /// Returns false for a command this die does not understand (the caller counts it as unimplemented).
    pub fn user_transaction(&mut self, regs: &mut [u32], mem: &mut [u8]) -> bool {
        self.commands += 1;
        let user = regs[USER];
        let has_cmd = user & (1 << 31) != 0;
        let miso = user & (1 << 28) != 0;
        let mosi = user & (1 << 27) != 0;
        if !has_cmd {
            return true;
        }
        // USR_COMMAND_BITLEN (bits 31..28): 7 = 8-bit quad command, 15 = 16-bit octal command
        let cmd_bits = (regs[USER2] >> 28) + 1;
        if (cmd_bits == 8) != self.quad {
            return false;
        }
        let cmd = regs[USER2] & 0xffff;
        let addr = regs[ADDR] as usize;
        let mosi_len = (((regs[MOSI_DLEN] & 0x3ff) as usize + 1) / 8).min(BUF_BYTES);
        let miso_len = (((regs[MISO_DLEN] & 0x3ff) as usize + 1) / 8).min(BUF_BYTES);
        let buf_get = |regs: &[u32], i: usize| (regs[W0 + i / 4] >> (8 * (i % 4))) as u8;
        if self.quad {
            // 24-bit address phase
            let addr = addr & 0xff_ffff;
            match cmd & 0xff {
                Q_READ_ID if miso => {
                    let n = miso_len.min(Self::QUAD_ID.len());
                    set_buf(regs, &Self::QUAD_ID[..n]);
                }
                Q_READ | Q_FAST_READ | Q_FAST_READ_QUAD if miso => {
                    let mut out = [0u8; BUF_BYTES];
                    for (i, b) in out.iter_mut().enumerate().take(miso_len) {
                        *b = mem[(addr + i) % mem.len()];
                    }
                    set_buf(regs, &out[..miso_len]);
                }
                Q_WRITE | Q_WRITE_QUAD if mosi => {
                    for i in 0..mosi_len {
                        let a = (addr + i) % mem.len();
                        mem[a] = buf_get(regs, i);
                    }
                }
                c if Q_NOP_CMDS.contains(&c) => {}
                _ => return false,
            }
            return true;
        }
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
            _ => return false,
        }
        true
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
        let bits = if c > 0xff || c == SYNC_READ { 15 } else { 7 };
        regs[USER2] = (bits << 28) | c;
        regs[ADDR] = addr;
        regs[MOSI_DLEN] = mosi_bits.saturating_sub(1);
        regs[MISO_DLEN] = miso_bits.saturating_sub(1);
    }

    #[test]
    fn mode_registers_and_data() {
        let mut p = Psram::default();
        let mut regs = [0u32; 64];
        let mut mem = vec![0u8; 8 << 20];
        regs[MISC] = 1;
        assert!(Psram::selected(&regs));
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

    #[test]
    fn quad_id_and_data() {
        let mut p = Psram {
            quad: true,
            ..Psram::default()
        };
        let mut regs = [0u32; 64];
        let mut mem = vec![0u8; 8 << 20];
        regs[MISC] = 1;
        // An octal mode-register read gets no answer from a quad die
        cmd(&mut regs, REG_READ, 0, 0, 16);
        assert!(!p.user_transaction(&mut regs, &mut mem));
        // 48-bit ID: AP, known good die, 64 Mbit, not 2T
        cmd(&mut regs, Q_READ_ID, 0, 0, 48);
        assert!(p.user_transaction(&mut regs, &mut mem));
        assert_eq!(regs[W0], 0x0052_5d0d);
        assert_eq!(regs[W0 + 1] & 0xffff, 0);
        // Connectivity check: write then read 32 bits at a 24-bit address
        regs[W0] = 0x5a5a_5a5a;
        cmd(&mut regs, Q_WRITE, 0x12_3456, 32, 0);
        assert!(p.user_transaction(&mut regs, &mut mem));
        regs[W0] = 0;
        cmd(&mut regs, Q_READ, 0x12_3456, 0, 32);
        assert!(p.user_transaction(&mut regs, &mut mem));
        assert_eq!(regs[W0], 0x5a5a_5a5a);
        assert_eq!(mem[0x12_3456], 0x5a);
        cmd(&mut regs, 0x35, 0, 0, 0);
        assert!(p.user_transaction(&mut regs, &mut mem));
    }
}
