//! 芯片无关的机器外壳：按镜像头芯片 ID 选 ESP32-C3 或 ESP32-S3，给 CLI 和 wasm 一套统一接口。
//! 新加芯片时在这里加一个分支，CLI / 网页不用改。

use std::collections::{HashMap, VecDeque};
use tryboard_elec::board::{Activity, Board, ChipKind, Power};
pub use tryboard_esp32c3::devices::audio::{Analysis as AudioAnalysis, Block as AudioBlock};
use tryboard_esp32c3::devices::audio::{Audio, MicSource};
use tryboard_esp32c3::devices::{
    bme280::{Bme280, Env},
    cst816s::Cst816s,
    ft6236::Ft6236,
    gc9a01::Gc9a01,
    imu::Pose,
    mpu6050::Mpu6050,
    qmi8658::Qmi8658,
    ssd1306::Ssd1306,
};
pub use tryboard_esp32c3::iotrace::IoEvent;
use tryboard_esp32c3::iotrace::IoTrace;
use tryboard_esp32c3::rmt::Ws2812;
use tryboard_esp32c3::Esp32c3;
use tryboard_esp32s3::Esp32s3;

pub use tryboard_esp32c3::periph::CPU_HZ;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Chip {
    Esp32c3,
    Esp32s3,
}

impl Chip {
    /// 镜像头里的芯片 ID（esp_app_format.h）
    pub fn from_image(flash: &[u8]) -> Option<Chip> {
        match tryboard_esp32s3::boot::image_chip_id(flash)? {
            5 => Some(Chip::Esp32c3),
            9 => Some(Chip::Esp32s3),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Chip::Esp32c3 => "esp32c3",
            Chip::Esp32s3 => "esp32s3",
        }
    }
    /// esp-rom-elfs 里该芯片 ROM 的文件名
    pub fn rom_file(self) -> &'static str {
        match self {
            Chip::Esp32c3 => "esp32c3_rev3_rom.elf",
            Chip::Esp32s3 => "esp32s3_rev0_rom.elf",
        }
    }
    pub fn npins(self) -> usize {
        match self {
            Chip::Esp32c3 => 22,
            Chip::Esp32s3 => tryboard_esp32s3::periph::NPINS,
        }
    }
    /// 网页 / tb_chip 用的数字编号，与镜像头芯片 ID 一致
    pub fn id(self) -> u32 {
        match self {
            Chip::Esp32c3 => 5,
            Chip::Esp32s3 => 9,
        }
    }
}

/// 一次运行的停止原因（芯片无关）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stop {
    Budget,
    /// 固件崩溃，文字说明
    Fault(String),
    /// 碰到没实现的 HLE 函数
    Hle(String),
    /// 固件请求软件复位（esp_restart / panic 后重启），值为复位原因；调用 reboot() 重新上电
    Reset(u32),
}

#[allow(clippy::large_enum_variant)]
pub enum Hw {
    C3(Esp32c3),
    S3(Esp32s3),
}

/// 外接线束（P2-11，估算，必须上真机）：I2C 排线总长、天线被金属件 / 电池挡住的衰减。
/// 和供电网络一样是外部世界：跨软件复位保留，复位后重新挂到新的总线 / Wi-Fi 模型上
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Harness {
    /// None = 理想总线（不算上升时间；之前所有用例都这样跑）
    pub i2c_wire_cm: Option<f64>,
    pub antenna_loss_db: i32,
}

/// 一台机器 = 芯片 + 开发板供电网络（tryboard-elec）。供电网络跨复位保留（它是外部世界）
pub struct Machine {
    pub hw: Hw,
    pub elec: Board,
    harness: Harness,
    /// 触摸控制器的 INT 脚接在哪个 GPIO（按着拉低、抬起回高）；None = 没接
    pub touch_int: Option<u32>,
}

pub struct BootInfo {
    pub offset: u32,
    pub entry: u32,
    pub segments: usize,
}

impl Machine {
    pub fn boot(rom: &[u8], flash: Vec<u8>) -> Result<(Machine, BootInfo), String> {
        match Chip::from_image(&flash) {
            Some(Chip::Esp32s3) => {
                let (m, a) = Esp32s3::boot(rom, flash)?;
                Ok((
                    Machine {
                        hw: Hw::S3(m),
                        elec: Board::new(ChipKind::S3),
                        touch_int: None,
                        harness: Harness::default(),
                    },
                    BootInfo {
                        offset: a.offset,
                        entry: a.entry,
                        segments: a.segments.len(),
                    },
                ))
            }
            Some(Chip::Esp32c3) | None => {
                let (m, a) = Esp32c3::boot(rom, flash)?;
                Ok((
                    Machine {
                        hw: Hw::C3(m),
                        elec: Board::new(ChipKind::C3),
                        touch_int: None,
                        harness: Harness::default(),
                    },
                    BootInfo {
                        offset: a.offset,
                        entry: a.entry,
                        segments: a.segments.len(),
                    },
                ))
            }
        }
    }

