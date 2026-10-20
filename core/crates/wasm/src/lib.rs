//! Browser bindings: bare extern "C" exports, JS reads / writes buffers via linear memory. One instance = one machine
//! (more boards = more instances / Workers); JS calls tb_image_chip to pick the matching ROM, then tb_boot.

use std::cell::RefCell;

// Wire-sensor and part exports (F-04a) live in parts.rs to keep this file under the size guardrail
mod parts;
use tryboard_machine::{touch_coord, Chip, ImuPose, Lcd, Machine, PowerMode, SensorEnv, Stop};

thread_local! {
    static M: RefCell<Option<Machine>> = const { RefCell::new(None) };
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static ERR: RefCell<String> = const { RefCell::new(String::new()) };
    static PANIC: RefCell<String> = const { RefCell::new(String::new()) };
    static WS: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static USB_JSON: RefCell<String> = const { RefCell::new(String::new()) };
    static BLE_JSON: RefCell<String> = const { RefCell::new(String::new()) };
    static REPORT: RefCell<String> = const { RefCell::new(String::new()) };
    static IO: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static TASKS: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static TASKS_JSON: RefCell<String> = const { RefCell::new(String::new()) };
    static AUDIO: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    // Resets re-powered inside tb_run since boot; the limit (u32::MAX = none) lets offline checks match the CLI's "at most 50"
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
/// p must come from tb_alloc(len)
#[no_mangle]
pub unsafe extern "C" fn tb_free(p: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(p, 0, len));
}

/// # Safety
/// `flash` must point to `flash_len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn tb_image_chip(flash: *const u8, flash_len: usize) -> u32 {
    // Image chip: 0 = ESP32, 5 = ESP32-C3, 9 = ESP32-S3, u32::MAX = unknown (0 is taken by ESP32)
    let flash = std::slice::from_raw_parts(flash, flash_len);
    Chip::from_image(flash).map(|c| c.id()).unwrap_or(u32::MAX)
}

/// # Safety
/// Same as tb_image_chip (old name used by the USB branch's page).
#[no_mangle]
pub unsafe extern "C" fn tb_flash_chip(flash: *const u8, flash_len: usize) -> u32 {
    tb_image_chip(flash, flash_len)
}

