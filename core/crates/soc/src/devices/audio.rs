//! I2S audio devices: MAX98357A (I2S-input class-D amp + small speaker) and INMP441 (I2S-output MEMS mic). Per datasheets:
//! MAX98357A Philips I2S, (L+R)/2 mix, 9 dB gain, 2.4 mA quiescent; INMP441 24-bit MSB-first Philips, L/R pin picks the slot
//! (other slot high-Z), 1.4 mA. Both only see I2S slot words (i2s.rs); time is simulated (CPU cycles) and speaker output is
//! timestamped so the web page can align it to the AudioContext timeline. (lint: allow-long-comment)

use crate::i2s::I2sIo;
use crate::periph::CPU_HZ;
use std::collections::VecDeque;

/// GPIOs of the three I2S lines (data line: DIN for the speaker, SD for the mic)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pins {
    pub bclk: u32,
    pub ws: u32,
    pub data: u32,
}

/// A run of contiguous speaker samples (mono, 16-bit); t = simulated time (cycles) of the first sample
#[derive(Clone, Debug, PartialEq)]
pub struct Block {
    pub t: u64,
    pub rate: f32,
    pub data: Vec<i16>,
}

/// Readings of a stretch of sound
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Analysis {
    pub rate: f64,
    pub samples: usize,
    /// Full scale = 1
    pub rms: f64,
    pub peak: f64,
    /// Dominant frequency (Hz): DC removed, linear interpolation between rising zero crossings; 0 if none
    pub freq: f64,
}

/// Readings: DC removal, RMS, peak, zero-crossing frequency
pub fn analyze(x: &[f32], rate: f64) -> Analysis {
    if x.is_empty() || rate <= 0.0 {
        return Analysis::default();
    }
    let mean = x.iter().map(|v| *v as f64).sum::<f64>() / x.len() as f64;
    let mut sum = 0.0;
    let mut peak: f64 = 0.0;
    // Periods between rising crossings; gaps over 20 ms (beep pauses, silence) are left out of the frequency
    let max_period = rate * 0.02;
    let (mut last, mut periods, mut span) = (-1.0f64, 0usize, 0.0f64);
    let mut prev = 0.0;
    // Hysteresis on zero crossings so rounding noise in silence doesn't count
    let hyst = 1e-4;
    let mut armed = false;
    for (i, v) in x.iter().enumerate() {
        let v = *v as f64 - mean;
        sum += v * v;
        peak = peak.max(v.abs());
        if v < -hyst {
            armed = true;
        }
        if i > 0 && armed && prev < 0.0 && v >= 0.0 {
            let t = (i - 1) as f64 + prev / (prev - v);
            if last >= 0.0 && t - last <= max_period {
                periods += 1;
                span += t - last;
            }
            last = t;
            armed = false;
        }
        prev = v;
    }
    let freq = if periods >= 1 && span > 0.0 {
        periods as f64 * rate / span
    } else {
        0.0
    };
    Analysis {
        rate,
        samples: x.len(),
        rms: (sum / x.len() as f64).sqrt(),
        peak,
        freq,
    }
}

/// History cap for analysis (about 6 s @ 44.1 kHz)
const HIST_CAP: usize = 1 << 18;
/// Cap on samples queued for the web page (about 3 s): oldest are dropped if not fetched in time
const QUEUE_CAP: usize = 1 << 17;

/// MAX98357A: (L+R)/2 mixed to mono, 9 dB gain (GAIN pin floating), driving a 4 Ω speaker
pub struct Max98357a {
    pub pins: Pins,
    /// 1-bit buzzer on the data line (M5Dial G3): each frame's slot bits are a delta-sigma word, its density is the sample
    pub buzzer: bool,
    /// The level ever changed (M5.begin() streams a constant idle level from boot; the buzzer report waits for a tone)
    pub sounded: bool,
    pub queue: VecDeque<Block>,
    queued: usize,
    pub dropped: u64,
    hist: VecDeque<i16>,
    /// Sample rate and mean square of the latest block (full scale = 1)
    pub rate: f64,
    pub recent_ms: f64,
    pub frames: u64,
    pub blocks: u64,
    pub first_t: Option<u64>,
    pub last_t: u64,
}