    /// 软件复位后重新上电：flash（含 NVS）保留，模拟时间继续。
    /// S3 另外保留 RTC 内存与 RTC_CNTL 存储寄存器（RTC_NOINIT、复位原因提示），见 Esp32s3::reboot
    pub fn reboot(&mut self, reason: u32) -> Result<(), String> {
        match &mut self.hw {
            Hw::C3(m) => m.reboot(reason)?,
            Hw::S3(m) => m.reboot(reason)?,
        }
        self.apply_harness();
        // 我们不跑 ROM 引导，ROM 每次复位都会打印的头三行由这里补上（复位原因与 ROM 的写法一致），
        // 网页和命令行串口里都能看到 rst:0x..（上电那一次不补：现有用例的串口输出保持不变）
        let banner = rom_banner(self.chip(), reason);
        self.console_push(banner.as_bytes());
        Ok(())
    }

    fn console_push(&mut self, b: &[u8]) {
        match &mut self.hw {
            Hw::C3(m) => m.bus.console.extend_from_slice(b),
            Hw::S3(m) => m.bus.console.extend_from_slice(b),
        }
    }

    pub fn harness(&self) -> Harness {
        self.harness
    }

    /// I2C 排线总长（cm）；None = 理想总线
    pub fn set_i2c_wire(&mut self, cm: Option<f64>) {
        self.harness.i2c_wire_cm = cm.map(|c| c.max(0.0));
        self.apply_harness();
    }

    /// 天线遮挡（dB，≥ 0）
    pub fn set_antenna_loss(&mut self, db: i32) {
        self.harness.antenna_loss_db = db.max(0);
        self.apply_harness();
    }

    fn apply_harness(&mut self) {
        let h = self.harness;
        self.i2c0().wire_cm = h.i2c_wire_cm;
        self.wifi_mut().world.antenna_loss_db = h.antenna_loss_db;
    }

    /// I2C0 总线负载：(上升时间 ns, 当前频率下的上限 ns, 结论)；理想总线 None
    pub fn i2c_load(&mut self) -> Option<(f64, f64, tryboard_elec::i2cbus::Verdict)> {
        self.i2c0().load()
    }

    /// 因上升时间超标读错的字节数、地址不应答次数（估算）
    pub fn i2c_slow_stats(&mut self) -> (u64, u64) {
        let b = self.i2c0();
        (b.slow_bytes, b.slow_nacks)
    }

    fn wifi_mut(&mut self) -> &mut tryboard_esp32c3::wifi::WifiMac {
        match &mut self.hw {
            Hw::C3(m) => m.bus.wifi_mut(),
            Hw::S3(m) => m.bus.wifi_mut(),
        }
    }

    /// 舵机信号接在哪个 GPIO（接上才有舵机电流；不接则供电网络只有芯片和模块）
    pub fn servo_attach(&mut self, pin: u32) {
        self.elec.attach_servo(pin);
    }

    /// 供电方式：USB（舵机也吃 USB 的 5V）或外接 5 V（舵机单独供电，共地）
    pub fn set_power(&mut self, p: Power) {
        self.elec.set_power(p);
    }

    /// 这一段运行里芯片在干什么，喂给供电网络
    fn activity(&self, c0: u64, i0: u64, w0: (u64, u64)) -> Activity {
        let dc = self.cycles().saturating_sub(c0).max(1);
        let busy = (self.instret().saturating_sub(i0)) as f64 / dc as f64;
        let w = self.wifi_frames();
        let tx_frames = w.0.saturating_sub(w0.0);
        let tx = tx_frames as f64 * self.elec.p.tx_airtime / (dc as f64 / CPU_HZ as f64);
        let servo_pw_us = self
            .elec
            .servo_pin
            .and_then(|p| self.pin_pwm(p as usize))
            .and_then(|(d, f)| {
                // 舵机只认 50 Hz 量级的脉冲；别的频率（蜂鸣器 kHz）不当舵机信号
                if (20.0..=500.0).contains(&f) && d > 0.0 {
                    Some(d as f64 / f as f64 * 1e6)
                } else {
                    None
                }
            });
        let amp_i = self
            .audio()
            .and_then(|a| a.speaker.as_ref())
            .map(|s| s.supply_current())
            .unwrap_or(0.0);
        Activity {
            busy,
            wifi_on: w.0 + w.1 > 0,
            tx,
            servo_pw_us,
            amp_i,
        }
    }

    /// Wi-Fi MAC 模型（两颗芯片共用 tryboard-soc 的实现）：空中日志、收发计数
    pub fn wifi(&self) -> &tryboard_esp32c3::wifi::WifiMac {
        match &self.hw {
            Hw::C3(m) => m.bus.wifi(),
            Hw::S3(m) => m.bus.wifi(),
        }
    }

    /// Wi-Fi 收发帧计数（发, 收）
    fn wifi_frames(&self) -> (u64, u64) {
        let w = self.wifi();
        (w.tx_frames, w.rx_frames)
    }

