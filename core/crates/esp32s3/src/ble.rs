//! S3 BLE hookup (E-04, C-01 route a' on Xtensa): same replacements as esp32c3/src/ble.rs, located by sig_xt.
//! Entries are intercepted by PC (Cpu::hle_addrs) before ENTRY, so the window is the caller's: n = PS.CALLINC, args in
//! a(4n+2..), return address a(4n), result to a(4n+2), PC back past the call with no RETW. To call into firmware we
//! reuse the caller's CALLn: a(4n) = n<<30 | magic slot, PS.CALLINC = n, PC = f; f's RETW lands on the slot in the
//! same window. The original return address is kept per caller SP (re-entrant across tasks). Flash is untouched.
//! The classic ESP32 (LX6, E-09) reuses this through `Bus` + its own `Osi` layout (esp32/src/ble.rs).
//! lint: allow-long-comment

use crate::SocBus;
use std::collections::HashMap;
use tryboard_soc::ble::sig::{self, Hooks, Seg};
use tryboard_soc::ble::sig_xt;
pub use tryboard_soc::ble::Ble;
use tryboard_xtensa::{sr, Cpu, PS_CALLINC_SHIFT};

/// Return slots for calls into firmware (right after ROM, no backing storage)
pub const MAGIC: u32 = 0x4006_0000;
const S_POP_RET0: u32 = 0;
/// Task name buffer allocated: create the stub task
const S_NAMED: u32 = 1;
/// Stub task entry / semaphore created / main loop
const S_ENTRY: u32 = 2;
const S_CREATED: u32 = 3;
const S_LOOP: u32 = 4;
/// notify_host_send_available returned inside send_packet: give the stub task's semaphore
const S_SENT: u32 = 5;
const SLOTS: u32 = 6;
pub const MAGIC_END: u32 = MAGIC + 4 * SLOTS;

const OSI_MAGIC: u32 = 0xFADE_BEAD;

/// osi_funcs_t layout of one bt.c (byte offsets)
pub struct Osi {
    pub magic_at: u32,
    pub version_at: u32,
    pub versions: std::ops::RangeInclusive<u32>,
    /// First version whose bt.c calls the extend pll_track setter (must be hooked); None = never
    pub pll_from: Option<u32>,
    pub semphr_create: u32,
    pub semphr_take: u32,
    pub semphr_give: u32,
    pub task_create: u32,
    pub malloc_internal: u32,
}

/// S3 builds controller/esp32c3/bt.c: IDF 5.1.0 / 5.1.1 = 0x10006 ... 5.4-5.5.1 = 0x1000A (F-08c: offsets checked per bt.c)
pub const OSI_S3: Osi = Osi {
    magic_at: 0,
    version_at: 4,
    versions: 0x0001_0006..=0x0001_000A,
    pll_from: Some(0x0001_0007),
    semphr_create: 36,
    semphr_take: 52,
    semphr_give: 56,
    task_create: 100,
    malloc_internal: 120,
};

/// What the HLE needs from a chip's bus
pub trait Bus {
    fn rd32(&self, a: u32) -> u32;
    fn rd8(&self, a: u32) -> u8;
    fn wr8(&mut self, a: u32, v: u8);
    fn ble_slot(&mut self) -> &mut Slot;
}

impl Bus for SocBus {
    fn rd32(&self, a: u32) -> u32 {
        self.mem_read(a, 4).unwrap_or(0)
    }
    fn rd8(&self, a: u32) -> u8 {
        self.mem_read(a, 1).unwrap_or(0) as u8
    }
    fn wr8(&mut self, a: u32, v: u8) {
        self.mem_write(a, 1, v as u32);
    }
    fn ble_slot(&mut self) -> &mut Slot {
        &mut self.ble
    }
}

/// Stub task stack: the host's receive callback runs on it (windowed frames are larger than on RISC-V)
const TASK_STACK: u32 = 8192;
/// Stack buffer for one packet going to the host
const BUF: u32 = 528;
/// Max wait per stub-task wake (ms), as on C3
const WAIT_MS: u32 = 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Entry {
    OsiReg,
    Init,
    Enable,
    GetMode,
    Check,
    Send,
    RegCb,
    Nop,
}