/// Output RMS (V) of a 0 dBFS sine at 9 dB gain. Estimate: the datasheet gives gain, not full-scale voltage; 2.5 Vrms unclipped at 5 V
pub const FS_VRMS: f64 = 2.5;
pub const SPEAKER_OHM: f64 = 4.0;
/// Class-D efficiency (estimate) and quiescent current (datasheet 2.4 mA)
pub const EFFICIENCY: f64 = 0.85;
pub const AMP_IQ: f64 = 0.0024;
/// INMP441 operating current (datasheet 1.4 mA)
pub const MIC_I: f64 = 0.0014;
/// Magnetic buzzer + driver transistor at full swing (estimate, no datasheet for the M5Dial part)
pub const BUZZER_I: f64 = 0.03;

impl Max98357a {
    pub fn new(pins: Pins) -> Self {
        Max98357a {
            pins,
            buzzer: false,
            sounded: false,
            queue: VecDeque::new(),
            queued: 0,
            dropped: 0,
            hist: VecDeque::new(),
            rate: 0.0,
            recent_ms: 0.0,
            frames: 0,
            blocks: 0,
            first_t: None,
            last_t: 0,
        }
    }

    pub fn push(&mut self, t: u64, rate: f64, frames: &[[i32; 2]]) {
        let mut data = Vec::with_capacity(frames.len());
        let mut ms = 0.0;
        for f in frames {
            let s = if self.buzzer {
                // Slot words are MSB-aligned (low bits 0), so popcount = density; unipolar since a low pin drives no current
                let ones = (f[0] as u32).count_ones() + (f[1] as u32).count_ones();
                (ones as i32 * 1024).min(32767) as i16
            } else {
                (((f[0] as i64 + f[1] as i64) / 2) >> 16) as i16
            };
            self.sounded |= data.last().or(self.hist.back()).is_some_and(|p| *p != s);
            ms += (s as f64 / 32768.0).powi(2);
            data.push(s);
        }
        self.recent_ms = ms / frames.len().max(1) as f64;
        self.rate = rate;
        self.frames += frames.len() as u64;
        self.blocks += 1;
        self.first_t.get_or_insert(t);
        self.last_t = t + (frames.len() as f64 * CPU_HZ as f64 / rate) as u64;
        for s in &data {
            if self.hist.len() == HIST_CAP {
                self.hist.pop_front();
            }
            self.hist.push_back(*s);
        }
        self.queued += data.len();
        self.queue.push_back(Block {
            t,
            rate: rate as f32,
            data,
        });
        while self.queued > QUEUE_CAP {
            if let Some(b) = self.queue.pop_front() {
                self.queued -= b.data.len();
                self.dropped += b.data.len() as u64;
            }
        }
    }

    /// Take the accumulated output (for web playback)
    pub fn take(&mut self) -> Vec<Block> {
        self.queued = 0;
        self.queue.drain(..).collect()
    }

    /// Readings over the last secs seconds
    pub fn analyze(&self, secs: f64) -> Analysis {
        let n = ((secs * self.rate) as usize).min(self.hist.len());
        let x: Vec<f32> = self
            .hist
            .iter()
            .skip(self.hist.len() - n)
            .map(|s| *s as f32 / 32768.0)
            .collect();
        analyze(&x, self.rate)
    }

    /// Current drawn from 5 V (A): quiescent + output power / (efficiency x 5 V)
    pub fn supply_current(&self) -> f64 {
        if self.buzzer {
            return BUZZER_I * self.recent_ms.sqrt().min(1.0);
        }
        let vrms = FS_VRMS * self.recent_ms.sqrt();
        AMP_IQ + vrms * vrms / SPEAKER_OHM / (EFFICIENCY * 5.0)
    }
}