/// # Safety
/// Both pointers must be tb_alloc buffers of the given lengths. Returns 0 on success, else read tb_error_ptr/len.
#[no_mangle]
pub unsafe extern "C" fn tb_boot(
    rom: *const u8,
    rom_len: usize,
    flash: *const u8,
    flash_len: usize,
) -> i32 {
    // panic = "abort" traps the instance; keep the message so the page can say where the simulator broke (R-04)
    std::panic::set_hook(Box::new(|info| {
        PANIC.with(|p| *p.borrow_mut() = info.to_string());
    }));
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

/// Current machine's chip id (image header id: 0 = ESP32, 5 = C3, 9 = S3); u32::MAX = no machine
#[no_mangle]
pub extern "C" fn tb_chip() -> u32 {
    with(u32::MAX, |m| m.chip().id())
}

/// Pin of the on-board BOOT button (C3: 9, S3 / ESP32: 0); u32::MAX = no machine
#[no_mangle]
pub extern "C" fn tb_boot_pin() -> u32 {
    with(u32::MAX, |m| m.boot_pin())
}

/// Message of the panic that trapped this instance (empty if none); readable after the trap
#[no_mangle]
pub extern "C" fn tb_panic_ptr() -> *const u8 {
    PANIC.with(|c| c.borrow().as_ptr())
}
#[no_mangle]
pub extern "C" fn tb_panic_len() -> usize {
    PANIC.with(|c| c.borrow().len())
}

/// Test hook: panic on purpose so the page's crash card can be checked (tools/webtest, Reviews/ab/R-04.md)
#[no_mangle]
pub extern "C" fn tb_debug_panic() {
    panic!("tb_debug_panic: injected for testing");
}

#[no_mangle]
pub extern "C" fn tb_error_ptr() -> *const u8 {
    ERR.with(|c| c.borrow().as_ptr())
}
#[no_mangle]
pub extern "C" fn tb_error_len() -> usize {
    ERR.with(|c| c.borrow().len())
}

/// Reset limit: beyond it tb_run stops re-powering and returns 3 (matches the CLI's "at most 50"). tb_boot clears it
#[no_mangle]
pub extern "C" fn tb_reset_limit(n: u32) {
    RESETS.with(|r| r.set((r.get().0, n)));
}

/// Resets re-powered inside tb_run since boot (software + brownout resets)
#[no_mangle]
pub extern "C" fn tb_reset_count() -> u32 {
    RESETS.with(|r| r.get().0)
}

/// Run `cycles` CPU cycles. 0 = budget used, 1 = fault, 2 = unimplemented HLE, 3 = reset limit hit (stopped before reset), -1 = no machine.
#[no_mangle]
pub extern "C" fn tb_run(cycles: f64) -> i32 {
    with(-1, |m| {
        let r = m.run(cycles as u64);
        let con = m.console_take();
        OUT.with(|o| o.borrow_mut().extend_from_slice(&con));
        match r {
            Stop::Budget => 0,
            Stop::Reset(reason) => {
                // Software / brownout reset: re-power inside the core (flash / NVS kept) so the page sees no break.
                // Machine::reboot writes the ROM reset banner (rst:0x..) to serial, byte-identical to the CLI
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
                ERR.with(|e| *e.borrow_mut() = format!("unimplemented ROM function {s}"));
                2
            }
        }
    })
}

/// Console output: read via pointer / length, then tb_console_clear.
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

/// Pin levels, low 32 bits (GPIO0..31)
#[no_mangle]
pub extern "C" fn tb_gpio_level() -> u32 {
    with(0, |m| m.gpio_level() as u32)
}
/// Pin levels, high bits (GPIO32.., the S3 has 49 pins)
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

/// Drive a pin externally (buttons etc.). level < 0 releases it (not driven).
#[no_mangle]
pub extern "C" fn tb_gpio_drive(pin: u32, level: i32) {
    with((), |m| m.gpio_drive(pin, level))
}

/// Pin PWM duty (0..1); -1 without PWM
#[no_mangle]
pub extern "C" fn tb_pin_pwm(pin: u32) -> f32 {
    with(-1.0, |m| {
        m.pin_pwm(pin as usize).map(|p| p.0).unwrap_or(-1.0)
    })
}

/// Pin PWM frequency (Hz)
#[no_mangle]
pub extern "C" fn tb_pin_pwm_freq(pin: u32) -> f32 {
    with(0.0, |m| m.pin_pwm(pin as usize).map(|p| p.1).unwrap_or(0.0))
}

/// Copy the latest WS2812 frame on `pin` into an internal buffer (r,g,b per LED) and return the LED count
/// (0 = no strip); then read it with tb_ws2812_ptr.
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

/// Frames decoded on `pin` (the page uses it to tell whether colours changed)
#[no_mangle]
pub extern "C" fn tb_ws2812_frames(pin: u32) -> f64 {
    with(0.0, |m| {
        m.ws2812().get(&pin).map(|d| d.frames as f64).unwrap_or(0.0)
    })
}

/// # Safety
/// p/len must describe a valid buffer
#[no_mangle]
pub unsafe extern "C" fn tb_uart_push(p: *const u8, len: usize) {
    let d = std::slice::from_raw_parts(p, len);
    with((), |m| m.uart_push(d))
}

/// Set a pin's analog voltage (mV) for the ADC
#[no_mangle]
pub extern "C" fn tb_analog_set(pin: u32, mv: f32) {
    with((), |m| m.analog_set(pin as usize, mv))
}

/// Attach an I2C device. kind: 1 = SSD1306, 2 = BME280, 3 = MPU6050, 4 = QMI8658, 5 = CST816S, 6 = FT6236,
/// 7 = CST9220, 8 = AXP2101, 9 = PCF85063, 10 = ES8311, 11 = ES7210. Returns 0 on success.
#[no_mangle]
pub extern "C" fn tb_i2c_attach(kind: u32, addr: u32) -> i32 {
    let Some(name) = i2c_kind(kind) else {
        return 1;
    };
    with(1, |m| if m.i2c_attach(name, addr as u8) { 0 } else { 1 })
}

/// Add an I2C bus on fixed pads (M5-02; reached by the routed controller or bit-banged GPIO); pullup != 0 = external
/// pull-ups. Returns the bus index, or -1 if a pad is taken / the chip has no pin buses.
#[no_mangle]
pub extern "C" fn tb_i2c_bus_add(sda: u32, scl: u32, pullup: u32) -> i32 {
    with(-1, |m| {
        m.i2c_bus_add(sda, scl, pullup != 0)
            .map_or(-1, |i| i as i32)
    })
}

/// Attach an I2C device (kind codes as `tb_i2c_attach`) to pin bus `bus`. Returns 0 on success.
#[no_mangle]
pub extern "C" fn tb_i2c_attach_bus(bus: u32, kind: u32, addr: u32) -> i32 {
    let Some(name) = i2c_kind(kind) else {
        return 1;
    };
    with(1, |m| {
        if m.i2c_attach_bus(bus as usize, name, addr as u8) {
            0
        } else {
            1
        }
    })
}

/// Package version eFuse (S3 0 = QFN56 / 1 = PICO; ESP32 5 = PICO-D4 / 6 = PICO-V3-02). Returns 0 on success.
#[no_mangle]
pub extern "C" fn tb_efuse_pkg(pkg: u32) -> i32 {
    with(1, |m| if m.set_efuse_pkg(pkg) { 0 } else { 1 })
}

/// Quad PSRAM size in MB (classic ESP32: 0 / 2 / 4 / 8). Returns 0 on success.
#[no_mangle]
pub extern "C" fn tb_psram(mb: u32) -> i32 {
    with(1, |m| if m.set_psram_mb(mb) { 0 } else { 1 })
}

fn i2c_kind(kind: u32) -> Option<&'static str> {
    Some(match kind {
        1 => "ssd1306",
        2 => "bme280",
        3 => "mpu6050",
        4 => "qmi8658",
        5 => "cst816s",
        6 => "ft6236",
        7 => "cst9220",
        8 => "axp2101",
        9 => "pcf85063",
        10 => "es8311",
        11 => "es7210",
        _ => return None,
    })
}

/// Set the environment (read by BME280 and other environment sensors)
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

/// Pose (MPU6050 / QMI8658): Euler angles (deg) + their rates (°/s), same as the script action imu=
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

/// GPIO wired to the touch INT pin (low while touched, high on release)
#[no_mangle]
pub extern "C" fn tb_touch_int(pin: u32) {
    with((), |m| m.touch_int_attach(pin))
}

