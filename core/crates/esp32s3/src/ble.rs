//! S3 BLE hookup (E-04, C-01 route a' on Xtensa): same replacements as esp32c3/src/ble.rs, located by sig_xt.
//! Entries are intercepted by PC (Cpu::hle_addrs) before ENTRY, so the window is the caller's: n = PS.CALLINC, args in
//! a(4n+2..), return address a(4n), result to a(4n+2), PC back past the call with no RETW. To call into firmware we
//! reuse the caller's CALLn: a(4n) = n<<30 | magic slot, PS.CALLINC = n, PC = f; f's RETW lands on the slot in the
//! same window. The original return address is kept per caller SP (re-entrant across tasks). Flash is untouched.
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

// osi_funcs_t offsets (S3 builds the same controller/esp32c3/bt.c, IDF 5.1-5.5.1)
const OSI_MAGIC: u32 = 0xFADE_BEAD;
const OSI_SEMPHR_CREATE: u32 = 36;
const OSI_SEMPHR_TAKE: u32 = 52;
const OSI_SEMPHR_GIVE: u32 = 56;
const OSI_TASK_CREATE: u32 = 100;
const OSI_MALLOC_INTERNAL: u32 = 120;

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
        BleHle {
            hooks,
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
        let mut v: Vec<u32> = self.entries().iter().map(|e| e.0).collect();
        v.extend((0..SLOTS).map(|i| MAGIC + 4 * i));
        v
    }
}

fn rd32(bus: &SocBus, a: u32) -> u32 {
    bus.mem_read(a, 4).unwrap_or(0)
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
pub fn call_at(pc: u32, cpu: &mut Cpu, bus: &mut SocBus) -> bool {
    let Some(mut b) = bus.ble.hle.take() else {
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
    bus.ble.hle = Some(b);
    hit
}

fn entry(b: &mut BleHle, e: Entry, cpu: &mut Cpu, bus: &mut SocBus) {
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
            let p = a(0);
            let (magic, ver) = (rd32(bus, p), rd32(bus, p + 4));
            if magic != OSI_MAGIC || !(0x0001_0009..=0x0001_000A).contains(&ver) {
                b.error = Some(format!(
                    "unknown bt.c osi function table version (magic {magic:08x} version {ver:08x})"
                ));
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
            let f = rd32(bus, b.osi + OSI_MALLOC_INTERNAL);
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
            let pkt: Vec<u8> = (0..len)
                .map(|i| bus.mem_read(p + i, 1).unwrap_or(0) as u8)
                .collect();
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

fn slot(b: &mut BleHle, s: u32, cpu: &mut Cpu, bus: &mut SocBus) {
    let n_of = |b: &BleHle, cpu: &Cpu| b.frames.get(&cpu.a(1)).map_or(1, |f| f.1);
    match s {
        S_POP_RET0 => pop_ret0(b, cpu),
        S_NAMED => {
            let n = n_of(b, cpu);
            let p = cpu.a(4 * n + 2);
            for (i, c) in b"btCtrl\0".iter().enumerate() {
                bus.mem_write(p + i as u32, 1, *c as u32);
            }
            // core_id (7th arg) is read from the caller's stack; bt.c maps out-of-range ids to no affinity
            let f = rd32(bus, b.osi + OSI_TASK_CREATE);
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
                let f = rd32(bus, b.osi + OSI_SEMPHR_GIVE);
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
            let f = rd32(bus, b.osi + OSI_SEMPHR_CREATE);
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

fn loop_step(b: &mut BleHle, cpu: &mut Cpu, bus: &mut SocBus) {
    let now = now_us(cpu);
    let n = b.task_n;
    if b.cb != 0 {
        if let Some(pkt) = b.world.poll(now) {
            let len = pkt.len().min(BUF as usize);
            for (i, x) in pkt[..len].iter().enumerate() {
                bus.mem_write(b.buf + i as u32, 1, *x as u32);
            }
            let f = rd32(bus, b.cb + 4);
            call(cpu, n, f, S_LOOP, &[b.buf, len as u32]);
            return;
        }
    }
    let f = rd32(bus, b.osi + OSI_SEMPHR_TAKE);
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
            if name.starts_with("s3-ble") || name.starts_with("s3-bluedroid-") {
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
