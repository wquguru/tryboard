//! FreeRTOS task timeline (C-04): per-core task switches stamped in CPU cycles; one per C3 / S3 SocBus. Needs only flash.bin, no ELF (DECISIONS 2026-10-19).
//! Both ports end a switch with SP loaded from word 0 of the new TCB (RISC-V `lw sp, 0(a0)` in rtos_int_exit, Xtensa `l32i a1, aN, 0`); the core reports
//! the base (`Bus::sp_loaded`). TCB signature: both list items' pvOwner point back (TCB+16, +36), printable NUL-ended name at +52; ISR-stack loads fail it
//! (rechecked every time, memory may become a TCB later). Outgoing state: state item still on its ready list -> preempted; event item linked -> waiting on
//! queue / semaphore; else delayed / notified / suspended. Stamp = the SP-load instruction; ISR time is billed to the interrupted task. (lint: allow-long-comment)

use std::collections::HashMap;

/// Default cap: 65536 x 16 bytes = 1MB (web drains each time slice, CLI every 1ms)
pub const DEFAULT_CAP: usize = 1 << 16;

/// No task running (boot, after reset)
pub const NO_TASK: u16 = 0xffff;

/// TCB layout of IDF v5.5 FreeRTOS (no MPU wrappers, no list integrity bytes)
pub mod tcb {
    /// xStateListItem.pvOwner
    pub const STATE_OWNER: u32 = 16;
    /// xStateListItem.pxContainer
    pub const STATE_LIST: u32 = 20;
    /// xEventListItem.pvOwner
    pub const EVENT_OWNER: u32 = 36;
    /// xEventListItem.pxContainer
    pub const EVENT_LIST: u32 = 40;
    pub const PRIORITY: u32 = 44;
    pub const STACK: u32 = 48;
    pub const NAME: u32 = 52;
    pub const NAME_LEN: u32 = 16;
    /// On dual core xCoreID follows the name (pinned core, 0x7fffffff = unpinned)
    pub const CORE_ID: u32 = 68;
}

/// State of the outgoing task (event's prev field)
pub mod state {
    /// No outgoing task (first switch on this core)
    pub const NONE: u8 = 0;
    /// Preempted: still on the ready list
    pub const READY: u8 = 1;
    /// Waiting on a queue / semaphore / event group (event list item linked)
    pub const WAIT: u8 = 2;
    /// Delayed, waiting for a notification or suspended
    pub const BLOCKED: u8 = 3;
    /// TCB no longer looks like one (task deleted, memory reused)
    pub const GONE: u8 = 4;

    pub fn name(s: u8) -> &'static str {
        match s {
            READY => "ready",
            WAIT => "wait",
            BLOCKED => "blocked",
            GONE => "gone",
            _ => "-",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskInfo {
    pub tcb: u32,
    pub name: String,
    pub prio: u32,
    /// Pinned core; -1 = unpinned or single core
    pub affinity: i32,
}

/// One switch, 16 bytes LE: t u64 | core u8 | prev u8 | task u16 | pc u32  (lint: allow-long-comment)
/// - task: incoming task (index into `TaskTrace::tasks`), NO_TASK = no task on the core (reset)
/// - prev: outgoing task's state now (`state::*`)
/// - pc: where the incoming task resumes (PC saved in its frame; an ELF maps it to a function)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct TaskEvent {
    pub t: u64,
    pub core: u8,
    pub prev: u8,
    pub task: u16,
    pub pc: u32,
}

impl TaskEvent {
    pub const BYTES: usize = 16;