    /// 欠压复位按住期间：芯片不执行，时间照走（外设时间随 CPU 周期一起推进）
    fn hold(&mut self, cycles: u64) {
        match &mut self.hw {
            Hw::C3(m) => {
                m.cpu.cycles += cycles;
                m.bus.now = m.cpu.cycles;
            }
            Hw::S3(m) => {
                m.cpu.cycles += cycles;
                m.bus.now = m.cpu.cycles;
                if m.cpu1_on {
                    m.cpu1.cycles = m.cpu.cycles;
                }
            }
        }
    }

    /// 跑完一段之后推进供电网络；触发欠压就让这一段以"复位（原因 15 = RTCWDT_BROWN_OUT_RESET）"结束
    fn after_run(&mut self, c0: u64, i0: u64, w0: (u64, u64), r: Stop) -> Stop {
        let act = self.activity(c0, i0, w0);
        let now = self.cycles();
        if self.elec.advance(now, &act) && matches!(r, Stop::Budget | Stop::Reset(_)) {
            return Stop::Reset(BROWNOUT_RESET);
        }
        r
    }

    /// 原生 USB（只有 S3 有）
    pub fn usb(&self) -> Option<&tryboard_esp32s3::usb::Usb> {
        match &self.hw {
            Hw::S3(m) => m.bus.usb.as_deref(),
            Hw::C3(_) => None,
        }
    }

    pub fn usb_mut(&mut self) -> Option<&mut tryboard_esp32s3::usb::Usb> {
        match &mut self.hw {
            Hw::S3(m) => m.bus.usb.as_deref_mut(),
            Hw::C3(_) => None,
        }
    }

    /// BLE 虚拟世界（C-01）：固件里认出了 VHCI 边界才有（目前只有 C3）
    pub fn ble(&self) -> Option<&tryboard_esp32c3::ble::Ble> {
        match &self.hw {
            Hw::C3(m) => m.bus.ble.as_deref().map(|b| &*b.world),
            Hw::S3(_) => None,
        }
    }

    pub fn ble_mut(&mut self) -> Option<&mut tryboard_esp32c3::ble::Ble> {
        match &mut self.hw {
            Hw::C3(m) => m.bus.ble.as_deref_mut().map(|b| &mut *b.world),
            Hw::S3(_) => None,
        }
    }

    /// 固件用了 BLE 但没认出 VHCI 边界（或 HLE 出错）的原因；None = 没用 BLE 或一切正常
    pub fn ble_error(&self) -> Option<String> {
        match &self.hw {
            Hw::C3(m) => m
                .bus
                .ble_error
                .clone()
                .or_else(|| m.bus.ble.as_ref().and_then(|b| b.error.clone())),
            Hw::S3(_) => None,
        }
    }

    /// 虚拟手机操作（输入日志 `ble=` 后面那段）
    pub fn ble_phone(&mut self, cmd: &str) -> Result<(), String> {
        let now = self.cycles() / (CPU_HZ / 1_000_000);
        match self.ble_mut() {
            Some(b) => b.phone_cmd(cmd, now),
            None => Err("这个固件没有可模拟的 BLE".into()),
        }
    }

    pub fn chip(&self) -> Chip {
        match &self.hw {
            Hw::C3(_) => Chip::Esp32c3,
            Hw::S3(_) => Chip::Esp32s3,
        }
    }

    /// 跑 cycles 个周期，然后按这段时间的芯片活动推进供电网络。
    /// 欠压复位按住期间不执行指令（时间照走），电压回升后由下一次 run 接着从复位后的状态跑
    pub fn run(&mut self, cycles: u64) -> Stop {
        let (c0, i0, w0) = (self.cycles(), self.instret(), self.wifi_frames());
        if self.elec.held {
            self.hold(cycles);
            return self.after_run(c0, i0, w0, Stop::Budget);
        }
        let r = match &mut self.hw {
            Hw::C3(m) => {
                let r = m.run(cycles);
                c3_stop(m, r)
            }
            Hw::S3(m) => {
                let r = m.run(cycles);
                s3_stop(m, r)
            }
        };
        self.after_run(c0, i0, w0, r)
    }

    pub fn run_traced(&mut self, cycles: u64, ring: &mut VecDeque<u32>, cap: usize) -> Stop {
        let (c0, i0, w0) = (self.cycles(), self.instret(), self.wifi_frames());
        if self.elec.held {
            self.hold(cycles);
            return self.after_run(c0, i0, w0, Stop::Budget);
        }
        let r = match &mut self.hw {
            Hw::C3(m) => {
                let r = m.run_traced(cycles, ring, cap);
                c3_stop(m, r)
            }
            Hw::S3(m) => {
                let r = m.run_traced(cycles, ring, cap);
                s3_stop(m, r)
            }
        };
        self.after_run(c0, i0, w0, r)
    }

    /// 核 0 的周期数（模拟时间）
    pub fn cycles(&self) -> u64 {
        match &self.hw {
            Hw::C3(m) => m.cpu.cycles,
            Hw::S3(m) => m.cpu.cycles,
        }
    }

    pub fn instret(&self) -> u64 {
        match &self.hw {
            Hw::C3(m) => m.cpu.instret,
            Hw::S3(m) => m.cpu.instret + if m.cpu1_on { m.cpu1.instret } else { 0 },
        }
    }

