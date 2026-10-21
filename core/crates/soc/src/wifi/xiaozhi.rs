//! xiaozhi-style virtual voice server (F-09a-2, from the RS-2 §2 protocol notes): OTA reply, hello, scripted turns.
//! Pure state machine: WsIn events and time in, `Action`s out; World applies them through Net::ws_send.

use super::tcp::{Key, WsIn};
use super::ws::{OP_BINARY, OP_TEXT};

/// HTTP endpoints served from `Tcp::pages` while the server is on (exact paths)
pub const OTA_PATHS: [&str; 2] = ["/xiaozhi/ota/", "/xiaozhi/ota"];
pub const ACTIVATE_PATHS: [&str; 2] = ["/xiaozhi/ota/activate", "/xiaozhi/ota/activate/"];
/// WebSocket route prefix (pushed into `Tcp::ws_routes`)
pub const WS_PATH: &str = "/xiaozhi/v1/";
pub const WS_URL: &str = "ws://tryboard.local/xiaozhi/v1/";
pub const TOKEN: &str = "tryboard-virtual-token";
/// Downlink frame length (and pacing), us
pub const FRAME_US: u64 = 60_000;
/// listen stop -> stt, and stt -> tts start (server "thinking" time, fixed so runs are reproducible)
pub const STT_DELAY_US: u64 = 100_000;
pub const TTS_DELAY_US: u64 = 200_000;
/// TOC byte: config 11 (SILK-only wideband, 60 ms), mono, one frame (RFC 6716 §3.1)
pub const TOC_SILK_WB_60MS: u8 = 11 << 3;

/// Built-in downlink clip (F-09b-1): our own formant-synthesized voice, 21 Opus packets (16 kHz, 60 ms, SILK WB),
/// each prefixed by a u16 LE length; regenerate with tools/audio/gen_xz_voice.py
pub const VOICE_DEMO: &[u8] = include_bytes!("xz_voice.bin");
/// Names for `xz=voice,<name>`: `noise` = synthesized LCG frames sized by the sentence (default), `demo` = VOICE_DEMO
pub const VOICES: [&str; 2] = ["noise", "demo"];

/// Unpack a length-prefixed packet list; None if it is truncated
pub fn unpack_frames(b: &[u8]) -> Option<Vec<Vec<u8>>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let n = u16::from_le_bytes([b[i], *b.get(i + 1)?]) as usize;
        out.push(b.get(i + 2..i + 2 + n)?.to_vec());
        i += 2 + n;
    }
    Some(out)
}

/// Downlink frames for a voice name (None = synthesized noise frames); Err for an unknown name
pub fn voice_frames(name: &str) -> Result<Option<Vec<Vec<u8>>>, ()> {
    match name {
        "noise" => Ok(None),
        "demo" => Ok(unpack_frames(VOICE_DEMO)),
        _ => Err(()),
    }
}

/// OTA reply body (RS-2 §2): no `activation` object, so the device counts as activated; firmware version 0.0.0 never upgrades
pub fn ota_body() -> String {
    format!(
        "{{\"server_time\":{{\"timestamp\":1792123200000,\"timezone_offset\":480}},\"firmware\":{{\"version\":\"0.0.0\",\"url\":\"\"}},\"websocket\":{{\"url\":\"{WS_URL}\",\"token\":\"{TOKEN}\",\"version\":1}}}}\n"
    )
}

/// One built-in conversation script
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Script {
    pub name: &'static str,
    /// What the "speech recognizer" claims the user said
    pub stt: &'static str,
    pub emotion: &'static str,
    /// Spoken answer, one entry per sentence
    pub reply: &'static [&'static str],
    /// Answer the device hello (false = the "server never replies" case for timeout tests)
    pub hello: bool,
}

pub const SCRIPTS: &[Script] = &[
    Script {
        name: "hello",
        stt: "Hello",
        emotion: "happy",
        reply: &["Hi, I am the TryBoard virtual assistant."],
        hello: true,
    },
    Script {
        name: "weather",
        stt: "What is the weather today?",
        emotion: "neutral",
        reply: &["It is sunny today.", "The high is 23 degrees."],
        hello: true,
    },
    Script {
        name: "silent",
        stt: "",
        emotion: "neutral",
        reply: &[],
        hello: false,
    },
];

