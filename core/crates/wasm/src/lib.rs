//! 浏览器绑定：裸 extern "C" 导出，JS 侧通过线性内存读写缓冲区。
//! 一个 wasm 实例只跑一台机器（多块板子就开多个实例 / Worker）。芯片按镜像头自动识别（ESP32-C3 / ESP32-S3），
//! JS 先用 tb_image_chip 看镜像是哪颗芯片、取对应的 ROM，再 tb_boot。

use std::cell::RefCell;
use tryboard_machine::{Chip, ImuPose, Machine, PowerMode, SensorEnv, Stop};

thread_local! {
    static M: RefCell<Option<Machine>> = const { RefCell::new(None) };
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static ERR: RefCell<String> = const { RefCell::new(String::new()) };
    static WS: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static USB_JSON: RefCell<String> = const { RefCell::new(String::new()) };
    static REPORT: RefCell<String> = const { RefCell::new(String::new()) };
    static IO: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static TASKS: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static TASKS_JSON: RefCell<String> = const { RefCell::new(String::new()) };
    static AUDIO: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    // 本次上电以来 tb_run 里做过几次复位重新上电；上限（u32::MAX = 不限）给离线验收对齐 CLI 的"最多 50 次"
    static FAULT: RefCell<[f64; 4]> = const { RefCell::new([0.0; 4]) };
    static RESETS: std::cell::Cell<(u32, u32)> = const { std::cell::Cell::new((0, u32::MAX)) };
}

fn with<R>(default: R, f: impl FnOnce(&mut Machine) -> R) -> R {
    M.with(|c| c.borrow_mut().as_mut().map(f).unwrap_or(default))
}

#[no_mangle]
pub extern "C" fn tb_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// p 必须来自 tb_alloc(len)
#[no_mangle]
pub unsafe extern "C" fn tb_free(p: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(p, 0, len));
}

/// 镜像是哪颗芯片：5 = ESP32-C3，9 = ESP32-S3，0 = 认不出（按 C3 处理）
/// # Safety
/// 指针必须指向长度正确的缓冲区
#[no_mangle]
pub unsafe extern "C" fn tb_image_chip(flash: *const u8, flash_len: usize) -> u32 {
    let flash = std::slice::from_raw_parts(flash, flash_len);
    Chip::from_image(flash).map(|c| c.id()).unwrap_or(0)
}

/// 旧名字（USB 分支的网页用过），同 tb_image_chip
/// # Safety
/// 指针必须指向长度正确的缓冲区
#[no_mangle]
pub unsafe extern "C" fn tb_flash_chip(flash: *const u8, flash_len: usize) -> u32 {
    tb_image_chip(flash, flash_len)
}

/// 返回 0 成功；非 0 时用 tb_error_ptr/len 取错误信息。
/// # Safety
/// 指针必须指向 tb_alloc 分配、长度正确的缓冲区
#[no_mangle]
pub unsafe extern "C" fn tb_boot(
    rom: *const u8,
    rom_len: usize,
    flash: *const u8,
    flash_len: usize,
) -> i32 {
    let rom = std::slice::from_raw_parts(rom, rom_len);
    let flash = std::slice::from_raw_parts(flash, flash_len).to_vec();
    match Machine::boot(rom, flash) {
        Ok((m, _)) => {
            M.with(|c| *c.borrow_mut() = Some(m));
            RESETS.with(|r| r.set((0, u32::MAX)));
            0
        }
        Err(e) => {
            ERR.with(|c| *c.borrow_mut() = e);
            1
        }
    }
}

/// 当前机器的芯片：5 = ESP32-C3，9 = ESP32-S3，0 = 没有机器
#[no_mangle]
pub extern "C" fn tb_chip() -> u32 {
    with(0, |m| m.chip().id())
}

/// 板载 BOOT 键所在引脚（C3：9，S3：0）
#[no_mangle]
pub extern "C" fn tb_boot_pin() -> u32 {
    with(9, |m| m.boot_pin())
}

#[no_mangle]
pub extern "C" fn tb_error_ptr() -> *const u8 {
    ERR.with(|c| c.borrow().as_ptr())
}
#[no_mangle]
pub extern "C" fn tb_error_len() -> usize {
    ERR.with(|c| c.borrow().len())
}

/// 复位次数上限：超过后 tb_run 不再重新上电、返回 3（与 CLI 的"最多 50 次"一致）。tb_boot 时恢复成不限
#[no_mangle]
pub extern "C" fn tb_reset_limit(n: u32) {
    RESETS.with(|r| r.set((r.get().0, n)));
}

/// 本次上电以来 tb_run 里复位重新上电的次数（软件复位 + 欠压复位）
#[no_mangle]
pub extern "C" fn tb_reset_count() -> u32 {
    RESETS.with(|r| r.get().0)
}

