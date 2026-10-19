//! FreeRTOS 任务时间线（C-04）：每个核的任务切换，按 CPU 周期盖戳。C3 / S3 两颗芯片的 SocBus 各有一份。
//!
//! 只靠 flash.bin 就能工作，不需要 ELF（办法与降级见 docs/DECISIONS.md 2026-10-19「任务时间线」）：
//! - 两个移植层换任务都以同一条指令收尾——栈指针取自新任务 TCB 的第一个字 pxTopOfStack：
//!   RISC-V `rtos_int_exit` 的 `lw sp, 0(a0)`，Xtensa `_frxt_dispatch` / `_frxt_int_exit` 的 `l32i a1, aN, 0`。
//!   CPU 核在执行 "栈指针 ← mem[基址 + 0]" 时报告基址（`Bus::sp_loaded`），这里判断基址是不是 TCB。
//! - TCB 自带签名：两个链表项的 pvOwner 都指回 TCB 自己（TCB+16、TCB+36），名字在 TCB+52（以 NUL 结尾的可打印字符）。
//!   中断入口从 xIsrStackTop 取栈之类的同形指令过不了签名，直接忽略（每次都判断，不拉黑：那块内存以后可能变成 TCB）。
//! - 被切出的任务处于什么状态，看它的两个链表项挂在哪：状态项还挂在上次在跑时的那条就绪链表 → 被抢占（就绪）；
//!   事件项挂着（xEventListItem.pxContainer ≠ 0）→ 在等队列 / 信号量；否则 → 延时 / 通知 / 挂起。
//!
//! 时刻是换栈那条指令的周期，比 vTaskSwitchContext 晚几条指令；中断处理的时间算在被打断的任务头上（行为模拟）。

use std::collections::HashMap;

/// 默认事件上限：65536 条 × 16 字节 = 1MB（网页每批时间片取走一次，CLI 每 1ms 取走一次）
pub const DEFAULT_CAP: usize = 1 << 16;

/// 没有任务在跑（启动期、复位之后）
pub const NO_TASK: u16 = 0xffff;

/// IDF v5.5 FreeRTOS（无 MPU 包装、无链表完整性校验字节）的 TCB 布局
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
    /// 双核时名字后面是 xCoreID（绑定的核，0x7fffffff = 不绑定）
    pub const CORE_ID: u32 = 68;
}

/// 被切出任务的状态（事件的 prev 字段）
pub mod state {
    /// 没有被切出的任务（这个核上的第一次切换）
    pub const NONE: u8 = 0;
    /// 被抢占：还在就绪链表里
    pub const READY: u8 = 1;
    /// 在等队列 / 信号量 / 事件组（事件链表项挂着）
    pub const WAIT: u8 = 2;
    /// 延时、等通知或挂起
    pub const BLOCKED: u8 = 3;
    /// TCB 已经不像 TCB 了（任务删掉、内存被复用）
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
    /// 绑定的核；-1 = 不绑定或单核
    pub affinity: i32,
}

/// 一次切换，16 字节小端：t u64 | core u8 | prev u8 | task u16 | pc u32
/// - task：换上来的任务（`TaskTrace::tasks` 的下标），NO_TASK = 核上没有任务（复位）
/// - prev：被切出的任务此刻的状态（`state::*`）
/// - pc：换上来的任务将从哪里继续（栈帧里保存的 PC；配 ELF 可以翻成函数名）
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
    /// 0 = 不记（CLI 没给 --trace-tasks 时）
    pub cap: usize,
    pub buf: Vec<TaskEvent>,
    pub dropped: u64,
    pub tasks: Vec<TaskInfo>,
    /// 栈帧里保存 PC 的偏移：RISC-V RV_STK_MEPC = 0，Xtensa XT_STK_PC / XT_SOL_PC = 4
    pub pc_off: u32,
    /// 每个核上在跑的 TCB（0 = 没有）
    cur: [u32; 2],
    by_tcb: HashMap<u32, u16>,
    /// 任务在跑时状态项挂的那条链表（= 它优先级的就绪链表）
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

    /// 读 TCB 的名字：以 NUL 结尾、全是可打印 ASCII、至少一个字符
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
        // 名字正好 16 字节、没有 NUL（configMAX_TASK_NAME_LEN 截断后总有 NUL，这里宽容）
        Some(s)
    }

    /// 基址像不像 TCB：两个链表项的 pvOwner 都指回自己，名字可读
    pub fn probe(rd: &dyn Fn(u32) -> Option<u32>, t: u32) -> Option<String> {
        if t & 3 != 0 || t == 0 {
            return None;
        }
        if rd(t + tcb::STATE_OWNER)? != t || rd(t + tcb::EVENT_OWNER)? != t {
            return None;
        }
        Self::name_at(rd, t)
    }

    /// 栈指针刚从 `base` 处取出（见模块说明）。`dual` = 双核芯片（TCB 里有 xCoreID）
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
        // 过不了签名的基址（xIsrStackTop 之类）每次都重新判断：同一块内存以后可能分给新任务的 TCB
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
        // 同一个 TCB 地址换了名字 = 旧任务删了、内存给了新任务：另起一条
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

    /// 软件复位后搬到新总线：已记的事件、任务表保留（时间线继续），各核"没有任务"
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

