//! MFRC522 (RC522 module) RFID reader as an SPI slave (F-04d): register file, 64-byte FIFO, CalcCRC, Transceive,
//! and an ISO 14443-3A card with a 4- or 7-byte UID answering REQA / WUPA / anticollision / SELECT / HLTA.
//! Enough for MFRC522-library style "read the UID" sketches; MIFARE Crypto1 authentication and block reads are not modelled.
//! (lint: allow-long-comment)

use std::collections::VecDeque;

/// Register addresses (MFRC522 datasheet §9)
pub mod reg {
    pub const COMMAND: u8 = 0x01;
    pub const COM_IRQ: u8 = 0x04;
    pub const DIV_IRQ: u8 = 0x05;
    pub const ERROR: u8 = 0x06;
    pub const STATUS1: u8 = 0x07;
    pub const FIFO_DATA: u8 = 0x09;
    pub const FIFO_LEVEL: u8 = 0x0A;
    pub const CONTROL: u8 = 0x0C;
    pub const BIT_FRAMING: u8 = 0x0D;
    pub const COLL: u8 = 0x0E;
    pub const MODE: u8 = 0x11;
    pub const TX_MODE: u8 = 0x12;
    pub const RX_MODE: u8 = 0x13;
    pub const TX_CONTROL: u8 = 0x14;
    pub const CRC_H: u8 = 0x21;
    pub const CRC_L: u8 = 0x22;
    pub const T_MODE: u8 = 0x2A;
    pub const VERSION: u8 = 0x37;
}

/// PCD commands (CommandReg bits 3..0)
pub mod cmd {
    pub const IDLE: u8 = 0x00;
    pub const CALC_CRC: u8 = 0x03;
    pub const TRANSMIT: u8 = 0x04;
    pub const TRANSCEIVE: u8 = 0x0C;
    pub const MF_AUTHENT: u8 = 0x0E;
    pub const SOFT_RESET: u8 = 0x0F;
}

/// ComIrqReg bits
const TX_IRQ: u8 = 0x40;
const RX_IRQ: u8 = 0x20;
const IDLE_IRQ: u8 = 0x10;
const ERR_IRQ: u8 = 0x02;
const TIMER_IRQ: u8 = 0x01;
/// DivIrqReg CRCIRq, Status1Reg CRCReady
const CRC_IRQ: u8 = 0x04;
const CRC_READY: u8 = 0x20;
/// VersionReg of an MFRC522 v2.0 (what most RC522 modules report)
pub const VERSION: u8 = 0x92;

/// ISO 14443-3A card state machine
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CardState {
    Idle,
    /// Answered REQA / WUPA; the number is the cascade level being selected (1 or 2)
    Ready(u8),
    Active,
    Halt,
}

#[derive(Clone, Debug)]
pub struct Card {
    pub uid: Vec<u8>,
    pub state: CardState,
}

impl Card {
    /// Four UID bytes of cascade level `lv` (7-byte UIDs start level 1 with the cascade tag 0x88)
    fn level_bytes(&self, lv: u8) -> [u8; 4] {
        let u = &self.uid;
        match (u.len(), lv) {
            (7, 1) => [0x88, u[0], u[1], u[2]],
            (7, _) => [u[3], u[4], u[5], u[6]],
            _ => [u[0], u[1], u[2], u[3]],
        }
    }

    fn levels(&self) -> u8 {
        if self.uid.len() == 7 {
            2
        } else {
            1
        }
    }

    /// ATQA: UID size in bits 7..6 (single / double), bit-frame anticollision bit 2
    fn atqa(&self) -> [u8; 2] {
        if self.uid.len() == 7 {
            [0x44, 0x00]
        } else {
            [0x04, 0x00]
        }
    }
}

/// ISO 14443-3A CRC_A (x^16 + x^12 + x^5 + 1, reflected) from `init`; sent low byte first
pub fn crc_a(data: &[u8], init: u16) -> u16 {
    let mut crc = init;
    for &b in data {
        let mut ch = b ^ crc as u8;
        ch ^= ch << 4;
        let ch = ch as u16;
        crc = (crc >> 8) ^ (ch << 8) ^ (ch << 3) ^ (ch >> 4);
    }
    crc
}