/// Script action after `xz=`
#[derive(Clone, Debug, PartialEq)]
pub enum Cmd {
    On,
    Off,
    Script(String),
    Say(String),
    /// Uplink frames needed before a listen stop gets an answer
    Min(u32),
    /// Downlink audio, one of VOICES (F-09b-1)
    Voice(String),
}

impl Cmd {
    pub fn parse(s: &str) -> Option<Cmd> {
        let s = s.trim();
        let (k, v) = s.split_once(',').unwrap_or((s, ""));
        match k.trim() {
            "on" | "1" => Some(Cmd::On),
            "off" | "0" => Some(Cmd::Off),
            "script" => Some(Cmd::Script(v.trim().to_string())),
            "say" => Some(Cmd::Say(v.to_string())),
            "min" => v.trim().parse().ok().map(Cmd::Min),
            "voice" => Some(Cmd::Voice(v.trim().to_string())),
            _ => None,
        }
    }
}

/// What the server wants done
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Send { key: Key, op: u8, data: Vec<u8> },
    Log(String),
}

struct Session {
    key: Key,
    id: String,
    hello: bool,
    listening: bool,
    up: u32,
}

struct Due {
    at: u64,
    key: Key,
    op: u8,
    data: Vec<u8>,
    note: Option<String>,
}

pub struct Server {
    pub script: Script,
    pub min_frames: u32,
    /// Downlink Opus packets per sentence; None = synthesized frames sized by the sentence length
    pub frames: Option<Vec<Vec<u8>>>,
    sessions: Vec<Session>,
    queue: Vec<Due>,
    /// say= texts waiting for a session that finished hello
    said: Vec<String>,
    opened: u32,
    seed: u32,
    /// Totals for the end-of-run summary
    pub turns: u32,
    pub up_frames: u32,
    pub down_frames: u32,
    /// (time us, line) for the CLI summary
    pub log: Vec<(u64, String)>,
}

impl Default for Server {
    fn default() -> Self {
        Server {
            script: SCRIPTS[0],
            min_frames: 5,
            frames: None,
            sessions: Vec::new(),
            queue: Vec::new(),
            said: Vec::new(),
            opened: 0,
            seed: 0x7259_0001,
            turns: 0,
            up_frames: 0,
            down_frames: 0,
            log: Vec::new(),
        }
    }
}

/// Escape a string for a JSON literal
pub fn json_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o
}

/// String value of a top-level-ish `"key": "value"` in a small JSON object (first match; enough for device messages)
pub fn json_str(s: &str, key: &str) -> Option<String> {
    let pat = format!("\"{key}\"");
    let mut from = 0;
    while let Some(p) = s[from..].find(&pat) {
        let rest = s[from + p + pat.len()..].trim_start();
        from += p + pat.len();
        let Some(rest) = rest.strip_prefix(':') else {
            continue;
        };
        let rest = rest.trim_start().strip_prefix('"')?;
        let mut out = String::new();
        let mut it = rest.chars();
        while let Some(c) = it.next() {
            match c {
                '"' => return Some(out),
                '\\' => match it.next()? {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    'r' => out.push('\r'),
                    c => out.push(c),
                },
                c => out.push(c),
            }
        }
        return None;
    }
    None
}

impl Server {
    pub fn script_by_name(name: &str) -> Option<Script> {
        SCRIPTS.iter().copied().find(|s| s.name == name)
    }

    fn note(&mut self, now: u64, s: String) -> Action {
        self.log.push((now, s.clone()));
        Action::Log(s)
    }

    fn push(&mut self, at: u64, key: Key, op: u8, data: Vec<u8>, note: Option<String>) {
        self.queue.push(Due {
            at,
            key,
            op,
            data,
            note,
        });
    }

    fn text(&mut self, at: u64, key: Key, json: String, note: Option<String>) {
        self.push(at, key, OP_TEXT, json.into_bytes(), note);
    }

