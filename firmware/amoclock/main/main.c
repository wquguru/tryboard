// G-17a work "AMOLED desk clock" for the Waveshare ESP32-S3-Touch-AMOLED-2.16: CO5300 480x480 QSPI AMOLED, CST9220 touch,
// AXP2101 PMIC (battery, PWR key), PCF85063 RTC. LVGL 9, three pages (clock / temperature / battery) switched by swipes;
// the dial is a seven-segment HH:MM with jumping seconds, redrawn only where it changes (G-07: no sweeping hands). The PWR
// key blanks the panel (CO5300 brightness 0x51 = 0) and wakes it; a NimBLE characteristic FF11 takes epoch seconds to set
// the RTC. Written for TryBoard from the datasheets and the IDF / LVGL APIs; no third-party firmware code. (lint: allow-long-comment)
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/spi_master.h"
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/temperature_sensor.h"
#include "esp_timer.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_co5300.h"
#include "esp_lvgl_port.h"
#include "lvgl.h"
#include "nvs_flash.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

// Board pins (same as s3-ai-dash / s3-co5300)
#define PIN_CS 12
#define PIN_CLK 38
#define PIN_D0 4
#define PIN_D1 5
#define PIN_D2 6
#define PIN_D3 7
#define PIN_RST 39
#define I2C_SDA 15
#define I2C_SCL 14
#define TP_INT 11
#define TP_RST 40
#define LCD_W 480
#define LCD_H 480
#define BUF_LINES 40

#define PAGES 3
#define SWIPE_MIN 60
#define BAR_W 400
#define BAR_H 40

#define C_BG 0x000000
#define C_CARD 0x1C1C24
#define C_TEXT 0xFFFFFF
#define C_MUTED 0x8E8E9A
#define C_IDLE 0x3A3A44
#define C_DIGIT 0x40C8FF
#define C_GREEN 0x30D158
#define C_AMBER 0xFFB020
#define C_BLUE 0x0A84FF

static const char *DEVICE_NAME = "TryBoard-Clock";
static const char *PAGE_NAMES[PAGES] = {"Clock", "Temperature", "Battery"};
static const char *PAGE_CN[PAGES] = {"时间", "温度", "电量"};
static const char *WEEKDAY[7] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};

// ---------------------------------------------------------------- I2C devices
static i2c_master_bus_handle_t bus;
static i2c_master_dev_handle_t tp, pmu, rtc;

static i2c_master_dev_handle_t add_dev(uint8_t addr)
{
    i2c_master_dev_handle_t h;
    i2c_device_config_t dc = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = addr, .scl_speed_hz = 400000};
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dc, &h));
    return h;
}

static esp_err_t rd8(i2c_master_dev_handle_t d, uint8_t reg, uint8_t *buf, size_t n)
{
    return i2c_master_transmit_receive(d, &reg, 1, buf, n, 50);
}

static esp_err_t wr8(i2c_master_dev_handle_t d, uint8_t reg, const uint8_t *v, size_t n)
{
    uint8_t b[16];
    b[0] = reg;
    memcpy(b + 1, v, n);
    return i2c_master_transmit(d, b, n + 1, 50);
}

static uint8_t bcd(int v) { return (v / 10) << 4 | v % 10; }
static int unbcd(uint8_t b) { return (b >> 4) * 10 + (b & 15); }