/// What the mic hears
pub enum MicSource {
    /// Silence (zeros only)
    Silence,
    /// Fixed WAV (looped, sampled by simulated time: the same WAV reads identically every run)
    Wav { rate: f64, data: Vec<f32> },
    /// Live external input (the browser mic), placed on the simulated-time sample grid and read exactly like `Wav`
    /// (F-09c): a WAV of the same samples, zeros elsewhere, replays the same frames (see `push_live_at`)
    Live {
        rate: f64,
        /// Absolute sample index of `buf[0]`; indices outside `buf` read 0
        base: u64,
        buf: VecDeque<f32>,
        /// High-water mark: every index below it may have been read, so new audio never lands there
        hwm: u64,
        underruns: u64,
    },
}

/// Simulated time -> (sample index, fraction): shared by `Wav` and `Live` so both interpolate bit-identically
fn grid(t: f64, rate: f64) -> (f64, f32) {
    let p = t / CPU_HZ as f64 * rate;
    let i = p.floor();
    (i, (p - i) as f32)
}

pub struct Inmp441 {
    pub pins: Pins,
    /// L/R pin high = right channel (default grounded = left)
    pub right: bool,
    /// Same sample on both slots (M5-08 board mics: a mono codec ADC, or a PDM mic whose L/R strap is unknown)
    pub both: bool,
    pub source: MicSource,
    pub frames: u64,
    /// PDM part (SPM1423 on M5 boards): the SoC decimates to PCM; data shows on both slots (see `slots`)
    pub pdm: bool,
}

impl Inmp441 {
    pub fn new(pins: Pins) -> Self {
        Inmp441 {
            pins,
            right: false,
            both: false,
            source: MicSource::Silence,
            frames: 0,
            pdm: false,
        }
    }

    /// Push live audio with no clock (appends after what is queued); see `push_live_at`
    pub fn push_live(&mut self, rate: f64, x: &[f32]) {
        self.push_live_at(0, rate, x);
    }

    /// Web page pushes live audio at simulated cycle `now` (rate = sample rate of the pushed data). The chunk lands at
    /// max(queued end, high-water mark, now's index); it is dropped (None) when that is over 1 s ahead of `now`
    pub fn push_live_at(&mut self, now: u64, rate: f64, x: &[f32]) -> Option<u64> {
        let at = (now as f64 / CPU_HZ as f64 * rate).floor() as u64;
        if !matches!(&self.source, MicSource::Live { rate: r, .. } if *r == rate) {
            self.source = MicSource::Live {
                rate,
                base: at,
                buf: VecDeque::new(),
                hwm: at,
                underruns: 0,
            };
        }
        let MicSource::Live { base, buf, hwm, .. } = &mut self.source else {
            return None;
        };
        let end = *base + buf.len() as u64;
        let start = end.max(*hwm).max(at);
        if start > at + rate.max(1.0) as u64 {
            return None;
        }
        if buf.is_empty() {
            *base = start;
        } else {
            buf.extend(std::iter::repeat_n(0.0, (start - end) as usize));
        }
        buf.extend(x.iter().copied());
        Some(start)
    }

    fn level(&mut self, t: f64) -> f32 {
        match &mut self.source {
            MicSource::Silence => 0.0,
            MicSource::Wav { rate, data } => {
                if data.is_empty() {
                    return 0.0;
                }
                let (i, fr) = grid(t, *rate);
                let n = data.len();
                let a = data[(i as usize) % n];
                let b = data[(i as usize + 1) % n];
                a + (b - a) * fr
            }
            MicSource::Live {
                rate,
                base,
                buf,
                hwm,
                underruns,
            } => {
                let (i, fr) = grid(t, *rate);
                let i = i as u64;
                let end = *base + buf.len() as u64;
                if i >= end {
                    *underruns += 1;
                }
                let at = |j: u64| {
                    if j >= *base && j < end {
                        buf[(j - *base) as usize]
                    } else {
                        0.0
                    }
                };
                let (a, b) = (at(i), at(i + 1));
                *hwm = (*hwm).max(i + 2);
                // Reads only move forward: drop what is behind this frame
                while *base < i && !buf.is_empty() {
                    buf.pop_front();
                    *base += 1;
                }
                a + (b - a) * fr
            }
        }
    }