/// Touch: down = 1 presses / moves to (x, y) (screen pixels, same clamp as script `touch=`), 0 = release
#[no_mangle]
pub extern "C" fn tb_touch(x: f64, y: f64, down: u32) {
    with((), |m| m.touch(touch_coord(x), touch_coord(y), down != 0))
}

/// AXP2101 battery percent + USB plugged (action `bat=pct[,usb]`); 1 without the PMIC
#[no_mangle]
pub extern "C" fn tb_battery(percent: f64, usb: u32) -> i32 {
    let p = percent.round().clamp(0.0, 100.0) as u8;
    with(1, |m| if m.battery_set(p, usb != 0) { 0 } else { 1 })
}

/// AXP2101 PWRON key (action `pwrkey=short|long`): long = 1 for a long press
#[no_mangle]
pub extern "C" fn tb_pwrkey(long: u32) -> i32 {
    with(1, |m| if m.pwrkey(long != 0) { 0 } else { 1 })
}

/// PCF85063 time as of now, UTC unix seconds
#[no_mangle]
pub extern "C" fn tb_rtc_set(epoch: f64) -> i32 {
    with(1, |m| if m.rtc_set(epoch as i64) { 0 } else { 1 })
}

/// OLED frame version: refetch pixels only when it changes. 0 = no OLED.
#[no_mangle]
pub extern "C" fn tb_oled_version() -> u32 {
    with(0, |m| m.oled().map(|o| o.version).unwrap_or(0))
}

/// OLED frame: 128×64 bytes, brightness 0..255 per pixel (display on/off and contrast applied). Null = no OLED.
#[no_mangle]
pub extern "C" fn tb_oled_ptr() -> *const u8 {
    with(std::ptr::null(), |m| {
        m.oled()
            .map(|o| o.render().as_ptr())
            .unwrap_or(std::ptr::null())
    })
}

/// Attach a GC9A01 round LCD on SPI2 (S3: SCLK=12 MOSI=11 CS=10 DC=14 RST=13 BL=15). 0 = ok (C3 unsupported: 1)
#[no_mangle]
pub extern "C" fn tb_lcd_attach() -> i32 {
    with(1, |m| if m.lcd_attach("gc9a01") { 0 } else { 1 })
}

/// Attach a screen by kind: 0 = GC9A01, 1 = CO5300 (S3 only). 0 = ok, 1 = unsupported
#[no_mangle]
pub extern "C" fn tb_lcd_attach_kind(kind: u32) -> i32 {
    let k = match kind {
        0 => "gc9a01",
        1 => "co5300",
        _ => return 1,
    };
    with(1, |m| if m.lcd_attach(k) { 0 } else { 1 })
}

/// # Safety
/// Attach a screen by CLI spec ("ili9342@sclk=36,mosi=37,cs=3,dc=35,rst=-1", see `Machine::lcd_attach_spec`); 0 = ok, 1 = rejected. p/len must be valid UTF-8
#[no_mangle]
pub unsafe extern "C" fn tb_lcd_attach_spec(p: *const u8, len: usize) -> i32 {
    let s = String::from_utf8_lossy(std::slice::from_raw_parts(p, len)).into_owned();
    with(1, |m| m.lcd_attach_spec(&s).map_or(1, |_| 0))
}

/// # Safety
/// Apply a board preset ("m5dial", see `Machine::board_preset`) after load; 0 = ok, 1 = rejected. p/len valid UTF-8
#[no_mangle]
pub unsafe extern "C" fn tb_board_preset(p: *const u8, len: usize) -> i32 {
    let s = String::from_utf8_lossy(std::slice::from_raw_parts(p, len)).into_owned();
    with(1, |m| m.board_preset(&s).map_or(1, |_| 0))
}

/// # Safety
/// Press (down = 1) / release a board key by legend name (M5-08 Cardputer); 0 ok, 1 no keyboard / unknown key. p/len valid UTF-8
#[no_mangle]
pub unsafe extern "C" fn tb_board_key(p: *const u8, len: usize, down: i32) -> i32 {
    let s = String::from_utf8_lossy(std::slice::from_raw_parts(p, len)).into_owned();
    with(1, |m| m.board_key(&s, down != 0).map_or(1, |_| 0))
}

/// # Safety
/// Plug a Grove unit ("env3" / "env4", see `Machine::grove_attach`) into Port A after `tb_board_preset`; 0 = ok. p/len valid UTF-8
#[no_mangle]
pub unsafe extern "C" fn tb_grove(p: *const u8, len: usize) -> i32 {
    let s = String::from_utf8_lossy(std::slice::from_raw_parts(p, len)).into_owned();
    with(1, |m| m.grove_attach(&s).map_or(1, |_| 0))
}

/// Attached screen: 0 = SPI TFT (any DCS panel), 1 = CO5300, -1 = none
#[no_mangle]
pub extern "C" fn tb_lcd_kind() -> i32 {
    with(-1, |m| {
        m.lcd()
            .map(|d| matches!(d, Lcd::Co5300(_)) as i32)
            .unwrap_or(-1)
    })
}

/// Screen frame width / height in pixels (0 = no screen); `tb_lcd_ptr` holds w × h × 4 bytes
#[no_mangle]
pub extern "C" fn tb_lcd_w() -> u32 {
    with(0, |m| m.lcd().map(|d| d.size().0 as u32).unwrap_or(0))
}