    pub fn to_bytes(&self) -> [u8; 16] {
        let mut o = [0u8; 16];
        o[..8].copy_from_slice(&self.t.to_le_bytes());
        o[8] = self.core;
        o[9] = self.prev;
        o[10..12].copy_from_slice(&self.task.to_le_bytes());
        o[12..16].copy_from_slice(&self.pc.to_le_bytes());
        o
    }
}

pub struct TaskTrace {
    /// 0 = don't record (CLI without --trace-tasks)
    pub cap: usize,
    pub buf: Vec<TaskEvent>,
    pub dropped: u64,
    pub tasks: Vec<TaskInfo>,
    /// Offset of the saved PC in the stack frame: RISC-V RV_STK_MEPC = 0, Xtensa XT_STK_PC / XT_SOL_PC = 4
    pub pc_off: u32,
    /// TCB running on each core (0 = none)
    cur: [u32; 2],
    by_tcb: HashMap<u32, u16>,
    /// List a task's state item sits on while running (= its priority's ready list)
    ready_list: HashMap<u32, u32>,
}

impl TaskTrace {
    pub fn new(pc_off: u32) -> Self {
        TaskTrace {
            cap: 0,
            buf: Vec::new(),
            dropped: 0,
            tasks: Vec::new(),
            pc_off,
            cur: [0; 2],
            by_tcb: HashMap::new(),
            ready_list: HashMap::new(),
        }
    }

    /// Read a TCB name: NUL-terminated, all printable ASCII, at least one character
    fn name_at(rd: &dyn Fn(u32) -> Option<u32>, t: u32) -> Option<String> {
        let mut s = String::new();
        for i in 0..tcb::NAME_LEN / 4 {
            let w = rd(t + tcb::NAME + i * 4)?;
            for b in w.to_le_bytes() {
                if b == 0 {
                    return (!s.is_empty()).then_some(s);
                }
                if !(0x20..0x7f).contains(&b) {
                    return None;
                }
                s.push(b as char);
            }
        }
        // Name exactly 16 bytes with no NUL (configMAX_TASK_NAME_LEN truncation always leaves one; be lenient)
        Some(s)
    }

    /// Does the base look like a TCB: both list items' pvOwner point back, name readable
    pub fn probe(rd: &dyn Fn(u32) -> Option<u32>, t: u32) -> Option<String> {
        if t & 3 != 0 || t == 0 {
            return None;
        }
        if rd(t + tcb::STATE_OWNER)? != t || rd(t + tcb::EVENT_OWNER)? != t {
            return None;
        }
        Self::name_at(rd, t)
    }

    /// SP was just loaded from `base` (see module docs). `dual` = dual-core chip (TCB has xCoreID)
    pub fn on_sp_load(
        &mut self,
        core: u32,
        base: u32,
        now: u64,
        dual: bool,
        rd: &dyn Fn(u32) -> Option<u32>,
    ) {
        if self.cap == 0 {
            return;
        }
        let core = (core as usize).min(1);
        // Bases failing the signature (xIsrStackTop etc.) are rechecked each time: the memory may later hold a new TCB
        if self.cur[core] == base {
            return;
        }
        let Some(name) = Self::probe(rd, base) else {
            return;
        };
        let prio = rd(base + tcb::PRIORITY).unwrap_or(0);
        let affinity = if dual {
            match rd(base + tcb::CORE_ID).unwrap_or(0x7fff_ffff) {
                c @ (0 | 1) => c as i32,
                _ => -1,
            }
        } else {
            -1
        };
        // Same TCB address with a new name = old task deleted, memory reused: start a new entry
        let idx = match self.by_tcb.get(&base) {
            Some(&i) if self.tasks[i as usize].name == name => {
                self.tasks[i as usize].prio = prio;
                i
            }
            _ => {
                let i = self.tasks.len().min(NO_TASK as usize - 1) as u16;
                if (i as usize) == self.tasks.len() {
                    self.tasks.push(TaskInfo {
                        tcb: base,
                        name,
                        prio,
                        affinity,
                    });
                }
                self.by_tcb.insert(base, i);
                i
            }
        };
        let prev = match self.cur[core] {
            0 => state::NONE,
            out => self.out_state(out, rd),
        };
        if let Some(l) = rd(base + tcb::STATE_LIST) {
            self.ready_list.insert(base, l);
        }
        self.cur[core] = base;
        let sp = rd(base).unwrap_or(0);
        let pc = rd(sp.wrapping_add(self.pc_off)).unwrap_or(0);
        self.push(TaskEvent {
            t: now,
            core: core as u8,
            prev,
            task: idx,
            pc,
        });
    }

