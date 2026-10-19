//! C3 BLE hookup (C-01 route a'): find libbtdm's VHCI boundary in user firmware by signature and redirect entries to HLE magic addresses.
//! Replaced: `btdm_osi_funcs_register` (keep bt.c's OS adapter table to call back into FreeRTOS), `btdm_controller_init` (no real
//! controller; a stub task via osi task_create), `btdm_controller_enable` / `_get_mode` (succeed / BLE mode), `API_vhci_host_*` (HCI I/O).
//! The stub task is pure HLE: wait on a semaphore -> hand due events to the host's notify_host_recv -> wait again. Firmware calls chain by
//! pointing ra at the next magic address, saving ra on the current task's stack (re-entrant). Flash is untouched: fetches are overlaid by
//! [`SocBus::code_patch`] with `lui t0, 0x40060; jalr x0, off(t0)`, so exports and post-reset signature search see the original. (lint: allow-long-comment)

use crate::SocBus;
use tryboard_rv32::Cpu;
use tryboard_soc::ble::sig::{self, Hooks, Seg};
pub use tryboard_soc::ble::Ble;

/// HLE magic address range (right after ROM, no backing storage)
pub const MAGIC: u32 = 0x4006_0000;
pub const MAGIC_END: u32 = MAGIC + 4 * SLOTS;

const S_OSI_REG: u32 = 0;
const S_INIT: u32 = 1;
const S_ENABLE: u32 = 2;
const S_GET_MODE: u32 = 3;
const S_CHECK: u32 = 4;
const S_SEND: u32 = 5;
const S_REG_CB: u32 = 6;
/// Chain step: pop the saved ra, return 0
const S_POP_RET0: u32 = 7;
/// Stub task entry / semaphore created / main loop
const S_ENTRY: u32 = 8;
const S_CREATED: u32 = 9;
const S_LOOP: u32 = 10;
/// After notify_host_send_available returns inside send_packet: give the stub task's semaphore
const S_SENT: u32 = 11;
/// sdk_config_extend_set_pll_track: no-op
const S_NOP: u32 = 12;
const SLOTS: u32 = 13;

// osi_funcs_t offsets (same in bt.c for IDF 5.1-5.5.1, versions 0x00010009 / 0x0001000A)
const OSI_MAGIC: u32 = 0xFADE_BEAD;
const OSI_SEMPHR_CREATE: u32 = 36;
const OSI_SEMPHR_TAKE: u32 = 52;
const OSI_SEMPHR_GIVE: u32 = 56;
const OSI_TASK_CREATE: u32 = 100;

/// Stub task stack: the host's receive callback (copy, push to the NimBLE event queue) runs on it, so leave plenty
const TASK_STACK: u32 = 6144;
/// Stack buffer for one packet going to the host
const BUF: u32 = 528;
/// Max wait per stub-task wake (ms): connection events are 30 ms, advertising tens of ms, so 10 ms is fine-grained enough
const WAIT_MS: u32 = 10;

pub struct BleHle {
    pub hooks: Hooks,
    osi: u32,
    /// vhci_host_callback_t*: {notify_host_send_available, notify_host_recv}
    cb: u32,
    sem: u32,
    buf: u32,
    pub world: Box<Ble>,
    /// Firmware called btdm_controller_init (the web page shows the "Bluetooth" tab based on this)
    pub inited: bool,
    /// HLE error (unknown osi version, etc.)
    pub error: Option<String>,
}

/// Find signatures in app segments. Ok(None) = no BLE; Err = uses BLE but unrecognized (web suggests dropping in app.elf)
pub fn locate(segs: &[Seg]) -> Result<Option<Hooks>, String> {
    if !sig::mentions_btdm(segs) {
        return Ok(None);
    }
    let code: Vec<Seg> = segs
        .iter()
        .copied()
        .filter(|(a, _)| (0x4000_0000..0x4400_0000).contains(a))
        .collect();
    sig::locate(&code).map(Some)
}