    pub fn pc(&self) -> u32 {
        match &self.hw {
            Hw::C3(m) => m.cpu.pc,
            Hw::S3(m) => m.cpu.pc,
        }
    }

    pub fn console_take(&mut self) -> Vec<u8> {
        match &mut self.hw {
            Hw::C3(m) => m.console_take(),
            Hw::S3(m) => m.console_take(),
        }
    }

    pub fn gpio_level(&self) -> u64 {
        match &self.hw {
            Hw::C3(m) => m.bus.gpio.level() as u64,
            Hw::S3(m) => m.bus.gpio.level(),
        }
    }

    pub fn gpio_enable(&self) -> u64 {
        match &self.hw {
            Hw::C3(m) => m.bus.gpio.enable as u64,
            Hw::S3(m) => m.bus.gpio.enable,
        }
    }

    /// 外部驱动一个引脚（按键等）。level < 0 表示松开（不驱动）
    pub fn gpio_drive(&mut self, pin: u32, level: i32) {
        macro_rules! drive {
            ($m:expr, $one:expr) => {{
                let bit = $one << pin;
                let g = &mut $m.bus.gpio;
                if level < 0 {
                    g.ext_driven &= !bit;
                } else {
                    g.ext_driven |= bit;
                    if level > 0 {
                        g.ext_in |= bit;
                    } else {
                        g.ext_in &= !bit;
                    }
                }
                let now = $m.cpu.cycles;
                $m.bus.gpio_changed(now);
            }};
        }
        match &mut self.hw {
            Hw::C3(m) => drive!(m, 1u32),
            Hw::S3(m) => drive!(m, 1u64),
        }
    }

    /// 板载 BOOT 键所在引脚（C3：GPIO9，S3：GPIO0）
    pub fn boot_pin(&self) -> u32 {
        match &self.hw {
            Hw::C3(_) => 9,
            Hw::S3(_) => 0,
        }
    }

    pub fn uart_push(&mut self, data: &[u8]) {
        match &mut self.hw {
            Hw::C3(m) => {
                m.bus.uart0.push_rx(data);
                m.bus.irq_dirty = true;
            }
            Hw::S3(m) => {
                m.bus.uart0.push_rx(data);
                m.bus.irq_dirty = true;
            }
        }
    }

    pub fn pin_pwm(&self, pin: usize) -> Option<(f32, f32)> {
        match &self.hw {
            Hw::C3(m) => m.bus.pin_pwm(pin),
            Hw::S3(m) => m.bus.pin_pwm(pin),
        }
    }

    /// 引脚上的模拟电压（毫伏），给 ADC 读
    pub fn analog_set(&mut self, pin: usize, mv: f32) {
        let slot = match &mut self.hw {
            Hw::C3(m) => m.bus.adc.pin_mv.get_mut(pin),
            Hw::S3(m) => m.bus.adc.pin_mv.get_mut(pin),
        };
        if let Some(p) = slot {
            *p = mv;
        }
    }

    pub fn ws2812(&self) -> &HashMap<u32, Ws2812> {
        match &self.hw {
            Hw::C3(m) => &m.bus.ws2812,
            Hw::S3(m) => &m.bus.ws2812,
        }
    }

    fn i2c0(&mut self) -> &mut tryboard_esp32c3::i2c::I2c {
        match &mut self.hw {
            Hw::C3(m) => &mut m.bus.i2c0,
            Hw::S3(m) => &mut m.bus.i2c0,
        }
    }

    /// 在 I2C0 总线上接一个器件（"ssd1306" / "bme280"）
    pub fn i2c_attach(&mut self, kind: &str, addr: u8) -> bool {
        match tryboard_esp32c3::devices::make_i2c(kind, addr) {
            Some(d) => {
                self.i2c0().attach(d);
                self.elec.add_module(kind);
                true
            }
            None => false,
        }
    }

    pub fn i2c_stats(&mut self) -> (u64, u64) {
        let b = self.i2c0();
        (b.transactions, b.nacks)
    }

    pub fn env_set(&mut self, env: Env) {
        let t = env.temp_c;
        let bus = self.i2c0();
        if let Some(b) = bus.device::<Bme280>() {
            b.env = env;
        }
        // IMU 的片上温度计读的是芯片温度：取环境温度（自热不建模）
        if let Some(d) = bus.device::<Mpu6050>() {
            d.temp_c = t;
        }
        if let Some(d) = bus.device::<Qmi8658>() {
            d.temp_c = t;
        }
    }

    /// 姿态（作用于总线上的 MPU6050 / QMI8658）：欧拉角（度）+ 欧拉角速率（°/s），见 devices/imu.rs
    pub fn imu_set(&mut self, pose: Pose) {
        let bus = self.i2c0();
        if let Some(d) = bus.device::<Mpu6050>() {
            d.pose = pose;
        }
        if let Some(d) = bus.device::<Qmi8658>() {
            d.pose = pose;
        }
    }

