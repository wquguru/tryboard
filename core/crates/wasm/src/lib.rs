//! 浏览器绑定：裸 extern "C" 导出，JS 侧通过线性内存读写缓冲区。
//! 一个 wasm 实例只跑一台机器（多块板子就开多个实例 / Worker）。

use std::cell::RefCell;
use tryboard_esp32c3::devices::{
    bme280::{Bme280, Env},
    ssd1306::Ssd1306,
};
use tryboard_esp32c3::{Esp32c3, Stop};

thread_local! {
    static M: RefCell<Option<Esp32c3>> = const { RefCell::new(None) };
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static ERR: RefCell<String> = const { RefCell::new(String::new()) };
    static WS: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
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
    match Esp32c3::boot(rom, flash) {
        Ok((m, _)) => {
            M.with(|c| *c.borrow_mut() = Some(m));
            0
        }
        Err(e) => {
            ERR.with(|c| *c.borrow_mut() = e);
            1
        }
    }
}

#[no_mangle]
pub extern "C" fn tb_error_ptr() -> *const u8 {
    ERR.with(|c| c.borrow().as_ptr())
}
#[no_mangle]
pub extern "C" fn tb_error_len() -> usize {
    ERR.with(|c| c.borrow().len())
}

/// 跑 cycles 个 CPU 周期。返回 0=跑满，1=异常，2=未实现 HLE，-1=没有机器。
#[no_mangle]
pub extern "C" fn tb_run(cycles: f64) -> i32 {
    M.with(|c| {
        let mut b = c.borrow_mut();
        let Some(m) = b.as_mut() else { return -1 };
        let r = m.run(cycles as u64);
        let con = m.console_take();
        OUT.with(|o| o.borrow_mut().extend_from_slice(&con));
        match r {
            Stop::Budget => 0,
            Stop::Fault { cause, pc, tval } => {
                ERR.with(|e| {
                    *e.borrow_mut() =
                        format!("CPU 异常 cause={cause} pc=0x{pc:08x} tval=0x{tval:08x}")
                });
                1
            }
            Stop::Hle(pc) => {
                ERR.with(|e| {
                    *e.borrow_mut() = format!(
                        "未实现的 ROM 函数 0x{pc:08x} {}",
                        m.symbol_at(pc).unwrap_or("")
                    )
                });
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
    M.with(|c| {
        c.borrow()
            .as_ref()
            .map(|m| m.cpu.cycles as f64)
            .unwrap_or(0.0)
    })
}

#[no_mangle]
pub extern "C" fn tb_gpio_level() -> u32 {
    M.with(|c| c.borrow().as_ref().map(|m| m.bus.gpio.level()).unwrap_or(0))
}

#[no_mangle]
pub extern "C" fn tb_gpio_enable() -> u32 {
    M.with(|c| c.borrow().as_ref().map(|m| m.bus.gpio.enable).unwrap_or(0))
}

/// 外部驱动一个引脚（按键等）。level<0 表示松开（不驱动）。
#[no_mangle]
pub extern "C" fn tb_gpio_drive(pin: u32, level: i32) {
    M.with(|c| {
        if let Some(m) = c.borrow_mut().as_mut() {
            let bit = 1u32 << pin;
            if level < 0 {
                m.bus.gpio.ext_driven &= !bit;
            } else {
                m.bus.gpio.ext_driven |= bit;
                if level > 0 {
                    m.bus.gpio.ext_in |= bit;
                } else {
                    m.bus.gpio.ext_in &= !bit;
                }
            }
            let now = m.cpu.cycles;
            m.bus.gpio_changed(now);
        }
    })
}

/// 引脚 PWM 占空比（0..1）；没有 PWM 时返回 -1
#[no_mangle]
pub extern "C" fn tb_pin_pwm(pin: u32) -> f32 {
    M.with(|c| c.borrow().as_ref().and_then(|m| m.bus.pin_pwm(pin as usize)).map(|p| p.0).unwrap_or(-1.0))
}

/// 引脚 PWM 频率（Hz）
#[no_mangle]
pub extern "C" fn tb_pin_pwm_freq(pin: u32) -> f32 {
    M.with(|c| c.borrow().as_ref().and_then(|m| m.bus.pin_pwm(pin as usize)).map(|p| p.1).unwrap_or(0.0))
}

/// 引脚 pin 上 WS2812 灯带最近一帧：拷进内部缓冲（每颗 r,g,b 三字节），返回灯珠数。
/// 之后用 tb_ws2812_ptr 读取。没有灯带返回 0。
#[no_mangle]
pub extern "C" fn tb_ws2812_fetch(pin: u32) -> usize {
    M.with(|c| {
        let b = c.borrow();
        let rgb: Vec<u8> = b
            .as_ref()
            .and_then(|m| m.bus.ws2812.get(&pin))
            .map(|d| d.rgb.iter().flatten().copied().collect())
            .unwrap_or_default();
        let n = rgb.len() / 3;
        WS.with(|w| *w.borrow_mut() = rgb);
        n
    })
}

#[no_mangle]
pub extern "C" fn tb_ws2812_ptr() -> *const u8 {
    WS.with(|w| w.borrow().as_ptr())
}

/// 引脚 pin 上已解码的帧数（前端据此判断颜色是否更新）
#[no_mangle]
pub extern "C" fn tb_ws2812_frames(pin: u32) -> f64 {
    M.with(|c| c.borrow().as_ref().and_then(|m| m.bus.ws2812.get(&pin)).map(|d| d.frames as f64).unwrap_or(0.0))
}

/// # Safety
/// p/len 指向有效缓冲区
#[no_mangle]
pub unsafe extern "C" fn tb_uart_push(p: *const u8, len: usize) {
    let d = std::slice::from_raw_parts(p, len);
    M.with(|c| {
        if let Some(m) = c.borrow_mut().as_mut() {
            m.bus.uart0.push_rx(d);
            m.bus.irq_dirty = true;
        }
    })
}

/// 设置引脚上的模拟电压（毫伏），给 ADC 读
#[no_mangle]
pub extern "C" fn tb_analog_set(pin: u32, mv: f32) {
    M.with(|c| {
        if let Some(m) = c.borrow_mut().as_mut() {
            if let Some(p) = m.bus.adc.pin_mv.get_mut(pin as usize) {
                *p = mv;
            }
        }
    })
}

/// 在 I2C 总线上接一个器件。kind：1 = SSD1306，2 = BME280。返回 0 成功。
#[no_mangle]
pub extern "C" fn tb_i2c_attach(kind: u32, addr: u32) -> i32 {
    let name = match kind {
        1 => "ssd1306",
        2 => "bme280",
        _ => return 1,
    };
    M.with(|c| {
        match (
            c.borrow_mut().as_mut(),
            tryboard_esp32c3::devices::make_i2c(name, addr as u8),
        ) {
            (Some(m), Some(d)) => {
                m.bus.i2c0.attach(d);
                0
            }
            _ => 1,
        }
    })
}

/// 设置环境（作用于 BME280 等环境传感器）
#[no_mangle]
pub extern "C" fn tb_env_set(temp_c: f64, humidity: f64, pressure_pa: f64) {
    M.with(|c| {
        if let Some(m) = c.borrow_mut().as_mut() {
            if let Some(b) = m.bus.i2c0.device::<Bme280>() {
                b.env = Env {
                    temp_c,
                    humidity,
                    pressure_pa,
                };
            }
        }
    })
}

/// OLED 画面版本号：变了才需要重新取像素。没有 OLED 时返回 0。
#[no_mangle]
pub extern "C" fn tb_oled_version() -> u32 {
    M.with(|c| {
        c.borrow_mut()
            .as_mut()
            .and_then(|m| m.bus.i2c0.device::<Ssd1306>().map(|o| o.version))
            .unwrap_or(0)
    })
}

/// OLED 画面：128×64 字节，每像素 0..255 亮度（含开关、对比度）。没有 OLED 时返回空指针。
#[no_mangle]
pub extern "C" fn tb_oled_ptr() -> *const u8 {
    M.with(|c| {
        c.borrow_mut()
            .as_mut()
            .and_then(|m| m.bus.i2c0.device::<Ssd1306>().map(|o| o.render().as_ptr()))
            .unwrap_or(std::ptr::null())
    })
}
