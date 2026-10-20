//! Board keyboards (M5-08): one 4 x 14 Cardputer legend and the script action `key=<name>,1|0` for both wirings.
//! Cardputer: 74HC138 (A0..A2 = G8, G9, G11) rows x 7 column inputs (G13, G15, G3, G4, G5, G6, G7); the row / column to
//! legend map follows the M5Cardputer library's scan convention as remembered, not checked against its source. Cardputer-Adv:
//! TCA8418 rows 0..7 x cols 0..6 with key (r, c) at TCA row 2r + c / 7, col c % 7 (assumed; M5's driver not checked). (lint: allow-long-comment)

use crate::Machine;
use tryboard_soc::devices::keymatrix::KeyMatrix;
use tryboard_soc::devices::tca8418::Tca8418;

/// How the keys reach the chip
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Keyboard {
    /// Decoder select pins (A0 first) and column input pins
    Hc138 { select: [u32; 3], cols: [u32; 7] },
    /// TCA8418 on one of the preset's I2C buses
    Tca8418,
}

/// Cardputer legend, row 0 at the top; the `key=` action takes these names (letters case-insensitive) or `ALIASES`
pub const LEGEND: [[&str; 14]; 4] = [
    [
        "`", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "=", "bksp",
    ],
    [
        "tab", "q", "w", "e", "r", "t", "y", "u", "i", "o", "p", "[", "]", "\\",
    ],
    [
        "fn", "shift", "a", "s", "d", "f", "g", "h", "j", "k", "l", ";", "'", "enter",
    ],
    [
        "ctrl", "opt", "alt", "z", "x", "c", "v", "b", "n", "m", ",", ".", "/", "space",
    ],
];

/// Names for keys that clash with the script syntax (`;` separates actions, `,` the level)
const ALIASES: &[(&str, &str)] = &[
    ("grave", "`"),
    ("minus", "-"),
    ("equal", "="),
    ("lbracket", "["),
    ("rbracket", "]"),
    ("backslash", "\\"),
    ("semicolon", ";"),
    ("quote", "'"),
    ("comma", ","),
    ("period", "."),
    ("slash", "/"),
    ("del", "bksp"),
    ("backspace", "bksp"),
    (" ", "space"),
];

/// Legend position (row, col) of a key name
pub fn key_pos(name: &str) -> Option<(usize, usize)> {
    let lower = name.to_ascii_lowercase();
    let n = ALIASES
        .iter()
        .find(|(a, _)| *a == lower)
        .map_or(lower.as_str(), |(_, k)| *k);
    LEGEND
        .iter()
        .enumerate()
        .find_map(|(r, row)| row.iter().position(|k| *k == n).map(|c| (r, c)))
}

/// Cardputer: decoder row and column for legend (r, c); odd legend columns sit on decoder rows 0..3, even on 4..7
pub fn hc138_pos(r: usize, c: usize) -> (usize, usize) {
    let row = 3 - r + if c.is_multiple_of(2) { 4 } else { 0 };
    (row, c / 2)
}

/// Cardputer-Adv: TCA8418 (row, col) for legend (r, c)
pub fn tca8418_pos(r: usize, c: usize) -> (u8, u8) {
    ((2 * r + c / 7) as u8, (c % 7) as u8)
}

impl Machine {
    pub(crate) fn keyboard_attach(&mut self, k: Keyboard) -> bool {
        match k {
            Keyboard::Hc138 { select, cols } => {
                self.hw.key_matrix_attach(KeyMatrix::new(&select, &cols))
            }
            Keyboard::Tca8418 => self.i2c_dev::<Tca8418>().is_some(),
        }
    }

    /// Press / release a board key by legend name (script action `key=a,1`); Err names what is missing
    pub fn board_key(&mut self, name: &str, down: bool) -> Result<(), String> {
        let k = self
            .board
            .and_then(|b| b.keyboard)
            .ok_or("the board has no keyboard (needs --board m5cardputer / m5cardputeradv)")?;
        let (r, c) = key_pos(name).ok_or_else(|| format!("unknown key {name}"))?;
        match k {
            Keyboard::Hc138 { .. } => {
                let (row, col) = hc138_pos(r, c);
                self.hw.key_matrix_set(row, col, down);
            }
            Keyboard::Tca8418 => {
                let (row, col) = tca8418_pos(r, c);
                let t = self.i2c_dev::<Tca8418>().ok_or("no TCA8418 attached")?;
                if down {
                    t.press(row, col);
                } else {
                    t.release(row, col);
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_maps_cover_every_key_once() {
        assert_eq!(key_pos("A"), Some((2, 2)));
        assert_eq!(key_pos("comma"), Some((3, 10)));
        assert_eq!(key_pos(","), Some((3, 10)));
        assert_eq!(key_pos("enter"), Some((2, 13)));
        assert_eq!(key_pos("nope"), None);
        let mut hc = std::collections::HashSet::new();
        let mut tca = std::collections::HashSet::new();
        for r in 0..4 {
            for c in 0..14 {
                let (row, col) = hc138_pos(r, c);
                assert!(row < 8 && col < 7);
                assert!(hc.insert((row, col)));
                let (row, col) = tca8418_pos(r, c);
                assert!(row < 8 && col < 7);
                assert!(tca.insert((row, col)));
            }
        }
    }
}
