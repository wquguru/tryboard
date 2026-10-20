// E-07a example "AI gateway dashboard" for the Waveshare ESP32-S3-Touch-AMOLED-2.16: CO5300 480x480 QSPI AMOLED, CST9220 touch,
// AXP2101 PMIC, PCF85063 RTC, NimBLE Nordic UART peripheral speaking the Claude Desktop Buddy protocol (one JSON object per line).
// LVGL 9 UI with 4 pages (requests / context / sessions / usage) switched by left / right swipes; top bar shows RTC time and battery.
// The protocol handling is written from the public protocol description; no third-party firmware code. (lint: allow-long-comment)
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "driver/spi_master.h"
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_co5300.h"
#include "esp_lvgl_port.h"
#include "lvgl.h"
#include "nvs_flash.h"
#include "cJSON.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

// Board pins (Waveshare ESP32-S3-Touch-AMOLED-2.16)
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

#define MSG_MAX 4096
#define CTX_WINDOW 200000
#define MAX_ENTRIES 5
#define PAGES 4
#define SWIPE_MIN 60

// Palette: true black for AMOLED, dark cards, one accent per meaning
#define C_BG 0x000000
#define C_CARD 0x1C1C24
#define C_TEXT 0xFFFFFF
#define C_MUTED 0x8E8E9A
#define C_IDLE 0x3A3A44
#define C_GREEN 0x30D158
#define C_AMBER 0xFFB020
#define C_BLUE 0x0A84FF
#define C_RED 0xFF453A

static const char *DEVICE_NAME = "Claude-Dash";
static const char *PAGE_NAMES[PAGES] = {"Requests", "Context", "Sessions", "Usage"};

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
}

// --------------------------------------------------------------- dashboard state
typedef struct {
    int total, running, waiting;
    long tokens, today;
    char msg[64];
    char entries[MAX_ENTRIES][64];
    int n_entries;
} hb_t;

static hb_t hb;
static int page;
static bool ble_online;
static int bat_pct = -1;
static bool bat_usb;
static bool rtc_valid;
static char clock_hm[8] = "--:--";
static char date_text[32] = "----------  --:--:--";

static lv_obj_t *pages[PAGES], *dots[PAGES];
static lv_obj_t *l_time, *l_title, *l_ble, *l_bat;
static lv_obj_t *l_total, *l_running, *l_waiting, *seg_run, *seg_wait, *l_msg1;
static lv_obj_t *l_tokens, *fill_ctx, *l_ctx_pct, *l_ctx_used;
static lv_obj_t *l_msg3, *row[MAX_ENTRIES], *l_row[MAX_ENTRIES];
static lv_obj_t *l_today, *l_bat4, *fill_bat, *l_link, *l_date;

static void thousands(long v, char *out, size_t n)
{
    char raw[24];
    snprintf(raw, sizeof raw, "%ld", v < 0 ? 0 : v);
    int len = strlen(raw), o = 0;
    for (int i = 0; i < len && o + 2 < (int)n; i++) {
        if (i > 0 && (len - i) % 3 == 0) out[o++] = ',';
        out[o++] = raw[i];
    }
    out[o] = 0;
}

// ---------------------------------------------------------------- LVGL widgets
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

static lv_obj_t *stat_card(lv_obj_t *parent, int x, const char *name, uint32_t color)
{
    lv_obj_t *c = box(parent, x, 8, 136, 160, C_CARD, 16);
    text(c, 16, 16, &lv_font_montserrat_14, C_MUTED, name);
    return text(c, 16, 70, &lv_font_montserrat_48, color, "-");
}