impl BleHle {
    pub fn new(hooks: Hooks, addr: [u8; 6]) -> BleHle {
        BleHle {
            hooks,
            osi: 0,
            cb: 0,
            sem: 0,
            buf: 0,
            world: Box::new(Ble::new(addr)),
            inited: false,
            error: None,
        }
    }

    /// Fetch overlay: an 8-byte trampoline per entry (as halfwords, matching fetch)
    pub fn patches(&self) -> Vec<(u32, u16)> {
        let h = &self.hooks;
        let mut v = Vec::new();
        for (addr, slot) in [
            (h.osi_funcs_register, S_OSI_REG),
            (h.controller_init, S_INIT),
            (h.controller_enable, S_ENABLE),
            (h.get_mode, S_GET_MODE),
            (h.check_send_available, S_CHECK),
            (h.send_packet, S_SEND),
            (h.register_callback, S_REG_CB),
            (h.pll_track, S_NOP),
        ] {
            if addr == 0 {
                continue;
            }
            let lui = 0x4006_02b7u32; // lui t0, 0x40060
            let jalr = ((slot * 4) << 20) | (5 << 15) | 0x67; // jalr x0, slot*4(t0)
            v.push((addr, lui as u16));
            v.push((addr + 2, (lui >> 16) as u16));
            v.push((addr + 4, jalr as u16));
            v.push((addr + 6, (jalr >> 16) as u16));
        }
        v.sort_unstable();
        v
    }

    /// Magic address list (for Cpu::hle_addrs)
    pub fn magic_addrs() -> Vec<u32> {
        (0..SLOTS).map(|i| MAGIC + 4 * i).collect()
    }
}

fn rd32(bus: &SocBus, a: u32) -> u32 {
    bus.mem_read(a, 4).unwrap_or(0)
}

/// Call firmware function f, returning to magic slot ret
fn call(cpu: &mut Cpu, f: u32, ret: u32, args: &[u32]) {
    for (i, a) in args.iter().enumerate() {
        cpu.x[10 + i] = *a;
    }
    cpu.x[1] = MAGIC + 4 * ret;
    cpu.pc = f;
    cpu.instret += 1;
    cpu.cycles += 1;
}

/// Push ra on the current stack (one 16-byte aligned frame)
fn push_ra(cpu: &mut Cpu, bus: &mut SocBus) {
    cpu.x[2] = cpu.x[2].wrapping_sub(16);
    bus.mem_write(cpu.x[2], 4, cpu.x[1]);
}

fn pop_ret(cpu: &mut Cpu, bus: &mut SocBus, ret: u32) {
    cpu.x[1] = rd32(bus, cpu.x[2]);
    cpu.x[2] = cpu.x[2].wrapping_add(16);
    cpu.hle_return(ret);
}

/// Simulated time (µs)
pub fn now_us(cpu: &Cpu) -> u64 {
    cpu.cycles / (crate::periph::CPU_HZ / 1_000_000)
}

pub fn call_slot(pc: u32, cpu: &mut Cpu, bus: &mut SocBus) {
    // Infallible: the only caller checks bus.ble.is_some() first.
    let mut b = bus.ble.take().expect("ble");
    slot(&mut b, (pc - MAGIC) / 4, cpu, bus);
    bus.ble = Some(b);
}