pub struct BleHle {
    pub hooks: Hooks,
    layout: &'static Osi,
    osi: u32,
    /// vhci_host_callback_t*: {notify_host_send_available, notify_host_recv}
    cb: u32,
    sem: u32,
    buf: u32,
    /// CALLINC the stub task's window was entered with (FreeRTOS starts tasks as a call4)
    task_n: u32,
    /// Caller SP -> (original return address, CALLINC) for hooks that call back into firmware before returning
    frames: HashMap<u32, (u32, u32)>,
    pub world: Box<Ble>,
    /// Firmware called btdm_controller_init (the web page shows the "Bluetooth" tab based on this)
    pub inited: bool,
    /// HLE error (unknown osi version, etc.)
    pub error: Option<String>,
}

/// SocBus state: the HLE when libbtdm's VHCI boundary was found, or why firmware using BLE can't be simulated
#[derive(Default)]
pub struct Slot {
    pub hle: Option<Box<BleHle>>,
    pub error: Option<String>,
}

/// Find signatures in app segments. Ok(None) = no BLE; Err = uses BLE but unrecognized
pub fn locate(segs: &[Seg]) -> Result<Option<Hooks>, String> {
    if !sig::mentions_btdm(segs) {
        return Ok(None);
    }
    let code: Vec<Seg> = segs
        .iter()
        .copied()
        .filter(|(a, _)| (0x4000_0000..0x4400_0000).contains(a))
        .collect();
    sig_xt::locate(&code).map(Some)
}

impl BleHle {
    pub fn new(hooks: Hooks, addr: [u8; 6]) -> BleHle {
        BleHle::with_osi(hooks, addr, &OSI_S3)
    }

    pub fn with_osi(hooks: Hooks, addr: [u8; 6], layout: &'static Osi) -> BleHle {
        BleHle {
            hooks,
            layout,
            osi: 0,
            cb: 0,
            sem: 0,
            buf: 0,
            task_n: 1,
            frames: HashMap::new(),
            world: Box::new(Ble::new(addr)),
            inited: false,
            error: None,
        }
    }

    fn entries(&self) -> [(u32, Entry); 8] {
        let h = &self.hooks;
        [
            (h.osi_funcs_register, Entry::OsiReg),
            (h.controller_init, Entry::Init),
            (h.controller_enable, Entry::Enable),
            (h.get_mode, Entry::GetMode),
            (h.check_send_available, Entry::Check),
            (h.send_packet, Entry::Send),
            (h.register_callback, Entry::RegCb),
            (h.pll_track, Entry::Nop),
        ]
    }

    /// Addresses for Cpu::hle_addrs: hooked entries plus the magic return slots
    pub fn hle_addrs(&self) -> Vec<u32> {
        // pll_track is 0 when the firmware's bt.c never calls it (IDF 5.1.0 / 5.1.1)
        let mut v: Vec<u32> = self
            .entries()
            .iter()
            .map(|e| e.0)
            .filter(|&a| a != 0)
            .collect();
        v.extend((0..SLOTS).map(|i| MAGIC + 4 * i));
        v
    }
}

fn rd32<B: Bus>(bus: &B, a: u32) -> u32 {
    bus.rd32(a)
}

fn callinc(cpu: &Cpu) -> u32 {
    (cpu.ps() >> PS_CALLINC_SHIFT) & 3
}

/// Return v to the caller of a hooked entry (window n, return address ra)
fn ret(cpu: &mut Cpu, n: u32, ra: u32, v: u32) {
    cpu.set_a(4 * n + 2, v);
    cpu.pc = (ra & 0x3fff_ffff) | (cpu.pc & 0xc000_0000);
    cpu.instret += 1;
    cpu.cycles += 1;
}

/// Call firmware function f as if the current window did CALLn; its RETW comes back to magic slot `slot`
fn call(cpu: &mut Cpu, n: u32, f: u32, slot: u32, args: &[u32]) {
    for (i, a) in args.iter().enumerate() {
        cpu.set_a(4 * n + 2 + i as u32, *a);
    }
    cpu.set_a(4 * n, (n << 30) | ((MAGIC + 4 * slot) & 0x3fff_ffff));
    let ps = cpu.ps() & !(3 << PS_CALLINC_SHIFT);
    cpu.write_sr(sr::PS, ps | (n << PS_CALLINC_SHIFT));
    cpu.pc = f;
    cpu.instret += 1;
    cpu.cycles += 1;
}

/// Simulated time (µs)
pub fn now_us(cpu: &Cpu) -> u64 {
    cpu.cycles / (crate::CPU_HZ / 1_000_000)
}

