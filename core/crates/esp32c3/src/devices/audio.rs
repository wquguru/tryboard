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
    let (mut first, mut last, mut ups) = (-1.0f64, -1.0f64, 0usize);
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
            if first < 0.0 {
                first = t;
            }
            last = t;
            ups += 1;
            armed = false;
        }
        prev = v;
    }
    let freq = if ups >= 2 && last > first {
        (ups - 1) as f64 * rate / (last - first)
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

impl Max98357a {
    pub fn new(pins: Pins) -> Self {
        Max98357a {
            pins,
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
            let m = ((f[0] as i64 + f[1] as i64) / 2) >> 16;
            let s = m as i16;
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
    /// Live external input (the browser mic): consumed from a queue at the I2S frame rate, 0 when empty
    Live {
        rate: f64,
        fifo: VecDeque<f32>,
        pos: f64,
        underruns: u64,
    },
}

pub struct Inmp441 {
    pub pins: Pins,
    /// L/R pin high = right channel (default grounded = left)
    pub right: bool,
    pub source: MicSource,
    pub frames: u64,
}

impl Inmp441 {
    pub fn new(pins: Pins) -> Self {
        Inmp441 {
            pins,
            right: false,
            source: MicSource::Silence,
            frames: 0,
        }
    }

    /// Web page pushes live audio (rate = sample rate of the pushed data). Queue keeps at most 1 s
    pub fn push_live(&mut self, rate: f64, x: &[f32]) {
        if !matches!(&self.source, MicSource::Live { rate: r, .. } if *r == rate) {
            self.source = MicSource::Live {
                rate,
                fifo: VecDeque::new(),
                pos: 0.0,
                underruns: 0,
            };
        }
        if let MicSource::Live { fifo, .. } = &mut self.source {
            fifo.extend(x.iter().copied());
            let cap = rate.max(1.0) as usize;
            while fifo.len() > cap {
                fifo.pop_front();
            }
        }
    }

    fn level(&mut self, t: f64, step: f64) -> f32 {
        match &mut self.source {
            MicSource::Silence => 0.0,
            MicSource::Wav { rate, data } => {
                if data.is_empty() {
                    return 0.0;
                }
                let p = t / CPU_HZ as f64 * *rate;
                let i = p.floor();
                let fr = (p - i) as f32;
                let n = data.len();
                let a = data[(i as usize) % n];
                let b = data[(i as usize + 1) % n];
                a + (b - a) * fr
            }
            MicSource::Live {
                rate,
                fifo,
                pos,
                underruns,
            } => {
                // step: pushed samples per I2S frame
                let _ = rate;
                let v = match fifo.front() {
                    Some(v) => *v,
                    None => {
                        *underruns += 1;
                        0.0
                    }
                };
                *pos += step;
                while *pos >= 1.0 {
                    *pos -= 1.0;
                    fifo.pop_front();
                }
                v
            }
        }
    }

    /// Slot words for n frames: 24-bit two's complement left-aligned (low 8 bits 0); the silent slot is high-Z and reads 0
    pub fn slots(&mut self, t0: u64, rate: f64, n: usize) -> Vec<[i32; 2]> {
        let fc = CPU_HZ as f64 / rate;
        let step = match &self.source {
            MicSource::Live { rate: r, .. } => *r / rate,
            _ => 0.0,
        };
        let k = self.right as usize;
        self.frames += n as u64;
        (0..n)
            .map(|i| {
                let x = self
                    .level(t0 as f64 + i as f64 * fc, step)
                    .clamp(-1.0, 1.0 - 1.0 / 8_388_608.0);
                let v24 = (x as f64 * 8_388_608.0).round() as i32;
                let mut s = [0i32; 2];
                s[k] = v24 << 8;
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
    let mut p = 12;
    while p + 8 <= b.len() {
        let id = &b[p..p + 4];
        let len = u32::from_le_bytes(b[p + 4..p + 8].try_into().unwrap()) as usize;
        let body = &b[p + 8..(p + 8 + len).min(b.len())];
        match id {
            b"fmt " => fmt = Some(body),
            b"data" => data = Some(body),
            _ => {}
        }
        p += 8 + len + (len & 1);
    }
    let fmt = fmt.ok_or("missing fmt chunk")?;
    let data = data.ok_or("missing data chunk")?;
    if fmt.len() < 16 {
        return Err("fmt chunk too short".into());
    }
    let tag = u16::from_le_bytes([fmt[0], fmt[1]]);
    let ch = u16::from_le_bytes([fmt[2], fmt[3]]).max(1) as usize;
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
        if let Some(sp) = &self.speaker {
            let a = sp.analyze(1.0);
            let secs = match sp.first_t {
                Some(t0) => (sp.last_t - t0) as f64 / CPU_HZ as f64,
                None => 0.0,
            };
            s += &format!(
                "[tryboard] I2S speaker MAX98357A (BCLK=GPIO{} LRC=GPIO{} DIN=GPIO{}): got {} frames ({:.2}s), sample rate {:.1} Hz, last 1 s RMS {:.4}, peak {:.4}, freq {:.1} Hz\n",
                sp.pins.bclk, sp.pins.ws, sp.pins.data, sp.frames, secs, sp.rate, a.rms, a.peak, a.freq
            );
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
            s += &format!(
                "[tryboard] I2S mic INMP441 (SCK=GPIO{} WS=GPIO{} SD=GPIO{}, {} channel): sent {} frames, source {}\n",
                m.pins.bclk,
                m.pins.ws,
                m.pins.data,
                if m.right { "right" } else { "left" },
                m.frames,
                src
            );
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
}