    /// Slot words for n frames: 24-bit two's complement left-aligned (low 8 bits 0); the silent slot is high-Z and reads 0
    pub fn slots(&mut self, t0: u64, rate: f64, n: usize) -> Vec<[i32; 2]> {
        let fc = CPU_HZ as f64 / rate;
        let k = self.right as usize;
        self.frames += n as u64;
        (0..n)
            .map(|i| {
                let x = self
                    .level(t0 as f64 + i as f64 * fc)
                    .clamp(-1.0, 1.0 - 1.0 / 8_388_608.0);
                let v24 = (x as f64 * 8_388_608.0).round() as i32;
                // A lone PDM mic's data line keeps its bit through the idle clock phase, so both slots decode it
                // (M5Unified reads the right slot, IDF's default the left one, both on SPM1423 boards)
                if self.pdm {
                    return [v24 << 8; 2];
                }
                let mut s = [0i32; 2];
                s[k] = v24 << 8;
                if self.both {
                    s[1 - k] = v24 << 8;
                }
                s
            })
            .collect()
    }
}

/// Read a WAV (PCM 8/16/24/32-bit int or 32-bit float, first channel of multi-channel) -> (sample rate, -1..1 samples)
pub fn parse_wav(b: &[u8]) -> Result<(u32, Vec<f32>), String> {
    if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".into());
    }
    let (mut fmt, mut data) = (None, None);
    let mut p: usize = 12;
    while p.saturating_add(8) <= b.len() {
        let id = &b[p..p + 4];
        // Infallible: 4-byte slice inside the p + 8 <= b.len() bound
        let len = u32::from_le_bytes(b[p + 4..p + 8].try_into().unwrap()) as usize;
        // Saturate: on wasm32 a huge chunk length would wrap usize and invert the slice or loop
        let body = &b[p + 8..p.saturating_add(8).saturating_add(len).min(b.len())];
        match id {
            b"fmt " => fmt = Some(body),
            b"data" => data = Some(body),
            _ => {}
        }
        p = p
            .saturating_add(8)
            .saturating_add(len)
            .saturating_add(len & 1);
    }
    let fmt = fmt.ok_or("missing fmt chunk")?;
    let data = data.ok_or("missing data chunk")?;
    if fmt.len() < 16 {
        return Err("fmt chunk too short".into());
    }
    let tag = u16::from_le_bytes([fmt[0], fmt[1]]);
    let ch = u16::from_le_bytes([fmt[2], fmt[3]]).max(1) as usize;
    // Infallible: fmt.len() >= 16 (checked above).
    let rate = u32::from_le_bytes(fmt[4..8].try_into().unwrap());
    let bits = u16::from_le_bytes([fmt[14], fmt[15]]) as usize;
    // WAVE_FORMAT_EXTENSIBLE: the first two bytes of the subformat GUID are the real format tag
    let tag = if tag == 0xfffe && fmt.len() >= 26 {
        u16::from_le_bytes([fmt[24], fmt[25]])
    } else {
        tag
    };
    let bps = bits.div_ceil(8);
    if bps == 0 || rate == 0 {
        return Err("sample rate or bit depth is 0".into());
    }
    let frame = bps * ch;
    let out = data
        .chunks_exact(frame)
        .map(|f| {
            let s = &f[..bps];
            match (tag, bps) {
                // Infallible: these arms have bps == 4, so s is 4 bytes.
                (3, 4) => f32::from_le_bytes(s.try_into().unwrap()),
                (_, 1) => (s[0] as f32 - 128.0) / 128.0,
                (_, 2) => i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0,
                (_, 3) => ((i32::from_le_bytes([0, s[0], s[1], s[2]])) >> 8) as f32 / 8_388_608.0,
                (_, 4) => i32::from_le_bytes(s.try_into().unwrap()) as f32 / 2_147_483_648.0,
                _ => 0.0,
            }
        })
        .collect::<Vec<_>>();
    if !matches!(tag, 1 | 3) {
        return Err(format!("unsupported WAV format {tag}"));
    }
    Ok((rate, out))
}