#[no_mangle]
pub extern "C" fn tb_lcd_h() -> u32 {
    with(0, |m| m.lcd().map(|d| d.size().1 as u32).unwrap_or(0))
}

/// Round LCD frame version: refetch pixels only when it changes. 0 = no LCD
#[no_mangle]
pub extern "C" fn tb_lcd_version() -> u32 {
    with(0, |m| m.lcd().map(|d| d.version()).unwrap_or(0))
}

/// Screen frame: w×h×4 RGBA (row-major; GC9A01 240×240 with alpha=0 outside the circle, CO5300 480×480 opaque);
/// opaque black when off / asleep / backlight off. Null = no screen
#[no_mangle]
pub extern "C" fn tb_lcd_ptr() -> *const u8 {
    with(std::ptr::null(), |m| {
        m.lcd()
            .map(|d| d.render().as_ptr())
            .unwrap_or(std::ptr::null())
    })
}

// ---------------------------------------------------------------- Pin-level external parts (P2-01 encoder, P2-04 ultrasonic)

/// Attach a rotary encoder: phases A / B, sw < 0 = no push button
#[no_mangle]
pub extern "C" fn tb_encoder_attach(a: u32, b: u32, sw: i32) {
    with((), |m| {
        m.encoder_attach(a, b, (sw >= 0).then_some(sw as u32))
    })
}

/// Turn `steps` detents (positive = clockwise); the core schedules one edge per 0.5 ms
#[no_mangle]
pub extern "C" fn tb_encoder_turn(steps: i32) {
    with((), |m| m.encoder_turn(steps))
}

/// Encoder button: 1 = pressed, 0 = released
#[no_mangle]
pub extern "C" fn tb_encoder_press(down: u32) {
    with((), |m| m.encoder_press(down != 0))
}

/// Detents the encoder has finished turning (NaN = not attached)
#[no_mangle]
pub extern "C" fn tb_encoder_pos() -> f64 {
    with(f64::NAN, |m| {
        m.encoder_position().map(|p| p as f64).unwrap_or(f64::NAN)
    })
}

/// Current count of PCNT unit u (S3 only; NaN otherwise)
#[no_mangle]
pub extern "C" fn tb_pcnt_count(u: u32) -> f64 {
    with(f64::NAN, |m| {
        m.pcnt_count(u as usize)
            .map(|c| c as f64)
            .unwrap_or(f64::NAN)
    })
}

/// Attach an HC-SR04: chip drives Trig, module drives Echo (5 V powered, current drawn from the 5V rail)
#[no_mangle]
pub extern "C" fn tb_sonar_attach(trig: u32, echo: u32) {
    with((), |m| m.sonar_attach(trig, echo))
}

/// Distance from the sensor to the obstacle (cm); negative = nothing ahead
#[no_mangle]
pub extern "C" fn tb_sonar_distance(cm: f64) {
    with((), |m| m.sonar_distance(cm))
}

/// Ultrasonic stats: 0 = triggers, 1 = echoes, 2 = last Echo width (µs); NaN = not attached
#[no_mangle]
pub extern "C" fn tb_sonar_stat(which: u32) -> f64 {
    with(f64::NAN, |m| match (m.sonar_stats(), which) {
        (Some(s), 0) => s.0 as f64,
        (Some(s), 1) => s.1 as f64,
        (Some(s), 2) => s.2,
        _ => f64::NAN,
    })
}

/// Attach a DHT11 (D-03) on an open-drain data pin; readings follow tb_env_set (call it after attaching)
#[no_mangle]
pub extern "C" fn tb_dht11_attach(pin: u32) {
    with((), |m| m.dht11_attach(pin))
}

/// DHT11 stats: 0 = frames sent, 1 = start pulses too short; NaN = not attached
#[no_mangle]
pub extern "C" fn tb_dht11_stat(which: u32) -> f64 {
    with(f64::NAN, |m| match (m.dht11_stats(), which) {
        (Some(s), 0) => s.0 as f64,
        (Some(s), 1) => s.1 as f64,
        _ => f64::NAN,
    })
}

/// Timing-sensitive code report (D-03) as JSON {"line","items":[{pin,kind,n}]} or {}; length, read via tb_report_ptr
#[no_mangle]
pub extern "C" fn tb_timing_report() -> usize {
    let r = with("{}".to_string(), |m| m.timing_json());
    let n = r.len();
    REPORT.with(|b| *b.borrow_mut() = r);
    n
}

/// Start a fine capture (D-04): pin mask as two 32-bit halves, window [t0, t1] in seconds (same rounding as the CLI)
#[no_mangle]
pub extern "C" fn tb_vcd_start(mask_lo: u32, mask_hi: u32, t0: f64, t1: f64) {
    let c = tryboard_soc::vcd::VcdCapture::cycles_of;
    with((), |m| {
        m.vcd_start(mask_lo as u64 | (mask_hi as u64) << 32, c(t0), c(t1))
    })
}

/// Triggered fine capture: from `from` s, the next edge on a captured pin opens a `len` s window
#[no_mangle]
pub extern "C" fn tb_vcd_arm(mask_lo: u32, mask_hi: u32, from: f64, len: f64) {
    let c = tryboard_soc::vcd::VcdCapture::cycles_of;
    with((), |m| {
        m.vcd_arm(mask_lo as u64 | (mask_hi as u64) << 32, c(from), c(len))
    })
}

