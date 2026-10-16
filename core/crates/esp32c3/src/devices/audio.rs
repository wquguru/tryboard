//! I2S 音频器件：MAX98357A（I2S 输入的 D 类功放 + 小喇叭）与 INMP441（I2S 输出的数字 MEMS 麦克风）。
//! 依据：MAX98357A 数据手册（Philips I2S、(L+R)/2 混音、增益 9 dB 档、静态电流 2.4 mA），
//! INMP441 数据手册（24 位、MSB 先、Philips 格式，L/R 脚选槽，另一槽高阻，工作电流 1.4 mA）。
//!
//! 两个器件只和 I2S 的"槽字"打交道（见 i2s.rs）：喇叭收到每帧左右槽字，麦克风给出每帧左右槽字。
//! 时间都是模拟时间（CPU 周期），喇叭输出带时间戳，网页按它对齐到 AudioContext 的时间轴。

use crate::i2s::I2sIo;
use crate::periph::CPU_HZ;
use std::collections::VecDeque;

/// 三根 I2S 线接在哪几个 GPIO（数据线：喇叭是 DIN，麦克风是 SD）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pins {
    pub bclk: u32,
    pub ws: u32,
    pub data: u32,
}

/// 喇叭输出的一段连续样本（单声道，16 位），t = 第一个样本的模拟时刻（周期）
#[derive(Clone, Debug, PartialEq)]
pub struct Block {
    pub t: u64,
    pub rate: f32,
    pub data: Vec<i16>,
}

/// 一段声音的读数
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Analysis {
    pub rate: f64,
    pub samples: usize,
    /// 满量程 = 1
    pub rms: f64,
    pub peak: f64,
    /// 主频（Hz）：去直流后相邻上升过零点线性插值；没有过零为 0
    pub freq: f64,
}

/// 读数：去直流、RMS、峰值、过零主频
pub fn analyze(x: &[f32], rate: f64) -> Analysis {
    if x.is_empty() || rate <= 0.0 {
        return Analysis::default();
    }
    let mean = x.iter().map(|v| *v as f64).sum::<f64>() / x.len() as f64;
    let mut sum = 0.0;
    let mut peak: f64 = 0.0;
    let (mut first, mut last, mut ups) = (-1.0f64, -1.0f64, 0usize);
    let mut prev = 0.0;
    // 过零加一点回差，免得静音时的舍入噪声算成过零
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

/// 分析用的历史样本上限（约 6 秒 @ 44.1 kHz）
const HIST_CAP: usize = 1 << 18;
/// 给网页取的样本上限（约 3 秒）：取得不及时就丢最老的
const QUEUE_CAP: usize = 1 << 17;

/// MAX98357A：(L+R)/2 混成单声道，增益 9 dB 档（GAIN 脚悬空），驱动 4Ω 喇叭
pub struct Max98357a {
    pub pins: Pins,
    pub queue: VecDeque<Block>,
    queued: usize,
    pub dropped: u64,
    hist: VecDeque<i16>,
    /// 最近一块的采样率、均方（满量程 = 1）
    pub rate: f64,
    pub recent_ms: f64,
    pub frames: u64,
    pub blocks: u64,
    pub first_t: Option<u64>,
    pub last_t: u64,
}

/// 0 dBFS 正弦在 9 dB 档的输出有效值（V）。估算：数据手册给的是增益而不是满量程电压，按 5 V 供电不削顶取 2.5 Vrms
pub const FS_VRMS: f64 = 2.5;
pub const SPEAKER_OHM: f64 = 4.0;
/// D 类效率（估算）与静态电流（数据手册 2.4 mA）
pub const EFFICIENCY: f64 = 0.85;
pub const AMP_IQ: f64 = 0.0024;
/// INMP441 工作电流（数据手册 1.4 mA）
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

    /// 取走攒下的输出（网页播放用）
    pub fn take(&mut self) -> Vec<Block> {
        self.queued = 0;
        self.queue.drain(..).collect()
    }

    /// 最近 secs 秒的读数
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

    /// 从 5 V 取的电流（A）：静态电流 + 输出功率 / (效率 × 5 V)
    pub fn supply_current(&self) -> f64 {
        let vrms = FS_VRMS * self.recent_ms.sqrt();
        AMP_IQ + vrms * vrms / SPEAKER_OHM / (EFFICIENCY * 5.0)
    }
}

/// 麦克风听到的声音
pub enum MicSource {
    /// 安静（只有 0）
    Silence,
    /// 固定 WAV（循环播放，按模拟时间取样：同一 WAV 每次运行读数一样）
    Wav { rate: f64, data: Vec<f32> },
    /// 外部实时推入（网页的浏览器麦克风）：按 I2S 帧率从队列里消耗，空了给 0
    Live {
        rate: f64,
        fifo: VecDeque<f32>,
        pos: f64,
        underruns: u64,
    },
}

pub struct Inmp441 {
    pub pins: Pins,
    /// L/R 脚接高 = 右声道（默认接地 = 左声道）
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