    /// 触摸控制器 INT 接在哪个 GPIO：接上就先驱动成高电平（没按）
    pub fn touch_int_attach(&mut self, pin: u32) {
        self.touch_int = Some(pin);
        self.gpio_drive(pin, 1);
    }

    /// 手指在触摸屏上（x, y 为屏幕像素；CST816S 截到 0..239，FT6236 是 12 位）：down = false 表示抬起
    pub fn touch(&mut self, x: u16, y: u16, down: bool) {
        let now = self.cycles();
        let bus = self.i2c0();
        if let Some(d) = bus.device::<Cst816s>() {
            if down {
                d.press(x, y, now);
            } else {
                d.release(now);
            }
        } else if let Some(d) = bus.device::<Ft6236>() {
            if down {
                d.press(x, y);
            } else {
                d.release();
            }
        } else {
            return;
        }
        if let Some(pin) = self.touch_int {
            self.gpio_drive(pin, if down { 0 } else { 1 });
        }
    }

    pub fn oled(&mut self) -> Option<&mut Ssd1306> {
        self.i2c0().device::<Ssd1306>()
    }

    /// 在 SPI2 上接一块屏（目前只有 "gc9a01"）。引脚按芯片不同：
    /// S3 见 tryboard_esp32s3::lcd_pin，C3 见 tryboard_esp32c3::lcd_pin
    pub fn lcd_attach(&mut self, kind: &str) -> bool {
        match (&mut self.hw, kind) {
            (Hw::S3(m), "gc9a01") => {
                m.bus.attach_lcd();
                self.elec.add_module("gc9a01");
                true
            }
            (Hw::C3(m), "gc9a01") => {
                m.bus.attach_lcd();
                self.elec.add_module("gc9a01");
                true
            }
            _ => false,
        }
    }

    pub fn lcd(&mut self) -> Option<&mut Gc9a01> {
        match &mut self.hw {
            Hw::S3(m) => m.bus.lcd.as_deref_mut(),
            Hw::C3(m) => m.bus.lcd.as_deref_mut(),
        }
    }

    pub fn audio(&self) -> Option<&Audio> {
        let a = match &self.hw {
            Hw::S3(m) => &m.bus.audio,
            Hw::C3(m) => &m.bus.audio,
        };
        (!a.is_empty()).then_some(a)
    }

    fn audio_mut(&mut self) -> &mut Audio {
        match &mut self.hw {
            Hw::S3(m) => &mut m.bus.audio,
            Hw::C3(m) => &mut m.bus.audio,
        }
    }

    /// 接 I2S 音频器件："max98357a"（喇叭）/ "inmp441"（麦克风）。引脚按芯片：
    /// S3 见 tryboard_esp32s3::i2s_pin，C3 见 tryboard_esp32c3::i2s_pin
    pub fn i2s_attach(&mut self, kind: &str) -> bool {
        match (&mut self.hw, kind) {
            (Hw::S3(m), "max98357a") => m.bus.attach_speaker(),
            (Hw::C3(m), "max98357a") => m.bus.attach_speaker(),
            (Hw::S3(m), "inmp441") => m.bus.attach_mic(),
            (Hw::C3(m), "inmp441") => m.bus.attach_mic(),
            _ => return false,
        }
        self.elec.add_module(kind);
        true
    }

    /// 麦克风听固定 WAV（循环）；没接麦克风时先接上
    pub fn mic_wav(&mut self, rate: f64, data: Vec<f32>) {
        if self.audio_mut().mic.is_none() {
            self.i2s_attach("inmp441");
        }
        if let Some(m) = self.audio_mut().mic.as_mut() {
            m.source = MicSource::Wav { rate, data };
        }
    }

    /// 麦克风听实时推入的声音（网页麦克风），rate = 推入数据的采样率
    pub fn mic_push(&mut self, rate: f64, x: &[f32]) {
        if let Some(m) = self.audio_mut().mic.as_mut() {
            m.push_live(rate, x);
        }
    }

    /// 麦克风回到安静
    pub fn mic_silence(&mut self) {
        if let Some(m) = self.audio_mut().mic.as_mut() {
            m.source = MicSource::Silence;
        }
    }

    /// 取走喇叭攒下的声音（带模拟时刻）
    pub fn audio_take(&mut self) -> Vec<AudioBlock> {
        self.audio_mut()
            .speaker
            .as_mut()
            .map(|s| s.take())
            .unwrap_or_default()
    }

    /// 喇叭最近 secs 秒的读数
    pub fn audio_analyze(&self, secs: f64) -> Option<AudioAnalysis> {
        self.audio()?.speaker.as_ref().map(|s| s.analyze(secs))
    }

    /// `[tryboard] I2S …` 观察记录（没接音频器件时为空）
    pub fn audio_report(&self) -> String {
        self.audio().map(|a| a.report()).unwrap_or_default()
    }

    /// SPI2 传输统计（次数, MOSI 字节数）
    pub fn spi_stats(&self) -> (u64, u64) {
        match &self.hw {
            Hw::S3(m) => (m.bus.spi2.transfers, m.bus.spi2.bytes),
            Hw::C3(m) => (m.bus.spi2.transfers, m.bus.spi2.bytes),
        }
    }

