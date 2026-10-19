// LVGL benchmark: S3 + GC9A01 dial UI (esp_lcd_gc9a01 on SPI2 40MHz + GDMA, esp_lvgl_port, 16ms refresh for 60 FPS);
// prints rendered frames and pixels sent per simulated second. Wiring as firmware/common/round_lcd.h.
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/spi_master.h"
#include "driver/gpio.h"
#include "esp_timer.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_gc9a01.h"
#include "esp_lvgl_port.h"
#include "lvgl.h"

#define LCD_W 240
#define LCD_H 240
#define LCD_SCLK 12
#define LCD_MOSI 11
#define LCD_CS 10
#define LCD_DC 14
#define LCD_RST 13
#define LCD_BL 15
#define BUF_LINES 40

// Written by the LVGL task, read by the stats task; 32-bit accesses are atomic on Xtensa
static volatile uint32_t frames, pixels;
static lv_obj_t *scale, *needle, *arc, *val_label, *fps_label;

static void on_render(lv_event_t *e)
{
    frames++;
}

static void on_flush(lv_event_t *e)
{
    const lv_area_t *a = lv_event_get_param(e);
    if (a) pixels += (uint32_t)lv_area_get_width(a) * lv_area_get_height(a);
}

static void anim_value(void *obj, int32_t v)
{
    lv_scale_set_line_needle_value(scale, needle, 92, v);
    lv_label_set_text_fmt(val_label, "%" LV_PRId32, v);
}

static void anim_arc(void *obj, int32_t v)
{
    // The arc spins: its start rotates while its length breathes between 60° and 150°
    lv_arc_set_rotation(arc, v % 360);
    int32_t len = 60 + (v % 180 < 90 ? v % 90 : 90 - v % 90);
    lv_arc_set_bg_angles(arc, 0, len);
}

static esp_lcd_panel_io_handle_t lcd_io;
static esp_lcd_panel_handle_t lcd_panel;