fn slot(b: &mut BleHle, s: u32, cpu: &mut Cpu, bus: &mut SocBus) {
    let a = |i: usize| cpu.x[10 + i];
    match s {
        S_OSI_REG => {
            let p = a(0);
            let (magic, ver) = (rd32(bus, p), rd32(bus, p + 4));
            if magic != OSI_MAGIC || !(0x0001_0009..=0x0001_000A).contains(&ver) {
                b.error = Some(format!(
                    "unknown bt.c osi function table version (magic {magic:08x} version {ver:08x})"
                ));
                cpu.hle_return(0x103);
                return;
            }
            b.osi = p;
            cpu.hle_return(0);
        }
        S_INIT => {
            // Create the stub task instead of the controller task; the task name lives in this frame briefly (xTaskCreate copies it)
            b.inited = true;
            b.world.active = true;
            push_ra(cpu, bus);
            let sp = cpu.x[2];
            for (i, w) in [u32::from_le_bytes(*b"btCt"), u32::from_le_bytes(*b"rl\0\0")]
                .iter()
                .enumerate()
            {
                bus.mem_write(sp + 4 + 4 * i as u32, 4, *w);
            }
            let f = rd32(bus, b.osi + OSI_TASK_CREATE);
            call(
                cpu,
                f,
                S_POP_RET0,
                &[MAGIC + 4 * S_ENTRY, sp + 4, TASK_STACK, 0, 23, 0, 0],
            );
        }
        S_POP_RET0 => pop_ret(cpu, bus, 0),
        S_ENABLE => cpu.hle_return(0),
        // ESP_BT_MODE_BLE
        S_GET_MODE => cpu.hle_return(1),
        S_CHECK => cpu.hle_return(1),
        S_REG_CB => {
            b.cb = a(0);
            cpu.hle_return(0);
        }
        S_SEND => {
            let (p, n) = (a(0), a(1) & 0xffff);
            let pkt: Vec<u8> = (0..n)
                .map(|i| bus.mem_read(p + i, 1).unwrap_or(0) as u8)
                .collect();
            b.world.host_send(&pkt, now_us(cpu));
            // For every packet the host waits for notify_host_send_available to return its send semaphore
            if b.cb != 0 {
                push_ra(cpu, bus);
                let f = rd32(bus, b.cb);
                call(cpu, f, S_SENT, &[]);
            } else {
                cpu.hle_return(0);
            }
        }
        S_SENT => {
            if b.sem != 0 {
                let f = rd32(bus, b.osi + OSI_SEMPHR_GIVE);
                call(cpu, f, S_POP_RET0, &[b.sem]);
            } else {
                pop_ret(cpu, bus, 0);
            }
        }
        S_ENTRY => {
            cpu.x[2] = cpu.x[2].wrapping_sub(BUF) & !15;
            b.buf = cpu.x[2];
            let f = rd32(bus, b.osi + OSI_SEMPHR_CREATE);
            call(cpu, f, S_CREATED, &[1, 0]);
        }
        S_CREATED => {
            b.sem = a(0);
            loop_step(b, cpu, bus);
        }
        S_LOOP => loop_step(b, cpu, bus),
        _ => cpu.hle_return(0),
    }
}

fn loop_step(b: &mut BleHle, cpu: &mut Cpu, bus: &mut SocBus) {
    let now = now_us(cpu);
    if b.cb != 0 {
        if let Some(pkt) = b.world.poll(now) {
            let n = pkt.len().min(BUF as usize);
            for (i, x) in pkt[..n].iter().enumerate() {
                bus.mem_write(b.buf + i as u32, 1, *x as u32);
            }
            let f = rd32(bus, b.cb + 4);
            call(cpu, f, S_LOOP, &[b.buf, n as u32]);
            return;
        }
    }
    let f = rd32(bus, b.osi + OSI_SEMPHR_TAKE);
    call(cpu, f, S_LOOP, &[b.sem, WAIT_MS]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boot::{find_app, parse_app};

    /// Signatures must not false-match: of all built C3 acceptance firmware (S3 images skipped by chip ID) only c3-ble-hr is BLE, with every entry found
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
            if name == "c3-ble-hr" {
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
                    assert!(a != 0 && a & 1 == 0, "{name}: {h:x?}");
                }
            } else {
                assert!(
                    matches!(r, Ok(None)),
                    "{name} wrongly detected as using BLE: {r:?}"
                );
            }
        }
        eprintln!("checked {n} firmware images");
    }
}