    /// Synthesized Opus packet: SILK WB 60 ms TOC + bytes from a fixed LCG (decodes to noise, never errors; deterministic)
    fn synth_frame(&mut self) -> Vec<u8> {
        let mut f = vec![TOC_SILK_WB_60MS];
        for _ in 0..40 {
            self.seed = self
                .seed
                .wrapping_mul(1_664_525)
                .wrapping_add(1_013_904_223);
            f.push((self.seed >> 24) as u8);
        }
        f
    }

    /// Queue one spoken answer starting at `t`; returns when tts stop goes out
    fn speak(&mut self, key: Key, sid: &str, sentences: &[String], mut t: u64) -> u64 {
        let sid = json_escape(sid);
        self.text(
            t,
            key,
            format!("{{\"type\":\"tts\",\"state\":\"start\",\"session_id\":\"{sid}\"}}"),
            Some("tts start".into()),
        );
        for s in sentences {
            let e = json_escape(s);
            self.text(
                t,
                key,
                format!("{{\"type\":\"tts\",\"state\":\"sentence_start\",\"text\":\"{e}\",\"session_id\":\"{sid}\"}}"),
                Some(format!("tts sentence_start \"{s}\"")),
            );
            let frames = match &self.frames {
                Some(f) => f.clone(),
                None => {
                    let n = s.chars().count().div_ceil(2).clamp(5, 50);
                    (0..n).map(|_| self.synth_frame()).collect()
                }
            };
            let n = frames.len();
            for (i, f) in frames.into_iter().enumerate() {
                let note = (i == 0).then(|| format!("{n} Opus frames, one every 60 ms"));
                self.push(t, key, OP_BINARY, f, note);
                t += FRAME_US;
            }
        }
        self.text(
            t,
            key,
            format!("{{\"type\":\"tts\",\"state\":\"stop\",\"session_id\":\"{sid}\"}}"),
            Some("tts stop".into()),
        );
        t
    }