static void build_requests(lv_obj_t *p)
{
    l_total = stat_card(p, 24, "TOTAL", C_TEXT);
    l_running = stat_card(p, 172, "RUNNING", C_GREEN);
    l_waiting = stat_card(p, 320, "WAITING", C_AMBER);
    text(p, 24, 188, &lv_font_montserrat_14, C_MUTED, "LOAD");
    lv_obj_t *track = box(p, 24, 212, 432, 24, C_IDLE, 0);
    seg_run = box(track, 0, 0, 0, 24, C_GREEN, 0);
    seg_wait = box(track, 0, 0, 0, 24, C_AMBER, 0);
    text(p, 24, 246, &lv_font_montserrat_14, C_GREEN, LV_SYMBOL_PLAY " running");
    text(p, 160, 246, &lv_font_montserrat_14, C_AMBER, LV_SYMBOL_PAUSE " waiting");
    text(p, 296, 246, &lv_font_montserrat_14, C_MUTED, LV_SYMBOL_STOP " idle");
    lv_obj_t *c = box(p, 24, 284, 432, 72, C_CARD, 16);
    l_msg1 = text(c, 16, 24, &lv_font_montserrat_20, C_TEXT, "waiting for desktop...");
    lv_label_set_long_mode(l_msg1, LV_LABEL_LONG_DOT);
    lv_obj_set_width(l_msg1, 400);
}

static void build_context(lv_obj_t *p)
{
    lv_obj_t *c = box(p, 24, 8, 432, 184, C_CARD, 16);
    text(c, 20, 18, &lv_font_montserrat_14, C_MUTED, "TOKENS IN CONTEXT");
    l_tokens = text(c, 20, 56, &lv_font_montserrat_48, C_TEXT, "-");
    text(c, 20, 132, &lv_font_montserrat_20, C_MUTED, "of 200,000 window");
    lv_obj_t *track = box(p, 24, 216, 432, 24, C_IDLE, 0);
    fill_ctx = box(track, 0, 0, 0, 24, C_BLUE, 0);
    l_ctx_pct = text(p, 24, 256, &lv_font_montserrat_48, C_BLUE, "-");
    l_ctx_used = text(p, 0, 0, &lv_font_montserrat_20, C_MUTED, "used");
    lv_obj_align_to(l_ctx_used, l_ctx_pct, LV_ALIGN_OUT_RIGHT_BOTTOM, 12, -10);
}

static void build_sessions(lv_obj_t *p)
{
    lv_obj_t *c = box(p, 24, 8, 432, 64, C_CARD, 16);
    l_msg3 = text(c, 16, 20, &lv_font_montserrat_20, C_GREEN, "-");
    lv_label_set_long_mode(l_msg3, LV_LABEL_LONG_DOT);
    lv_obj_set_width(l_msg3, 400);
    for (int i = 0; i < MAX_ENTRIES; i++) {
        row[i] = box(p, 24, 84 + i * 56, 432, 48, C_CARD, 12);
        l_row[i] = text(row[i], 16, 14, &lv_font_montserrat_20, i == 0 ? C_TEXT : C_MUTED, "");
        lv_label_set_long_mode(l_row[i], LV_LABEL_LONG_DOT);
        lv_obj_set_width(l_row[i], 400);
        lv_obj_add_flag(row[i], LV_OBJ_FLAG_HIDDEN);
    }
}