static void lcd_init(void)
{
    spi_bus_config_t bc = {
        .sclk_io_num = LCD_SCLK,
        .mosi_io_num = LCD_MOSI,
        .miso_io_num = -1,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = LCD_W * BUF_LINES * 2,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bc, SPI_DMA_CH_AUTO));
    esp_lcd_panel_io_spi_config_t ioc = {
        .dc_gpio_num = LCD_DC,
        .cs_gpio_num = LCD_CS,
        .pclk_hz = 40 * 1000 * 1000,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
        .spi_mode = 0,
        .trans_queue_depth = 10,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI2_HOST, &ioc, &lcd_io));
    esp_lcd_panel_dev_config_t pc = {
        .reset_gpio_num = LCD_RST,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_BGR,
        .bits_per_pixel = 16,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_gc9a01(lcd_io, &pc, &lcd_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_reset(lcd_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(lcd_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_invert_color(lcd_panel, true));
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(lcd_panel, true));
    gpio_config_t bl = {.pin_bit_mask = 1ULL << LCD_BL, .mode = GPIO_MODE_OUTPUT};
    ESP_ERROR_CHECK(gpio_config(&bl));
    gpio_set_level(LCD_BL, 1);
}

static void build_ui(lv_display_t *disp)
{
    lv_obj_t *scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, lv_color_hex(0x101820), 0);

    scale = lv_scale_create(scr);
    lv_obj_set_size(scale, 220, 220);
    lv_obj_center(scale);
    lv_scale_set_mode(scale, LV_SCALE_MODE_ROUND_INNER);
    lv_scale_set_range(scale, 0, 100);
    lv_scale_set_total_tick_count(scale, 41);
    lv_scale_set_major_tick_every(scale, 5);
    lv_scale_set_angle_range(scale, 270);
    lv_scale_set_rotation(scale, 135);
    lv_scale_set_label_show(scale, true);
    lv_obj_set_style_text_color(scale, lv_color_hex(0xC0D0E0), 0);
    lv_obj_set_style_line_color(scale, lv_color_hex(0x6080A0), LV_PART_ITEMS);
    lv_obj_set_style_line_color(scale, lv_color_hex(0xFFFFFF), LV_PART_INDICATOR);
    lv_obj_set_style_length(scale, 6, LV_PART_ITEMS);
    lv_obj_set_style_length(scale, 12, LV_PART_INDICATOR);
    lv_obj_set_style_arc_width(scale, 0, LV_PART_MAIN);

    needle = lv_line_create(scale);
    lv_obj_set_style_line_width(needle, 4, 0);
    lv_obj_set_style_line_color(needle, lv_color_hex(0xFF5030), 0);
    lv_obj_set_style_line_rounded(needle, true, 0);

    arc = lv_arc_create(scr);
    lv_obj_set_size(arc, 236, 236);
    lv_obj_center(arc);
    lv_obj_remove_style(arc, NULL, LV_PART_KNOB);
    lv_obj_remove_flag(arc, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_style_arc_width(arc, 6, LV_PART_MAIN);
    lv_obj_set_style_arc_color(arc, lv_color_hex(0x30E0C0), LV_PART_MAIN);
    lv_obj_set_style_arc_opa(arc, LV_OPA_0, LV_PART_INDICATOR);

    val_label = lv_label_create(scr);
    lv_obj_set_style_text_font(val_label, &lv_font_montserrat_48, 0);
    lv_obj_set_style_text_color(val_label, lv_color_hex(0xFFFFFF), 0);
    lv_obj_align(val_label, LV_ALIGN_CENTER, 0, 30);
    lv_label_set_text(val_label, "0");

    lv_obj_t *unit = lv_label_create(scr);
    lv_obj_set_style_text_color(unit, lv_color_hex(0x30E0C0), 0);
    lv_label_set_text(unit, "km/h");
    lv_obj_align(unit, LV_ALIGN_CENTER, 0, 64);

    fps_label = lv_label_create(scr);
    lv_obj_set_style_text_color(fps_label, lv_color_hex(0xFFD040), 0);
    lv_label_set_text(fps_label, "FPS --");
    lv_obj_align(fps_label, LV_ALIGN_CENTER, 0, -40);

    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, scale);
    lv_anim_set_exec_cb(&a, anim_value);
    lv_anim_set_values(&a, 0, 100);
    lv_anim_set_duration(&a, 2000);
    lv_anim_set_playback_duration(&a, 2000);
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_in_out);
    lv_anim_start(&a);

    lv_anim_t b;
    lv_anim_init(&b);
    lv_anim_set_var(&b, arc);
    lv_anim_set_exec_cb(&b, anim_arc);
    lv_anim_set_values(&b, 0, 359);
    lv_anim_set_duration(&b, 1500);
    lv_anim_set_repeat_count(&b, LV_ANIM_REPEAT_INFINITE);
    lv_anim_start(&b);

    lv_display_add_event_cb(disp, on_render, LV_EVENT_RENDER_READY, NULL);
    lv_display_add_event_cb(disp, on_flush, LV_EVENT_FLUSH_START, NULL);
}

void app_main(void)
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
    build_ui(disp);
    lvgl_port_unlock();
    printf("LVGL %d.%d.%d up\n", LVGL_VERSION_MAJOR, LVGL_VERSION_MINOR, LVGL_VERSION_PATCH);

    // Stats once per simulated second; the firmware reports FPS in simulated time
    TickType_t wake = xTaskGetTickCount();
    uint32_t f0 = frames, p0 = pixels;
    for (int sec = 1;; sec++) {
        vTaskDelayUntil(&wake, pdMS_TO_TICKS(1000));
        uint32_t f = frames, p = pixels;
        uint32_t df = f - f0, dp = p - p0;
        f0 = f;
        p0 = p;
        printf("FPS %lu px/frame %lu t=%d\n", (unsigned long)df, (unsigned long)(df ? dp / df : 0), sec);
        if (lvgl_port_lock(0)) {
            lv_label_set_text_fmt(fps_label, "FPS %lu", (unsigned long)df);
            lvgl_port_unlock();
        }
        if (sec == 1 && df > 0) printf("TRYBOARD_OK s3-lvgl\n");
    }
}