    /// One WebSocket event from tcp.rs (only routes under WS_PATH reach the inbox)
    pub fn on_ws(&mut self, ev: WsIn, now: u64) -> Vec<Action> {
        let mut out = Vec::new();
        match ev {
            WsIn::Open { key, path, head } => {
                self.opened += 1;
                let id = format!("tb-{:04}", self.opened);
                let tok = head
                    .split("\r\n")
                    .find_map(|l| {
                        let (k, v) = l.split_once(':')?;
                        k.trim()
                            .eq_ignore_ascii_case("authorization")
                            .then(|| v.trim().to_string())
                    })
                    .unwrap_or_else(|| "none".into());
                let pv = head
                    .split("\r\n")
                    .find_map(|l| {
                        let (k, v) = l.split_once(':')?;
                        k.trim()
                            .eq_ignore_ascii_case("protocol-version")
                            .then(|| v.trim().to_string())
                    })
                    .unwrap_or_else(|| "1".into());
                out.push(self.note(
                    now,
                    format!("open {path} (Authorization {tok}, Protocol-Version {pv})"),
                ));
                if pv != "1" {
                    out.push(self.note(
                        now,
                        format!("Protocol-Version {pv} not modelled, binary frames stay bare Opus"),
                    ));
                }
                self.sessions.retain(|s| s.key != key);
                self.sessions.push(Session {
                    key,
                    id,
                    hello: false,
                    listening: false,
                    up: 0,
                });
            }
            WsIn::Closed { key, code } => {
                self.sessions.retain(|s| s.key != key);
                self.queue.retain(|d| d.key != key);
                out.push(self.note(now, format!("closed {code}")));
            }
            WsIn::Msg { key, op, data } => {
                let Some(si) = self.sessions.iter().position(|s| s.key == key) else {
                    return out;
                };
                if op == OP_BINARY {
                    let s = &mut self.sessions[si];
                    if s.listening && !data.is_empty() {
                        s.up += 1;
                        self.up_frames += 1;
                    }
                    return out;
                }
                if op != OP_TEXT {
                    return out;
                }
                let msg = String::from_utf8_lossy(&data).into_owned();
                let ty = json_str(&msg, "type").unwrap_or_default();
                match ty.as_str() {
                    "hello" => {
                        out.push(self.note(now, "device hello".into()));
                        if !self.script.hello {
                            out.push(self.note(now, "script silent: no hello reply".into()));
                            return out;
                        }
                        let sid = self.sessions[si].id.clone();
                        self.sessions[si].hello = true;
                        self.text(
                            now,
                            key,
                            format!("{{\"type\":\"hello\",\"transport\":\"websocket\",\"session_id\":\"{sid}\",\"audio_params\":{{\"format\":\"opus\",\"sample_rate\":16000,\"channels\":1,\"frame_duration\":60}}}}"),
                            Some(format!("hello reply session {sid}, downlink opus 16000 Hz 60 ms")),
                        );
                        let said = std::mem::take(&mut self.said);
                        for s in said {
                            self.speak(key, &sid, &[s], now);
                        }
                    }
                    "listen" => {
                        let state = json_str(&msg, "state").unwrap_or_default();
                        match state.as_str() {
                            "start" => {
                                let s = &mut self.sessions[si];
                                s.listening = true;
                                s.up = 0;
                                let mode = json_str(&msg, "mode").unwrap_or_else(|| "?".into());
                                out.push(self.note(now, format!("listen start ({mode})")));
                            }
                            "stop" => {
                                let s = &mut self.sessions[si];
                                let n = s.up;
                                let was = std::mem::replace(&mut s.listening, false);
                                if !was || n < self.min_frames {
                                    let m = self.min_frames;
                                    out.push(self.note(
                                        now,
                                        format!("listen stop after {n} frames (< {m}): no answer"),
                                    ));
                                } else {
                                    out.push(
                                        self.note(now, format!("listen stop after {n} frames")),
                                    );
                                    self.turn(si, now);
                                }
                            }
                            "detect" => {
                                let t = json_str(&msg, "text").unwrap_or_default();
                                out.push(self.note(now, format!("wake word \"{t}\"")));
                            }
                            _ => out.push(self.note(now, format!("listen {state}"))),
                        }
                    }
                    "abort" => {
                        let had = self.queue.iter().any(|d| d.key == key);
                        self.queue.retain(|d| d.key != key);
                        out.push(self.note(now, "abort".into()));
                        if had {
                            let sid = self.sessions[si].id.clone();
                            self.text(
                                now,
                                key,
                                format!(
                                    "{{\"type\":\"tts\",\"state\":\"stop\",\"session_id\":\"{sid}\"}}"
                                ),
                                Some("tts stop (aborted)".into()),
                            );
                        }
                    }
                    t => {
                        let t = if t.is_empty() { "?" } else { t };
                        out.push(self.note(now, format!("device message type {t} ignored")));
                    }
                }
            }
        }
        out
    }

    /// Scripted answer to one listen stop
    fn turn(&mut self, si: usize, now: u64) {
        let (key, sid) = (self.sessions[si].key, self.sessions[si].id.clone());
        let sc = self.script;
        self.turns += 1;
        let t = now + STT_DELAY_US;
        let e = json_escape(sc.stt);
        self.text(
            t,
            key,
            format!("{{\"type\":\"stt\",\"text\":\"{e}\",\"session_id\":\"{sid}\"}}"),
            Some(format!("stt \"{}\"", sc.stt)),
        );
        self.text(
            t,
            key,
            format!(
                "{{\"type\":\"llm\",\"emotion\":\"{}\",\"session_id\":\"{sid}\"}}",
                sc.emotion
            ),
            None,
        );
        let sentences: Vec<String> = sc.reply.iter().map(|s| s.to_string()).collect();
        self.speak(key, &sid, &sentences, t + TTS_DELAY_US);
    }

    /// Script action `say`: speak on every session past hello, or wait for the next one
    pub fn say(&mut self, text: &str, now: u64) -> Vec<Action> {
        let ready: Vec<(Key, String)> = self
            .sessions
            .iter()
            .filter(|s| s.hello)
            .map(|s| (s.key, s.id.clone()))
            .collect();
        if ready.is_empty() {
            self.said.push(text.to_string());
            return vec![self.note(now, format!("say \"{text}\" queued until hello"))];
        }
        let out = vec![self.note(now, format!("say \"{text}\""))];
        for (k, sid) in ready {
            self.speak(k, &sid, &[text.to_string()], now);
        }
        out
    }