/// Run the HLE for pc if it is a BLE hook or return slot; false = not ours
pub fn call_at<B: Bus>(pc: u32, cpu: &mut Cpu, bus: &mut B) -> bool {
    let Some(mut b) = bus.ble_slot().hle.take() else {
        return false;
    };
    let hit = if (MAGIC..MAGIC_END).contains(&pc) {
        slot(&mut b, (pc - MAGIC) / 4, cpu, bus);
        true
    } else if let Some(&(_, e)) = b.entries().iter().find(|x| x.0 == pc) {
        entry(&mut b, e, cpu, bus);
        true
    } else {
        false
    };
    bus.ble_slot().hle = Some(b);
    hit
}

fn entry<B: Bus>(b: &mut BleHle, e: Entry, cpu: &mut Cpu, bus: &mut B) {
    let n = callinc(cpu);
    if n == 0 {
        // libbtdm and bt.c are windowed code; a CALL0 caller means a mismatched hook
        b.error = Some(format!("BLE hook {e:?} entered by CALL0 at {:08x}", cpu.pc));
        cpu.hle_return_call0(0);
        return;
    }
    let ra = cpu.a(4 * n);
    let a = |i: u32| cpu.a(4 * n + 2 + i);
    match e {
        Entry::OsiReg => {
            let (p, l) = (a(0), b.layout);
            let (magic, ver) = (rd32(bus, p + l.magic_at), rd32(bus, p + l.version_at));
            let err = if magic != OSI_MAGIC || !l.versions.contains(&ver) {
                Some(format!(
                    "unknown bt.c osi function table version (magic {magic:08x} version {ver:08x})"
                ))
            } else if l.pll_from.is_some_and(|v| ver >= v) && b.hooks.pll_track == 0 {
                // This bt.c calls the setter, which would write through the sdk_config pointer we never set
                Some(
                    "no sdk_config_extend_set_pll_track call found before btdm_controller_enable"
                        .into(),
                )
            } else {
                None
            };
            if let Some(msg) = err {
                b.error = Some(msg);
                ret(cpu, n, ra, 0x103);
                return;
            }
            b.osi = p;
            ret(cpu, n, ra, 0);
        }
        Entry::Init => {
            // Stub task instead of the controller task. Its name must outlive this frame's spill area, so malloc it
            b.inited = true;
            b.world.active = true;
            b.frames.insert(cpu.a(1), (ra, n));
            let f = rd32(bus, b.osi + b.layout.malloc_internal);
            call(cpu, n, f, S_NAMED, &[8]);
        }
        Entry::Enable | Entry::Nop => ret(cpu, n, ra, 0),
        // ESP_BT_MODE_BLE
        Entry::GetMode => ret(cpu, n, ra, 1),
        Entry::Check => ret(cpu, n, ra, 1),
        Entry::RegCb => {
            b.cb = a(0);
            ret(cpu, n, ra, 0);
        }
        Entry::Send => {
            let (p, len) = (a(0), a(1) & 0xffff);
            let pkt: Vec<u8> = (0..len).map(|i| bus.rd8(p + i)).collect();
            b.world.host_send(&pkt, now_us(cpu));
            // For every packet the host waits for notify_host_send_available to return its send semaphore
            if b.cb != 0 {
                b.frames.insert(cpu.a(1), (ra, n));
                let f = rd32(bus, b.cb);
                call(cpu, n, f, S_SENT, &[]);
            } else {
                ret(cpu, n, ra, 0);
            }
        }
    }
}

/// Return 0 to the hooked entry's caller whose window is current
fn pop_ret0(b: &mut BleHle, cpu: &mut Cpu) {
    match b.frames.remove(&cpu.a(1)) {
        Some((ra, n)) => ret(cpu, n, ra, 0),
        None => {
            b.error = Some(format!(
                "BLE HLE lost its return frame (sp {:08x})",
                cpu.a(1)
            ))
        }
    }
}