/// 跑 cycles 个 CPU 周期。返回 0=跑满，1=异常，2=未实现 HLE，3=复位次数超过上限（停在复位前），-1=没有机器。
#[no_mangle]
pub extern "C" fn tb_run(cycles: f64) -> i32 {
    with(-1, |m| {
        let r = m.run(cycles as u64);
        let con = m.console_take();
        OUT.with(|o| o.borrow_mut().extend_from_slice(&con));
        match r {
            Stop::Budget => 0,
            Stop::Reset(reason) => {
                // 软件复位 / 欠压复位：在内核里直接重新上电（flash / NVS 保留），页面感知不到中断。
                // ROM 的复位头（rst:0x..）由 Machine::reboot 写进串口，与命令行逐字节相同
                let (n, lim) = RESETS.with(|r| r.get());
                RESETS.with(|r| r.set((n + 1, lim)));
                if n + 1 > lim {
                    return 3;
                }
                match m.reboot(reason) {
                    Ok(()) => 0,
                    Err(e) => {
                        ERR.with(|x| *x.borrow_mut() = e);
                        1
                    }
                }
            }
            Stop::Fault(s) => {
                ERR.with(|e| *e.borrow_mut() = s);
                1
            }
            Stop::Hle(s) => {
                ERR.with(|e| *e.borrow_mut() = format!("未实现的 ROM 函数 {s}"));
                2
            }
        }
    })
}

/// 控制台输出：先取指针 / 长度读走，再 tb_console_clear。
#[no_mangle]
pub extern "C" fn tb_console_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}
#[no_mangle]
pub extern "C" fn tb_console_len() -> usize {
    OUT.with(|o| o.borrow().len())
}
#[no_mangle]
pub extern "C" fn tb_console_clear() {
    OUT.with(|o| o.borrow_mut().clear())
}

#[no_mangle]
pub extern "C" fn tb_cycles() -> f64 {
    with(0.0, |m| m.cycles() as f64)
}

/// 引脚电平低 32 位（GPIO0..31）
#[no_mangle]
pub extern "C" fn tb_gpio_level() -> u32 {
    with(0, |m| m.gpio_level() as u32)
}
/// 引脚电平高位（GPIO32..，S3 有 49 个引脚）
#[no_mangle]
pub extern "C" fn tb_gpio_level_hi() -> u32 {
    with(0, |m| (m.gpio_level() >> 32) as u32)
}

#[no_mangle]
pub extern "C" fn tb_gpio_enable() -> u32 {
    with(0, |m| m.gpio_enable() as u32)
}
#[no_mangle]
pub extern "C" fn tb_gpio_enable_hi() -> u32 {
    with(0, |m| (m.gpio_enable() >> 32) as u32)
}

/// 外部驱动一个引脚（按键等）。level<0 表示松开（不驱动）。
#[no_mangle]
pub extern "C" fn tb_gpio_drive(pin: u32, level: i32) {
    with((), |m| m.gpio_drive(pin, level))
}

/// 引脚 PWM 占空比（0..1）；没有 PWM 时返回 -1
#[no_mangle]
pub extern "C" fn tb_pin_pwm(pin: u32) -> f32 {
    with(-1.0, |m| {
        m.pin_pwm(pin as usize).map(|p| p.0).unwrap_or(-1.0)
    })
}

/// 引脚 PWM 频率（Hz）
#[no_mangle]
pub extern "C" fn tb_pin_pwm_freq(pin: u32) -> f32 {
    with(0.0, |m| m.pin_pwm(pin as usize).map(|p| p.1).unwrap_or(0.0))
}

/// 引脚 pin 上 WS2812 灯带最近一帧：拷进内部缓冲（每颗 r,g,b 三字节），返回灯珠数。
/// 之后用 tb_ws2812_ptr 读取。没有灯带返回 0。
#[no_mangle]
pub extern "C" fn tb_ws2812_fetch(pin: u32) -> usize {
    let rgb: Vec<u8> = with(Vec::new(), |m| {
        m.ws2812()
            .get(&pin)
            .map(|d| d.rgb.iter().flatten().copied().collect())
            .unwrap_or_default()
    });
    let n = rgb.len() / 3;
    WS.with(|w| *w.borrow_mut() = rgb);
    n
}

#[no_mangle]
pub extern "C" fn tb_ws2812_ptr() -> *const u8 {
    WS.with(|w| w.borrow().as_ptr())
}

/// 引脚 pin 上已解码的帧数（前端据此判断颜色是否更新）
#[no_mangle]
pub extern "C" fn tb_ws2812_frames(pin: u32) -> f64 {
    with(0.0, |m| {
        m.ws2812().get(&pin).map(|d| d.frames as f64).unwrap_or(0.0)
    })
}