    /// Board reset: every connection is gone without a close; script and settings stay
    pub fn chip_reset(&mut self) {
        self.sessions.clear();
        self.queue.clear();
    }

    /// Connections with a live session
    pub fn keys(&self) -> Vec<Key> {
        self.sessions.iter().map(|s| s.key).collect()
    }

    pub fn next_timer(&self) -> Option<u64> {
        self.queue.iter().map(|d| d.at).min()
    }

    /// Everything due by `now`, in schedule order (stable for equal times)
    pub fn poll(&mut self, now: u64) -> Vec<Action> {
        let mut due: Vec<Due> = Vec::new();
        let mut i = 0;
        while i < self.queue.len() {
            if self.queue[i].at <= now {
                due.push(self.queue.remove(i));
            } else {
                i += 1;
            }
        }
        due.sort_by_key(|d| d.at);
        let mut out = Vec::new();
        for d in due {
            if d.op == OP_BINARY {
                self.down_frames += 1;
            }
            if let Some(n) = d.note {
                out.push(self.note(d.at, n));
            }
            out.push(Action::Send {
                key: d.key,
                op: d.op,
                data: d.data,
            });
        }
        out
    }

    /// One-line summary for the CLI
    pub fn summary(&self) -> String {
        format!(
            "xiaozhi server: script {}, {} sessions, {} turns, {} uplink frames, {} downlink frames",
            self.script.name, self.opened, self.turns, self.up_frames, self.down_frames
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const K: Key = ([192, 168, 4, 100], 50000, [192, 168, 4, 1], 80);
    const K2: Key = ([192, 168, 4, 100], 50001, [192, 168, 4, 1], 80);

    fn open(s: &mut Server, k: Key, now: u64) {
        s.on_ws(
            WsIn::Open {
                key: k,
                path: WS_PATH.into(),
                head: "GET /xiaozhi/v1/ HTTP/1.1\r\nAuthorization: Bearer x\r\nProtocol-Version: 1\r\n".into(),
            },
            now,
        );
    }

    fn txt(s: &mut Server, k: Key, j: &str, now: u64) -> Vec<Action> {
        s.on_ws(
            WsIn::Msg {
                key: k,
                op: OP_TEXT,
                data: j.as_bytes().to_vec(),
            },
            now,
        )
    }

    fn bin(s: &mut Server, k: Key, n: u32, now: u64) {
        for _ in 0..n {
            s.on_ws(
                WsIn::Msg {
                    key: k,
                    op: OP_BINARY,
                    data: vec![TOC_SILK_WB_60MS, 1, 2],
                },
                now,
            );
        }
    }

    /// Run the queue to the end: (time, op, text or "<bin N>")
    fn drain(s: &mut Server) -> Vec<(u64, u8, String)> {
        let mut v = Vec::new();
        while let Some(t) = s.next_timer() {
            for a in s.poll(t) {
                if let Action::Send { op, data, .. } = a {
                    let d = if op == OP_TEXT {
                        String::from_utf8(data).unwrap()
                    } else {
                        format!("<bin {}>", data.len())
                    };
                    v.push((t, op, d));
                }
            }
        }
        v
    }

    fn hello(s: &mut Server, k: Key, now: u64) -> Vec<(u64, u8, String)> {
        open(s, k, now);
        txt(
            s,
            k,
            r#"{"type":"hello","version":1,"transport":"websocket","audio_params":{"format":"opus","sample_rate":16000,"channels":1,"frame_duration":60}}"#,
            now,
        );
        drain(s)
    }

    #[test]
    fn hello_reply_has_session_and_audio_params() {
        let mut s = Server::default();
        let v = hello(&mut s, K, 1000);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].0, 1000, "answered at once");
        assert_eq!(
            v[0].2,
            r#"{"type":"hello","transport":"websocket","session_id":"tb-0001","audio_params":{"format":"opus","sample_rate":16000,"channels":1,"frame_duration":60}}"#
        );
        assert_eq!(json_str(&v[0].2, "session_id").as_deref(), Some("tb-0001"));
    }