fn slot<B: Bus>(b: &mut BleHle, s: u32, cpu: &mut Cpu, bus: &mut B) {
    let n_of = |b: &BleHle, cpu: &Cpu| b.frames.get(&cpu.a(1)).map_or(1, |f| f.1);
    match s {
        S_POP_RET0 => pop_ret0(b, cpu),
        S_NAMED => {
            let n = n_of(b, cpu);
            let p = cpu.a(4 * n + 2);
            for (i, c) in b"btCtrl\0".iter().enumerate() {
                bus.wr8(p + i as u32, *c);
            }
            // core_id (7th arg) is read from the caller's stack; bt.c maps out-of-range ids to no affinity
            let f = rd32(bus, b.osi + b.layout.task_create);
            call(
                cpu,
                n,
                f,
                S_POP_RET0,
                &[MAGIC + 4 * S_ENTRY, p, TASK_STACK, 0, 23, 0],
            );
        }
        S_SENT => {
            if b.sem != 0 {
                let n = n_of(b, cpu);
                let f = rd32(bus, b.osi + b.layout.semphr_give);
                call(cpu, n, f, S_POP_RET0, &[b.sem]);
            } else {
                pop_ret0(b, cpu);
            }
        }
        S_ENTRY => {
            // Never returns, so the packet buffer can sit just below the entry SP
            b.task_n = callinc(cpu).max(1);
            let sp = cpu.a(1).wrapping_sub(BUF) & !15;
            cpu.set_a(1, sp);
            b.buf = sp;
            let f = rd32(bus, b.osi + b.layout.semphr_create);
            call(cpu, b.task_n, f, S_CREATED, &[1, 0]);
        }
        S_CREATED => {
            b.sem = cpu.a(4 * b.task_n + 2);
            loop_step(b, cpu, bus);
        }
        S_LOOP => loop_step(b, cpu, bus),
        _ => {}
    }
}

fn loop_step<B: Bus>(b: &mut BleHle, cpu: &mut Cpu, bus: &mut B) {
    let now = now_us(cpu);
    let n = b.task_n;
    if b.cb != 0 {
        if let Some(pkt) = b.world.poll(now) {
            let len = pkt.len().min(BUF as usize);
            for (i, x) in pkt[..len].iter().enumerate() {
                bus.wr8(b.buf + i as u32, *x);
            }
            let f = rd32(bus, b.cb + 4);
            call(cpu, n, f, S_LOOP, &[b.buf, len as u32]);
            return;
        }
    }
    let f = rd32(bus, b.osi + b.layout.semphr_take);
    call(cpu, n, f, S_LOOP, &[b.sem, WAIT_MS]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boot::{find_app, parse_app};
    use tryboard_soc::ble::sigs_xt;

    /// No false matches: of all built S3 acceptance firmware (C3 images skipped by chip ID) only BLE firmware is recognised
    #[test]
    fn sigs_hit_only_ble_firmware() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../firmware/build");
        let Ok(rd) = std::fs::read_dir(&dir) else {
            eprintln!("skipped: no firmware/build");
            return;
        };
        let mut n = 0;
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(flash) = std::fs::read(e.path().join("flash.bin")) else {
                continue;
            };
            let Ok(app) = find_app(&flash).and_then(|o| parse_app(&flash, o)) else {
                continue;
            };
            let segs: Vec<Seg> = app
                .segments
                .iter()
                .filter_map(|&(load, data, len)| {
                    flash
                        .get(data as usize..(data + len) as usize)
                        .map(|b| (load, b))
                })
                .collect();
            let r = locate(&segs);
            n += 1;
            // BLE firmware: s3-ble-* / s3-bluedroid-* plus examples that link NimBLE (E-07a dashboard, G-17a clock)
            if name.starts_with("s3-ble")
                || name.starts_with("s3-bluedroid-")
                || name == "s3-ai-dash"
                || name == "amoclock"
            {
                let h = r
                    .unwrap_or_else(|e| panic!("{name}: {e}"))
                    .expect("BLE should be recognized");
                for a in [
                    h.osi_funcs_register,
                    h.controller_init,
                    h.controller_enable,
                    h.get_mode,
                    h.check_send_available,
                    h.send_packet,
                    h.register_callback,
                    h.pll_track,
                ] {
                    assert!(a != 0 && a & 3 == 0, "{name}: {h:x?}");
                }
            } else {
                assert!(
                    matches!(r, Ok(None)),
                    "{name} wrongly detected as using BLE: {r:?}"
                );
                // Without the BLE_INIT gate the signatures alone must still find nothing (non-BLE code has no libbtdm)
                for (fname, v) in [
                    ("send", sigs_xt::API_VHCI_HOST_SEND_PACKET),
                    ("init", sigs_xt::BTDM_CONTROLLER_INIT),
                    ("enable", sigs_xt::BTDM_CONTROLLER_ENABLE),
                    ("osi", sigs_xt::BTDM_OSI_FUNCS_REGISTER),
                    ("check", sigs_xt::API_VHCI_HOST_CHECK_SEND_AVAILABLE),
                ] {
                    let hits = sig_xt::find(&segs, v, 0, u32::MAX);
                    assert!(hits.is_empty(), "{name}: {fname} false hit {hits:x?}");
                }
            }
        }
        eprintln!("checked {n} firmware images");
    }
}