/// # Safety
/// p/len 指向有效缓冲区
#[no_mangle]
pub unsafe extern "C" fn tb_uart_push(p: *const u8, len: usize) {
    let d = std::slice::from_raw_parts(p, len);
    with((), |m| m.uart_push(d))
}

/// 设置引脚上的模拟电压（毫伏），给 ADC 读
#[no_mangle]
pub extern "C" fn tb_analog_set(pin: u32, mv: f32) {
    with((), |m| m.analog_set(pin as usize, mv))
}

/// 在 I2C 总线上接一个器件。kind：1 = SSD1306，2 = BME280，3 = MPU6050，4 = QMI8658，5 = CST816S。返回 0 成功。
#[no_mangle]
pub extern "C" fn tb_i2c_attach(kind: u32, addr: u32) -> i32 {
    let name = match kind {
        1 => "ssd1306",
        2 => "bme280",
        3 => "mpu6050",
        4 => "qmi8658",
        5 => "cst816s",
        _ => return 1,
    };
    with(1, |m| if m.i2c_attach(name, addr as u8) { 0 } else { 1 })
}

/// 设置环境（作用于 BME280 等环境传感器）
#[no_mangle]
pub extern "C" fn tb_env_set(temp_c: f64, humidity: f64, pressure_pa: f64) {
    with((), |m| {
        m.env_set(SensorEnv {
            temp_c,
            humidity,
            pressure_pa,
        })
    })
}

/// 姿态（MPU6050 / QMI8658）：欧拉角（度）+ 欧拉角变化率（°/s），同脚本动作 imu=
#[no_mangle]
pub extern "C" fn tb_imu_set(pitch: f64, roll: f64, yaw: f64, dpitch: f64, droll: f64, dyaw: f64) {
    with((), |m| {
        m.imu_set(ImuPose {
            pitch,
            roll,
            yaw,
            dpitch,
            droll,
            dyaw,
        })
    })
}

/// 触摸 INT 脚接在哪个 GPIO（按着拉低、抬起回高）
#[no_mangle]
pub extern "C" fn tb_touch_int(pin: u32) {
    with((), |m| m.touch_int_attach(pin))
}

/// 触摸：down = 1 按下 / 移动到 (x, y)（屏幕像素 0..239），0 = 抬起
#[no_mangle]
pub extern "C" fn tb_touch(x: f64, y: f64, down: u32) {
    let c = |v: f64| v.round().clamp(0.0, 239.0) as u16;
    with((), |m| m.touch(c(x), c(y), down != 0))
}

/// OLED 画面版本号：变了才需要重新取像素。没有 OLED 时返回 0。
#[no_mangle]
pub extern "C" fn tb_oled_version() -> u32 {
    with(0, |m| m.oled().map(|o| o.version).unwrap_or(0))
}

/// OLED 画面：128×64 字节，每像素 0..255 亮度（含开关、对比度）。没有 OLED 时返回空指针。
#[no_mangle]
pub extern "C" fn tb_oled_ptr() -> *const u8 {
    with(std::ptr::null(), |m| {
        m.oled()
            .map(|o| o.render().as_ptr())
            .unwrap_or(std::ptr::null())
    })
}

/// 在 SPI2 上接 GC9A01 圆屏（S3：SCLK=12 MOSI=11 CS=10 DC=14 RST=13 背光=15）。返回 0 成功（C3 不支持，返回 1）
#[no_mangle]
pub extern "C" fn tb_lcd_attach() -> i32 {
    with(1, |m| if m.lcd_attach("gc9a01") { 0 } else { 1 })
}

/// 圆屏画面版本号：变了才需要重新取像素。没有屏时返回 0
#[no_mangle]
pub extern "C" fn tb_lcd_version() -> u32 {
    with(0, |m| m.lcd().map(|d| d.version).unwrap_or(0))
}

/// 圆屏画面：240×240×4 字节 RGBA（行优先），圆形可视区外 alpha=0；显示关 / 睡眠 / 背光灭时圆内为不透明黑。没有屏时返回空指针
#[no_mangle]
pub extern "C" fn tb_lcd_ptr() -> *const u8 {
    with(std::ptr::null(), |m| {
        m.lcd()
            .map(|d| d.render().as_ptr())
            .unwrap_or(std::ptr::null())
    })
}

// ---------------------------------------------------------------- 引脚上的外接器件（P2-01 编码器、P2-04 超声波）

/// 接一个旋转编码器：A / B 两相，sw < 0 表示没有按键
#[no_mangle]
pub extern "C" fn tb_encoder_attach(a: u32, b: u32, sw: i32) {
    with((), |m| {
        m.encoder_attach(a, b, (sw >= 0).then_some(sw as u32))
    })
}