    fn pins(&mut self) -> &mut tryboard_esp32c3::devices::pins::PinDevices {
        match &mut self.hw {
            Hw::C3(m) => &mut m.bus.pins,
            Hw::S3(m) => &mut m.bus.pins,
        }
    }

    /// 让 SoC 马上重新问一次外接引脚器件（新排了波形）
    fn pins_kick(&mut self) {
        match &mut self.hw {
            Hw::C3(m) => {
                m.bus.next_event = 0;
                m.bus.irq_dirty = true;
            }
            Hw::S3(m) => {
                m.bus.next_event = 0;
                m.bus.irq_dirty = true;
            }
        }
    }

    /// 接一个旋转编码器（P2-01）：A / B 两相与可选的按键脚；3V3 供电，电流进供电网络
    pub fn encoder_attach(&mut self, a: u32, b: u32, sw: Option<u32>) {
        let now = self.cycles();
        self.pins()
            .encoders
            .push(tryboard_esp32c3::devices::pins::Encoder::new(a, b, sw, now));
        self.elec.add_module("encoder");
        self.pins_kick();
    }

    /// 编码器转 steps 格（正 = 顺时针）；脚本动作 enc=+N / enc=-N
    pub fn encoder_turn(&mut self, steps: i32) {
        let now = self.cycles();
        if let Some(e) = self.pins().encoders.first_mut() {
            e.turn(now, steps);
        }
        self.pins_kick();
    }

    /// 编码器按键；脚本动作 encsw=1|0
    pub fn encoder_press(&mut self, down: bool) {
        let now = self.cycles();
        if let Some(e) = self.pins().encoders.first_mut() {
            e.press(now, down);
        }
        self.pins_kick();
    }

    /// 编码器已经转完的格数（顺时针为正）
    pub fn encoder_position(&mut self) -> Option<i64> {
        self.pins().encoders.first().map(|e| e.position)
    }

    /// 接一个 HC-SR04（P2-04）：Trig 由芯片驱动，Echo 由模块驱动；5 V 供电，电流进 5V 轨
    pub fn sonar_attach(&mut self, trig: u32, echo: u32) {
        let now = self.cycles();
        self.pins()
            .sonars
            .push(tryboard_esp32c3::devices::pins::Hcsr04::new(
                trig, echo, now,
            ));
        self.elec.add_module("hcsr04");
        self.pins_kick();
    }

    /// 探头到障碍物的距离（cm）；负数 = 前方没有东西（超量程）。脚本动作 dist=厘米
    pub fn sonar_distance(&mut self, cm: f64) {
        if let Some(s) = self.pins().sonars.first_mut() {
            s.distance_cm = (cm >= 0.0).then_some(cm);
        }
    }

    /// 超声波的统计（触发次数, 回波次数, 最近回波宽度 µs）
    pub fn sonar_stats(&mut self) -> Option<(u64, u64, f64)> {
        self.pins()
            .sonars
            .first()
            .map(|s| (s.pings, s.echoes, s.last_us))
    }

    /// 脉冲计数器单元 u 的当前计数（只有 S3 有 PCNT）
    pub fn pcnt_count(&self, u: usize) -> Option<i16> {
        match &self.hw {
            Hw::S3(m) => Some(m.bus.pcnt.count(u)),
            Hw::C3(_) => None,
        }
    }

    /// GPIO 电平变化记录（周期, 电平）
    pub fn gpio_log(&self) -> Vec<(u64, u64)> {
        match &self.hw {
            Hw::C3(m) => m
                .bus
                .gpio_log
                .iter()
                .map(|(t, l)| (*t, *l as u64))
                .collect(),
            Hw::S3(m) => m.bus.gpio_log.clone(),
        }
    }

    fn iotrace(&mut self) -> &mut IoTrace {
        match &mut self.hw {
            Hw::C3(m) => &mut m.bus.iotrace,
            Hw::S3(m) => &mut m.bus.iotrace,
        }
    }

    /// 逻辑分析仪要观察的 GPIO（位 = 引脚号）。PWM / WS2812 / I2C 事件总是记
    pub fn io_watch(&mut self, mask: u64) {
        self.iotrace().watch = mask;
    }

    /// 事件缓冲上限（条）；0 = 不记
    pub fn io_cap(&mut self, cap: usize) {
        self.iotrace().cap = cap;
    }

    /// 取走事件缓冲里的全部事件（按记录先后）
    pub fn io_take(&mut self) -> Vec<IoEvent> {
        self.iotrace().take()
    }

    /// 缓冲满了丢掉的条数
    pub fn io_dropped(&mut self) -> u64 {
        self.iotrace().dropped
    }

    /// 上电时的引脚电平（gpio_log 的起点）
    pub fn gpio_reset_level(&self) -> u64 {
        match &self.hw {
            Hw::C3(_) => 0,
            Hw::S3(_) => 1,
        }
    }

