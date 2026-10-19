//! SAR ADC transfer model shared by ESP32-C3 and ESP32-S3 (D-02).
//! "Real" (default) inverts ESP-IDF's curve-fitting calibration for the eFuse values burnt here, then adds end bends
//! and seeded noise; "ideal" is the plain linear law over the datasheet range. Numbers: docs/DECISIONS.md (D-02).

use std::collections::VecDeque;

/// Salt that separates the ADC noise stream from the network stream (DECISIONS 2026-10-19 D batch)
pub const SEED_SALT: u32 = 0x4144_4300;
/// Default run seed when neither --seed nor seed= is given
pub const DEFAULT_SEED: u32 = 7;
/// Samples kept per pin for the web part panel
pub const RING: usize = 48;
/// Noise standard deviation in LSB (12 dB, typical board with a decoupled 3V3)
const NOISE_SIGMA: f64 = 2.0;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AdcChip {
    C3,
    S3,
}

/// Datasheet input range per attenuation (0 / 2.5 / 6 / 12 dB, mV); the ideal model is linear over it
pub fn range_mv(chip: AdcChip, atten: u32) -> f64 {
    let r = match chip {
        AdcChip::C3 => [750.0, 1050.0, 1300.0, 2500.0],
        AdcChip::S3 => [950.0, 1250.0, 1750.0, 3100.0],
    };
    r[(atten & 3) as usize]
}

// ---------------------------------------------------------------- eFuse calibration data (typical chip)
// Word index of BLK1 (RD_MAC_SPI_SYS_0) and BLK2 (RD_SYS_PART1_DATA0) in the 0x200-byte eFuse read window.
const BLK1: usize = 0x44 / 4;
const BLK2: usize = 0x5c / 4;

/// (block word base, bit, width, value), positions from esp_efuse_table.csv (IDF v5.5.1)
type Field = (usize, u32, u32, u32);

const C3_FIELDS: &[Field] = &[
    (BLK2, 128, 2, 1),    // BLK_VERSION_MAJOR = 1: "with calibration"
    (BLK2, 140, 8, 92),   // OCODE
    (BLK2, 148, 10, 638), // ADC1_INIT_CODE_ATTEN0..3 (+1000 in IDF)
    (BLK2, 158, 10, 646),
    (BLK2, 168, 10, 662),
    (BLK2, 178, 10, 690),
    (BLK2, 188, 10, 18), // ADC1_CAL_VOL_ATTEN0..3: sign-magnitude offset from 2000 (bit 9 = negative)
    (BLK2, 198, 10, (1 << 9) | 9),
    (BLK2, 208, 10, 6),
    (BLK2, 218, 10, 27),
];

const S3_FIELDS: &[Field] = &[
    (BLK2, 128, 2, 1),   // BLK_VERSION_MAJOR = 1: "ADC calib V1"
    (BLK2, 141, 8, 92),  // OCODE
    (BLK2, 149, 8, 120), // ADC1_INIT_CODE_ATTEN0..3: chained diffs from 1850
    (BLK2, 157, 6, 20),
    (BLK2, 163, 6, 30),
    (BLK2, 169, 6, 15),
    (BLK2, 175, 8, 110), // ADC2_INIT_CODE_ATTEN0..3: chained diffs from 2020
    (BLK2, 183, 6, 25),
    (BLK2, 189, 6, 30),
    (BLK2, 195, 6, 20),
    (BLK2, 201, 8, 75), // ADC1_CAL_VOL_ATTEN0..3: chained diffs from 900 (digi at 850 mV)
    (BLK2, 209, 8, 95),
    (BLK2, 217, 8, 180),
    (BLK2, 225, 8, 100),
    (BLK2, 233, 8, 30), // ADC2_CAL_VOL_ATTEN0..2, subtracted from the ADC1 values
    (BLK2, 241, 7, 20),
    (BLK2, 248, 7, 12),
    (BLK1, 186, 6, 8), // ADC2_CAL_VOL_ATTEN3 lives in BLK1
];

fn fields(chip: AdcChip) -> &'static [Field] {
    match chip {
        AdcChip::C3 => C3_FIELDS,
        AdcChip::S3 => S3_FIELDS,
    }
}

fn field(chip: AdcChip, base: usize, bit: u32) -> u32 {
    fields(chip)
        .iter()
        .find(|f| f.0 == base && f.1 == bit)
        .map_or(0, |f| f.3)
}