/// 转 steps 格（正 = 顺时针）；波形由内核按 0.5 ms 一个沿排出来
#[no_mangle]
pub extern "C" fn tb_encoder_turn(steps: i32) {
    with((), |m| m.encoder_turn(steps))
}

/// 编码器按键：1 按下，0 松开
#[no_mangle]
pub extern "C" fn tb_encoder_press(down: u32) {
    with((), |m| m.encoder_press(down != 0))
}

/// 编码器已经转完的格数（没接为 NaN）
#[no_mangle]
pub extern "C" fn tb_encoder_pos() -> f64 {
    with(f64::NAN, |m| {
        m.encoder_position().map(|p| p as f64).unwrap_or(f64::NAN)
    })
}

/// PCNT 单元 u 的当前计数（只有 S3 有；没有为 NaN）
#[no_mangle]
pub extern "C" fn tb_pcnt_count(u: u32) -> f64 {
    with(f64::NAN, |m| {
        m.pcnt_count(u as usize)
            .map(|c| c as f64)
            .unwrap_or(f64::NAN)
    })
}

/// 接一个 HC-SR04：Trig 由芯片驱动，Echo 由模块驱动（5 V 供电，电流进 5V 轨）
#[no_mangle]
pub extern "C" fn tb_sonar_attach(trig: u32, echo: u32) {
    with((), |m| m.sonar_attach(trig, echo))
}

/// 探头到障碍物的距离（cm）；负数 = 前方没有东西
#[no_mangle]
pub extern "C" fn tb_sonar_distance(cm: f64) {
    with((), |m| m.sonar_distance(cm))
}

/// 超声波统计：0 = 触发次数，1 = 回波次数，2 = 最近一次 Echo 宽度（µs）；没接为 NaN
#[no_mangle]
pub extern "C" fn tb_sonar_stat(which: u32) -> f64 {
    with(f64::NAN, |m| match (m.sonar_stats(), which) {
        (Some(s), 0) => s.0 as f64,
        (Some(s), 1) => s.1 as f64,
        (Some(s), 2) => s.2,
        _ => f64::NAN,
    })
}

// ---------------------------------------------------------------- 供电网络（tryboard-elec，P1-01 / P1-02）

/// 供电方式：0 = 只有 USB（舵机也吃 USB 的 5V），1 = 舵机由外接 5 V 2 A 供电
#[no_mangle]
pub extern "C" fn tb_power_set(mode: u32) {
    with((), |m| {
        m.set_power(if mode == 1 {
            PowerMode::Ext
        } else {
            PowerMode::Usb
        })
    })
}

/// 在 GPIO pin 上接一个 SG90（舵机电流进供电网络，角度由二阶动力学给出）
#[no_mangle]
pub extern "C" fn tb_servo_attach(pin: u32) {
    with((), |m| m.servo_attach(pin))
}

/// 节点电压（V）：1 = 5V 轨，2 = 3V3，3 = 舵机红线，4 = 外接 5 V
#[no_mangle]
pub extern "C" fn tb_elec_v(node: u32) -> f64 {
    with(0.0, |m| m.elec.node_v(node as usize))
}

/// 电流（A）：0 = USB 口，1 = 外接电源，2 = 舵机，3 = LDO 输出（3V3 总电流），4 = 芯片，5 = 5 V 轨上的功放
#[no_mangle]
pub extern "C" fn tb_elec_i(which: u32) -> f64 {
    with(0.0, |m| {
        let n = &m.elec.now;
        match which {
            0 => n.i_usb,
            1 => n.i_ext,
            2 => n.i_servo,
            3 => n.i_3v3,
            5 => n.i_amp,
            _ => n.i_chip,
        }
    })
}

/// 上电以来的统计：0 = 5V 最低，1 = 3V3 最低，2 = 舵机端最低，3 = USB 峰值电流，4 = 外接峰值，5 = 舵机峰值，
/// 6 = 3V3 峰值，7 = 欠压复位次数，8 = 芯片是否被欠压复位按住（1/0），9 = 功放峰值电流
#[no_mangle]
pub extern "C" fn tb_elec_stat(which: u32) -> f64 {
    with(0.0, |m| {
        let s = &m.elec.stats;
        let v = |x: f64| if x == f64::MAX { f64::NAN } else { x };
        match which {
            0 => v(s.min_v5),
            1 => v(s.min_v3v3),
            2 => v(s.min_v_servo),
            3 => s.peak_i_usb,
            4 => s.peak_i_ext,
            5 => s.peak_i_servo,
            6 => s.peak_i_3v3,
            7 => s.resets as f64,
            9 => s.peak_i_amp,
            _ => m.elec.held as u32 as f64,
        }
    })
}