/// Audio devices on I2S (the outside world, kept across resets)
#[derive(Default)]
pub struct Audio {
    pub speaker: Option<Box<Max98357a>>,
    pub mic: Option<Box<Inmp441>>,
    /// Frames I2S sent while the speaker's DIN wasn't on that port's data output (miswired)
    pub tx_unrouted: u64,
    /// Frames I2S received while its data input wasn't connected to the mic's SD
    pub rx_unrouted: u64,
}

impl Audio {
    pub fn is_empty(&self) -> bool {
        self.speaker.is_none() && self.mic.is_none()
    }

    /// Observation record shared by CLI / web (`[tryboard] I2S ...` lines); text stays Chinese until check.py / checks.ts / fingerprints migrate
    pub fn report(&self) -> String {
        let mut s = String::new();
        if let Some(sp) = self.speaker.as_ref().filter(|s| !s.buzzer || s.sounded) {
            let a = sp.analyze(1.0);
            let secs = match sp.first_t {
                Some(t0) => (sp.last_t - t0) as f64 / CPU_HZ as f64,
                None => 0.0,
            };
            if sp.buzzer {
                s += &format!(
                    "[tryboard] I2S buzzer (1-bit delta-sigma, DOUT=GPIO{}): got {} frames ({:.2}s), sample rate {:.1} Hz, last 1 s RMS {:.4}, peak {:.4}, freq {:.1} Hz\n",
                    sp.pins.data, sp.frames, secs, sp.rate, a.rms, a.peak, a.freq
                );
            } else {
                s += &format!(
                "[tryboard] I2S speaker MAX98357A (BCLK=GPIO{} LRC=GPIO{} DIN=GPIO{}): got {} frames ({:.2}s), sample rate {:.1} Hz, last 1 s RMS {:.4}, peak {:.4}, freq {:.1} Hz\n",
                sp.pins.bclk, sp.pins.ws, sp.pins.data, sp.frames, secs, sp.rate, a.rms, a.peak, a.freq
            );
            }
        }
        if let Some(m) = &self.mic {
            let src = match &m.source {
                MicSource::Silence => "silence".to_string(),
                MicSource::Wav { rate, data } => {
                    #[rustfmt::skip]
                    let s = format!("WAV {} Hz {:.2}s loop", rate, data.len() as f64 / rate);
                    s
                }
                MicSource::Live { underruns, .. } => {
                    format!("live input ({underruns} frames underrun)")
                }
            };
            let side = if m.right { "right" } else { "left" };
            s += &if m.pdm {
                format!(
                    "[tryboard] PDM mic SPM1423 (CLK=GPIO{} DATA=GPIO{}, {} channel): sent {} PCM frames, source {}\n",
                    m.pins.ws, m.pins.data, side, m.frames, src
                )
            } else {
                format!(
                    "[tryboard] I2S mic INMP441 (SCK=GPIO{} WS=GPIO{} SD=GPIO{}, {} channel): sent {} frames, source {}\n",
                    m.pins.bclk, m.pins.ws, m.pins.data, side, m.frames, src
                )
            };
        }
        if self.tx_unrouted > 0 {
            s += &format!(
                "[tryboard] I2S wiring: {} transmitted frames never reached the speaker (DIN is not on the I2S data output)\n",
                self.tx_unrouted
            );
        }
        if self.rx_unrouted > 0 {
            s += &format!(
                "[tryboard] I2S wiring: {} received frames did not come from the mic (data input not routed to the SD pin)\n",
                self.rx_unrouted
            );
        }
        s
    }
}

/// Which devices an I2S port is connected to right now (computed by the SoC from the GPIO matrix)
pub struct PortIo<'a> {
    pub audio: &'a mut Audio,
    pub speaker: bool,
    pub mic: bool,
}