    fn out_state(&self, out: u32, rd: &dyn Fn(u32) -> Option<u32>) -> u8 {
        if Self::probe(rd, out).is_none() {
            return state::GONE;
        }
        let list = rd(out + tcb::STATE_LIST).unwrap_or(0);
        if list != 0 && self.ready_list.get(&out) == Some(&list) {
            state::READY
        } else if rd(out + tcb::EVENT_LIST).unwrap_or(0) != 0 {
            state::WAIT
        } else {
            state::BLOCKED
        }
    }

    fn push(&mut self, e: TaskEvent) {
        if self.buf.len() >= self.cap {
            self.dropped += 1;
            return;
        }
        self.buf.push(e);
    }

    pub fn take(&mut self) -> Vec<TaskEvent> {
        std::mem::take(&mut self.buf)
    }

    /// Move to the new bus after a software reset: events and task table kept (timeline continues), no task on any core
    pub fn carry(&mut self, now: u64) -> TaskTrace {
        for c in 0..2 {
            if self.cur[c] != 0 {
                let e = TaskEvent {
                    t: now,
                    core: c as u8,
                    prev: state::GONE,
                    task: NO_TASK,
                    pc: 0,
                };
                self.push(e);
            }
        }
        let mut t = TaskTrace::new(self.pc_off);
        t.cap = self.cap;
        t.dropped = self.dropped;
        t.buf = std::mem::take(&mut self.buf);
        t.tasks = std::mem::take(&mut self.tasks);
        t.by_tcb = std::mem::take(&mut self.by_tcb);
        t
    }
}

/// Task timeline summary and export (CLI and tests; the web does the same in TS)
pub mod report {
    use super::*;

    /// One "running" span: task runs on core over [t0, t1)
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct Slice {
        pub core: u8,
        pub task: u16,
        pub t0: u64,
        pub t1: u64,
        /// Task state when the span ends (state::*; NONE if it ran to the end)
        pub end: u8,
        pub pc: u32,
    }

    /// Events -> per-core running slices; `end` is the simulation end (closes open slices)
    pub fn slices(ev: &[TaskEvent], end: u64) -> Vec<Slice> {
        let mut open: [Option<Slice>; 2] = [None, None];
        let mut out = Vec::new();
        for e in ev {
            let c = (e.core as usize).min(1);
            if let Some(mut s) = open[c].take() {
                s.t1 = e.t;
                s.end = e.prev;
                out.push(s);
            }
            if e.task != NO_TASK {
                open[c] = Some(Slice {
                    core: e.core,
                    task: e.task,
                    t0: e.t,
                    t1: e.t,
                    end: state::NONE,
                    pc: e.pc,
                });
            }
        }
        for s in open.into_iter().flatten() {
            out.push(Slice {
                t1: end.max(s.t0),
                ..s
            });
        }
        out.sort_by_key(|s| (s.t0, s.core));
        out
    }

    /// Cycles per core per task: [(core, task, cycles)], by core then usage descending
    pub fn usage(sl: &[Slice]) -> Vec<(u8, u16, u64)> {
        let mut m: HashMap<(u8, u16), u64> = HashMap::new();
        for s in sl {
            *m.entry((s.core, s.task)).or_default() += s.t1 - s.t0;
        }
        let mut v: Vec<_> = m.into_iter().map(|((c, t), n)| (c, t, n)).collect();
        v.sort_by_key(|x| (x.0, std::cmp::Reverse(x.2), x.1));
        v
    }