/// Write the ADC calibration fields into an eFuse read-register image (bits may span words)
pub fn burn_efuse(chip: AdcChip, e: &mut [u32]) {
    for &(base, bit, width, val) in fields(chip) {
        for i in 0..width {
            let b = bit + i;
            let w = base + (b / 32) as usize;
            let m = 1u32 << (b % 32);
            if val >> i & 1 != 0 {
                e[w] |= m;
            } else {
                e[w] &= !m;
            }
        }
    }
}

/// (digi, mV) reference point as esp_efuse_rtc_calib_get_cal_voltage decodes it from the fields above
pub fn cal_point(chip: AdcChip, unit: u32, atten: u32) -> (u32, u32) {
    let atten = atten & 3;
    match chip {
        AdcChip::C3 => {
            let v = field(chip, BLK2, 188 + 10 * atten);
            let off = (v & 0x1ff) as i32;
            let digi = 2000 + if v & (1 << 9) != 0 { -off } else { off };
            (digi as u32, [400, 550, 750, 1370][atten as usize])
        }
        AdcChip::S3 => {
            let d = |bit| field(chip, BLK2, bit);
            let mut a1 = [0u32; 4];
            a1[3] = d(225) + 900;
            a1[2] = d(217) + a1[3] + 800;
            a1[1] = d(209) + a1[2] + 700;
            a1[0] = d(201) + a1[1] + 800;
            let digi = if unit == 0 {
                a1[atten as usize]
            } else {
                let d7 = field(chip, BLK1, 186);
                let a2 = [
                    a1[0] - d(233) + 40,
                    a1[1] - d(241) + 10,
                    a1[2] - d(248) + 20,
                    a1[3] - d7 + 15,
                ];
                a2[atten as usize]
            };
            (digi, 850)
        }
    }
}

// ---------------------------------------------------------------- IDF second-step curves (curve_fitting_coefficients.c)
type Coef = &'static [(u64, u64)];
const E15: u64 = 1_000_000_000_000_000;
const E16: u64 = 10_000_000_000_000_000;

const C3_COEF: [Coef; 4] = [
    &[
        (225966470500043, E15),
        (7265418501948, E16),
        (109410402681, E16),
    ],
    &[
        (4229623392600516, E16),
        (731527490903, E16),
        (88166562521, E16),
    ],
    &[
        (1017859239236435, E15),
        (97159265299153, E16),
        (149794028038, E16),
    ],
    &[
        (14912262772850453, E16),
        (228549975564099, E16),
        (356391935717, E16),
        (179964582, E16),
        (42046, E16),
    ],
];
const C3_SIGN: [&[i32]; 4] = [&[-1, -1, 1], &[1, -1, 1], &[-1, -1, 1], &[-1, -1, 1, -1, 1]];

const S3_COEF1: [Coef; 4] = [
    &[
        (27856531419538344, E16),
        (50871540569528, E16),
        (9798249589, E15),
    ],
    &[
        (29831022915028695, E16),
        (49393185868806, E16),
        (101379430548, E16),
    ],
    &[
        (23285545746296417, E16),
        (147640181047414, E16),
        (208385525314, E16),
    ],
    &[
        (644403418269478, E15),
        (644334888647536, E16),
        (1297891447611, E16),
        (70769718, E15),
        (13515, E15),
    ],
];
const S3_SIGN1: [&[i32]; 4] = [
    &[-1, -1, 1],
    &[-1, -1, 1],
    &[-1, -1, 1],
    &[-1, -1, 1, -1, 1],
];
const S3_COEF2: [Coef; 4] = [
    &[
        (25668651654328927, E16),
        (1353548869615, E16),
        (36615265189, E16),
    ],
    &[
        (23690184690298404, E16),
        (66319894226185, E16),
        (118964995959, E16),
    ],
    &[
        (9452499397020617, E16),
        (200996773954387, E16),
        (259011467956, E16),
    ],
    &[
        (12247719764336924, E16),
        (755717904943462, E16),
        (1478791187119, E16),
        (79672528, E15),
        (15038, E15),
    ],
];
const S3_SIGN2: [&[i32]; 4] = [&[-1, 1, 1], &[-1, -1, 1], &[-1, -1, 1], &[1, -1, 1, -1, 1]];

