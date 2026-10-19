//! C3 的 BLE 接入（C-01 路线 a′）：在用户固件里按签名找到 libbtdm 的 VHCI 边界，入口改成跳到 HLE 魔术地址。
//!
//! 被替换的函数（libbtdm 里的符号）：
//! - `btdm_osi_funcs_register`：记下 bt.c 的 OS 适配函数表（信号量、建任务都借它调回 FreeRTOS）
//! - `btdm_controller_init`：不跑真控制器，借 osi 的 task_create 建一个"桩任务"代替控制器任务
//! - `btdm_controller_enable` / `btdm_controller_get_mode`：直接成功 / 报 BLE 模式
//! - `API_vhci_host_check_send_available` / `_send_packet` / `_register_callback`：HCI 进出口
//!
//! 桩任务全部是 HLE（没有一条真指令）：等信号量 → 有到期事件就调主机的 notify_host_recv 交出去 → 再等。
//! 调固件函数用"改 ra 指向下一个魔术地址"的接力写法；中间要保存的 ra 压在当前任务自己的栈上，可重入。
//!
//! 入口不改 flash：取指时由 [`SocBus::code_patch`] 覆盖成 `lui t0, 0x40060; jalr x0, off(t0)`，
//! flash 内容（用户导出、复位后重新找签名）保持原样。

use crate::SocBus;
use tryboard_rv32::Cpu;
use tryboard_soc::ble::sig::{self, Hooks, Seg};
pub use tryboard_soc::ble::Ble;

/// HLE 魔术地址区（紧跟在 ROM 之后，没有实际存储）
pub const MAGIC: u32 = 0x4006_0000;
pub const MAGIC_END: u32 = MAGIC + 4 * SLOTS;

const S_OSI_REG: u32 = 0;
const S_INIT: u32 = 1;
const S_ENABLE: u32 = 2;
const S_GET_MODE: u32 = 3;
const S_CHECK: u32 = 4;
const S_SEND: u32 = 5;
const S_REG_CB: u32 = 6;
/// 接力：弹出保存的 ra，返回 0
const S_POP_RET0: u32 = 7;
/// 桩任务入口 / 信号量建好 / 主循环
const S_ENTRY: u32 = 8;
const S_CREATED: u32 = 9;
const S_LOOP: u32 = 10;
/// send_packet 里 notify_host_send_available 返回后：给桩任务的信号量
const S_SENT: u32 = 11;
/// sdk_config_extend_set_pll_track：空转
const S_NOP: u32 = 12;
const SLOTS: u32 = 13;

// osi_funcs_t 偏移（IDF 5.1–5.5.1 的 bt.c 都相同，版本号 0x00010009 / 0x0001000A）
const OSI_MAGIC: u32 = 0xFADE_BEAD;
const OSI_SEMPHR_CREATE: u32 = 36;
const OSI_SEMPHR_TAKE: u32 = 52;
const OSI_SEMPHR_GIVE: u32 = 56;
const OSI_TASK_CREATE: u32 = 100;

/// 桩任务栈：主机的收包回调（拷贝、进 NimBLE 事件队列）在这个栈上跑，留足
const TASK_STACK: u32 = 6144;
/// 栈上留给"发给主机的一个包"的缓冲
const BUF: u32 = 528;
/// 桩任务每次最多等多久（毫秒）：连接事件 30 ms、广播几十毫秒，10 ms 一醒够细
const WAIT_MS: u32 = 10;

pub struct BleHle {
    pub hooks: Hooks,
    osi: u32,
    /// vhci_host_callback_t*：{notify_host_send_available, notify_host_recv}
    cb: u32,
    sem: u32,
    buf: u32,
    pub world: Box<Ble>,
    /// 固件调用过 btdm_controller_init（网页据此显示"蓝牙"页签）
    pub inited: bool,
    /// HLE 出错（osi 版本不认识等）
    pub error: Option<String>,
}

/// 在 app 段里找签名。返回 Ok(None) = 固件没用 BLE；Err = 用了但没认出来（网页提示拖 app.elf）
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

    /// 取指覆盖：每个入口 8 字节跳板（按半字，与取指一致）
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

    /// 魔术地址列表（给 Cpu::hle_addrs）
    pub fn magic_addrs() -> Vec<u32> {
        (0..SLOTS).map(|i| MAGIC + 4 * i).collect()
    }
}

fn rd32(bus: &SocBus, a: u32) -> u32 {
    bus.mem_read(a, 4).unwrap_or(0)
}

/// 调固件函数 f，返回到魔术槽 ret
fn call(cpu: &mut Cpu, f: u32, ret: u32, args: &[u32]) {
    for (i, a) in args.iter().enumerate() {
        cpu.x[10 + i] = *a;
    }
    cpu.x[1] = MAGIC + 4 * ret;
    cpu.pc = f;
    cpu.instret += 1;
    cpu.cycles += 1;
}

/// 把 ra 压到当前栈（16 字节对齐的一帧）
fn push_ra(cpu: &mut Cpu, bus: &mut SocBus) {
    cpu.x[2] = cpu.x[2].wrapping_sub(16);
    bus.mem_write(cpu.x[2], 4, cpu.x[1]);
}

fn pop_ret(cpu: &mut Cpu, bus: &mut SocBus, ret: u32) {
    cpu.x[1] = rd32(bus, cpu.x[2]);
    cpu.x[2] = cpu.x[2].wrapping_add(16);
    cpu.hle_return(ret);
}

/// 模拟时间（微秒）
pub fn now_us(cpu: &Cpu) -> u64 {
    cpu.cycles / (crate::periph::CPU_HZ / 1_000_000)
}

pub fn call_slot(pc: u32, cpu: &mut Cpu, bus: &mut SocBus) {
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
                    "bt.c 的 osi 函数表版本不认识（magic {magic:08x} 版本 {ver:08x}）"
                ));
                cpu.hle_return(0x103);
                return;
            }
            b.osi = p;
            cpu.hle_return(0);
        }
        S_INIT => {
            // 建桩任务代替控制器任务；任务名临时放在本帧里（xTaskCreate 会拷走）
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
            // 主机每发一包都要等 notify_host_send_available 把它的发送信号量还回来
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

    /// 签名不能在别的固件里误中：仓库里所有已构建的 C3 验收固件（S3 镜像芯片 ID 不对，跳过），只有 c3-ble-hr 认出 BLE，且每个入口都找到
    #[test]
    fn sigs_hit_only_ble_firmware() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../firmware/build");
        let Ok(rd) = std::fs::read_dir(&dir) else {
            eprintln!("跳过：没有 firmware/build");
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
                    .expect("应认出 BLE");
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
                assert!(matches!(r, Ok(None)), "{name} 误认为用了 BLE：{r:?}");
            }
        }
        eprintln!("检查了 {n} 个固件");
    }
}