    fn esc(s: &str) -> String {
        let mut o = String::new();
        for ch in s.chars() {
            match ch {
                '"' => o.push_str("\\\""),
                '\\' => o.push_str("\\\\"),
                c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
                c => o.push(c),
            }
        }
        o
    }

    /// Chrome Trace Event JSON (opens in Perfetto / chrome://tracing): process 1 "CPU" has a track per core, slices named by task;
    /// process 2 has a track per task (running / waiting). `hz` = CPU clock (cycles -> us); `func` maps PC to a name (None without ELF). (lint: allow-long-comment)
    pub fn chrome_json(
        tasks: &[TaskInfo],
        sl: &[Slice],
        chip: &str,
        cores: usize,
        hz: u64,
        func: &dyn Fn(u32) -> Option<String>,
    ) -> String {
        // Cycles -> us with 3 decimals via integer round-half-up; web BigInt uses the same so text matches (float formatting rounds .5 differently)
        let us = |c: u64| {
            let ns = (c as u128 * 2_000_000_000 + hz as u128) / (2 * hz as u128);
            format!("{}.{:03}", ns / 1000, ns % 1000)
        };
        let name = |t: u16| {
            tasks
                .get(t as usize)
                .map(|x| x.name.clone())
                .unwrap_or_else(|| "?".into())
        };
        let mut v: Vec<String> = Vec::new();
        v.push(format!(
            r#"{{"ph":"M","pid":1,"name":"process_name","args":{{"name":"{} CPU"}}}}"#,
            esc(chip)
        ));
        v.push(r#"{"ph":"M","pid":2,"name":"process_name","args":{"name":"任务"}}"#.into()); // lint: allow-cjk
        for c in 0..cores {
            v.push(format!(
                r#"{{"ph":"M","pid":1,"tid":{c},"name":"thread_name","args":{{"name":"核 {c}"}}}}"# // lint: allow-cjk
            ));
        }
        for (i, t) in tasks.iter().enumerate() {
            v.push(format!(
                r#"{{"ph":"M","pid":2,"tid":{},"name":"thread_name","args":{{"name":"{}"}}}}"#,
                i + 10,
                esc(&t.name)
            ));
        }
        // Last switch-out time and state per task: add a "waiting" span when it is switched back in
        let mut last_out: HashMap<u16, (u64, u8)> = HashMap::new();
        for s in sl {
            let n = esc(&name(s.task));
            let f = func(s.pc)
                .map(|f| format!(r#","resume":"{}""#, esc(&f)))
                .unwrap_or_default();
            v.push(format!(
                r#"{{"ph":"X","pid":1,"tid":{},"name":"{n}","cat":"task","ts":{},"dur":{},"args":{{"prio":{},"pc":"0x{:08x}"{f},"out":"{}"}}}}"#,
                s.core,
                us(s.t0),
                us(s.t1 - s.t0),
                tasks.get(s.task as usize).map(|x| x.prio).unwrap_or(0),
                s.pc,
                state::name(s.end)
            ));
            if let Some((t, st)) = last_out.get(&s.task) {
                if *st == state::WAIT && s.t0 > *t {
                    v.push(format!(
                        r#"{{"ph":"X","pid":2,"tid":{},"name":"等待","cat":"wait","ts":{},"dur":{}}}"#, // lint: allow-cjk
                        s.task as usize + 10,
                        us(*t),
                        us(s.t0 - t)
                    ));
                }
            }
            v.push(format!(
                r#"{{"ph":"X","pid":2,"tid":{},"name":"核 {}","cat":"run","ts":{},"dur":{}}}"#, // lint: allow-cjk
                s.task as usize + 10,
                s.core,
                us(s.t0),
                us(s.t1 - s.t0)
            ));
            last_out.insert(s.task, (s.t1, s.end));
        }
        format!(
            "{{\"displayTimeUnit\":\"ms\",\"traceEvents\":[\n{}\n]}}\n",
            v.join(",\n")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Fake memory: place a TCB at base
    struct Mem(RefCell<HashMap<u32, u32>>);
    impl Mem {
        fn new() -> Self {
            Mem(RefCell::new(HashMap::new()))
        }
        fn w(&self, a: u32, v: u32) {
            self.0.borrow_mut().insert(a, v);
        }
        fn rd(&self, a: u32) -> Option<u32> {
            Some(*self.0.borrow().get(&a).unwrap_or(&0))
        }
        fn tcb(&self, t: u32, name: &str, prio: u32, sp: u32, pc: u32, ready: u32) {
            self.w(t, sp);
            self.w(sp, pc);
            self.w(t + tcb::STATE_OWNER, t);
            self.w(t + tcb::EVENT_OWNER, t);
            self.w(t + tcb::STATE_LIST, ready);
            self.w(t + tcb::PRIORITY, prio);
            let mut b = name.as_bytes().to_vec();
            b.resize(16, 0);
            for i in 0..4 {
                let x = u32::from_le_bytes(b[i * 4..i * 4 + 4].try_into().unwrap());
                self.w(t + tcb::NAME + i as u32 * 4, x);
            }
        }
    }

    #[test]
    fn switches_and_states() {
        let m = Mem::new();
        let rd = |a| m.rd(a);
        m.tcb(
            0x3fc9_0000,
            "main",
            1,
            0x3fc9_1000,
            0x4200_0100,
            0x3fc8_0014,
        );
        m.tcb(
            0x3fc9_2000,
            "IDLE",
            0,
            0x3fc9_3000,
            0x4200_0200,
            0x3fc8_0000,
        );
        let mut tt = TaskTrace::new(0);
        tt.cap = 100;
        // Base that isn't a TCB (xIsrStackTop): ignored
        tt.on_sp_load(0, 0x3fc8_8000, 5, false, &rd);
        tt.on_sp_load(0, 0x3fc9_0000, 10, false, &rd);
        // Same task loads its stack again (interrupt return, no switch): not recorded
        tt.on_sp_load(0, 0x3fc9_0000, 15, false, &rd);
        // main on the delay list with its event item on a queue -> waiting on queue
        m.w(0x3fc9_0000 + tcb::STATE_LIST, 0x3fc8_0100);
        m.w(0x3fc9_0000 + tcb::EVENT_LIST, 0x3fc8_0200);
        tt.on_sp_load(0, 0x3fc9_2000, 20, false, &rd);
        // main back on the ready list; IDLE preempted (still on its original ready list)
        m.w(0x3fc9_0000 + tcb::STATE_LIST, 0x3fc8_0014);
        m.w(0x3fc9_0000 + tcb::EVENT_LIST, 0);
        tt.on_sp_load(0, 0x3fc9_0000, 30, false, &rd);
        let ev = tt.take();
        assert_eq!(ev.len(), 3);
        assert_eq!(tt.tasks[0].name, "main");
        assert_eq!(tt.tasks[1].name, "IDLE");
        assert_eq!(
            ev.iter().map(|e| (e.t, e.task, e.prev)).collect::<Vec<_>>(),
            vec![
                (10, 0, state::NONE),
                (20, 1, state::WAIT),
                (30, 0, state::READY)
            ]
        );
        assert_eq!(ev[0].pc, 0x4200_0100);
        let sl = report::slices(&ev, 40);
        assert_eq!(
            sl.iter()
                .map(|s| (s.task, s.t0, s.t1, s.end))
                .collect::<Vec<_>>(),
            vec![
                (0, 10, 20, state::WAIT),
                (1, 20, 30, state::READY),
                (0, 30, 40, state::NONE)
            ]
        );
        let u = report::usage(&sl);
        assert_eq!(u, vec![(0, 0, 20), (0, 1, 10)]);
        let j = report::chrome_json(&tt.tasks, &sl, "ESP32-C3", 1, 160_000_000, &|_| None);
        #[rustfmt::skip]
        let ok = j.contains(r#""name":"main""#) && j.contains(r#""name":"等待""#); // lint: allow-cjk
        assert!(ok);
    }

    #[test]
    fn reused_tcb_gets_new_entry_and_reset_closes() {
        let m = Mem::new();
        let rd = |a| m.rd(a);
        m.tcb(0x3fc9_0000, "a", 1, 0x3fc9_1000, 0, 0);
        m.tcb(0x3fc9_2000, "b", 1, 0x3fc9_3000, 0, 0);
        let mut tt = TaskTrace::new(4);
        tt.cap = 100;
        tt.on_sp_load(1, 0x3fc9_0000, 1, true, &rd);
        tt.on_sp_load(1, 0x3fc9_2000, 2, true, &rd);
        m.tcb(0x3fc9_0000, "c", 1, 0x3fc9_1000, 0, 0);
        tt.on_sp_load(1, 0x3fc9_0000, 3, true, &rd);
        assert_eq!(tt.tasks.len(), 3);
        let mut t2 = tt.carry(9);
        let ev = t2.take();
        assert_eq!(ev.last().unwrap().task, NO_TASK);
        assert_eq!(ev.last().unwrap().core, 1);
        let sl = report::slices(&ev, 20);
        assert_eq!(sl.last().unwrap().t1, 9);
    }

    #[test]
    fn disabled_records_nothing() {
        let m = Mem::new();
        m.tcb(0x3fc9_0000, "a", 1, 0x3fc9_1000, 0, 0);
        let mut tt = TaskTrace::new(0);
        tt.on_sp_load(0, 0x3fc9_0000, 1, false, &|a| m.rd(a));
        assert!(tt.take().is_empty());
    }

    #[test]
    fn event_bytes() {
        let e = TaskEvent {
            t: 0x0102_0304_0506_0708,
            core: 1,
            prev: state::WAIT,
            task: 0x0a0b,
            pc: 0x4200_1234,
        };
        let b = e.to_bytes();
        assert_eq!(b[0], 0x08);
        assert_eq!(&b[8..12], &[1, 2, 0x0b, 0x0a]);
        assert_eq!(
            u32::from_le_bytes(b[12..16].try_into().unwrap()),
            0x4200_1234
        );
    }
    /// Same events as web/test/tasktrace.test.ts: both exports produce identical JSON lines (web export = CLI export)
    #[test]
    fn chrome_json_matches_web() {
        use report::*;
        let e = |t, core, prev, task, pc| TaskEvent {
            t,
            core,
            prev,
            task,
            pc,
        };
        let ev = [
            e(100, 0, state::NONE, 0, 0x4200_0010),
            e(110, 1, state::NONE, 1, 0),
            e(300, 0, state::WAIT, 2, 0x4200_0020),
            e(500, 0, state::READY, 0, 0x4200_0010),
            e(600, 1, state::GONE, NO_TASK, 0),
        ];
        let sl = slices(&ev, 1000);
        let ti = |name: &str, prio| TaskInfo {
            tcb: 0,
            name: name.into(),
            prio,
            affinity: -1,
        };
        let tasks = [ti("main", 1), ti("w1", 5), ti("IDLE0", 0)];
        let j = chrome_json(&tasks, &sl, "esp32s3", 2, 160_000_000, &|a| {
            (a == 0x4200_0010).then(|| "app_main".to_string())
        });
        assert!(j.starts_with("{\"displayTimeUnit\":\"ms\",\"traceEvents\":[\n{\"ph\":\"M\",\"pid\":1,\"name\":\"process_name\",\"args\":{\"name\":\"esp32s3 CPU\"}}"));
        assert!(j.contains(r#"{"ph":"X","pid":1,"tid":0,"name":"main","cat":"task","ts":0.625,"dur":1.250,"args":{"prio":1,"pc":"0x42000010","resume":"app_main","out":"wait"}}"#), "{j}");
        assert_eq!(j.matches(r#""cat":"wait""#).count(), 1);
    }
}