    pub fn unimpl(&self) -> Vec<(u32, u64)> {
        let m = match &self.hw {
            Hw::C3(m) => &m.bus.unimpl,
            Hw::S3(m) => &m.bus.unimpl,
        };
        let mut v: Vec<_> = m.iter().map(|(a, n)| (*a, *n)).collect();
        v.sort_by_key(|x| std::cmp::Reverse(x.1));
        v
    }

    /// 读一个 32 位字（调试用，会触发 MMIO 读副作用）
    pub fn peek(&mut self, a: u32) -> Option<u32> {
        match &mut self.hw {
            Hw::C3(m) => tryboard_rv32::Bus::load(&mut m.bus, a, 4).ok(),
            Hw::S3(m) => tryboard_xtensa::Bus::load(&mut m.bus, a, 4).ok(),
        }
    }

    /// 停机时的 CPU 状态说明（调试用），sym 把地址翻成符号
    pub fn debug_state(&self, sym: &dyn Fn(u32) -> String) -> String {
        match &self.hw {
            Hw::C3(m) => format!("pc {}  ra {}", sym(m.cpu.pc), sym(m.cpu.x[1])),
            Hw::S3(m) => {
                use tryboard_xtensa::sr;
                let core = |c: &tryboard_xtensa::Cpu, k: usize| {
                    format!(
                        "核{k} pc {}  PS=0x{:08x} WB={} WS=0x{:04x} INTENABLE=0x{:08x} INTERRUPT=0x{:08x} EXCCAUSE={} EPC1={}",
                        sym(c.pc),
                        c.ps(),
                        c.windowbase,
                        c.windowstart,
                        c.read_sr(sr::INTENABLE),
                        c.read_sr(sr::INTERRUPT),
                        c.read_sr(sr::EXCCAUSE),
                        sym(c.read_sr(sr::EPC1)),
                    )
                };
                let mut s = core(&m.cpu, 0);
                if m.cpu1_on {
                    s += "\n[tryboard] ";
                    s += &core(&m.cpu1, 1);
                }
                s
            }
        }
    }
}

/// RTCWDT_BROWN_OUT_RESET（esp_rom rtc.h，S3 / C3 相同）：esp_reset_reason() 读到 ESP_RST_BROWNOUT
pub const BROWNOUT_RESET: u32 = 15;

/// ROM 复位后打印的头三行（ESP32-S3 rev0 ROM 20210327、ESP32-C3 ROM 20210207 的格式）
pub fn rom_banner(chip: Chip, reason: u32) -> String {
    let name = match reason {
        1 => "POWERON",
        3 => "RTC_SW_SYS_RST",
        12 => "RTC_SW_CPU_RST",
        15 => "BROWNOUT_RST",
        _ => "UNKNOWN",
    };
    match chip {
        Chip::Esp32s3 => format!("ESP-ROM:esp32s3-20210327\nBuild:Mar 27 2021\nrst:0x{reason:x} ({name}),boot:0x8 (SPI_FAST_FLASH_BOOT)\n"),
        Chip::Esp32c3 => format!("ESP-ROM:esp32c3-api1-20210207\nBuild:Feb  7 2021\nrst:0x{reason:x} ({name}),boot:0xc (SPI_FAST_FLASH_BOOT)\n"),
    }
}

fn c3_stop(m: &Esp32c3, r: tryboard_esp32c3::Stop) -> Stop {
    use tryboard_esp32c3::Stop as S;
    match r {
        S::Budget => Stop::Budget,
        S::Fault { cause, pc, tval } => Stop::Fault(format!(
            "CPU 异常 cause={cause} pc=0x{pc:08x} tval=0x{tval:08x}"
        )),
        S::Hle(pc) => Stop::Hle(format!("0x{pc:08x} {}", m.symbol_at(pc).unwrap_or(""))),
        S::Reset(r) => Stop::Reset(r),
    }
}

fn s3_stop(m: &Esp32s3, r: tryboard_esp32s3::Stop) -> Stop {
    use tryboard_esp32s3::Stop as S;
    match r {
        S::Budget => Stop::Budget,
        S::Fault { cause, epc, vaddr } => Stop::Fault(format!(
            "CPU 异常 EXCCAUSE={cause} EPC1=0x{epc:08x} EXCVADDR=0x{vaddr:08x}"
        )),
        S::Break(v) => Stop::Fault(format!("BREAK 0x{v:x}")),
        S::Hle(pc) => Stop::Hle(format!("0x{pc:08x} {}", m.symbol_at(pc).unwrap_or(""))),
        S::Reset(r) => Stop::Reset(r),
    }
}

pub use tryboard_esp32c3::devices::bme280::Env as SensorEnv;
pub use tryboard_esp32c3::devices::imu::Pose as ImuPose;

/// 脚本动作 `imu=pitch,roll,yaw[,dpitch,droll,dyaw]`（度、°/s）的参数部分
pub fn parse_imu(s: &str) -> Option<Pose> {
    let v: Vec<f64> = s
        .split(',')
        .map(|x| x.trim().parse().ok())
        .collect::<Option<_>>()?;
    match v.as_slice() {
        [p, r, y] => Some(Pose::new(*p, *r, *y)),
        [p, r, y, dp, dr, dy] => Some(Pose {
            pitch: *p,
            roll: *r,
            yaw: *y,
            dpitch: *dp,
            droll: *dr,
            dyaw: *dy,
        }),
        _ => None,
    }
}