/// 第 i 次欠压复位的模拟时刻（秒）；没有返回 -1
#[no_mangle]
pub extern "C" fn tb_elec_brownout_t(i: u32) -> f64 {
    with(-1.0, |m| {
        m.elec
            .stats
            .brownouts
            .get(i as usize)
            .map(|b| b.0)
            .unwrap_or(-1.0)
    })
}

/// 舵机输出轴角度（度）；没接舵机返回 NaN
#[no_mangle]
pub extern "C" fn tb_servo_angle() -> f64 {
    with(f64::NAN, |m| {
        m.elec
            .servo
            .as_ref()
            .map(|s| s.angle_deg())
            .unwrap_or(f64::NAN)
    })
}

/// 与命令行 `--elec-report` 相同的文字，返回长度；内容用 tb_report_ptr 读（与 tb_report 共用缓冲）
#[no_mangle]
pub extern "C" fn tb_elec_report() -> usize {
    let r = with(String::new(), |m| m.elec.report());
    let n = r.len();
    REPORT.with(|b| *b.borrow_mut() = r);
    n
}

// ---------------------------------------------------------------- 接错线求解（P2-14，估算）

/// 给实验台接线检查算错接的电流（不碰模拟器里的机器，同样的参数永远同样的结果，命令行 tools/elec 是同一电路）。
/// kind：1 = 零件输出（a V 经 b Ω）对上 GPIO 相反电平；2 = 两个零件对打（a V 经 b Ω 对 c V 经 d Ω）；
/// 3 = GPIO 高电平点 LED（串 a Ω，0 = 没电阻）；4 = 电源轨接地（a：0 = 3V3，1 = 5V，2 = 外接 5 V）；
/// 5 = 5 V 经 a Ω 进 GPIO（钳位二极管）。s3 = 1 用 S3 的芯片电流。返回支路电流（A），其它结果看 tb_fault_out
#[no_mangle]
pub extern "C" fn tb_fault(kind: u32, s3: u32, a: f64, b: f64, c: f64, d: f64) -> f64 {
    use tryboard_elec::board::ChipKind;
    use tryboard_elec::fault::{self, Rail};
    let chip = if s3 == 1 { ChipKind::S3 } else { ChipKind::C3 };
    let o = match kind {
        1 => fault::fight_gpio(a, b),
        2 => fault::fight(a, b, c, d),
        3 => fault::led(a),
        4 => fault::short(
            match a as u32 {
                1 => Rail::V5,
                2 => Rail::Ext5v,
                _ => Rail::V3v3,
            },
            chip,
        ),
        5 => fault::clamp(a, chip),
        _ => return f64::NAN,
    };
    FAULT.with(|f| *f.borrow_mut() = [o.v_pin, o.v5, o.v33, o.limiter as u32 as f64]);
    o.i
}

/// 上一次 tb_fault 的其它结果：0 = 关键节点电压（引脚 / 被短路的轨），1 = 5V 轨，2 = 3V3 轨，
/// 3 = 谁限住了电流（0 = 只有内阻，1 = USB 口限流，2 = 外接电源限流，3 = LDO 限流，4 = LDO 进压差区）
#[no_mangle]
pub extern "C" fn tb_fault_out(k: u32) -> f64 {
    FAULT.with(|f| f.borrow().get(k as usize).copied().unwrap_or(f64::NAN))
}

// ---------------------------------------------------------------- 线束（P2-11，估算）

/// I2C 排线总长（cm）；负数 = 理想总线（不算上升时间）
#[no_mangle]
pub extern "C" fn tb_i2c_wire(cm: f64) {
    with((), |m| {
        m.set_i2c_wire(if cm < 0.0 { None } else { Some(cm) })
    })
}

/// 天线被金属件 / 电池挡住的衰减（dB）
#[no_mangle]
pub extern "C" fn tb_antenna_loss(db: i32) {
    with((), |m| m.set_antenna_loss(db))
}

/// 线束结论（与命令行同样的文字，没设就是空），返回长度；内容用 tb_report_ptr 读
#[no_mangle]
pub extern "C" fn tb_harness_report() -> usize {
    let r = with(String::new(), |m| {
        let mut o = String::new();
        for l in [
            tryboard_machine::harness_i2c_line(m),
            tryboard_machine::harness_wifi_line(m),
        ]
        .into_iter()
        .flatten()
        {
            o.push_str(&l);
            o.push('\n');
        }
        o
    });
    let n = r.len();
    REPORT.with(|b| *b.borrow_mut() = r);
    n
}

// ---------------------------------------------------------------- 原生 USB（ESP32-S3）