impl I2sIo for PortIo<'_> {
    fn tx(&mut self, t: u64, rate: f64, frames: &[[i32; 2]]) {
        match (self.speaker, self.audio.speaker.as_mut()) {
            (true, Some(s)) => s.push(t, rate, frames),
            (_, Some(_)) => self.audio.tx_unrouted += frames.len() as u64,
            _ => {}
        }
    }
    fn rx(&mut self, t: u64, rate: f64, n: usize) -> Vec<[i32; 2]> {
        match (self.mic, self.audio.mic.as_mut()) {
            (true, Some(m)) => m.slots(t, rate, n),
            (false, Some(_)) => {
                self.audio.rx_unrouted += n as u64;
                vec![[0; 2]; n]
            }
            _ => vec![[0; 2]; n],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav16(rate: u32, x: &[f32]) -> Vec<u8> {
        let mut b = Vec::new();
        let n = x.len() as u32 * 2;
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + n).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&[1, 0, 1, 0]);
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&(rate * 2).to_le_bytes());
        b.extend_from_slice(&[2, 0, 16, 0]);
        b.extend_from_slice(b"data");
        b.extend_from_slice(&n.to_le_bytes());
        for v in x {
            b.extend_from_slice(&((v * 32767.0) as i16).to_le_bytes());
        }
        b
    }

    #[test]
    fn analyze_sine() {
        let rate = 44100.0;
        let x: Vec<f32> = (0..44100)
            .map(|i| 0.5 * (2.0 * std::f64::consts::PI * 440.0 * i as f64 / rate).sin() as f32)
            .collect();
        let a = analyze(&x, rate);
        assert!((a.freq - 440.0).abs() < 0.01, "{}", a.freq);
        assert!((a.rms - 0.5 / 2f64.sqrt()).abs() < 1e-3);
        assert_eq!(analyze(&[0.0; 100], rate).freq, 0.0);
    }

    #[test]
    fn analyze_beeps_ignore_gaps() {
        // Three 200 ms 2 kHz beeps 400 ms apart (G-16a alarm): the pauses must not drag the frequency down
        let rate = 48000.0;
        let x: Vec<f32> = (0..48000)
            .map(|i| {
                let t = i as f64 / rate;
                let on = t % 0.4 < 0.2;
                if on {
                    0.5 * (2.0 * std::f64::consts::PI * 2000.0 * t).sin() as f32
                } else {
                    0.0
                }
            })
            .collect();
        let a = analyze(&x, rate);
        assert!((a.freq - 2000.0).abs() < 1.0, "{}", a.freq);
    }

    #[test]
    fn wav_roundtrip_and_mic_slots() {
        let x: Vec<f32> = (0..48).map(|i| (i as f32 / 48.0) - 0.5).collect();
        let (r, y) = parse_wav(&wav16(48000, &x)).unwrap();
        assert_eq!(r, 48000);
        assert_eq!(y.len(), 48);
        assert!((y[10] - x[10]).abs() < 1e-4);
        let mut m = Inmp441::new(Pins {
            bclk: 1,
            ws: 2,
            data: 3,
        });
        m.source = MicSource::Wav {
            rate: 48000.0,
            data: y,
        };
        // 48 kHz frame rate from time 0: samples line up one by one, left slot has data, right slot 0
        let s = m.slots(0, 48000.0, 4);
        assert_eq!(s[2][1], 0);
        assert_eq!(
            s[2][0] >> 8,
            ((x[2] as f64 * 32767.0) as i16 as f64 / 32768.0 * 8_388_608.0).round() as i32
        );
        assert!(parse_wav(b"RIFX....").is_err());
    }

    #[test]
    fn speaker_mix_and_current() {
        let mut s = Max98357a::new(Pins {
            bclk: 1,
            ws: 2,
            data: 3,
        });
        s.push(100, 44100.0, &[[0x4000_0000, 0], [i32::MIN, i32::MIN]]);
        let b = s.take();
        assert_eq!(b[0].data, vec![0x2000, -32768]);
        assert_eq!(b[0].t, 100);
        assert!(s.take().is_empty());
        assert!(s.supply_current() > AMP_IQ);
    }

    #[test]
    fn buzzer_density_to_pcm() {
        let mut s = Max98357a::new(Pins {
            bclk: 3,
            ws: 3,
            data: 3,
        });
        s.buzzer = true;
        // Slot words carry 16 bits each in their top half: all ones = FS, none = silence, half density = FS / 2
        let half = [0xff00_0000u32 as i32, 0xff00_0000u32 as i32];
        s.push(0, 48000.0, &[[-65536, -65536], [0, 0], half]);
        assert_eq!(s.take()[0].data, vec![32767, 0, 16384]);
        assert!(s.supply_current() > 0.0 && s.supply_current() <= BUZZER_I);
        assert!(Audio::default().report().is_empty());
    }

    #[test]
    fn live_mic_resamples() {
        let mut m = Inmp441::new(Pins {
            bclk: 1,
            ws: 2,
            data: 3,
        });
        m.push_live(32000.0, &[0.5, 0.5, -0.5, -0.5]);
        // 16 kHz frame rate: each frame consumes 2 pushed samples
        let s = m.slots(0, 16000.0, 3);
        assert!(s[0][0] > 0 && s[1][0] < 0 && s[2][0] == 0);
        assert!(matches!(m.source, MicSource::Live { underruns: 1, .. }));
    }

    #[test]
    fn live_mic_record_replays_as_wav() {
        // F-09c: pushes interleaved with reads (one read past the queued audio, one chunk too far ahead) must
        // replay frame for frame from a WAV holding each kept chunk at its returned index, zeros elsewhere
        let pins = || Pins {
            bclk: 1,
            ws: 2,
            data: 3,
        };
        let rate = 48000.0;
        let fc = CPU_HZ / 16000;
        let mut live = Inmp441::new(pins());
        let mut kept: Vec<(u64, Vec<f32>)> = Vec::new();
        let mut reads = Vec::new();
        let mut out = Vec::new();
        let mut t = 7_777u64;
        let mut k = 0u32;
        for step in 0..60u64 {
            let now = t + step * 13;
            let chunk: Vec<f32> = (0..300)
                .map(|_| {
                    k += 1;
                    ((k as f32 * 0.37).sin() * 32767.0).round() / 32768.0
                })
                .collect();
            if step != 7 && step != 8 {
                if let Some(at) = live.push_live_at(now, rate, &chunk) {
                    kept.push((at, chunk));
                }
            }
            // Frames run a bit faster than pushes arrive, so the sim catches up and underruns
            let n = if step % 5 == 0 { 140 } else { 95 };
            reads.push((t, n));
            out.extend(live.slots(t, 16000.0, n));
            t += n as u64 * fc;
        }
        // Paused sim, wall clock keeps pushing: the queue stops 1 s ahead of now
        let mut fed = 0;
        while let Some(at) = live.push_live_at(t, rate, &[0.25; 1000]) {
            kept.push((at, vec![0.25; 1000]));
            fed += 1;
            assert!(fed < 100, "a chunk over 1 s ahead of now must be dropped");
        }
        let MicSource::Live { hwm, underruns, .. } = live.source else {
            panic!("live source expected");
        };
        assert!(
            underruns > 0,
            "the test must cover a read past the queued audio"
        );
        let end = kept.iter().map(|(a, c)| a + c.len() as u64).max().unwrap();
        let mut data = vec![0.0f32; end.max(hwm) as usize + 1];
        for (a, c) in &kept {
            data[*a as usize..*a as usize + c.len()].copy_from_slice(c);
        }
        let mut wav = Inmp441::new(pins());
        wav.source = MicSource::Wav { rate, data };
        let again: Vec<_> = reads
            .iter()
            .flat_map(|&(t0, n)| wav.slots(t0, 16000.0, n))
            .collect();
        assert_eq!(out.len(), again.len());
        assert!(out.iter().any(|s| s[0] != 0));
        assert_eq!(out, again);
    }
}