/// What adc_cali_raw_to_voltage (curve fitting) returns for `raw`, with IDF's integer arithmetic
pub fn calibrated_mv(chip: AdcChip, unit: u32, atten: u32, raw: u32) -> i32 {
    let a = (atten & 3) as usize;
    let (coef, sign) = match (chip, unit) {
        (AdcChip::C3, _) => (C3_COEF[a], C3_SIGN[a]),
        (AdcChip::S3, 0) => (S3_COEF1[a], S3_SIGN1[a]),
        (AdcChip::S3, _) => (S3_COEF2[a], S3_SIGN2[a]),
    };
    let (digi, mv) = cal_point(chip, unit, atten);
    let coeff_a = (65536 * mv / digi) as u64;
    let v1 = raw as u64 * coeff_a / 65536;
    if v1 == 0 {
        return 0;
    }
    let mut err = (coef[0].0 / coef[0].1) as i32 * sign[0];
    let mut var = 1u64;
    for i in 1..coef.len() {
        var = var.wrapping_mul(v1);
        err += (var.wrapping_mul(coef[i].0) / coef[i].1) as i32 * sign[i];
    }
    v1 as i32 - err
}

/// Fractional code whose calibrated reading is `mv` (calibrated_mv is monotonic over 0..4095)
fn inverse(chip: AdcChip, unit: u32, atten: u32, mv: f64) -> f64 {
    let cal = |r: u32| calibrated_mv(chip, unit, atten, r) as f64;
    if mv <= cal(0) {
        // Extrapolate below code 0 so noise cannot lift a deep dead-zone input off zero
        return (mv - cal(0)) * 4095.0 / (cal(4095) - cal(0)).max(1.0);
    }
    if mv >= cal(4095) {
        return 4095.0;
    }
    let (mut lo, mut hi) = (0u32, 4095u32);
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        if cal(mid) < mv {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let (c0, c1) = (cal(lo), cal(hi));
    lo as f64 + if c1 > c0 { (mv - c0) / (c1 - c0) } else { 0.0 }
}

/// Front-end bends: dead zone near 0 V and compression near the top of the range (calibration doesn't cover them)
fn bend(mv: f64, range: f64) -> f64 {
    let lo = 0.035 * range;
    let hi = 0.935 * range;
    let w = range - hi;
    if mv < lo {
        let t = 1.0 - mv.max(0.0) / lo;
        mv - 0.6 * lo * t * t
    } else if mv > hi {
        let d = (mv - hi).min(2.0 * w);
        hi + d - d * d / (4.0 * w)
    } else {
        mv
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sample {
    pub raw: u16,
    /// What correctly calibrated firmware would report (IDF curve in real mode, linear in ideal mode)
    pub mv: i32,
}

#[derive(Clone)]
pub struct AdcModel {
    pub chip: AdcChip,
    /// adc=ideal: linear, noiseless; default false (real)
    pub ideal: bool,
    rng: u32,
    rings: Vec<VecDeque<Sample>>,
    /// ADC2 conversions refused because Wi-Fi held the arbiter
    pub blocked: u64,
}

impl AdcModel {
    pub fn new(chip: AdcChip) -> Self {
        AdcModel {
            chip,
            ideal: false,
            rng: DEFAULT_SEED ^ SEED_SALT,
            rings: Vec::new(),
            blocked: 0,
        }
    }

    /// Restart the noise stream from a run seed (seed= / --seed)
    pub fn reseed(&mut self, seed: u32) {
        self.rng = seed ^ SEED_SALT;
    }

    /// Switch ideal / real; a change drops the sample rings so the panel never mixes the two laws
    pub fn set_ideal(&mut self, ideal: bool) {
        if ideal != self.ideal {
            self.rings.clear();
        }
        self.ideal = ideal;
    }

    fn next(&mut self) -> u32 {
        // splitmix32: any state (including 0) gives a full-period, well-mixed stream
        self.rng = self.rng.wrapping_add(0x9e37_79b9);
        let mut z = self.rng;
        z = (z ^ (z >> 16)).wrapping_mul(0x85eb_ca6b);
        z = (z ^ (z >> 13)).wrapping_mul(0xc2b2_ae35);
        z ^ (z >> 16)
    }

    /// Approximately Gaussian (sum of four uniforms), in LSB
    fn noise(&mut self) -> f64 {
        let s: f64 = (0..4).map(|_| self.next() as f64 / 4_294_967_296.0).sum();
        (s - 2.0) * NOISE_SIGMA * 3f64.sqrt()
    }

    /// One conversion of `mv` on (unit, atten); `pin` = external pad (None = internal channel, not recorded)
    pub fn convert(&mut self, unit: u32, atten: u32, pin: Option<usize>, mv: f32) -> u32 {
        let range = range_mv(self.chip, atten);
        let mv = mv as f64;
        let raw = if self.ideal {
            (mv / range * 4095.0).round().clamp(0.0, 4095.0) as u32
        } else {
            let x = inverse(self.chip, unit, atten, bend(mv, range));
            (x + self.noise()).round().clamp(0.0, 4095.0) as u32
        };
        if let Some(p) = pin {
            let cal = if self.ideal {
                (raw as f64 * range / 4095.0).round() as i32
            } else {
                calibrated_mv(self.chip, unit, atten, raw)
            };
            if self.rings.len() <= p {
                self.rings.resize(p + 1, VecDeque::new());
            }
            let r = &mut self.rings[p];
            if r.len() == RING {
                r.pop_front();
            }
            r.push_back(Sample {
                raw: raw as u16,
                mv: cal,
            });
        }
        raw
    }

    /// Recent conversions on `pin`, oldest first
    pub fn samples(&self, pin: usize) -> impl Iterator<Item = &Sample> {
        self.rings.get(pin).into_iter().flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn efuse_decodes_like_idf() {
        assert_eq!(cal_point(AdcChip::C3, 0, 1), (1991, 550));
        assert_eq!(cal_point(AdcChip::C3, 0, 3), (2027, 1370));
        assert_eq!(cal_point(AdcChip::S3, 0, 3), (1000, 850));
        assert_eq!(cal_point(AdcChip::S3, 0, 0), (3650, 850));
        assert_eq!(cal_point(AdcChip::S3, 1, 3), (1007, 850));
        let mut e = [0u32; 0x80];
        burn_efuse(AdcChip::S3, &mut e);
        // BLK_VERSION_MAJOR at BLK2 bit 128 (word 4); ADC2_CAL_VOL_ATTEN3 = 8 at BLK1 bits 186..191
        assert_eq!(e[BLK2 + 4] & 3, 1);
        assert_eq!(e[BLK1 + 5] >> 26 & 0x3f, 8);
        // S3 ADC1_INIT_CODE_ATTEN1 (bits 157..162) straddles no word but ATTEN0 (149..156) is in word 4
        assert_eq!(e[BLK2 + 4] >> 21 & 0xff, 120);
    }

    #[test]
    fn calibrated_error_under_one_percent_mid_range() {
        for chip in [AdcChip::C3, AdcChip::S3] {
            for unit in 0..2 {
                for atten in 0..4 {
                    let range = range_mv(chip, atten);
                    let mut m = AdcModel::new(chip);
                    for k in 2..=8 {
                        let mv = range * k as f64 / 10.0;
                        let n = 32;
                        let sum: i64 = (0..n)
                            .map(|_| {
                                let raw = m.convert(unit, atten, None, mv as f32);
                                calibrated_mv(chip, unit, atten, raw) as i64
                            })
                            .sum();
                        let avg = sum as f64 / n as f64;
                        let err = (avg - mv).abs() / mv;
                        assert!(err < 0.01, "{chip:?} u{unit} a{atten} {mv} mV -> {avg}");
                    }
                }
            }
        }
    }

    #[test]
    fn ideal_is_exact_and_noiseless() {
        let mut m = AdcModel::new(AdcChip::C3);
        m.ideal = true;
        for _ in 0..10 {
            assert_eq!(m.convert(0, 3, Some(2), 1250.0), 2048);
        }
        let s: Vec<_> = m.samples(2).collect();
        assert_eq!(s.len(), 10);
        assert_eq!(s[0].mv, 1250);
    }

    #[test]
    fn noise_depends_only_on_seed() {
        let run = |seed| {
            let mut m = AdcModel::new(AdcChip::S3);
            m.reseed(seed);
            (0..64)
                .map(|_| m.convert(0, 3, Some(4), 1650.0))
                .collect::<Vec<_>>()
        };
        assert_eq!(run(7), run(7));
        assert_ne!(run(7), run(8));
        let v = run(7);
        let (lo, hi) = (*v.iter().min().unwrap(), *v.iter().max().unwrap());
        assert!(hi > lo && hi - lo <= 16, "{lo}..{hi}");
    }

    #[test]
    fn ends_bend() {
        let mut m = AdcModel::new(AdcChip::S3);
        m.reseed(1);
        // A few tens of mV read as 0; 3.1 V reads clearly low after calibration
        assert_eq!(m.convert(0, 3, None, 20.0), 0);
        let avg = (0..32)
            .map(|_| calibrated_mv(AdcChip::S3, 0, 3, m.convert(0, 3, None, 3100.0)) as f64)
            .sum::<f64>()
            / 32.0;
        assert!(avg < 3070.0, "{avg}");
    }
}