/// 关卡验收的 USB 结论（= 命令行 --usb-log 的"USB 主机：…"与"USB 键盘输入: …"两行），返回长度；内容用 tb_report_ptr 读
#[no_mangle]
pub extern "C" fn tb_usb_report() -> usize {
    let r = with(String::new(), |m| tryboard_machine::usb_report_lines(m));
    let n = r.len();
    REPORT.with(|b| *b.borrow_mut() = r);
    n
}

/// 生成检查点的 I2C 应答次数（U-17），与命令行 `--i2c-log` 同一段文字；读法同 tb_report
#[no_mangle]
pub extern "C" fn tb_i2c_report() -> usize {
    let r = with(String::new(), |m| tryboard_machine::i2c_ack_lines(m));
    let n = r.len();
    REPORT.with(|b| *b.borrow_mut() = r);
    n
}

fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
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
    o.push('"');
    o
}

/// USB 状态的变化计数：变了再取 JSON。0 表示没有 USB 设备（C3 或固件没用 USB）
#[no_mangle]
pub extern "C" fn tb_usb_version() -> f64 {
    M.with(|c| {
        let b = c.borrow();
        let Some(u) = b.as_ref().and_then(|m| m.usb()) else {
            return 0.0;
        };
        let h = &u.host;
        if h.log.is_empty() {
            return 0.0;
        }
        (h.log.len() + h.typed.len() * 7 + h.cdc_rx.len() * 13) as f64 + h.mouse.3 as f64 * 1e6
    })
}

/// 把虚拟主机看到的情况序列化成 JSON，返回长度；内容用 tb_usb_json_ptr 读
#[no_mangle]
pub extern "C" fn tb_usb_json() -> usize {
    let j = M.with(|c| {
        let b = c.borrow();
        let Some(u) = b.as_ref().and_then(|m| m.usb()) else { return String::new() };
        let h = &u.host;
        let i = &h.info;
        let list = |v: &[String]| v.iter().map(|s| json_str(s)).collect::<Vec<_>>().join(",");
        format!(
            "{{\"state\":{},\"configured\":{},\"vid\":{},\"pid\":{},\"manufacturer\":{},\"product\":{},\"serial\":{},\"interfaces\":[{}],\"log\":[{}],\"typed\":{},\"mouse\":{{\"x\":{},\"y\":{},\"buttons\":{},\"reports\":{}}},\"cdc\":{}}}",
            json_str(h.state_name()),
            h.configured(),
            i.vid,
            i.pid,
            json_str(&i.manufacturer),
            json_str(&i.product),
            json_str(&i.serial),
            list(&i.interfaces),
            list(&h.log),
            json_str(&h.typed),
            h.mouse.0,
            h.mouse.1,
            h.mouse.2,
            h.mouse.3,
            json_str(&String::from_utf8_lossy(&h.cdc_rx)),
        )
    });
    let n = j.len();
    USB_JSON.with(|b| *b.borrow_mut() = j);
    n
}

#[no_mangle]
pub extern "C" fn tb_usb_json_ptr() -> *const u8 {
    USB_JSON.with(|b| b.borrow().as_ptr())
}

/// 虚拟电脑往 USB 虚拟串口（CDC-ACM）里写
/// # Safety
/// p/len 指向有效缓冲区
#[no_mangle]
pub unsafe extern "C" fn tb_usb_cdc_send(p: *const u8, len: usize) {
    let d = std::slice::from_raw_parts(p, len);
    M.with(|c| {
        if let Some(u) = c.borrow_mut().as_mut().and_then(|m| m.usb_mut()) {
            u.host.cdc_tx.extend_from_slice(d);
        }
    });
}

// ---------------------------------------------------------------- 验收观察（关卡检查用）

/// 生成与命令行 `--gpio-log --ws2812-log` 相同格式的观察记录（GPIO 翻转次数、WS2812 各帧颜色、OLED 点亮像素、圆屏非黑像素），
/// 网页的关卡检查与 tools/accept.sh 解析同一种文本，两边结论才一致。返回长度，内容用 tb_report_ptr 读。
#[no_mangle]
pub extern "C" fn tb_report() -> usize {
    use std::fmt::Write;
    let r = with(String::new(), |m| {
        let mut o = String::new();
        let log = m.gpio_log();
        for pin in 0..m.chip().npins() {
            let mut n = 0;
            let mut prev = m.gpio_reset_level();
            for (_, lv) in &log {
                if (lv ^ prev) >> pin & 1 != 0 {
                    n += 1;
                }
                prev = *lv;
            }
            if n > 0 {
                let _ = writeln!(o, "[tryboard] GPIO{pin} 翻转 {n} 次");
            }
        }
        let mut pins: Vec<_> = m.ws2812().iter().collect();
        pins.sort_by_key(|(p, _)| **p);
        for (pin, d) in pins {
            let _ = writeln!(o, "[tryboard] WS2812 GPIO{pin} 共 {} 帧", d.frames);
            for (t, rgb) in &d.history {
                let cols: Vec<String> = rgb
                    .iter()
                    .map(|c| format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2]))
                    .collect();
                let _ = writeln!(
                    o,
                    "    {:.4}s {}",
                    *t as f64 / tryboard_machine::CPU_HZ as f64,
                    cols.join(" ")
                );
            }
        }
        if let Some(d) = m.oled() {
            let _ = writeln!(o, "[tryboard] OLED 点亮像素 {}", d.lit_pixels());
        }
        if let Some(d) = m.lcd() {
            let _ = writeln!(o, "[tryboard] LCD GC9A01 非黑像素 {}", d.lit_pixels());
            o.push_str(&d.color_report());
        }
        o
    });
    let n = r.len();
    REPORT.with(|b| *b.borrow_mut() = r);
    n
}

