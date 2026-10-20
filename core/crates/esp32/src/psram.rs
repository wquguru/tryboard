//! Classic ESP32 quad PSRAM: SPI1 user commands while CS1 is selected (command set per IDF's quad driver; no timing,
//! dummy or QPI modelling), plus the cache's DRAM1 window (0x3F800000, 4MB, 32KB MMU pages at entries 1152..1279).

/// First PSRAM entry in the PRO / APP MMU tables (mmu_ll.h MMU_LL_PSRAM_ENTRY_START_ID)
pub const MMU_FIRST: usize = 1152;
/// 4MB window / 32KB pages
pub const MMU_COUNT: usize = 128;
pub const DRAM1_LOW: u32 = 0x3F80_0000;
pub const DRAM1_HIGH: u32 = 0x3FC0_0000;

/// SPI_PIN_REG (classic offset 0x34): CS0_DIS bit 0, CS1_DIS bit 1
pub const SPI_PIN: usize = 0x34 / 4;

#[derive(Default)]
pub struct QuadPsram {
    /// Storage; empty = no chip on CS1 (bus floats high)
    pub mem: Vec<u8>,
    /// SPI1 user commands answered (tests, stats)
    pub commands: u64,
    /// Opcodes seen that the model ignores (QPI enter / exit, reset, 2T mode)
    pub ignored: u64,
}

impl QuadPsram {
    pub fn with_size(bytes: usize) -> Self {
        QuadPsram {
            mem: vec![0; bytes],
            ..Default::default()
        }
    }

    /// SPI1 routes the user command to the PSRAM when CS1 is enabled and CS0 (flash) disabled
    pub fn selected(pin: u32) -> bool {
        pin & 3 == 1
    }

    /// ID bytes: MFID 0x0D, KGD 0x5D, EID whose bits [7:5] give the density (0 = 16, 1 = 32, 2 = 64 Mbit).
    /// EID 0x20 / 0x26 select special-cased early parts in IDF, so the low bits stay at 0x12
    pub fn id(&self) -> [u8; 3] {
        let d = match self.mem.len() {
            n if n > 4 << 20 => 2,
            n if n > 2 << 20 => 1,
            _ => 0,
        };
        [0x0d, 0x5d, d << 5 | 0x12]
    }

    /// One user transaction. `regs` use the C3 SPI_MEM layout the classic Spi1 wrapper maps into
    /// (USER 0x18, USER1 0x1c, USER2 0x20, MOSI_DLEN 0x24, MISO_DLEN 0x28, ADDR 0x04, W0 0x58).
    pub fn user_transaction(&mut self, regs: &mut [u32]) {
        let user = regs[0x18 / 4];
        let user1 = regs[0x1c / 4];
        let user2 = regs[0x20 / 4];
        let cmd_bits = (user2 >> 28) + 1;
        let has_cmd = user & (1 << 31) != 0;
        let has_addr = user & (1 << 30) != 0;
        let miso = user & (1 << 28) != 0;
        let mosi = user & (1 << 27) != 0;
        let abits = (user1 >> 26) + 1;
        // Address bits leave MSB first from ADDR[31]
        let mut addr = if has_addr {
            if abits >= 32 {
                regs[1]
            } else {
                regs[1] >> (32 - abits)
            }
        } else {
            0
        };
        // At 40MHz with a separate PSRAM clock IDF sends a 2-bit delay "command" and the opcode in ADDR[31:24]
        let op = if has_cmd && cmd_bits >= 8 {
            Some(user2 as u8)
        } else if has_addr && abits == 32 {
            let o = (addr >> 24) as u8;
            addr &= 0xff_ffff;
            Some(o)
        } else {
            None
        };
        let miso_len = ((regs[0x28 / 4] & 0xffffff) as usize + 1) / 8;
        let mosi_len = ((regs[0x24 / 4] & 0xffffff) as usize + 1) / 8;
        self.commands += 1;
        let n = self.mem.len().max(1);
        let reply: Option<Vec<u8>> = match op {
            Some(0x9f) => {
                let mut v = self.id().to_vec();
                v.resize(8, 0);
                Some(v)
            }
            Some(0x03 | 0x0b | 0xeb) => Some(
                (0..miso_len)
                    .map(|k| {
                        self.mem
                            .get((addr as usize + k) % n)
                            .copied()
                            .unwrap_or(0xff)
                    })
                    .collect(),
            ),
            Some(0x02 | 0x38) if mosi => {
                for k in 0..mosi_len.min(64) {
                    let b = (regs[0x58 / 4 + k / 4] >> (8 * (k % 4))) as u8;
                    if let Some(x) = self.mem.get_mut((addr as usize + k) % n) {
                        *x = b;
                    }
                }
                None
            }
            _ => {
                self.ignored += 1;
                None
            }
        };
        if miso {
            // No chip: MISO is pulled up
            let fill = if self.mem.is_empty() { 0xff } else { 0 };
            let mut r = if self.mem.is_empty() {
                Vec::new()
            } else {
                reply.unwrap_or_default()
            };
            r.resize(miso_len.clamp(1, 64), fill);
            for w in 0..16 {
                regs[0x58 / 4 + w] = 0;
            }
            for (i, b) in r.iter().take(64).enumerate() {
                regs[0x58 / 4 + i / 4] |= (*b as u32) << (8 * (i % 4));
            }
        }
    }
}