/// The fine capture as VCD text, byte-identical to the CLI's --vcd file; length, read via tb_report_ptr
#[no_mangle]
pub extern "C" fn tb_vcd_text() -> usize {
    let r = with(String::new(), |m| m.vcd_text());
    let n = r.len();
    REPORT.with(|b| *b.borrow_mut() = r);
    n
}

/// Fine capture stats: 0 = edges kept, 1 = edges dropped (buffer full), 2 / 3 = window start / end cycle;
/// NaN = no capture (2 / 3: still waiting for the trigger)
#[no_mangle]
pub extern "C" fn tb_vcd_stat(which: u32) -> f64 {
    with(f64::NAN, |m| match (m.vcd_stats(), m.vcd_window(), which) {
        (Some(s), _, 0) => s.0 as f64,
        (Some(s), _, 1) => s.1 as f64,
        (_, Some(w), 2) => w.0 as f64,
        (_, Some(w), 3) => w.1 as f64,
        _ => f64::NAN,
    })
}

// ---------------------------------------------------------------- Power network (tryboard-elec, P1-01 / P1-02)

/// Power mode: 0 = USB only (servo also on USB 5V), 1 = servo on an external 5 V 2 A supply
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

/// Attach an SG90 on GPIO `pin` (its current enters the power network, angle from second-order dynamics)
#[no_mangle]
pub extern "C" fn tb_servo_attach(pin: u32) {
    with((), |m| m.servo_attach(pin))
}

/// Node voltage (V): 1 = 5V rail, 2 = 3V3, 3 = servo red wire, 4 = external 5 V
#[no_mangle]
pub extern "C" fn tb_elec_v(node: u32) -> f64 {
    with(0.0, |m| m.elec.node_v(node as usize))
}

/// Current (A): 0 = USB port, 1 = external supply, 2 = servo, 3 = LDO output (total 3V3), 4 = chip, 5 = amplifier on the 5 V rail
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

/// Stats since power-on: 0 = min 5V, 1 = min 3V3, 2 = min at servo, 3 = peak USB current, 4 = peak external, 5 = peak servo,
/// 6 = peak 3V3, 7 = brownout resets, 8 = chip held in brownout reset (1/0), 9 = peak amplifier current
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

/// Simulated time (s) of the i-th brownout reset; -1 if none
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

/// Servo output shaft angle (deg); NaN = no servo
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

/// Same text as the CLI's `--elec-report`; returns its length, read via tb_report_ptr (buffer shared with tb_report)
#[no_mangle]
pub extern "C" fn tb_elec_report() -> usize {
    let r = with(String::new(), |m| m.elec.report());
    let n = r.len();
    REPORT.with(|b| *b.borrow_mut() = r);
    n
}

// ---------------------------------------------------------------- Miswiring solver (P2-14, estimate)