    /// 网页推入实时声音（rate = 推入数据的采样率）。队列最多留 1 秒
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
                // step：每个 I2S 帧对应多少个推入样本
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

    /// n 帧的槽字：24 位补码左对齐（低 8 位为 0），不说话的那个槽高阻读 0
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

/// 读 WAV（PCM 8/16/24/32 位整数或 32 位浮点，多声道取第一声道）→（采样率, -1..1 样本）
pub fn parse_wav(b: &[u8]) -> Result<(u32, Vec<f32>), String> {
    if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return Err("不是 RIFF/WAVE 文件".into());
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
    let fmt = fmt.ok_or("缺少 fmt 块")?;
    let data = data.ok_or("缺少 data 块")?;
    if fmt.len() < 16 {
        return Err("fmt 块太短".into());
    }
    let tag = u16::from_le_bytes([fmt[0], fmt[1]]);
    let ch = u16::from_le_bytes([fmt[2], fmt[3]]).max(1) as usize;
    let rate = u32::from_le_bytes(fmt[4..8].try_into().unwrap());
    let bits = u16::from_le_bytes([fmt[14], fmt[15]]) as usize;
    // WAVE_FORMAT_EXTENSIBLE：子格式 GUID 的头两个字节是真正的格式号
    let tag = if tag == 0xfffe && fmt.len() >= 26 {
        u16::from_le_bytes([fmt[24], fmt[25]])
    } else {
        tag
    };
    let bps = bits.div_ceil(8);
    if bps == 0 || rate == 0 {
        return Err("采样率或位宽为 0".into());
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
        return Err(format!("不支持的 WAV 格式 {tag}"));
    }
    Ok((rate, out))
}

/// 挂在 I2S 上的音频器件（外部世界，跨复位保留）
#[derive(Default)]
pub struct Audio {
    pub speaker: Option<Box<Max98357a>>,
    pub mic: Option<Box<Inmp441>>,
    /// I2S 在发数据、但喇叭的 DIN 不在那个口的数据输出上（接线不对）的帧数
    pub tx_unrouted: u64,
    /// I2S 在收、但数据输入没接到麦克风 SD 的帧数
    pub rx_unrouted: u64,
}

impl Audio {
    pub fn is_empty(&self) -> bool {
        self.speaker.is_none() && self.mic.is_none()
    }

    /// CLI / 网页共用的观察记录（`[tryboard] I2S …` 行）
    pub fn report(&self) -> String {
        let mut s = String::new();
        if let Some(sp) = &self.speaker {
            let a = sp.analyze(1.0);
            let secs = match sp.first_t {
                Some(t0) => (sp.last_t - t0) as f64 / CPU_HZ as f64,
                None => 0.0,
            };
            s += &format!(
                "[tryboard] I2S 喇叭 MAX98357A（BCLK=GPIO{} LRC=GPIO{} DIN=GPIO{}）：收到 {} 帧（{:.2}s），采样率 {:.1} Hz，最近 1 秒 RMS {:.4}、峰值 {:.4}、主频 {:.1} Hz\n",
                sp.pins.bclk, sp.pins.ws, sp.pins.data, sp.frames, secs, sp.rate, a.rms, a.peak, a.freq
            );
        }
        if let Some(m) = &self.mic {
            let src = match &m.source {
                MicSource::Silence => "安静".to_string(),
                MicSource::Wav { rate, data } => {
                    format!("WAV {} Hz {:.2}s 循环", rate, data.len() as f64 / rate)
                }
                MicSource::Live { underruns, .. } => format!("实时输入（欠载 {underruns} 帧）"),
            };
            s += &format!(
                "[tryboard] I2S 麦克风 INMP441（SCK=GPIO{} WS=GPIO{} SD=GPIO{}，{}声道）：送出 {} 帧，声源 {}\n",
                m.pins.bclk,
                m.pins.ws,
                m.pins.data,
                if m.right { "右" } else { "左" },
                m.frames,
                src
            );
        }
        if self.tx_unrouted > 0 {
            s += &format!(
                "[tryboard] I2S 接线：有 {} 帧发送数据没到喇叭（DIN 不在 I2S 数据输出上）\n",
                self.tx_unrouted
            );
        }
        if self.rx_unrouted > 0 {
            s += &format!(
                "[tryboard] I2S 接线：有 {} 帧接收数据不是来自麦克风（数据输入没选到 SD 脚）\n",
                self.rx_unrouted
            );
        }
        s
    }
}

/// 一个 I2S 口此刻接到了哪些器件（SoC 按 GPIO 矩阵算出）
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
        // 48 kHz 帧率、时刻 0 起：逐个样本对上，左槽有数据、右槽 0
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
        // 16 kHz 帧率：每帧吃掉 2 个推入样本
        let s = m.slots(0, 16000.0, 3);
        assert!(s[0][0] > 0 && s[1][0] < 0 && s[2][0] == 0);
        assert!(matches!(m.source, MicSource::Live { underruns: 1, .. }));
    }
}