static void i2c_init(void)
{
    // Touch reset: low 10 ms, then the chip firmware needs ~30 ms before I2C
    gpio_config_t rst = {.pin_bit_mask = 1ULL << TP_RST, .mode = GPIO_MODE_OUTPUT};
    ESP_ERROR_CHECK(gpio_config(&rst));
    gpio_set_level(TP_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(TP_RST, 1);
    gpio_config_t ic = {.pin_bit_mask = 1ULL << TP_INT, .mode = GPIO_MODE_INPUT, .pull_up_en = 1};
    ESP_ERROR_CHECK(gpio_config(&ic));
    i2c_master_bus_config_t bc = {
        .i2c_port = 0,
        .sda_io_num = I2C_SDA,
        .scl_io_num = I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    ESP_ERROR_CHECK(i2c_new_master_bus(&bc, &bus));
    tp = add_dev(0x5A);
    pmu = add_dev(0x34);
    rtc = add_dev(0x51);
    // AXP2101: clear stale IRQ status, then enable only the PWRON short / long press IRQs (0x41 bits 3 / 2)
    const uint8_t clr[3] = {0xFF, 0xFF, 0xFF}, en[3] = {0x00, 0x0C, 0x00};
    wr8(pmu, 0x48, clr, 3);
    wr8(pmu, 0x40, en, 3);
}

// ---------------------------------------------------------------- UI
static int page;
static int hh = -1, mm = -1, ss = -1, cur_digits[4] = {-1, -1, -1, -1};
static char date_text[32] = "----------";
static int bat_pct = -1, vbat_mv;
static bool bat_usb, bat_chg;
static float temp_c;
static bool temp_ok, ble_online, screen_on = true;

static lv_obj_t *pages[PAGES], *dots[PAGES];
static lv_obj_t *l_title, *l_ble, *l_bat;
static lv_obj_t *seg[4][7], *l_sec, *l_date, *l_sync;
static lv_obj_t *l_temp, *l_temp_note;
static lv_obj_t *l_pct, *fill_bat, *l_chg, *l_vbat;

static lv_obj_t *box(lv_obj_t *parent, int x, int y, int w, int h, uint32_t color, int radius)
{
    lv_obj_t *o = lv_obj_create(parent);
    lv_obj_remove_style_all(o);
    lv_obj_remove_flag(o, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_pos(o, x, y);
    lv_obj_set_size(o, w, h);
    lv_obj_set_style_bg_color(o, lv_color_hex(color), 0);
    lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(o, radius, 0);
    return o;
}

static lv_obj_t *text(lv_obj_t *parent, int x, int y, const lv_font_t *font, uint32_t color, const char *s)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(color), 0);
    lv_obj_set_pos(l, x, y);
    lv_label_set_text(l, s);
    return l;
}

static lv_obj_t *centered(lv_obj_t *parent, int y, const lv_font_t *font, uint32_t color, const char *s)
{
    lv_obj_t *l = text(parent, 0, y, font, color, s);
    lv_obj_set_width(l, LCD_W);
    lv_obj_set_style_text_align(l, LV_TEXT_ALIGN_CENTER, 0);
    return l;
}

// Seven-segment digit 80 x 150, stroke 16: solid rectangles (no antialiasing) so the lit pixel count is exact per digit
#define DIG_W 80
#define DIG_H 150
#define DIG_T 16
#define DIG_Y 46
static const int DIG_X[4] = {40, 136, 264, 360};
static const uint8_t SEG_MASK[10] = {0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F};

static void build_digit(lv_obj_t *p, int i)
{
    const int x = DIG_X[i], y = DIG_Y, m = (DIG_H - DIG_T) / 2, half = (DIG_H + DIG_T) / 2;
    const int r[7][4] = {
        {x, y, DIG_W, DIG_T},                      // a
        {x + DIG_W - DIG_T, y, DIG_T, half},       // b
        {x + DIG_W - DIG_T, y + m, DIG_T, half},   // c
        {x, y + DIG_H - DIG_T, DIG_W, DIG_T},      // d
        {x, y + m, DIG_T, half},                   // e
        {x, y, DIG_T, half},                       // f
        {x, y + m, DIG_W, DIG_T},                  // g
    };
    for (int s = 0; s < 7; s++) {
        seg[i][s] = box(p, r[s][0], r[s][1], r[s][2], r[s][3], C_DIGIT, 0);
        lv_obj_add_flag(seg[i][s], LV_OBJ_FLAG_HIDDEN);
    }
}

static void set_digit(int i, int v)
{
    if (cur_digits[i] == v) return;
    cur_digits[i] = v;
    for (int s = 0; s < 7; s++) {
        if (v >= 0 && SEG_MASK[v] & (1 << s)) {
            lv_obj_remove_flag(seg[i][s], LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(seg[i][s], LV_OBJ_FLAG_HIDDEN);
        }
    }
}

static void build_clock(lv_obj_t *p)
{
    for (int i = 0; i < 4; i++) build_digit(p, i);
    box(p, 232, DIG_Y + 40, 16, 16, C_DIGIT, 0);
    box(p, 232, DIG_Y + 94, 16, 16, C_DIGIT, 0);
    l_sec = centered(p, 220, &lv_font_montserrat_48, C_TEXT, "--");
    l_date = centered(p, 296, &lv_font_montserrat_20, C_MUTED, date_text);
    l_sync = centered(p, 330, &lv_font_montserrat_14, C_IDLE, "Set the time from the phone: write FF11");
}

static void build_temp(lv_obj_t *p)
{
    centered(p, 40, &lv_font_montserrat_20, C_MUTED, "Chip temperature");
    l_temp = centered(p, 120, &lv_font_montserrat_48, C_AMBER, "--.- C");
    l_temp_note = centered(p, 220, &lv_font_montserrat_14, C_MUTED, "ESP32-S3 internal sensor: die temperature, not room air");
}

static void build_battery(lv_obj_t *p)
{
    l_pct = centered(p, 60, &lv_font_montserrat_48, C_TEXT, "--%");
    box(p, 40, 160, BAR_W, BAR_H, C_CARD, 0);
    fill_bat = box(p, 40, 160, 0, BAR_H, C_GREEN, 0);
    l_chg = centered(p, 228, &lv_font_montserrat_20, C_MUTED, "");
    l_vbat = centered(p, 262, &lv_font_montserrat_14, C_MUTED, "");
}

static void show_page(int n)
{
    page = n;
    for (int i = 0; i < PAGES; i++) {
        if (i == n) {
            lv_obj_remove_flag(pages[i], LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(pages[i], LV_OBJ_FLAG_HIDDEN);
        }
        lv_obj_set_style_bg_color(dots[i], lv_color_hex(i == n ? C_TEXT : C_IDLE), 0);
    }
    lv_label_set_text(l_title, PAGE_NAMES[n]);
}

static void build_ui(void)
{
    lv_obj_t *scr = lv_screen_active();
    lv_obj_remove_flag(scr, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_bg_color(scr, lv_color_hex(C_BG), 0);
    l_title = centered(scr, 20, &lv_font_montserrat_20, C_MUTED, "");
    l_ble = text(scr, 24, 20, &lv_font_montserrat_20, C_IDLE, LV_SYMBOL_BLUETOOTH);
    l_bat = text(scr, 344, 20, &lv_font_montserrat_20, C_TEXT, LV_SYMBOL_BATTERY_EMPTY " --%");
    lv_obj_set_width(l_bat, 112);
    lv_obj_set_style_text_align(l_bat, LV_TEXT_ALIGN_RIGHT, 0);
    for (int i = 0; i < PAGES; i++) {
        pages[i] = lv_obj_create(scr);
        lv_obj_remove_style_all(pages[i]);
        lv_obj_remove_flag(pages[i], LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);
        lv_obj_set_pos(pages[i], 0, 64);
        lv_obj_set_size(pages[i], LCD_W, 368);
        dots[i] = box(scr, 210 + i * 24, 448, 12, 12, C_IDLE, LV_RADIUS_CIRCLE);
    }
    build_clock(pages[0]);
    build_temp(pages[1]);
    build_battery(pages[2]);
    show_page(0);
}

// Caller holds the LVGL lock; only labels whose text changed are invalidated by LVGL, so a tick redraws the seconds alone
static void apply_clock(void)
{
    if (hh < 0) return;
    set_digit(0, hh / 10);
    set_digit(1, hh % 10);
    set_digit(2, mm / 10);
    set_digit(3, mm % 10);
    char s[4];
    snprintf(s, sizeof s, "%02d", ss);
    if (strcmp(lv_label_get_text(l_sec), s)) lv_label_set_text(l_sec, s);
    if (strcmp(lv_label_get_text(l_date), date_text)) lv_label_set_text(l_date, date_text);
}

static void apply_status(void)
{
    const char *sym = bat_usb ? LV_SYMBOL_CHARGE : bat_pct > 80 ? LV_SYMBOL_BATTERY_FULL : bat_pct > 55 ? LV_SYMBOL_BATTERY_3
                    : bat_pct > 30 ? LV_SYMBOL_BATTERY_2 : bat_pct > 10 ? LV_SYMBOL_BATTERY_1 : LV_SYMBOL_BATTERY_EMPTY;
    if (bat_pct >= 0) {
        lv_label_set_text_fmt(l_bat, "%s %d%%", sym, bat_pct);
        lv_label_set_text_fmt(l_pct, "%d%%", bat_pct);
        lv_obj_set_width(fill_bat, BAR_W * bat_pct / 100);
        lv_label_set_text(l_chg, bat_chg ? "Charging (USB)" : bat_usb ? "USB, full" : "On battery");
        lv_label_set_text_fmt(l_vbat, "VBAT %d mV", vbat_mv);
    }
    if (temp_ok) lv_label_set_text_fmt(l_temp, "%.1f C", temp_c);
    lv_obj_set_style_text_color(l_ble, lv_color_hex(ble_online ? C_BLUE : C_IDLE), 0);
}

// ---------------------------------------------------------------- display and touch
static esp_lcd_panel_io_handle_t lcd_io;
static esp_lcd_panel_handle_t lcd_panel;
static int64_t first_frame_us;

static void lcd_init(void)
{
    const spi_bus_config_t bc = CO5300_PANEL_BUS_QSPI_CONFIG(PIN_CLK, PIN_D0, PIN_D1, PIN_D2, PIN_D3, LCD_W * BUF_LINES * 2);
    ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bc, SPI_DMA_CH_AUTO));
    // esp_lvgl_port installs its own transfer-done callback
    const esp_lcd_panel_io_spi_config_t ioc = CO5300_PANEL_IO_QSPI_CONFIG(PIN_CS, NULL, NULL);
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI2_HOST, &ioc, &lcd_io));
    co5300_vendor_config_t vc = {.flags = {.use_qspi_interface = 1}};
    const esp_lcd_panel_dev_config_t pc = {
        .reset_gpio_num = PIN_RST,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = 16,
        .vendor_config = &vc,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_co5300(lcd_io, &pc, &lcd_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_reset(lcd_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(lcd_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(lcd_panel, true));
}

// CO5300 column / row windows must start on an even pixel and span an even count
static void on_invalidate(lv_event_t *e)
{
    lv_area_t *a = lv_event_get_param(e);
    a->x1 &= ~1;
    a->y1 &= ~1;
    a->x2 |= 1;
    a->y2 |= 1;
}

static void on_render(lv_event_t *e)
{
    if (!first_frame_us) {
        first_frame_us = esp_timer_get_time();
        printf("首屏 已显示 %lld ms\n", first_frame_us / 1000);
    }
}

static void swipe(int dx, int dy)
{
    if (!screen_on) {
        printf("息屏中 忽略滑动\n");
        return;
    }
    if (abs(dx) < SWIPE_MIN || abs(dx) < abs(dy)) return;
    int n = dx < 0 ? page + 1 : page - 1;
    if (n < 0 || n >= PAGES) {
        printf("滑动 %s：已经是%s一页\n", dx < 0 ? "向左" : "向右", dx < 0 ? "最后" : "第");
        return;
    }
    show_page(n);
    printf("滑动 %s dx=%d → 页 %d/%d %s\n", dx < 0 ? "向左" : "向右", dx, n + 1, PAGES, PAGE_CN[n]);
}

// LVGL pointer: pressed state from the INT pin (low while touched), coordinates from the CST9220 0xD000 report
static void touch_read(lv_indev_t *indev, lv_indev_data_t *data)
{
    static int x, y, sx, sy;
    static bool down;
    bool pressed = gpio_get_level(TP_INT) == 0;
    if (pressed) {
        uint8_t a[2] = {0xD0, 0x00}, d[7];
        if (i2c_master_transmit_receive(tp, a, 2, d, sizeof d, 50) == ESP_OK) {
            uint8_t ack[3] = {0xD0, 0x00, 0xAB};
            i2c_master_transmit(tp, ack, 3, 50);
            if (d[6] == 0xAB && (d[5] & 0x7F) > 0 && (d[0] & 0x0F) == 0x06) {
                x = d[1] << 4 | d[3] >> 4;
                y = d[2] << 4 | (d[3] & 15);
            }
        }
        if (!down) {
            sx = x;
            sy = y;
            down = true;
        }
    } else if (down) {
        down = false;
        swipe(x - sx, y - sy);
    }
    data->point.x = x;
    data->point.y = y;
    data->state = pressed ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
}

static void display_init(void)
{
    lcd_init();
    const lvgl_port_cfg_t pcfg = ESP_LVGL_PORT_INIT_CONFIG();
    ESP_ERROR_CHECK(lvgl_port_init(&pcfg));
    const lvgl_port_display_cfg_t dcfg = {
        .io_handle = lcd_io,
        .panel_handle = lcd_panel,
        .buffer_size = LCD_W * BUF_LINES,
        .double_buffer = true,
        .hres = LCD_W,
        .vres = LCD_H,
        .color_format = LV_COLOR_FORMAT_RGB565,
        .flags = {.buff_dma = 1, .swap_bytes = 1},
    };
    lv_display_t *disp = lvgl_port_add_disp(&dcfg);
    assert(disp);
    lvgl_port_lock(0);
    lv_display_add_event_cb(disp, on_invalidate, LV_EVENT_INVALIDATE_AREA, NULL);
    lv_display_add_event_cb(disp, on_render, LV_EVENT_RENDER_READY, NULL);
    lv_indev_t *indev = lv_indev_create();
    lv_indev_set_type(indev, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(indev, touch_read);
    lv_indev_set_display(indev, disp);
    build_ui();
    lvgl_port_unlock();
}

// Brightness command 0x51 shares the QSPI bus with LVGL's flushes, so it goes out under the LVGL lock
static void set_screen(bool on)
{
    if (!lvgl_port_lock(0)) return;
    esp_err_t r = esp_lcd_panel_co5300_set_brightness(lcd_panel, on ? 100 : 0);
    lvgl_port_unlock();
    if (r != ESP_OK) {
        printf("亮度设置失败 %d\n", r);
        return;
    }
    screen_on = on;
    printf("电源键 短按 → %s（0x51 = %d）\n", on ? "亮屏" : "息屏", on ? 255 : 0);
}

// ---------------------------------------------------------------- RTC, PMIC, temperature
static temperature_sensor_handle_t tsens;
static bool rtc_valid_known, rtc_valid, ok_printed, ble_up;
static volatile bool announce;
static volatile uint32_t rtc_epoch;

static bool rtc_write(time_t local)
{
    struct tm tm;
    gmtime_r(&local, &tm);
    const uint8_t t[7] = {bcd(tm.tm_sec), bcd(tm.tm_min), bcd(tm.tm_hour), bcd(tm.tm_mday), tm.tm_wday, bcd(tm.tm_mon + 1),
                          bcd(tm.tm_year % 100)};
    if (wr8(rtc, 0x04, t, 7) != ESP_OK) {
        printf("RTC 写入失败\n");
        return false;
    }
    printf("RTC 已写入 %04d-%02d-%02d %02d:%02d:%02d\n", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min,
           tm.tm_sec);
    return true;
}

// Returns true when the second changed
static bool poll_rtc(void)
{
    uint8_t b[7];
    if (rd8(rtc, 0x04, b, 7) != ESP_OK) return false;
    // OS flag: the oscillator stopped since the last time write; still shown, but flagged on serial
    bool valid = !(b[0] & 0x80);
    if (!rtc_valid_known || valid != rtc_valid) printf("RTC %s\n", valid ? "时间有效" : "振荡器停过，时间可能不准，请用手机对时");
    rtc_valid_known = true;
    rtc_valid = valid;
    int s = unbcd(b[0] & 0x7F), m = unbcd(b[1] & 0x7F), h = unbcd(b[2] & 0x3F);
    if (s == ss && m == mm && h == hh && !announce) return false;
    // Wall time as epoch seconds (TZ is unset, so mktime works in UTC) for reads of FF11
    struct tm tm = {.tm_sec = s, .tm_min = m, .tm_hour = h, .tm_mday = unbcd(b[3] & 0x3F), .tm_mon = unbcd(b[5] & 0x1F) - 1,
                    .tm_year = 100 + unbcd(b[6])};
    rtc_epoch = (uint32_t)mktime(&tm);
    bool first = hh < 0 || announce, minute = m != mm || h != hh;
    announce = false;
    hh = h;
    mm = m;
    ss = s;
    snprintf(date_text, sizeof date_text, "20%02d-%02d-%02d  %s", unbcd(b[6]), unbcd(b[5] & 0x1F), unbcd(b[3] & 0x3F),
             WEEKDAY[(b[4] & 7) % 7]);
    if (first) {
        printf("表盘 显示 %s %02d:%02d:%02d\n", date_text, hh, mm, ss);
    } else if (minute) {
        printf("整分 %02d:%02d\n", hh, mm);
    }
    return true;
}

static void poll_pmu(void)
{
    uint8_t st, st2, pct, v[2];
    if (rd8(pmu, 0x00, &st, 1) != ESP_OK || rd8(pmu, 0x01, &st2, 1) != ESP_OK || rd8(pmu, 0xA4, &pct, 1) != ESP_OK) return;
    bool usb = st & 0x20, chg = ((st2 >> 5) & 3) == 1;
    if (rd8(pmu, 0x34, v, 2) == ESP_OK) vbat_mv = (v[0] & 0x3F) << 8 | v[1];
    if (pct != bat_pct || usb != bat_usb || chg != bat_chg) {
        printf("电量 %d%% USB %s %s VBAT %d mV\n", pct, usb ? "已插" : "未插", chg ? "充电中" : usb ? "已充满" : "放电", vbat_mv);
    }
    bat_pct = pct;
    bat_usb = usb;
    bat_chg = chg;
}

static void poll_temp(void)
{
    float c;
    if (!tsens || temperature_sensor_get_celsius(tsens, &c) != ESP_OK) return;
    // Print on a 0.5 C change so serial stays quiet while the die temperature is steady
    if (!temp_ok || c - temp_c > 0.5f || temp_c - c > 0.5f) printf("温度 芯片 %.1f °C\n", c);
    temp_c = c;
    temp_ok = true;
}

static void poll_key(void)
{
    uint8_t irq;
    if (rd8(pmu, 0x49, &irq, 1) != ESP_OK || !(irq & 0x0C)) return;
    wr8(pmu, 0x49, &irq, 1);
    if (irq & 0x08) set_screen(!screen_on);
    if (irq & 0x04) printf("电源键 长按（本固件不关机）\n");
}

// 50 ms loop: PWR key and RTC second; PMIC and temperature once a second
static void board_task(void *arg)
{
    TickType_t wake = xTaskGetTickCount();
    for (int n = 0;; n++) {
        poll_key();
        bool tick = poll_rtc();
        bool slow = n % 20 == 0;
        if (slow) {
            poll_pmu();
            if (n % 100 == 0) poll_temp();
        }
        if ((tick || slow) && lvgl_port_lock(0)) {
            apply_clock();
            if (slow) apply_status();
            lvgl_port_unlock();
        }
        if (!ok_printed && first_frame_us && hh >= 0 && bat_pct >= 0 && ble_up) {
            ok_printed = true;
            printf("TRYBOARD_OK amoclock\n");
        }
        vTaskDelayUntil(&wake, pdMS_TO_TICKS(50));
    }
}

// ---------------------------------------------------------------- BLE time sync (service FF10, characteristic FF11)
static uint8_t own_addr_type;
static volatile bool resync;
static volatile uint32_t sync_epoch;

static int time_access(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        uint32_t now = rtc_epoch;
        return os_mbuf_append(ctxt->om, &now, 4) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_UNLIKELY;
    uint8_t buf[8];
    uint16_t n = 0;
    if (ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof buf, &n) != 0 || n != 4) {
        printf("对时 长度错误 %d 字节（要 4 字节小端 epoch 秒）\n", n);
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    // The NimBLE host task only records it; the board task owns the I2C writes to the RTC
    sync_epoch = buf[0] | buf[1] << 8 | buf[2] << 16 | (uint32_t)buf[3] << 24;
    resync = true;
    return 0;
}

static const ble_uuid16_t svc_uuid = BLE_UUID16_INIT(0xFF10);
static const ble_uuid16_t chr_uuid = BLE_UUID16_INIT(0xFF11);
static const struct ble_gatt_svc_def services[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &svc_uuid.u,
        .characteristics = (struct ble_gatt_chr_def[]){
            {.uuid = &chr_uuid.u, .access_cb = time_access, .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE},
            {0},
        },
    },
    {0},
};

static void advertise(void);

static int gap_event(struct ble_gap_event *event, void *arg)
{
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        printf("连接 %s status=%d\n", event->connect.status == 0 ? "成功" : "失败", event->connect.status);
        ble_online = event->connect.status == 0;
        if (!ble_online) advertise();
        break;
    case BLE_GAP_EVENT_DISCONNECT:
        printf("断开 reason=0x%x\n", event->disconnect.reason);
        ble_online = false;
        advertise();
        break;
    default:
        break;
    }
    return 0;
}

static void advertise(void)
{
    struct ble_hs_adv_fields f = {0};
    f.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    f.name = (uint8_t *)DEVICE_NAME;
    f.name_len = strlen(DEVICE_NAME);
    f.name_is_complete = 1;
    f.uuids16 = (ble_uuid16_t *)&svc_uuid;
    f.num_uuids16 = 1;
    f.uuids16_is_complete = 1;
    struct ble_gap_adv_params p = {0};
    p.conn_mode = BLE_GAP_CONN_MODE_UND;
    p.disc_mode = BLE_GAP_DISC_MODE_GEN;
    int rc = ble_gap_adv_set_fields(&f);
    if (rc == 0) rc = ble_gap_adv_start(own_addr_type, NULL, BLE_HS_FOREVER, &p, gap_event, NULL);
    if (rc != 0) {
        printf("广播启动失败 rc=%d\n", rc);
        return;
    }
    printf("BLE 广播 %s（对时特征 FF11）\n", DEVICE_NAME);
    ble_up = true;
}

static void on_sync(void)
{
    ble_hs_id_infer_auto(0, &own_addr_type);
    advertise();
}

static void host_task(void *param)
{
    nimble_port_run();
    nimble_port_freertos_deinit();
}

static void ble_init(void)
{
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);
    ESP_ERROR_CHECK(nimble_port_init());
    ble_hs_cfg.sync_cb = on_sync;
    ble_svc_gap_init();
    ble_svc_gatt_init();
    ble_gatts_count_cfg(services);
    ble_gatts_add_svcs(services);
    ble_svc_gap_device_name_set(DEVICE_NAME);
    nimble_port_freertos_init(host_task);
}

static void sync_task(void *arg)
{
    for (;;) {
        if (resync) {
            resync = false;
            time_t t = sync_epoch;
            struct tm tm;
            gmtime_r(&t, &tm);
            printf("对时 收到 epoch=%lu → %04d-%02d-%02d %02d:%02d:%02d\n", (unsigned long)sync_epoch, tm.tm_year + 1900,
                   tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec);
            if (rtc_write(t)) {
                announce = true;
                if (lvgl_port_lock(0)) {
                    lv_label_set_text(l_sync, "Time set from the phone");
                    lvgl_port_unlock();
                }
            }
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

void app_main(void)
{
    // I2C before LVGL (the touch read callback uses it); BLE last so the first frame does not wait for its stack
    i2c_init();
    temperature_sensor_config_t tc = TEMPERATURE_SENSOR_CONFIG_DEFAULT(-10, 80);
    if (temperature_sensor_install(&tc, &tsens) != ESP_OK || temperature_sensor_enable(tsens) != ESP_OK) {
        printf("温度传感器 启动失败\n");
        tsens = NULL;
    }
    display_init();
    poll_rtc();
    poll_pmu();
    poll_temp();
    if (lvgl_port_lock(0)) {
        apply_clock();
        apply_status();
        lvgl_port_unlock();
    }
    printf("AMOLED 时钟 启动：3 页（时间 / 温度 / 电量），左右滑动翻页，电源键息屏 / 亮屏\n");
    xTaskCreate(board_task, "board", 3072, NULL, 3, NULL);
    xTaskCreate(sync_task, "sync", 3072, NULL, 3, NULL);
    ble_init();
}