static void build_usage(lv_obj_t *p)
{
    lv_obj_t *c = box(p, 24, 8, 432, 140, C_CARD, 16);
    text(c, 20, 18, &lv_font_montserrat_14, C_MUTED, "TOKENS TODAY");
    l_today = text(c, 20, 56, &lv_font_montserrat_48, C_TEXT, "-");
    c = box(p, 24, 160, 210, 104, C_CARD, 16);
    text(c, 16, 14, &lv_font_montserrat_14, C_MUTED, "BATTERY");
    l_bat4 = text(c, 16, 36, &lv_font_montserrat_28, C_TEXT, "-");
    lv_obj_t *track = box(c, 16, 78, 178, 12, C_IDLE, 0);
    fill_bat = box(track, 0, 0, 0, 12, C_GREEN, 0);
    c = box(p, 246, 160, 210, 104, C_CARD, 16);
    text(c, 16, 14, &lv_font_montserrat_14, C_MUTED, "BLUETOOTH");
    l_link = text(c, 16, 44, &lv_font_montserrat_28, C_RED, "OFFLINE");
    c = box(p, 24, 276, 432, 88, C_CARD, 16);
    text(c, 16, 14, &lv_font_montserrat_14, C_MUTED, "DATE / TIME (RTC)");
    l_date = text(c, 16, 40, &lv_font_montserrat_28, C_TEXT, date_text);
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
    l_time = text(scr, 24, 14, &lv_font_montserrat_28, C_TEXT, clock_hm);
    l_title = text(scr, 0, 20, &lv_font_montserrat_20, C_MUTED, "");
    lv_obj_set_width(l_title, LCD_W);
    lv_obj_set_style_text_align(l_title, LV_TEXT_ALIGN_CENTER, 0);
    l_ble = text(scr, 340, 20, &lv_font_montserrat_20, C_IDLE, LV_SYMBOL_BLUETOOTH);
    l_bat = text(scr, 0, 20, &lv_font_montserrat_20, C_TEXT, LV_SYMBOL_BATTERY_EMPTY " --%");
    lv_obj_set_width(l_bat, 112);
    lv_obj_set_x(l_bat, 344);
    lv_obj_set_style_text_align(l_bat, LV_TEXT_ALIGN_RIGHT, 0);
    for (int i = 0; i < PAGES; i++) {
        pages[i] = lv_obj_create(scr);
        lv_obj_remove_style_all(pages[i]);
        lv_obj_remove_flag(pages[i], LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);
        lv_obj_set_pos(pages[i], 0, 64);
        lv_obj_set_size(pages[i], LCD_W, 368);
        dots[i] = box(scr, 198 + i * 24, 448, 12, 12, C_IDLE, LV_RADIUS_CIRCLE);
    }
    build_requests(pages[0]);
    build_context(pages[1]);
    build_sessions(pages[2]);
    build_usage(pages[3]);
    show_page(0);
}