/// Branch current (A) of a miswiring for the lab wiring check; pure (machine untouched), same circuit as CLI tools/elec.
/// s3 = 1 uses S3 chip currents; other results via tb_fault_out.
#[no_mangle]
pub extern "C" fn tb_fault(kind: u32, s3: u32, a: f64, b: f64, c: f64, d: f64) -> f64 {
    // kind 1: part output (a V via b Ω) vs opposite GPIO level; 2: two parts fight (a V via b Ω vs c V via d Ω)
    // 3: GPIO high into LED (a Ω series, 0 = none); 4: rail to GND (a: 0 = 3V3, 1 = 5V, 2 = ext 5 V); 5: 5 V via a Ω into GPIO clamp
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

/// Other results of the last tb_fault: 0 = key node voltage (pin / shorted rail), 1 = 5V rail, 2 = 3V3 rail, 3 = current limiter
/// (0 = internal resistance only, 1 = USB port limit, 2 = external supply limit, 3 = LDO limit, 4 = LDO in dropout)
#[no_mangle]
pub extern "C" fn tb_fault_out(k: u32) -> f64 {
    FAULT.with(|f| f.borrow().get(k as usize).copied().unwrap_or(f64::NAN))
}

// ---------------------------------------------------------------- Wiring harness (P2-11, estimate)

/// Total I2C cable length (cm); negative = ideal bus (no rise time)
#[no_mangle]
pub extern "C" fn tb_i2c_wire(cm: f64) {
    with((), |m| {
        m.set_i2c_wire(if cm < 0.0 { None } else { Some(cm) })
    })
}

/// Attenuation (dB) from metal parts / battery blocking the antenna
#[no_mangle]
pub extern "C" fn tb_antenna_loss(db: i32) {
    with((), |m| m.set_antenna_loss(db))
}

/// Harness conclusion (same text as the CLI, empty if unset); returns its length, read via tb_report_ptr
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

// ---------------------------------------------------------------- Native USB (ESP32-S3)

/// USB conclusion for level checks (the USB host and keyboard-input lines of the CLI's --usb-log); length, read via tb_report_ptr
#[no_mangle]
pub extern "C" fn tb_usb_report() -> usize {
    let r = with(String::new(), |m| tryboard_machine::usb_report_lines(m));
    let n = r.len();
    REPORT.with(|b| *b.borrow_mut() = r);
    n
}

/// I2C ack counts for generated checkpoints (U-17), same text as the CLI's `--i2c-log`; read like tb_report
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

/// USB state change counter: fetch JSON only when it changes. 0 = no USB device (C3, or firmware without USB)
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

/// Serialize what the virtual host sees as JSON; returns its length, read via tb_usb_json_ptr
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

/// # Safety
/// p/len must describe a valid buffer (bytes the virtual PC writes to the CDC-ACM port)
#[no_mangle]
pub unsafe extern "C" fn tb_usb_cdc_send(p: *const u8, len: usize) {
    let d = std::slice::from_raw_parts(p, len);
    M.with(|c| {
        if let Some(u) = c.borrow_mut().as_mut().and_then(|m| m.usb_mut()) {
            u.host.cdc_tx.extend_from_slice(d);
        }
    });
}

// ---------------------------------------------------------------- BLE (C-01)

/// 0 = firmware uses no BLE; 1 = VHCI boundary found, virtual controller running; 2 = BLE used but not recognised (reason in tb_ble_json)
#[no_mangle]
pub extern "C" fn tb_ble_state() -> u32 {
    with(0, |m| {
        if m.ble_error().is_some() {
            2
        } else if m.ble().is_some_and(|b| b.active) {
            1
        } else {
            0
        }
    })
}

/// Total air-log entries: fetch only when it changes
#[no_mangle]
pub extern "C" fn tb_ble_seq() -> f64 {
    with(0.0, |m| m.ble().map_or(0.0, |b| b.log_seq as f64))
}

/// Advertising / connection / virtual phone view + air log from seq `from`, as JSON; length, read via tb_ble_json_ptr.
/// {"error": reason} when the VHCI boundary was not found
#[no_mangle]
pub extern "C" fn tb_ble_json(from: f64) -> usize {
    let j = with(String::new(), |m| {
        if let Some(e) = m.ble_error() {
            return format!("{{\"error\":{}}}", json_str(&e));
        }
        let Some(b) = m.ble() else {
            return String::new();
        };
        format!(
            "{{\"view\":{},\"log\":{}}}",
            b.json(),
            b.log_json(from as u64)
        )
    });
    let n = j.len();
    BLE_JSON.with(|b| *b.borrow_mut() = j);
    n
}

#[no_mangle]
pub extern "C" fn tb_ble_json_ptr() -> *const u8 {
    BLE_JSON.with(|b| b.borrow().as_ptr())
}

/// # Safety
/// p/len must describe a valid buffer. Virtual phone command (same text as CLI `ble=`); 0 = accepted, else see tb_error_ptr
#[no_mangle]
pub unsafe extern "C" fn tb_ble_cmd(p: *const u8, len: usize) -> i32 {
    let cmd = String::from_utf8_lossy(std::slice::from_raw_parts(p, len)).into_owned();
    match with(Err("not powered on".into()), |m| m.ble_phone(&cmd)) {
        Ok(()) => 0,
        Err(e) => {
            ERR.with(|b| *b.borrow_mut() = e);
            1
        }
    }
}

// ---------------------------------------------------------------- Virtual phone / network (C-02 / C-03)

thread_local! {
    static PHONE_JSON: RefCell<String> = const { RefCell::new(String::new()) };
}

/// Firmware used Wi-Fi (sent frames): only then does the web dock show the "network" tab.
/// Having picked up the phone counts too: esp_restart clears the frame count, the tab must not flicker away
#[no_mangle]
pub extern "C" fn tb_wifi_used() -> u32 {
    with(0, |m| {
        let w = m.wifi();
        (w.tx_frames > 0 || w.world.phone.is_some()) as u32
    })
}

/// # Safety
/// One virtual phone step (same text as after phone=: on / join,ssid[,pass] / leave / open / get,url / post,url,body); returns 0 ok, 1 unrecognised. p/len must be valid UTF-8
#[no_mangle]
pub unsafe extern "C" fn tb_phone_cmd(p: *const u8, len: usize) -> u32 {
    let s = String::from_utf8_lossy(std::slice::from_raw_parts(p, len)).into_owned();
    let Some(c) = tryboard_machine::PhoneCmd::parse(&s) else {
        return 1;
    };
    with(1, |m| {
        m.phone_cmd(c);
        0
    })
}

/// "Real network" switch (C-03, script action realnet=1/0)
#[no_mangle]
pub extern "C" fn tb_realnet_set(on: u32) {
    with((), |m| m.realnet_set(on != 0));
}

/// # Safety
/// p/len: script action text seed=N / net=preset / netfault=kind[,s] (D-01); 0 ok, 1 unrecognised
#[no_mangle]
pub unsafe extern "C" fn tb_net_action(p: *const u8, len: usize) -> u32 {
    let s = String::from_utf8_lossy(std::slice::from_raw_parts(p, len)).into_owned();
    with(1, |m| (m.net_action(&s) != Some(true)) as u32)
}

/// Drain the real-network outbox: [{id, method, url, ctype, body(base64)}], returns the length (0 = none); read via tb_phone_json_ptr
#[no_mangle]
pub extern "C" fn tb_net_outbox() -> usize {
    let reqs = with(Vec::new(), |m| m.net_outbox_take());
    if reqs.is_empty() {
        return 0;
    }
    let v: Vec<String> = reqs
        .iter()
        .map(|r| {
            format!(
                "{{\"id\":{},\"method\":{},\"url\":{},\"ctype\":{},\"body\":\"{}\"}}",
                r.id,
                json_str(&r.method),
                json_str(&r.url),
                json_str(&r.ctype),
                tryboard_soc::wifi::tcp::b64_encode(&r.body)
            )
        })
        .collect();
    let j = format!("[{}]", v.join(","));
    let n = j.len();
    PHONE_JSON.with(|b| *b.borrow_mut() = j);
    n
}

/// # Safety
/// Real-network reply (the part after netreply=); returns 0 ok, 1 unparsable. p/len must be valid UTF-8
#[no_mangle]
pub unsafe extern "C" fn tb_net_reply(p: *const u8, len: usize) -> u32 {
    let s = String::from_utf8_lossy(std::slice::from_raw_parts(p, len)).into_owned();
    with(1, |m| if m.net_reply(&s) { 0 } else { 1 })
}

/// Phone state change counter (0 = phone never picked up): fetch the JSON when it moves
#[no_mangle]
pub extern "C" fn tb_phone_version() -> f64 {
    M.with(|c| {
        let b = c.borrow();
        b.as_ref()
            .and_then(|m| m.phone())
            .map_or(0.0, |p| (p.version + p.log.len() as u64 + 1) as f64)
    })
}

/// What the phone sees (nearby networks, IP, sign-in needed, opened pages, log), returns the length; read via tb_phone_json_ptr
#[no_mangle]
pub extern "C" fn tb_phone_json() -> usize {
    let j = M.with(|c| {
        let b = c.borrow();
        b.as_ref()
            .and_then(|m| m.phone())
            .map(|p| p.json())
            .unwrap_or_default()
    });
    let n = j.len();
    PHONE_JSON.with(|b| *b.borrow_mut() = j);
    n
}

#[no_mangle]
pub extern "C" fn tb_phone_json_ptr() -> *const u8 {
    PHONE_JSON.with(|b| b.borrow().as_ptr())
}

/// Number of network-tab rows (fetch the JSON when it changes)
#[no_mangle]
pub extern "C" fn tb_net_version() -> f64 {
    with(0.0, |m| {
        let n = &m.wifi().world.net;
        // Rows + rewrites (real-network rows go from "Waiting" to 200 / Timed out): both only grow, so a changed sum means a change
        let c = m.wifi().world.cond.rev;
        (n.tcp.rows.len() as u64 + n.tcp.rev + c) as f64 + if n.leased { 1e9 } else { 0.0 }
    })
}

/// Network tab: latest 300 rows [time ms, method, dest, url, status, duration ms | null, note], returns the length; read via tb_phone_json_ptr
#[no_mangle]
pub extern "C" fn tb_net_json() -> usize {
    let j = with(String::new(), |m| {
        let net = &m.wifi().world.net;
        let rows = &net.tcp.rows;
        let r: Vec<String> = rows[rows.len().saturating_sub(300)..]
            .iter()
            .map(|r| {
                format!(
                    "[{},{},{},{},{},{},{}]",
                    r.t_us as f64 / 1000.0,
                    json_str(&r.method),
                    json_str(r.dest),
                    json_str(&r.url),
                    json_str(&r.status),
                    r.dur_us
                        .map_or("null".to_string(), |d| format!("{}", d as f64 / 1000.0)),
                    json_str(&r.note)
                )
            })
            .collect();
        // Address the chip got from the virtual router (only after DHCP ACK): the provisioning panel's "got IP"
        let lease = if net.leased {
            let i = net.sta_ip;
            format!("\"{}.{}.{}.{}\"", i[0], i[1], i[2], i[3])
        } else {
            "null".to_string()
        };
        // Network conditions summary (D-01): null while untouched
        let cond = m.net_summary().map_or("null".to_string(), |n| {
            format!(
                "{{\"preset\":\"{}\",\"seed\":{},\"faults\":{},\"disconnects\":{},\"reconnect_ms\":{},\"lost\":{},\"ok\":{},\"failed\":{},\"lost_frames\":{}}}",
                n.preset.name(),
                n.seed,
                n.faults,
                n.disconnects,
                n.reconnect_us
                    .map_or("null".to_string(), |d| format!("{}", d as f64 / 1000.0)),
                n.lost,
                n.ok,
                n.failed,
                n.lost_frames
            )
        });
        format!(
            "{{\"total\":{},\"lease\":{lease},\"realnet\":{},\"cond\":{cond},\"rows\":[{}]}}",
            rows.len(),
            net.tcp.realnet,
            r.join(",")
        )
    });
    let n = j.len();
    PHONE_JSON.with(|b| *b.borrow_mut() = j);
    n
}

// ---------------------------------------------------------------- Acceptance observations (for level checks)

/// Observations in the CLI `--gpio-log --ws2812-log` format (GPIO toggles, WS2812 frames, OLED / LCD lit pixels); web checks and
/// tools/accept.sh parse the same text so their verdicts agree. Returns the length, read via tb_report_ptr.
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
                let _ = writeln!(o, "[tryboard] GPIO{pin} toggled {n} times");
            }
        }
        let mut pins: Vec<_> = m.ws2812().iter().collect();
        pins.sort_by_key(|(p, _)| **p);
        for (pin, d) in pins {
            let _ = writeln!(o, "[tryboard] WS2812 GPIO{pin} {} frames", d.frames);
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
            let _ = writeln!(o, "[tryboard] OLED lit pixels {}", d.lit_pixels());
        }
        if let Some(d) = m.lcd() {
            let _ = writeln!(
                o,
                "[tryboard] LCD {} non-black pixels {}",
                d.name(),
                d.lit_pixels()
            );
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

// ---------------------------------------------------------------- Logic-analyzer events (P1-05)

/// GPIOs to watch (lo = GPIO0..31, hi = GPIO32..); PWM / WS2812 / I2C are always logged. Set after boot, again after re-boot
#[no_mangle]
pub extern "C" fn tb_io_watch(lo: u32, hi: u32) {
    with((), |m| m.io_watch(lo as u64 | (hi as u64) << 32))
}

/// Take the core's event buffer: 16 bytes each (t u64 | kind u8 | a u8 | b u16 | v u32, LE, see tryboard_soc::iotrace),
/// copied internally; returns the count, then read count × 16 bytes via tb_io_ptr
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

/// Events dropped because the core buffer was full (cumulative since boot)
#[no_mangle]
pub extern "C" fn tb_io_dropped() -> f64 {
    with(0.0, |m| m.io_dropped() as f64)
}

// ---------------------------------------------------------------- FreeRTOS task timeline (C-04)

/// Start recording task switches (cap = core buffer entries, 0 = off). Set after boot, again after re-boot
#[no_mangle]
pub extern "C" fn tb_tasks_enable(cap: u32) {
    with((), |m| m.tasks_enable(cap as usize))
}

/// Take task-switch events: 16 bytes each (t u64 | core u8 | prev u8 | task u16 | pc u32, LE, see
/// tryboard_soc::tasktrace), copied internally; returns the count, then read via tb_tasks_ptr
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

/// Task table JSON (event `task` is an index): {"cores":N,"dropped":N,"tasks":[{"name","prio","core","tcb"}]};
/// returns its length, read via tb_tasks_json_ptr
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

// ---------------------------------------------------------------- I2S audio (P2-06)

/// Attach an I2S audio part: 0 = MAX98357A speaker, 1 = INMP441 microphone (pins: ARCH "I2S"). Returns 0 on success
#[no_mangle]
pub extern "C" fn tb_i2s_attach(kind: u32) -> i32 {
    let k = match kind {
        0 => "max98357a",
        1 => "inmp441",
        _ => return 1,
    };
    with(1, |m| if m.i2s_attach(k) { 0 } else { 1 })
}

/// Take buffered speaker audio, returns the block count. Block: t f64 (sim time of first sample, s) | rate f32 | n u32 |
/// n mono i16 samples, padded to 4 bytes; read via tb_audio_ptr / tb_audio_len
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

/// Speaker readings (last 1 s): 0 = sample rate, 1 = total frames, 2 = RMS, 3 = dominant freq (Hz), 4 = peak;
/// 5 = frames sent by the microphone. NaN if that part is not attached
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

/// # Safety
/// ptr..ptr+len must be filled tb_alloc memory. Feeds the microphone a fixed WAV; 0 = ok, 1 = unreadable WAV
#[no_mangle]
pub unsafe extern "C" fn tb_mic_wav(ptr: *const u8, len: usize) -> i32 {
    let b = std::slice::from_raw_parts(ptr, len);
    match tryboard_soc::devices::audio::parse_wav(b) {
        Ok((rate, x)) => with(1, |m| {
            m.mic_wav(rate as f64, x);
            0
        }),
        Err(_) => 1,
    }
}

/// # Safety
/// ptr..ptr+4n must be filled tb_alloc memory (no alignment needed): n LE f32 (-1..1) live mic samples at `rate`
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

/// Return the microphone to silence
#[no_mangle]
pub extern "C" fn tb_mic_silence() {
    with((), |m| m.mic_silence())
}

/// Same `[tryboard] I2S …` text the CLI prints at exit; returns its length, read via tb_report_ptr
#[no_mangle]
pub extern "C" fn tb_audio_report() -> usize {
    let r = with(String::new(), |m| m.audio_report());
    let n = r.len();
    REPORT.with(|b| *b.borrow_mut() = r);
    n
}

thread_local! {
    static ADC: RefCell<Vec<i32>> = const { RefCell::new(Vec::new()) };
}

/// Session seed (input-log action `seed=`); same streams as the CLI's --seed
#[no_mangle]
pub extern "C" fn tb_seed(seed: u32) {
    with((), |m| m.set_seed(seed))
}

/// ADC model: 1 = ideal (linear, exact), 0 = real (default); input-log action `adc=`
#[no_mangle]
pub extern "C" fn tb_adc_mode(ideal: u32) {
    with((), |m| m.set_adc_ideal(ideal != 0))
}

/// Copy recent conversions on `pin` as (raw, calibrated mV) i32 pairs, oldest first; returns the pair count.
/// Read them with tb_adc_ptr.
#[no_mangle]
pub extern "C" fn tb_adc_fetch(pin: u32) -> usize {
    let v: Vec<i32> = with(Vec::new(), |m| {
        m.adc_samples(pin as usize)
            .iter()
            .flat_map(|s| [s.raw as i32, s.mv])
            .collect()
    });
    let n = v.len() / 2;
    ADC.with(|a| *a.borrow_mut() = v);
    n
}

#[no_mangle]
pub extern "C" fn tb_adc_ptr() -> *const i32 {
    ADC.with(|a| a.borrow().as_ptr())
}

/// ADC2 reads refused while Wi-Fi held the arbiter
#[no_mangle]
pub extern "C" fn tb_adc_blocked() -> f64 {
    with(0.0, |m| m.adc_blocked() as f64)
}