/// Parse "DEADBEEF" / "de:ad:be:ef" / "04 A1 B2 C3 D4 E5 F6" into a 4- or 7-byte UID
pub fn parse_uid(s: &str) -> Option<Vec<u8>> {
    let hex: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let clean = s
        .chars()
        .all(|c| c.is_ascii_hexdigit() || ":- ".contains(c));
    if !clean || !(hex.len() == 8 || hex.len() == 14) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect()
}

pub fn uid_text(uid: &[u8]) -> String {
    uid.iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

#[derive(Clone, Debug)]
pub struct Rc522 {
    /// Chip-select GPIO (active low)
    pub cs: u32,
    regs: [u8; 64],
    fifo: VecDeque<u8>,
    /// Address byte of the SPI frame in progress (None = waiting for one)
    frame: Option<u8>,
    /// Register a read frame returns on the next byte
    read_reg: u8,
    pub card: Option<Card>,
    /// Stats: SPI frames, REQA, WUPA, completed SELECTs (UID reads), HLTA, PICC commands not modelled
    pub frames: u64,
    pub reqa: u64,
    pub wupa: u64,
    pub uid_reads: u64,
    pub halts: u64,
    pub unsupported: u64,
    pub last_uid: Option<Vec<u8>>,
}

impl Rc522 {
    pub fn new(cs: u32) -> Rc522 {
        let mut r = Rc522 {
            cs,
            regs: [0; 64],
            fifo: VecDeque::new(),
            frame: None,
            read_reg: 0,
            card: None,
            frames: 0,
            reqa: 0,
            wupa: 0,
            uid_reads: 0,
            halts: 0,
            unsupported: 0,
            last_uid: None,
        };
        r.reset();
        r
    }

    /// Power-on / SoftReset register values (datasheet §9.3); the RF field is off afterwards
    fn reset(&mut self) {
        self.regs = [0; 64];
        for (a, v) in [
            (reg::COMMAND, 0x20),
            (0x02, 0x80),
            (reg::COM_IRQ, 0x14),
            (reg::STATUS1, 0x21),
            (0x0B, 0x08),
            (reg::CONTROL, 0x10),
            (reg::COLL, 0x80),
            (reg::MODE, 0x3F),
            (reg::TX_CONTROL, 0x80),
            (0x16, 0x10),
            (0x17, 0x84),
            (0x18, 0x84),
            (0x19, 0x4D),
            (reg::CRC_H, 0xFF),
            (reg::CRC_L, 0xFF),
            (0x24, 0x26),
            (0x26, 0x48),
            (0x27, 0x88),
            (0x28, 0x20),
            (0x29, 0x20),
        ] {
            self.regs[a as usize] = v;
        }
        self.fifo.clear();
        self.field_off();
    }

    /// Card loses power when the antenna drivers stop: it falls back to Idle (a halted card wakes up again)
    fn field_off(&mut self) {
        if let Some(c) = &mut self.card {
            c.state = CardState::Idle;
        }
    }

    fn field_on(&self) -> bool {
        self.regs[reg::TX_CONTROL as usize] & 0x03 != 0
    }

    /// Put a card on the reader (None = take it away); a new card starts Idle
    pub fn set_card(&mut self, uid: Option<Vec<u8>>) {
        self.card = uid.map(|uid| Card {
            uid,
            state: CardState::Idle,
        });
    }

    /// One full-duplex SPI byte. Address byte: bit 7 = read, bits 6..1 = register. While reading, each MOSI
    /// byte names the next register and MISO carries the previous one; while writing, bytes go to one register
    pub fn byte(&mut self, mosi: u8) -> u8 {
        let Some(a) = self.frame else {
            self.frame = Some(mosi);
            self.frames += 1;
            self.read_reg = (mosi >> 1) & 0x3F;
            return 0;
        };
        if a & 0x80 != 0 {
            let v = self.read(self.read_reg);
            self.read_reg = (mosi >> 1) & 0x3F;
            v
        } else {
            self.write((a >> 1) & 0x3F, mosi);
            0
        }
    }

    /// One GP-SPI transfer: command / address bytes, then MOSI data; returns `miso_len` MISO bytes. Full duplex
    /// (both phases set) returns what came back under the data bytes; half duplex clocks 0x00 for the read phase
    pub fn transfer(&mut self, head: &[u8], data: &[u8], miso_len: usize) -> Vec<u8> {
        for &b in head {
            self.byte(b);
        }
        let mut rx: Vec<u8> = data.iter().map(|&b| self.byte(b)).collect();
        if data.is_empty() || miso_len > data.len() {
            rx.clear();
            rx.extend((0..miso_len).map(|_| self.byte(0)));
        }
        rx.truncate(miso_len);
        rx
    }

    /// CS went high: the next byte is an address again
    pub fn cs_release(&mut self) {
        self.frame = None;
    }

    pub fn read(&mut self, r: u8) -> u8 {
        match r {
            reg::FIFO_DATA => self.fifo.pop_front().unwrap_or(0),
            reg::FIFO_LEVEL => self.fifo.len() as u8,
            reg::VERSION => VERSION,
            _ => self.regs[r as usize & 0x3F],
        }
    }

    pub fn write(&mut self, r: u8, v: u8) {
        let i = r as usize & 0x3F;
        match r {
            reg::COMMAND => {
                self.regs[i] = v;
                self.command(v & 0x0F);
            }
            reg::COM_IRQ | reg::DIV_IRQ => {
                // Bit 7 = Set1 / Set2: 1 sets the marked bits, 0 clears them
                if v & 0x80 != 0 {
                    self.regs[i] |= v & 0x7F;
                } else {
                    self.regs[i] &= !v;
                }
            }
            reg::FIFO_DATA => {
                if self.fifo.len() < 64 {
                    self.fifo.push_back(v);
                } else {
                    self.regs[reg::ERROR as usize] |= 0x10;
                }
            }
            reg::FIFO_LEVEL => {
                if v & 0x80 != 0 {
                    self.fifo.clear();
                    self.regs[reg::ERROR as usize] &= !0x10;
                }
            }
            reg::BIT_FRAMING => {
                self.regs[i] = v & 0x7F;
                if v & 0x80 != 0 && self.regs[reg::COMMAND as usize] & 0x0F == cmd::TRANSCEIVE {
                    self.transmit(true);
                }
            }
            reg::TX_CONTROL => {
                self.regs[i] = v;
                if v & 0x03 == 0 {
                    self.field_off();
                }
            }
            reg::VERSION => {}
            _ => self.regs[i] = v,
        }
    }

    fn command(&mut self, c: u8) {
        match c {
            cmd::SOFT_RESET => self.reset(),
            cmd::CALC_CRC => {
                let data: Vec<u8> = self.fifo.drain(..).collect();
                let init = match self.regs[reg::MODE as usize] & 0x03 {
                    0 => 0x0000,
                    1 => 0x6363,
                    2 => 0xA671,
                    _ => 0xFFFF,
                };
                let crc = crc_a(&data, init);
                self.regs[reg::CRC_L as usize] = crc as u8;
                self.regs[reg::CRC_H as usize] = (crc >> 8) as u8;
                self.regs[reg::DIV_IRQ as usize] |= CRC_IRQ;
                self.regs[reg::STATUS1 as usize] |= CRC_READY;
            }
            cmd::TRANSMIT => self.transmit(false),
            cmd::MF_AUTHENT => {
                // Crypto1 is not modelled: end with a protocol error so drivers report failure instead of hanging
                self.unsupported += 1;
                self.regs[reg::ERROR as usize] |= 0x01;
                self.regs[reg::COM_IRQ as usize] |= ERR_IRQ | IDLE_IRQ;
            }
            _ => {}
        }
    }

    /// Send the FIFO to the card; with `receive` (Transceive) the answer lands in the FIFO, silence fires the timer
    fn transmit(&mut self, receive: bool) {
        let mut tx: Vec<u8> = self.fifo.drain(..).collect();
        let last_bits = self.regs[reg::BIT_FRAMING as usize] & 0x07;
        if self.regs[reg::TX_MODE as usize] & 0x80 != 0 {
            let c = crc_a(&tx, 0x6363);
            tx.extend_from_slice(&[c as u8, (c >> 8) as u8]);
        }
        self.regs[reg::ERROR as usize] &= 0x10;
        self.regs[reg::COM_IRQ as usize] |= TX_IRQ;
        let resp = if self.field_on() {
            self.picc(&tx, last_bits)
        } else {
            None
        };
        if !receive {
            self.regs[reg::COM_IRQ as usize] |= IDLE_IRQ;
            return;
        }
        match resp {
            Some(mut r) => {
                if self.regs[reg::RX_MODE as usize] & 0x80 != 0 && r.len() >= 3 {
                    r.truncate(r.len() - 2);
                }
                self.fifo.extend(r);
                // Every answer modelled is whole bytes: RxLastBits = 0
                self.regs[reg::CONTROL as usize] &= !0x07;
                self.regs[reg::COM_IRQ as usize] |= RX_IRQ;
            }
            // TAuto starts the timer at the end of transmission; with the usual 25 ms reload it runs out
            None if self.regs[reg::T_MODE as usize] & 0x80 != 0 => {
                self.regs[reg::COM_IRQ as usize] |= TIMER_IRQ;
            }
            None => {}
        }
    }

    /// What the card on the field answers to `tx` (None = silence)
    fn picc(&mut self, tx: &[u8], last_bits: u8) -> Option<Vec<u8>> {
        let card = self.card.as_mut()?;
        let first = *tx.first()?;
        if tx.len() == 1 && last_bits == 7 {
            let ok = match first {
                0x26 => {
                    self.reqa += 1;
                    card.state == CardState::Idle
                }
                0x52 => {
                    self.wupa += 1;
                    matches!(card.state, CardState::Idle | CardState::Halt)
                }
                _ => false,
            };
            if !ok {
                return None;
            }
            card.state = CardState::Ready(1);
            return Some(card.atqa().to_vec());
        }
        match first {
            0x50 if tx.get(1) == Some(&0) => {
                if card.state != CardState::Idle {
                    card.state = CardState::Halt;
                    self.halts += 1;
                }
                None
            }
            0x93 | 0x95 => {
                let lv = if first == 0x93 { 1 } else { 2 };
                if card.state != CardState::Ready(lv) {
                    return None;
                }
                let cl = card.level_bytes(lv);
                let bcc = cl.iter().fold(0, |a, b| a ^ b);
                let nvb = *tx.get(1)?;
                if nvb == 0x70 {
                    if tx.len() < 9 || tx[2..6] != cl || tx[6] != bcc {
                        card.state = CardState::Idle;
                        return None;
                    }
                    let done = lv == card.levels();
                    let sak = match (done, card.uid.len()) {
                        (false, _) => 0x04,
                        (true, 4) => 0x08,
                        (true, _) => 0x00,
                    };
                    if done {
                        card.state = CardState::Active;
                        self.uid_reads += 1;
                        self.last_uid = Some(card.uid.clone());
                    } else {
                        card.state = CardState::Ready(lv + 1);
                    }
                    let c = crc_a(&[sak], 0x6363);
                    return Some(vec![sak, c as u8, (c >> 8) as u8]);
                }
                // Anticollision: send the UID bytes after the ones the reader already knows (whole bytes only)
                let known = ((nvb >> 4) as usize).saturating_sub(2).min(4);
                let mut full = cl.to_vec();
                full.push(bcc);
                Some(full[known..].to_vec())
            }
            _ => {
                self.unsupported += 1;
                None
            }
        }
    }

    /// End-of-run summary
    pub fn report(&self) -> String {
        let last = self
            .last_uid
            .as_deref()
            .map(uid_text)
            .unwrap_or_else(|| "-".into());
        format!(
            "RC522 CS=GPIO{}: SPI frames {}, REQA {}, WUPA {}, UID reads {}, HLTA {}, unsupported {}, last UID {last}",
            self.cs, self.frames, self.reqa, self.wupa, self.uid_reads, self.halts, self.unsupported
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Host-side helpers doing what the MFRC522 Arduino library does over SPI (one CS frame per register access)
    struct Host(Rc522);

    impl Host {
        fn wr(&mut self, r: u8, v: u8) {
            self.0.byte(r << 1);
            self.0.byte(v);
            self.0.cs_release();
        }
        fn rd(&mut self, r: u8) -> u8 {
            self.0.byte(0x80 | r << 1);
            let v = self.0.byte(0);
            self.0.cs_release();
            v
        }
        fn set_bits(&mut self, r: u8, m: u8) {
            let v = self.rd(r);
            self.wr(r, v | m);
        }
        fn init(&mut self) {
            self.wr(reg::COMMAND, cmd::SOFT_RESET);
            assert_eq!(self.rd(reg::COMMAND) & 0x10, 0);
            self.wr(reg::TX_MODE, 0);
            self.wr(reg::RX_MODE, 0);
            self.wr(0x24, 0x26);
            self.wr(reg::T_MODE, 0x80);
            self.wr(0x2B, 0xA9);
            self.wr(0x2C, 0x03);
            self.wr(0x2D, 0xE8);
            self.wr(0x15, 0x40);
            self.wr(reg::MODE, 0x3D);
            self.set_bits(reg::TX_CONTROL, 0x03);
        }
        fn crc(&mut self, data: &[u8]) -> [u8; 2] {
            self.wr(reg::COMMAND, cmd::IDLE);
            self.wr(reg::DIV_IRQ, 0x04);
            self.wr(reg::FIFO_LEVEL, 0x80);
            for &b in data {
                self.wr(reg::FIFO_DATA, b);
            }
            self.wr(reg::COMMAND, cmd::CALC_CRC);
            assert_ne!(self.rd(reg::DIV_IRQ) & 0x04, 0);
            self.wr(reg::COMMAND, cmd::IDLE);
            [self.rd(reg::CRC_L), self.rd(reg::CRC_H)]
        }
        /// PCD_TransceiveData: Some(answer) on RxIRq, None on timer timeout
        fn transceive(&mut self, data: &[u8], bits: u8) -> Option<Vec<u8>> {
            self.wr(reg::COMMAND, cmd::IDLE);
            self.wr(reg::COM_IRQ, 0x7F);
            self.wr(reg::FIFO_LEVEL, 0x80);
            for &b in data {
                self.wr(reg::FIFO_DATA, b);
            }
            self.wr(reg::BIT_FRAMING, bits);
            self.wr(reg::COMMAND, cmd::TRANSCEIVE);
            self.set_bits(reg::BIT_FRAMING, 0x80);
            let irq = self.rd(reg::COM_IRQ);
            if irq & 0x30 == 0 {
                assert_ne!(irq & 0x01, 0, "neither RxIRq nor timeout");
                return None;
            }
            assert_eq!(self.rd(reg::ERROR) & 0x13, 0);
            let n = self.rd(reg::FIFO_LEVEL);
            // Burst read like PCD_ReadRegister(reg, count, ...): address repeated, 0 last
            self.0.byte(0x80 | reg::FIFO_DATA << 1);
            let mut out = Vec::new();
            for i in 0..n {
                let next = if i + 1 < n {
                    0x80 | reg::FIFO_DATA << 1
                } else {
                    0
                };
                out.push(self.0.byte(next));
            }
            self.0.cs_release();
            Some(out)
        }
        /// PICC_Select over all cascade levels; returns the UID
        fn select(&mut self) -> Option<Vec<u8>> {
            let mut uid = Vec::new();
            for sel in [0x93u8, 0x95] {
                let cl = self.transceive(&[sel, 0x20], 0)?;
                assert_eq!(cl.len(), 5);
                assert_eq!(cl[..4].iter().fold(0, |a, b| a ^ b), cl[4], "BCC");
                let mut f = vec![sel, 0x70];
                f.extend_from_slice(&cl);
                let c = self.crc(&f);
                f.extend_from_slice(&c);
                let sak = self.transceive(&f, 0)?;
                assert_eq!(sak.len(), 3);
                assert_eq!(self.crc(&sak[..1]), [sak[1], sak[2]], "SAK CRC_A");
                if cl[0] == 0x88 {
                    uid.extend_from_slice(&cl[1..4]);
                } else {
                    uid.extend_from_slice(&cl[..4]);
                }
                if sak[0] & 0x04 == 0 {
                    return Some(uid);
                }
            }
            None
        }
        fn halt(&mut self) -> bool {
            let mut f = vec![0x50, 0x00];
            let c = self.crc(&f);
            f.extend_from_slice(&c);
            self.transceive(&f, 0).is_none()
        }
    }

    #[test]
    fn crc_a_vectors() {
        // ISO/IEC 14443-3 Annex B: CRC_A of 00 00 is 1E A0 (sent A0 1E)
        assert_eq!(crc_a(&[0x00, 0x00], 0x6363), 0x1EA0);
        // HLTA 50 00 is followed by 57 CD on the air
        assert_eq!(crc_a(&[0x50, 0x00], 0x6363), 0xCD57);
        let c = crc_a(&[0x93, 0x70, 1, 2, 3, 4, 4], 0x6363);
        let mut f = vec![0x93, 0x70, 1, 2, 3, 4, 4, c as u8, (c >> 8) as u8];
        assert_eq!(crc_a(&f, 0x6363), 0);
        f[3] ^= 1;
        assert_ne!(crc_a(&f, 0x6363), 0);
    }

    #[test]
    fn version_and_register_frames() {
        let mut h = Host(Rc522::new(7));
        assert_eq!(h.rd(reg::VERSION), VERSION);
        h.wr(0x2C, 0x5A);
        assert_eq!(h.rd(0x2C), 0x5A);
        // One frame writing three FIFO bytes, then a level read: CS release restarts at an address byte
        h.0.byte(reg::FIFO_DATA << 1);
        for b in [1, 2, 3] {
            h.0.byte(b);
        }
        h.0.cs_release();
        assert_eq!(h.rd(reg::FIFO_LEVEL), 3);
        h.wr(reg::FIFO_LEVEL, 0x80);
        assert_eq!(h.rd(reg::FIFO_LEVEL), 0);
        // Set1 / clear semantics of ComIrqReg
        h.wr(reg::COM_IRQ, 0x7F);
        assert_eq!(h.rd(reg::COM_IRQ), 0);
        h.wr(reg::COM_IRQ, 0x81);
        assert_eq!(h.rd(reg::COM_IRQ), 0x01);
    }

    #[test]
    fn no_card_times_out() {
        let mut h = Host(Rc522::new(7));
        h.init();
        assert_eq!(h.transceive(&[0x26], 7), None);
        assert_eq!(h.0.reqa, 0);
    }

    #[test]
    fn reads_four_byte_uid_and_halts() {
        let mut h = Host(Rc522::new(7));
        h.init();
        h.0.set_card(parse_uid("DE:AD:BE:EF"));
        assert_eq!(h.transceive(&[0x26], 7), Some(vec![0x04, 0x00]));
        assert_eq!(h.select(), Some(vec![0xDE, 0xAD, 0xBE, 0xEF]));
        assert!(h.halt());
        // A halted card ignores REQA but wakes on WUPA
        assert_eq!(h.transceive(&[0x26], 7), None);
        assert_eq!(h.transceive(&[0x52], 7), Some(vec![0x04, 0x00]));
        assert_eq!(h.select(), Some(vec![0xDE, 0xAD, 0xBE, 0xEF]));
        assert_eq!((h.0.reqa, h.0.wupa, h.0.uid_reads, h.0.halts), (2, 1, 2, 1));
        h.0.set_card(None);
        assert_eq!(h.transceive(&[0x52], 7), None);
    }

    #[test]
    fn reads_seven_byte_uid_over_two_cascade_levels() {
        let mut h = Host(Rc522::new(7));
        h.init();
        h.0.set_card(parse_uid("04A1B2C3D4E5F6"));
        assert_eq!(h.transceive(&[0x26], 7), Some(vec![0x44, 0x00]));
        assert_eq!(h.select(), parse_uid("04 A1 B2 C3 D4 E5 F6"));
        assert_eq!(
            uid_text(h.0.last_uid.as_ref().unwrap()),
            "04:A1:B2:C3:D4:E5:F6"
        );
    }

    #[test]
    fn antenna_off_or_soft_reset_wakes_a_halted_card() {
        let mut h = Host(Rc522::new(7));
        h.init();
        h.0.set_card(parse_uid("01020304"));
        h.transceive(&[0x26], 7).unwrap();
        h.select().unwrap();
        assert!(h.halt());
        h.init();
        assert_eq!(h.transceive(&[0x26], 7), Some(vec![0x04, 0x00]));
        // Antenna off: nothing answers
        h.wr(reg::TX_CONTROL, 0x80);
        assert_eq!(h.transceive(&[0x26], 7), None);
    }

    #[test]
    fn uid_parsing() {
        assert_eq!(parse_uid("deadbeef"), Some(vec![0xDE, 0xAD, 0xBE, 0xEF]));
        assert_eq!(parse_uid("DEADBE"), None);
        assert_eq!(parse_uid("DEADBEEG"), None);
        assert_eq!(parse_uid("04-a1-b2-c3-d4-e5-f6").map(|u| u.len()), Some(7));
    }
}