// Caller holds the LVGL lock
static void apply_heartbeat(void)
{
    char s[32];
    lv_label_set_text_fmt(l_total, "%d", hb.total);
    lv_label_set_text_fmt(l_running, "%d", hb.running);
    lv_label_set_text_fmt(l_waiting, "%d", hb.waiting);
    int total = hb.total > 0 ? hb.total : 1;
    int run = hb.running > total ? total : hb.running;
    int wait = hb.waiting > total - run ? total - run : hb.waiting;
    int wr = 432 * run / total, ww = 432 * wait / total;
    lv_obj_set_width(seg_run, wr);
    lv_obj_set_x(seg_wait, wr);
    lv_obj_set_width(seg_wait, ww);
    lv_label_set_text(l_msg1, hb.msg[0] ? hb.msg : "idle");

    thousands(hb.tokens, s, sizeof s);
    lv_label_set_text(l_tokens, s);
    long ctx = hb.tokens > CTX_WINDOW ? CTX_WINDOW : hb.tokens;
    lv_obj_set_width(fill_ctx, (int)(432 * ctx / CTX_WINDOW));
    lv_label_set_text_fmt(l_ctx_pct, "%d%%", (int)(100 * ctx / CTX_WINDOW));
    lv_obj_align_to(l_ctx_used, l_ctx_pct, LV_ALIGN_OUT_RIGHT_BOTTOM, 12, -10);

    bool approve = strncmp(hb.msg, "approve", 7) == 0;
    lv_obj_set_style_text_color(l_msg3, lv_color_hex(approve ? C_AMBER : C_GREEN), 0);
    lv_label_set_text(l_msg3, hb.msg[0] ? hb.msg : "idle");
    for (int i = 0; i < MAX_ENTRIES; i++) {
        if (i < hb.n_entries) {
            lv_label_set_text(l_row[i], hb.entries[i]);
            lv_obj_remove_flag(row[i], LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(row[i], LV_OBJ_FLAG_HIDDEN);
        }
    }

    thousands(hb.today, s, sizeof s);
    lv_label_set_text(l_today, s);
}

// Caller holds the LVGL lock
static void apply_status(void)
{
    lv_label_set_text(l_time, clock_hm);
    lv_label_set_text(l_date, date_text);
    const char *sym = bat_usb ? LV_SYMBOL_CHARGE : bat_pct > 80 ? LV_SYMBOL_BATTERY_FULL : bat_pct > 55 ? LV_SYMBOL_BATTERY_3
                    : bat_pct > 30 ? LV_SYMBOL_BATTERY_2 : bat_pct > 10 ? LV_SYMBOL_BATTERY_1 : LV_SYMBOL_BATTERY_EMPTY;
    if (bat_pct >= 0) {
        lv_label_set_text_fmt(l_bat, "%s %d%%", sym, bat_pct);
        lv_label_set_text_fmt(l_bat4, "%d%%%s", bat_pct, bat_usb ? " USB" : "");
        lv_obj_set_width(fill_bat, 178 * bat_pct / 100);
    }
    lv_obj_set_style_text_color(l_ble, lv_color_hex(ble_online ? C_BLUE : C_IDLE), 0);
    lv_label_set_text(l_link, ble_online ? "ONLINE" : "OFFLINE");
    lv_obj_set_style_text_color(l_link, lv_color_hex(ble_online ? C_GREEN : C_RED), 0);
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
    if (abs(dx) < SWIPE_MIN || abs(dx) < abs(dy)) return;
    int n = dx < 0 ? page + 1 : page - 1;
    if (n < 0 || n >= PAGES) {
        printf("滑动 %s：已经是%s一页\n", dx < 0 ? "向左" : "向右", dx < 0 ? "最后" : "第");
        return;
    }
    show_page(n);
    printf("滑动 %s dx=%d → 页 %d/%d %s\n", dx < 0 ? "向左" : "向右", dx, n + 1, PAGES, PAGE_NAMES[n]);
}

// LVGL pointer: pressed state from the INT pin (low while touched), coordinates from the 0xD000 report
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

// ---------------------------------------------------------------- RTC and battery (1 Hz)
static void rtc_write_local(time_t local)
{
    struct tm tm;
    gmtime_r(&local, &tm);
    const uint8_t t[7] = {bcd(tm.tm_sec), bcd(tm.tm_min), bcd(tm.tm_hour), bcd(tm.tm_mday), tm.tm_wday, bcd(tm.tm_mon + 1),
                          bcd(tm.tm_year % 100)};
    if (wr8(rtc, 0x04, t, 7) == ESP_OK) {
        printf("RTC 已写入 %04d-%02d-%02d %02d:%02d:%02d\n", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min,
               tm.tm_sec);
    } else {
        printf("RTC 写入失败\n");
    }
}

static void poll_board(void)
{
    uint8_t b[7];
    if (rd8(rtc, 0x04, b, 7) == ESP_OK) {
        // OS flag: the oscillator stopped since the last time write, so the time is not trustworthy
        bool valid = !(b[0] & 0x80);
        if (valid != rtc_valid) printf("RTC %s\n", valid ? "时间有效" : "未设置（振荡器停过），等电脑同步时间");
        rtc_valid = valid;
        if (valid) {
            snprintf(clock_hm, sizeof clock_hm, "%02d:%02d", unbcd(b[2] & 0x3F), unbcd(b[1] & 0x7F));
            snprintf(date_text, sizeof date_text, "20%02d-%02d-%02d  %02d:%02d:%02d", unbcd(b[6]), unbcd(b[5] & 0x1F),
                     unbcd(b[3] & 0x3F), unbcd(b[2] & 0x3F), unbcd(b[1] & 0x7F), unbcd(b[0] & 0x7F));
        }
    }
    uint8_t st, pct;
    if (rd8(pmu, 0x00, &st, 1) == ESP_OK && rd8(pmu, 0xA4, &pct, 1) == ESP_OK) {
        bool usb = st & 0x20;
        if (pct != bat_pct || usb != bat_usb) printf("电量 %d%% USB %s\n", pct, usb ? "已插" : "未插");
        bat_pct = pct;
        bat_usb = usb;
    }
}

static void board_task(void *arg)
{
    TickType_t wake = xTaskGetTickCount();
    for (;;) {
        poll_board();
        if (lvgl_port_lock(0)) {
            apply_status();
            lvgl_port_unlock();
        }
        vTaskDelayUntil(&wake, pdMS_TO_TICKS(1000));
    }
}

// ---------------------------------------------------------------- BLE Nordic UART
// 6e40000x-b5a3-f393-e0a9-e50e24dcca9e, little-endian as NimBLE wants
#define NUS_UUID(x) BLE_UUID128_INIT(0x9e, 0xca, 0xdc, 0x24, 0x0e, 0xe5, 0xa9, 0xe0, 0x93, 0xf3, 0xa3, 0xb5, x, 0x00, 0x40, 0x6e)
static const ble_uuid128_t nus_svc = NUS_UUID(0x01);
static const ble_uuid128_t nus_rx = NUS_UUID(0x02);
static const ble_uuid128_t nus_tx = NUS_UUID(0x03);

typedef struct {
    char *text;
    int len;
} line_t;

static uint16_t tx_handle;
static uint16_t conn = BLE_HS_CONN_HANDLE_NONE;
static volatile bool tx_notify;
static uint8_t own_addr_type;
static QueueHandle_t lines;

// Receive buffer: owned by the NimBLE host task only
static char rx_buf[MSG_MAX + 1];
static int rx_len;
static bool rx_drop;

static void rx_bytes(const uint8_t *d, int n)
{
    for (int i = 0; i < n; i++) {
        char c = (char)d[i];
        if (c == '\n') {
            if (rx_drop) {
                printf("丢弃超长消息 (> %d 字节)\n", MSG_MAX);
            } else if (rx_len > 0) {
                line_t l = {.text = malloc(rx_len + 1), .len = rx_len};
                if (l.text) {
                    memcpy(l.text, rx_buf, rx_len);
                    l.text[rx_len] = 0;
                    if (xQueueSend(lines, &l, 0) != pdTRUE) free(l.text);
                }
            }
            rx_len = 0;
            rx_drop = false;
        } else if (rx_len < MSG_MAX) {
            rx_buf[rx_len++] = c;
        } else {
            rx_drop = true;
        }
    }
}

static int chr_access(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_UNLIKELY;
    uint8_t buf[512];
    uint16_t n = 0;
    if (ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &n) != 0) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    rx_bytes(buf, n);
    return 0;
}