/// 任务时间线的汇总与导出（CLI 与测试用；网页在 TS 里做同样的事）
pub mod report {
    use super::*;

    /// 一段"在跑"：[t0, t1) 核 core 上跑 task
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct Slice {
        pub core: u8,
        pub task: u16,
        pub t0: u64,
        pub t1: u64,
        /// 这段结束时任务的状态（state::*；跑到结尾 = NONE）
        pub end: u8,
        pub pc: u32,
    }

    /// 事件序列 → 每核的在跑切片；`end` 是模拟结束时刻（收尾未结束的切片）
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

    /// 每核每任务的周期数：[(核, 任务, 周期)]，按核、占用从高到低
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

    /// Chrome Trace Event JSON（Perfetto / chrome://tracing 能打开）：
    /// 进程 1「CPU」每核一条轨道（tid = 核号），切片名 = 任务名；进程 2「任务」每任务一条轨道，画在跑 / 等待。
    /// `hz` 是 CPU 主频（周期 → 微秒）；`func` 把 PC 翻成函数名（没有 ELF 时返回 None）
    pub fn chrome_json(
        tasks: &[TaskInfo],
        sl: &[Slice],
        chip: &str,
        cores: usize,
        hz: u64,
        func: &dyn Fn(u32) -> Option<String>,
    ) -> String {
        // 周期 → 微秒 3 位小数：整数算、四舍五入（半数进位），网页 BigInt 同一算法，两边逐字相同（浮点格式化在 .5 上舍入规则不同）
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
        v.push(r#"{"ph":"M","pid":2,"name":"process_name","args":{"name":"任务"}}"#.into());
        for c in 0..cores {
            v.push(format!(
                r#"{{"ph":"M","pid":1,"tid":{c},"name":"thread_name","args":{{"name":"核 {c}"}}}}"#
            ));
        }
        for (i, t) in tasks.iter().enumerate() {
            v.push(format!(
                r#"{{"ph":"M","pid":2,"tid":{},"name":"thread_name","args":{{"name":"{}"}}}}"#,
                i + 10,
                esc(&t.name)
            ));
        }
        // 每个任务上一次被切出的时刻和状态：再被换上来时补一段"等待"
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
                        r#"{{"ph":"X","pid":2,"tid":{},"name":"等待","cat":"wait","ts":{},"dur":{}}}"#,
                        s.task as usize + 10,
                        us(*t),
                        us(s.t0 - t)
                    ));
                }
            }
            v.push(format!(
                r#"{{"ph":"X","pid":2,"tid":{},"name":"核 {}","cat":"run","ts":{},"dur":{}}}"#,
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

    /// 一块假内存：在 base 处摆一个 TCB
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
        // 不是 TCB 的基址（xIsrStackTop）：忽略
        tt.on_sp_load(0, 0x3fc8_8000, 5, false, &rd);
        tt.on_sp_load(0, 0x3fc9_0000, 10, false, &rd);
        // 同一个任务再取一次栈（中断返回，没换任务）：不记
        tt.on_sp_load(0, 0x3fc9_0000, 15, false, &rd);
        // main 进了延时链表、事件项挂在队列上 → 等队列
        m.w(0x3fc9_0000 + tcb::STATE_LIST, 0x3fc8_0100);
        m.w(0x3fc9_0000 + tcb::EVENT_LIST, 0x3fc8_0200);
        tt.on_sp_load(0, 0x3fc9_2000, 20, false, &rd);
        // main 回到就绪链表；IDLE 被抢占（还挂在原来的就绪链表）
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
        assert!(j.contains(r#""name":"main""#) && j.contains(r#""name":"等待""#));
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
    /// 与 web/test/tasktrace.test.ts 同一组事件：两边导出的 JSON 行逐字相同（网页导出 = CLI 导出）
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