/// 脚本动作 `touch=x,y` 的参数部分（屏幕像素）。按触摸芯片的 12 位坐标上限截断，
/// 具体屏多大由器件模型自己截（CST816S 的圆屏 240×240）
pub fn parse_touch(s: &str) -> Option<(u16, u16)> {
    let (x, y) = s.split_once(',')?;
    let f = |t: &str| {
        t.trim()
            .parse::<f64>()
            .ok()
            .map(|v| v.round().clamp(0.0, 4095.0) as u16)
    };
    Some((f(x)?, f(y)?))
}
pub use tryboard_elec::board::Power as PowerMode;

/// I2C 排线（P2-11）的一行结论；没设线长（理想总线）返回 None。命令行与网页共用这段文字
pub fn harness_i2c_line(m: &mut Machine) -> Option<String> {
    use tryboard_elec::i2cbus::Verdict;
    let cm = m.harness().i2c_wire_cm?;
    let (rise, limit, v) = m.i2c_load()?;
    let khz = m.i2c0().scl_hz() / 1000.0;
    let (bad, nacks) = m.i2c_slow_stats();
    let what = match v {
        Verdict::Ok => "在规范内".to_string(),
        Verdict::Marginal => format!("超出规范：读回的字节会错（已读错 {bad} 字节）"),
        Verdict::Fail => format!("超出两倍：器件不应答（NACK {nacks} 次）"),
    };
    Some(format!("[tryboard] I2C 排线 {cm} cm：上升时间 {rise:.0} ns，{khz:.0} kHz 允许 {limit:.0} ns，{what}（估算，必须上真机）"))
}

/// 天线遮挡（P2-11）的一行结论；没遮挡返回 None
pub fn harness_wifi_line(m: &Machine) -> Option<String> {
    use tryboard_esp32c3::wifi::world::{LINK_MIN_DBM, SCAN_MIN_DBM};
    let db = m.harness().antenna_loss_db;
    if db == 0 {
        return None;
    }
    let w = &m.wifi().world;
    let aps: Vec<String> = (0..w.aps.len())
        .map(|i| {
            let r = w.rssi(i) as i32;
            let note = if r < SCAN_MIN_DBM {
                "（收不到）"
            } else if r < LINK_MIN_DBM {
                "（连不上）"
            } else {
                ""
            };
            format!("{} {r} dBm{note}", w.aps[i].ssid)
        })
        .collect();
    Some(format!(
        "[tryboard] 天线遮挡 {db} dB：{}（估算，必须上真机）",
        aps.join("、")
    ))
}

/// 关卡验收要看的 USB 虚拟主机结论（P2-12）：主机状态 + 键盘打出的字。
/// 命令行 `--usb-log` 打印的就是这两行（另有枚举日志等），网页 wasm tb_usb_report 同一段文字，指纹两边一致
pub fn usb_report_lines(m: &Machine) -> String {
    let Some(u) = m.usb() else {
        return String::new();
    };
    let h = &u.host;
    let mut o = format!("[tryboard] USB 主机：{}\n", h.state_name());
    if !h.typed.is_empty() {
        o.push_str(&format!("[tryboard] USB 键盘输入: {:?}\n", h.typed));
    }
    o
}

/// 生成检查点的 I2C 判据（U-17）：每个被寻址过的 7 位地址应答了几次，按地址升序。
/// 命令行 `--i2c-log` 打印的就是这几行，网页 wasm tb_i2c_report 同一段文字，指纹两边一致。
/// S3 两个控制器合在一起：用户接在哪个控制器上都算接上了
pub fn i2c_ack_lines(m: &Machine) -> String {
    let mut acks: std::collections::BTreeMap<u8, u64> = std::collections::BTreeMap::new();
    let mut add = |b: &tryboard_esp32c3::i2c::I2c| {
        for (a, (_, ok)) in &b.addr_acks {
            *acks.entry(*a).or_insert(0) += ok;
        }
    };
    match &m.hw {
        Hw::C3(c) => add(&c.bus.i2c0),
        Hw::S3(s) => {
            add(&s.bus.i2c0);
            add(&s.bus.i2c1);
        }
    }
    acks.iter()
        .map(|(a, n)| format!("[tryboard] I2C 0x{a:02x} 应答 {n} 次\n"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imu_touch_actions() {
        assert_eq!(parse_imu("30,-20,5"), Some(Pose::new(30.0, -20.0, 5.0)));
        assert_eq!(parse_imu("1,2,3,4,5,6").map(|p| p.dyaw), Some(6.0));
        assert_eq!(parse_imu("1,2"), None);
        assert_eq!(parse_touch("120.4, 300"), Some((120, 300)));
        assert_eq!(parse_touch("-3, 9000"), Some((0, 4095)));
        assert_eq!(parse_touch("x,1"), None);
    }
}