#[no_mangle]
pub extern "C" fn tb_report_ptr() -> *const u8 {
    REPORT.with(|b| b.borrow().as_ptr())
}

// ---------------------------------------------------------------- 逻辑分析仪事件（P1-05）

/// 要观察的 GPIO（lo = GPIO0..31，hi = GPIO32..）。PWM / WS2812 / I2C 事件总是记。上电后设，重新上电要再设
#[no_mangle]
pub extern "C" fn tb_io_watch(lo: u32, hi: u32) {
    with((), |m| m.io_watch(lo as u64 | (hi as u64) << 32))
}

/// 取走内核事件缓冲：每条 16 字节（t u64 | kind u8 | a u8 | b u16 | v u32，小端，含义见 tryboard_esp32c3::iotrace），
/// 拷进内部缓冲，返回条数；之后用 tb_io_ptr 读 条数 × 16 字节
#[no_mangle]
pub extern "C" fn tb_io_take() -> usize {
    let ev = with(Vec::new(), |m| m.io_take());
    IO.with(|b| {
        let mut b = b.borrow_mut();
        b.clear();
        b.reserve(ev.len() * 16);
        for e in &ev {
            b.extend_from_slice(&e.to_bytes());
        }
    });
    ev.len()
}

#[no_mangle]
pub extern "C" fn tb_io_ptr() -> *const u8 {
    IO.with(|b| b.borrow().as_ptr())
}

/// 内核缓冲满了丢掉的条数（自上电起累计）
#[no_mangle]
pub extern "C" fn tb_io_dropped() -> f64 {
    with(0.0, |m| m.io_dropped() as f64)
}

// ---------------------------------------------------------------- FreeRTOS 任务时间线（C-04）

/// 开始记任务切换（cap = 内核缓冲条数，0 = 关）。上电后设，重新上电要再设
#[no_mangle]
pub extern "C" fn tb_tasks_enable(cap: u32) {
    with((), |m| m.tasks_enable(cap as usize))
}

/// 取走任务切换事件：每条 16 字节（t u64 | core u8 | prev u8 | task u16 | pc u32，小端，
/// 含义见 tryboard_esp32c3::tasktrace），拷进内部缓冲，返回条数；之后用 tb_tasks_ptr 读
#[no_mangle]
pub extern "C" fn tb_tasks_take() -> usize {
    let ev = with(Vec::new(), |m| m.tasks_take());
    TASKS.with(|b| {
        let mut b = b.borrow_mut();
        b.clear();
        b.reserve(ev.len() * 16);
        for e in &ev {
            b.extend_from_slice(&e.to_bytes());
        }
    });
    ev.len()
}

#[no_mangle]
pub extern "C" fn tb_tasks_ptr() -> *const u8 {
    TASKS.with(|b| b.borrow().as_ptr())
}