    #[test]
    fn turn_order_and_60ms_cadence() {
        let mut s = Server::default();
        hello(&mut s, K, 0);
        txt(
            &mut s,
            K,
            r#"{"type":"listen","state":"start","mode":"manual"}"#,
            1_000_000,
        );
        bin(&mut s, K, 8, 1_200_000);
        txt(&mut s, K, r#"{"type":"listen","state":"stop"}"#, 1_500_000);
        let v = drain(&mut s);
        let kinds: Vec<String> = v
            .iter()
            .map(|(_, op, d)| {
                if *op == OP_BINARY {
                    "bin".into()
                } else {
                    let t = json_str(d, "type").unwrap();
                    json_str(d, "state").map_or(t.clone(), |st| format!("{t}:{st}"))
                }
            })
            .collect();
        let nb = kinds.iter().filter(|k| *k == "bin").count();
        let mut want = vec!["stt", "llm", "tts:start", "tts:sentence_start"];
        want.extend(std::iter::repeat_n("bin", nb));
        want.push("tts:stop");
        assert_eq!(kinds, want);
        // "Hi, I am the TryBoard virtual assistant." = 40 chars -> 20 frames
        assert_eq!(nb, 20);
        assert_eq!(v[0].0, 1_500_000 + STT_DELAY_US);
        assert!(v[0].2.contains("\"text\":\"Hello\""));
        let t0 = 1_500_000 + STT_DELAY_US + TTS_DELAY_US;
        let bins: Vec<u64> = v.iter().filter(|e| e.1 == OP_BINARY).map(|e| e.0).collect();
        for (i, t) in bins.iter().enumerate() {
            assert_eq!(*t, t0 + i as u64 * FRAME_US, "frame {i}");
        }
        assert_eq!(
            v.last().unwrap().0,
            t0 + 20 * FRAME_US,
            "stop one frame after the last"
        );
        assert_eq!((s.turns, s.up_frames, s.down_frames), (1, 8, 20));
        // Frames are SILK WB 60 ms and deterministic across servers
        let mut s2 = Server::default();
        assert_eq!(s2.synth_frame()[0], TOC_SILK_WB_60MS);
        let a = Server::default().synth_frame();
        assert_eq!(a, Server::default().synth_frame());
    }

    #[test]
    fn late_poll_keeps_schedule() {
        // poll also runs for beacons: a late wake sends what is due, the next frames keep their slots
        let mut s = Server::default();
        hello(&mut s, K, 0);
        s.say("abcdefghij", 0);
        let sent = s.poll(130_000);
        let bins = sent
            .iter()
            .filter(|a| matches!(a, Action::Send { op: OP_BINARY, .. }))
            .count();
        assert_eq!(bins, 3, "frames at 0, 60, 120 ms");
        assert_eq!(s.next_timer(), Some(180_000));
    }

    #[test]
    fn below_threshold_gets_no_answer() {
        let mut s = Server::default();
        hello(&mut s, K, 0);
        txt(
            &mut s,
            K,
            r#"{"type":"listen","state":"start","mode":"auto"}"#,
            10,
        );
        bin(&mut s, K, 4, 20);
        let a = txt(&mut s, K, r#"{"type":"listen","state":"stop"}"#, 30);
        assert!(a.contains(&Action::Log(
            "listen stop after 4 frames (< 5): no answer".into()
        )));
        assert_eq!(s.next_timer(), None);
        // Frames outside listen start..stop do not count
        bin(&mut s, K, 9, 40);
        txt(
            &mut s,
            K,
            r#"{"type":"listen","state":"start","mode":"auto"}"#,
            50,
        );
        bin(&mut s, K, 5, 60);
        txt(&mut s, K, r#"{"type":"listen","state":"stop"}"#, 70);
        assert!(!drain(&mut s).is_empty(), "5 frames reach the threshold");
        s.min_frames = 1;
        assert_eq!(Cmd::parse("min,3"), Some(Cmd::Min(3)));
    }

    #[test]
    fn say_before_and_after_hello() {
        let mut s = Server::default();
        let a = s.say("Wake up", 0);
        assert_eq!(
            a,
            vec![Action::Log("say \"Wake up\" queued until hello".into())]
        );
        let v = hello(&mut s, K, 500);
        assert_eq!(json_str(&v[0].2, "type").as_deref(), Some("hello"));
        assert!(v[2].2.contains("\"text\":\"Wake up\""));
        // 7 chars -> min 5 frames, then stop
        assert_eq!(v.iter().filter(|e| e.1 == OP_BINARY).count(), 5);
        s.say("Again \"quoted\"", 2_000_000);
        let v = drain(&mut s);
        assert_eq!(v[0].0, 2_000_000);
        assert!(v[1].2.contains(r#""text":"Again \"quoted\"""#));
        assert_eq!(Cmd::parse("say,a, b"), Some(Cmd::Say("a, b".into())));
    }

    #[test]
    fn close_drops_queue_and_reconnect_gets_new_session() {
        let mut s = Server::default();
        hello(&mut s, K, 0);
        s.say("one two three four five six", 0);
        s.poll(0);
        assert!(s.next_timer().is_some());
        s.on_ws(WsIn::Closed { key: K, code: 1006 }, 70_000);
        assert_eq!(s.next_timer(), None, "nothing left for a closed connection");
        let v = hello(&mut s, K2, 1_000_000);
        assert_eq!(json_str(&v[0].2, "session_id").as_deref(), Some("tb-0002"));
        // Board reset: sessions dropped without a close
        s.say("x", 1_000_000);
        s.chip_reset();
        assert_eq!(s.next_timer(), None);
        assert!(s.say("y", 2_000_000)[0] == Action::Log("say \"y\" queued until hello".into()));
    }

    #[test]
    fn abort_stops_speaking_and_silent_script() {
        let mut s = Server::default();
        hello(&mut s, K, 0);
        s.say("a long sentence to be cut short", 0);
        s.poll(60_000);
        txt(&mut s, K, r#"{"type":"abort"}"#, 70_000);
        let v = drain(&mut s);
        assert_eq!(v.len(), 1);
        assert_eq!(
            (v[0].0, json_str(&v[0].2, "state").as_deref()),
            (70_000, Some("stop"))
        );
        let mut q = Server {
            script: Server::script_by_name("silent").unwrap(),
            ..Default::default()
        };
        assert!(hello(&mut q, K, 0).is_empty(), "silent never answers hello");
        assert_eq!(
            Cmd::parse("script,weather"),
            Some(Cmd::Script("weather".into()))
        );
        assert_eq!(Cmd::parse("bogus"), None);
        assert_eq!(Cmd::parse("voice,demo"), Some(Cmd::Voice("demo".into())));
    }

    #[test]
    fn demo_voice_is_silk_wb_60ms() {
        let f = voice_frames("demo").unwrap().unwrap();
        assert_eq!(f.len(), 21);
        assert!(f.iter().all(|p| !p.is_empty() && p[0] == TOC_SILK_WB_60MS));
        assert_eq!(voice_frames("noise"), Ok(None));
        assert!(voice_frames("x").is_err());
        assert_eq!(unpack_frames(&[3, 0, 1]), None);
        // A whole turn with the clip: one sentence = 21 frames, still 60 ms apart
        let mut s = Server {
            frames: voice_frames("demo").unwrap(),
            ..Server::default()
        };
        hello(&mut s, K, 0);
        s.say("hi", 1_000_000);
        let bins: Vec<_> = drain(&mut s).into_iter().filter(|(_, op, _)| *op == OP_BINARY).collect();
        assert_eq!(bins.len(), 21);
        assert_eq!(bins[20].0 - bins[0].0, 20 * FRAME_US);
    }

    #[test]
    fn ota_body_points_at_ws() {
        let b = ota_body();
        assert_eq!(json_str(&b, "url").as_deref(), Some(""));
        assert!(b.contains("\"websocket\":{\"url\":\"ws://tryboard.local/xiaozhi/v1/\",\"token\":\"tryboard-virtual-token\""));
    }
}
