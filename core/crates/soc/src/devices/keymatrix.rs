//! Decoder-scanned key matrix (M5-08, M5 Cardputer): the firmware drives a 74HC138's A0..A2 select inputs, the selected
//! active-low output row pulls a column input low through each pressed key; columns rest on the chip's pull-ups. Purely
//! combinational, so the SoC resolves it synchronously whenever a pin level changes (a scan reads right after writing).
//! No diodes / ghosting, no bounce. (lint: allow-long-comment)

/// One 74HC138-style matrix: rows = decoder outputs (2^select.len()), columns = input pins
#[derive(Clone, Debug)]
pub struct KeyMatrix {
    /// Select pins, A0 first
    pub select: Vec<u32>,
    pub cols: Vec<u32>,
    /// Pressed keys, bit row * cols.len() + col
    pressed: u128,
    /// Key events applied (press + release)
    pub events: u64,
}

impl KeyMatrix {
    pub fn new(select: &[u32], cols: &[u32]) -> KeyMatrix {
        assert!((1usize << select.len()) * cols.len() <= 128);
        KeyMatrix {
            select: select.to_vec(),
            cols: cols.to_vec(),
            pressed: 0,
            events: 0,
        }
    }

    pub fn rows(&self) -> usize {
        1 << self.select.len()
    }

    /// Press or release the key at (row, col); false when outside the matrix
    pub fn set(&mut self, row: usize, col: usize, down: bool) -> bool {
        if row >= self.rows() || col >= self.cols.len() {
            return false;
        }
        let bit = 1u128 << (row * self.cols.len() + col);
        if down {
            self.pressed |= bit;
        } else {
            self.pressed &= !bit;
        }
        self.events += 1;
        true
    }

    /// Column pins pulled low for the given pin levels (bit = pin number)
    pub fn low_cols(&self, level: u64) -> u64 {
        let row = self
            .select
            .iter()
            .enumerate()
            .fold(0, |r, (i, p)| r | ((level >> p & 1) as usize) << i);
        let n = self.cols.len();
        let mut low = 0u64;
        for (c, p) in self.cols.iter().enumerate() {
            if self.pressed >> (row * n + c) & 1 != 0 {
                low |= 1 << p;
            }
        }
        low
    }

    /// All column pins (bit mask)
    pub fn col_mask(&self) -> u64 {
        self.cols.iter().fold(0, |m, p| m | 1 << p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_row_pulls_its_columns() {
        let mut k = KeyMatrix::new(&[8, 9, 11], &[13, 15, 3, 4, 5, 6, 7]);
        assert!(k.set(5, 2, true));
        assert!(!k.set(8, 0, true));
        // Row 5 = A0 (G8) 1, A1 (G9) 0, A2 (G11) 1
        let row5 = 1 << 8 | 1 << 11;
        assert_eq!(k.low_cols(row5), 1 << 3);
        assert_eq!(k.low_cols(1 << 8), 0);
        k.set(5, 2, false);
        assert_eq!(k.low_cols(row5), 0);
        assert_eq!(k.events, 2);
    }
}