/// 任务表 JSON（事件里的 task 是下标）：{"cores":N,"dropped":N,"tasks":[{"name","prio","core","tcb"}]}，
/// 返回长度；内容用 tb_tasks_json_ptr 读
#[no_mangle]
pub extern "C" fn tb_tasks_json() -> usize {
    let j = with(String::new(), |m| {
        let cores = m.cores();
        let dropped = m.tasks_dropped();
        let list = m
            .tasks_list()
            .iter()
            .map(|t| {
                format!(
                    "{{\"name\":{},\"prio\":{},\"core\":{},\"tcb\":{}}}",
                    json_str(&t.name),
                    t.prio,
                    t.affinity,
                    t.tcb
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        format!("{{\"cores\":{cores},\"dropped\":{dropped},\"tasks\":[{list}]}}")
    });
    let n = j.len();
    TASKS_JSON.with(|b| *b.borrow_mut() = j);
    n
}

#[no_mangle]
pub extern "C" fn tb_tasks_json_ptr() -> *const u8 {
    TASKS_JSON.with(|b| b.borrow().as_ptr())
}

// ---------------------------------------------------------------- I2S 音频（P2-06）

/// 接 I2S 音频器件：0 = MAX98357A 喇叭，1 = INMP441 麦克风。引脚见 ARCH「I2S」。返回 0 成功
#[no_mangle]
pub extern "C" fn tb_i2s_attach(kind: u32) -> i32 {
    let k = match kind {
        0 => "max98357a",
        1 => "inmp441",
        _ => return 1,
    };
    with(1, |m| if m.i2s_attach(k) { 0 } else { 1 })
}

/// 取走喇叭攒下的声音，拷进内部缓冲，返回块数。每块：t f64（第一个样本的模拟时刻，秒）| rate f32 | n u32 |
/// n 个 i16 样本（单声道），按 4 字节补齐；用 tb_audio_ptr / tb_audio_len 读
#[no_mangle]
pub extern "C" fn tb_audio_take() -> u32 {
    let blocks = with(Vec::new(), |m| m.audio_take());
    AUDIO.with(|b| {
        let mut b = b.borrow_mut();
        b.clear();
        for blk in &blocks {
            b.extend_from_slice(&(blk.t as f64 / tryboard_machine::CPU_HZ as f64).to_le_bytes());
            b.extend_from_slice(&blk.rate.to_le_bytes());
            b.extend_from_slice(&(blk.data.len() as u32).to_le_bytes());
            for v in &blk.data {
                b.extend_from_slice(&v.to_le_bytes());
            }
            if blk.data.len() % 2 == 1 {
                b.extend_from_slice(&[0, 0]);
            }
        }
    });
    blocks.len() as u32
}

#[no_mangle]
pub extern "C" fn tb_audio_ptr() -> *const u8 {
    AUDIO.with(|b| b.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn tb_audio_len() -> usize {
    AUDIO.with(|b| b.borrow().len())
}

/// 喇叭读数（最近 1 秒）：0 = 采样率，1 = 累计帧数，2 = RMS，3 = 主频（Hz），4 = 峰值；5 = 麦克风送出的帧数。
/// 没接对应器件返回 NaN
#[no_mangle]
pub extern "C" fn tb_audio_stat(which: u32) -> f64 {
    with(f64::NAN, |m| {
        if which == 5 {
            return m
                .audio()
                .and_then(|a| a.mic.as_ref())
                .map(|x| x.frames as f64)
                .unwrap_or(f64::NAN);
        }
        let frames = m
            .audio()
            .and_then(|a| a.speaker.as_ref())
            .map(|s| s.frames as f64);
        let a = m.audio_analyze(1.0);
        match (which, a) {
            (_, None) => f64::NAN,
            (0, Some(a)) => a.rate,
            (1, _) => frames.unwrap_or(f64::NAN),
            (2, Some(a)) => a.rms,
            (3, Some(a)) => a.freq,
            (_, Some(a)) => a.peak,
        }
    })
}

/// 麦克风听固定 WAV（JS 用 tb_alloc 放进线性内存）。返回 0 成功，1 不是可读的 WAV
///
/// # Safety
/// ptr..ptr+len 必须是 tb_alloc 分配并已写好的内存
#[no_mangle]
pub unsafe extern "C" fn tb_mic_wav(ptr: *const u8, len: usize) -> i32 {
    let b = std::slice::from_raw_parts(ptr, len);
    match tryboard_esp32c3::devices::audio::parse_wav(b) {
        Ok((rate, x)) => with(1, |m| {
            m.mic_wav(rate as f64, x);
            0
        }),
        Err(_) => 1,
    }
}

/// 麦克风听实时声音（浏览器麦克风）：n 个 f32 小端（-1..1），rate = 它们的采样率
///
/// # Safety
/// ptr..ptr+4n 必须是 tb_alloc 分配并已写好的内存（不要求对齐）
#[no_mangle]
pub unsafe extern "C" fn tb_mic_push(ptr: *const u8, n: usize, rate: f64) {
    let b = std::slice::from_raw_parts(ptr, n * 4);
    let x: Vec<f32> = b
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes(*c))
        .collect();
    with((), |m| m.mic_push(rate, &x))
}

/// 麦克风回到安静
#[no_mangle]
pub extern "C" fn tb_mic_silence() {
    with((), |m| m.mic_silence())
}

/// 与命令行结束时相同的 `[tryboard] I2S …` 文字，返回长度；内容用 tb_report_ptr 读
#[no_mangle]
pub extern "C" fn tb_audio_report() -> usize {
    let r = with(String::new(), |m| m.audio_report());
    let n = r.len();
    REPORT.with(|b| *b.borrow_mut() = r);
    n
}