static const struct ble_gatt_svc_def services[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &nus_svc.u,
        .characteristics = (struct ble_gatt_chr_def[]){
            {.uuid = &nus_rx.u, .access_cb = chr_access, .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP},
            {.uuid = &nus_tx.u, .access_cb = chr_access, .val_handle = &tx_handle, .flags = BLE_GATT_CHR_F_NOTIFY},
            {0},
        },
    },
    {0},
};

// Send one line on TX, split at MTU-3
static void send_line(const char *s)
{
    if (conn == BLE_HS_CONN_HANDLE_NONE || !tx_notify) return;
    int len = strlen(s);
    int chunk = ble_att_mtu(conn) - 3;
    if (chunk < 20) chunk = 20;
    for (int off = 0; off <= len; off += chunk) {
        int n = len + 1 - off < chunk ? len + 1 - off : chunk;
        char tmp[260];
        if (n > (int)sizeof(tmp)) n = sizeof(tmp);
        memcpy(tmp, s + off, n);
        if (off + n == len + 1) tmp[n - 1] = '\n';
        struct os_mbuf *om = ble_hs_mbuf_from_flat(tmp, n);
        if (ble_gatts_notify_custom(conn, tx_handle, om) != 0) break;
        if (off + n >= len + 1) break;
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

static void ack(const char *cmd, bool ok)
{
    char s[96];
    snprintf(s, sizeof(s), "{\"ack\":\"%s\",\"ok\":%s}", cmd, ok ? "true" : "false");
    send_line(s);
}

static void set_online(bool on)
{
    ble_online = on;
    if (lvgl_port_lock(0)) {
        apply_status();
        lvgl_port_unlock();
    }
}

static void advertise(void);

static int gap_event(struct ble_gap_event *ev, void *arg)
{
    switch (ev->type) {
    case BLE_GAP_EVENT_CONNECT:
        printf("蓝牙 连接%s\n", ev->connect.status == 0 ? "成功" : "失败");
        if (ev->connect.status == 0) {
            conn = ev->connect.conn_handle;
        } else {
            advertise();
        }
        break;
    case BLE_GAP_EVENT_DISCONNECT:
        printf("蓝牙 断开 reason=0x%x → OFFLINE\n", ev->disconnect.reason);
        conn = BLE_HS_CONN_HANDLE_NONE;
        tx_notify = false;
        set_online(false);
        advertise();
        break;
    case BLE_GAP_EVENT_SUBSCRIBE:
        if (ev->subscribe.attr_handle == tx_handle) {
            tx_notify = ev->subscribe.cur_notify;
            printf("蓝牙 %s\n", tx_notify ? "ONLINE（电脑已订阅 TX）" : "电脑取消订阅");
            set_online(tx_notify);
        }
        break;
    case BLE_GAP_EVENT_ADV_COMPLETE:
        advertise();
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
    // The 128-bit service UUID does not fit next to the name in 31 bytes: it goes in the scan response
    struct ble_hs_adv_fields r = {0};
    r.uuids128 = (ble_uuid128_t *)&nus_svc;
    r.num_uuids128 = 1;
    r.uuids128_is_complete = 1;
    struct ble_gap_adv_params p = {0};
    p.conn_mode = BLE_GAP_CONN_MODE_UND;
    p.disc_mode = BLE_GAP_DISC_MODE_GEN;
    int rc = ble_gap_adv_set_fields(&f);
    if (rc == 0) rc = ble_gap_adv_rsp_set_fields(&r);
    if (rc == 0) rc = ble_gap_adv_start(own_addr_type, NULL, BLE_HS_FOREVER, &p, gap_event, NULL);
    if (rc != 0) {
        printf("广播启动失败 rc=%d\n", rc);
        return;
    }
    printf("BLE 广播 %s\n", DEVICE_NAME);
}

static void on_sync(void)
{
    ble_hs_id_infer_auto(0, &own_addr_type);
    advertise();
}

static void on_reset(int reason)
{
    printf("BLE 主机复位 reason=%d\n", reason);
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
    ble_hs_cfg.reset_cb = on_reset;
    ble_svc_gap_init();
    ble_svc_gatt_init();
    ble_gatts_count_cfg(services);
    ble_gatts_add_svcs(services);
    ble_svc_gap_device_name_set(DEVICE_NAME);
    nimble_port_freertos_init(host_task);
}

// ---------------------------------------------------------------- protocol
static int n_hb, n_status;
static bool time_set, ok_printed;

static int num(cJSON *j, const char *k)
{
    cJSON *v = cJSON_GetObjectItem(j, k);
    return cJSON_IsNumber(v) ? v->valueint : 0;
}

static void on_heartbeat(cJSON *j)
{
    hb_t h = {0};
    h.total = num(j, "total");
    h.running = num(j, "running");
    h.waiting = num(j, "waiting");
    cJSON *tok = cJSON_GetObjectItem(j, "tokens"), *today = cJSON_GetObjectItem(j, "tokens_today");
    h.tokens = cJSON_IsNumber(tok) ? (long)tok->valuedouble : 0;
    h.today = cJSON_IsNumber(today) ? (long)today->valuedouble : 0;
    cJSON *msg = cJSON_GetObjectItem(j, "msg");
    if (cJSON_IsString(msg)) snprintf(h.msg, sizeof h.msg, "%s", msg->valuestring);
    cJSON *ent = cJSON_GetObjectItem(j, "entries");
    int n_ent = cJSON_IsArray(ent) ? cJSON_GetArraySize(ent) : 0;
    for (int i = 0; i < n_ent && h.n_entries < MAX_ENTRIES; i++) {
        cJSON *e = cJSON_GetArrayItem(ent, i);
        if (cJSON_IsString(e)) snprintf(h.entries[h.n_entries++], sizeof h.entries[0], "%s", e->valuestring);
    }
    n_hb++;
    printf("心跳 #%d total=%d running=%d waiting=%d tokens=%ld tokens_today=%ld entries=%d\n", n_hb, h.total, h.running,
           h.waiting, h.tokens, h.today, n_ent);
    if (h.n_entries) printf("  最近: %s\n", h.entries[0]);
    if (lvgl_port_lock(0)) {
        hb = h;
        apply_heartbeat();
        lvgl_port_unlock();
    }
    printf("屏幕 已更新 心跳 #%d（第 %d/%d 页 %s）\n", n_hb, page + 1, PAGES, PAGE_NAMES[page]);
}

static void on_status(void)
{
    n_status++;
    struct timeval now;
    gettimeofday(&now, NULL);
    char s[400];
    snprintf(s, sizeof(s),
             "{\"ack\":\"status\",\"ok\":true,\"data\":{\"name\":\"%s\",\"sec\":false,"
             "\"bat\":{\"pct\":%d,\"usb\":%s},\"sys\":{\"up\":%lld,\"heap\":%lu,\"clock\":%lld},"
             "\"stats\":{\"hb\":%d,\"polls\":%d,\"page\":%d},\"fw\":\"TryBoard s3-ai-dash 1.0 (ESP32-S3, NimBLE, LVGL)\"}}",
             DEVICE_NAME, bat_pct, bat_usb ? "true" : "false", (long long)(esp_timer_get_time() / 1000000),
             (unsigned long)esp_get_free_heap_size(), (long long)now.tv_sec, n_hb, n_status, page + 1);
    send_line(s);
}

static void handle_line(const line_t *l)
{
    cJSON *j = cJSON_Parse(l->text);
    if (!j) {
        printf("JSON 解析失败 (%d 字节)\n", l->len);
        return;
    }
    cJSON *t = cJSON_GetObjectItem(j, "time");
    cJSON *cmd = cJSON_GetObjectItem(j, "cmd");
    if (cJSON_IsArray(t) && cJSON_GetArraySize(t) == 2) {
        time_t epoch = (time_t)cJSON_GetArrayItem(t, 0)->valuedouble;
        int tz = (int)cJSON_GetArrayItem(t, 1)->valuedouble;
        struct timeval tv = {.tv_sec = epoch};
        settimeofday(&tv, NULL);
        printf("时间 收到 epoch=%lld UTC%+d\n", (long long)epoch, tz / 3600);
        // The RTC keeps local wall time, like the board's stock demos
        rtc_write_local(epoch + tz);
        time_set = true;
        poll_board();
        if (lvgl_port_lock(0)) {
            apply_status();
            lvgl_port_unlock();
        }
    } else if (cJSON_IsString(cmd)) {
        const char *c = cmd->valuestring;
        if (!strcmp(c, "owner")) {
            cJSON *n = cJSON_GetObjectItem(j, "name");
            printf("主人 %s\n", cJSON_IsString(n) ? n->valuestring : "?");
            ack("owner", true);
        } else if (!strcmp(c, "status")) {
            on_status();
        } else {
            printf("未知命令 %s\n", c);
            ack(c, false);
        }
    } else if (cJSON_GetObjectItem(j, "total")) {
        on_heartbeat(j);
    } else {
        printf("未识别的消息\n");
    }
    cJSON_Delete(j);
    if (!ok_printed && n_hb >= 1 && time_set) {
        ok_printed = true;
        printf("TRYBOARD_OK s3-ai-dash\n");
    }
}

void app_main(void)
{
    // I2C before LVGL (the touch read callback uses it); BLE last so the first frame does not wait for its stack
    i2c_init();
    display_init();
    poll_board();
    if (lvgl_port_lock(0)) {
        apply_status();
        lvgl_port_unlock();
    }
    printf("仪表盘 启动：4 页（请求 / 上下文 / 会话 / 用量），左右滑动翻页\n");
    xTaskCreate(board_task, "board", 3072, NULL, 3, NULL);
    lines = xQueueCreate(8, sizeof(line_t));
    ble_init();

    line_t l;
    for (;;) {
        if (xQueueReceive(lines, &l, portMAX_DELAY) == pdTRUE) {
            handle_line(&l);
            free(l.text);
        }
    }
}
