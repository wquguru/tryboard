// GC9A01 240x240 round LCD (SPI2) helpers: bus / panel init + simple graphics on a frame buffer; shared by lens, spin, their checkpoints, c3-lcd.
// Wiring S3: SCLK=12 MOSI=11 CS=10 DC=14 RST=13 BL=15; C3: SCLK=6 MOSI=7 CS=10 DC=5 RST=4 BL=3 (backlight active high). SCLK / MOSI / CS are SPI2's
// IO_MUX direct pins, so the driver bypasses the GPIO matrix. Pins can be overridden with #define before include (boards with a built-in LCD). (lint: allow-long-comment)
#pragma once
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "driver/spi_master.h"
#include "driver/gpio.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_gc9a01.h"
#include "sdkconfig.h"

#define LCD_W 240
#define LCD_H 240
#ifndef LCD_SCLK
#if CONFIG_IDF_TARGET_ESP32C3
// C3 DevKitM-1: 2, 8, 9 are strapping pins (8 also drives the onboard RGB); DC / RST / backlight avoid them
#define LCD_SCLK 6
#define LCD_MOSI 7
#define LCD_CS 10
#define LCD_DC 5
#define LCD_RST 4
#define LCD_BL 3
#else
#define LCD_SCLK 12
#define LCD_MOSI 11
#define LCD_CS 10
#define LCD_DC 14
#define LCD_RST 13
#define LCD_BL 15
#endif
#endif
// At most 40 lines (19200 bytes) per SPI transfer: a frame is 6 DMAs of 5 descriptors each
#define LCD_CHUNK_LINES 40

static esp_lcd_panel_handle_t lcd_panel;
static uint16_t *lcd_fb; // big-endian RGB565 (SPI sends the high byte first)
static SemaphoreHandle_t lcd_done;

// RGB888 -> RGB565 in wire byte order
static inline uint16_t rgb(uint32_t c)
{
    uint16_t v = ((c >> 8) & 0xF800) | ((c >> 5) & 0x07E0) | ((c >> 3) & 0x001F);
    return (uint16_t)((v >> 8) | (v << 8));
}

static bool lcd_on_done(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *e, void *ctx)
{
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR(lcd_done, &woken);
    return woken == pdTRUE;
}

static void lcd_init(void)
{
    spi_bus_config_t bc = {
        .sclk_io_num = LCD_SCLK,
        .mosi_io_num = LCD_MOSI,
        .miso_io_num = -1,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = LCD_W * LCD_CHUNK_LINES * 2,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bc, SPI_DMA_CH_AUTO));
    lcd_done = xSemaphoreCreateBinary();
    esp_lcd_panel_io_handle_t io;
    esp_lcd_panel_io_spi_config_t ioc = {
        .dc_gpio_num = LCD_DC,
        .cs_gpio_num = LCD_CS,
        .pclk_hz = 40 * 1000 * 1000,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
        .spi_mode = 0,
        .trans_queue_depth = 10,
        .on_color_trans_done = lcd_on_done,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI2_HOST, &ioc, &io));
    esp_lcd_panel_dev_config_t pc = {
        .reset_gpio_num = LCD_RST,
        // Round LCD modules use BGR subpixel order (as in the IDF spi_lcd_touch example)
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_BGR,
        .bits_per_pixel = 16,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_gc9a01(io, &pc, &lcd_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_reset(lcd_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(lcd_panel));
    // Common GC9A01 modules are normally-black IPS panels: inversion on gives correct colours
    ESP_ERROR_CHECK(esp_lcd_panel_invert_color(lcd_panel, true));
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(lcd_panel, true));
    gpio_config_t bl = {.pin_bit_mask = 1ULL << LCD_BL, .mode = GPIO_MODE_OUTPUT};
    ESP_ERROR_CHECK(gpio_config(&bl));
    gpio_set_level(LCD_BL, 1);
    lcd_fb = heap_caps_malloc(LCD_W * LCD_H * 2, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    assert(lcd_fb);
}

// Send rows [y0, y1) and wait for completion (the buffer is about to be redrawn)
static void lcd_flush_rows(int y0, int y1)
{
    ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(lcd_panel, 0, y0, LCD_W, y1, lcd_fb + y0 * LCD_W));
    xSemaphoreTake(lcd_done, portMAX_DELAY);
}

static inline void fb_px(int x, int y, uint16_t c)
{
    if ((unsigned)x < LCD_W && (unsigned)y < LCD_H) lcd_fb[y * LCD_W + x] = c;
}

static void fb_clear(uint16_t c)
{
    for (int i = 0; i < LCD_W * LCD_H; i++) lcd_fb[i] = c;
}

// Filled ellipse (centre cx,cy, semi-axes rx,ry)
static void fb_ellipse(int cx, int cy, int rx, int ry, uint16_t c)
{
    if (rx <= 0 || ry <= 0) return;
    for (int dy = -ry; dy <= ry; dy++) {
        // x² / rx² + y² / ry² ≤ 1, compared in integers to avoid floats
        int64_t lim = (int64_t)rx * rx * ((int64_t)ry * ry - (int64_t)dy * dy);
        int w = 0;
        while ((int64_t)(w + 1) * (w + 1) * ry * ry <= lim) w++;
        for (int x = cx - w; x <= cx + w; x++) fb_px(x, cy + dy, c);
    }
}

static void fb_circle(int cx, int cy, int r, uint16_t c)
{
    fb_ellipse(cx, cy, r, r, c);
}

// Filled rounded rectangle (top-left x,y, width w, height h, corner radius r)
static void fb_rrect(int x, int y, int w, int h, int r, uint16_t c)
{
    if (w <= 0 || h <= 0) return;
    if (r * 2 > w) r = w / 2;
    if (r * 2 > h) r = h / 2;
    for (int j = 0; j < h; j++) {
        int inset = 0;
        int d = j < r ? r - j : j >= h - r ? j - (h - r - 1) : 0;
        if (d > 0) {
            // In the corners this row is inset by r - sqrt(r² - d²)
            int k = 0;
            while ((k + 1) * (k + 1) <= r * r - d * d) k++;
            inset = r - k;
        }
        for (int i = inset; i < w - inset; i++) fb_px(x + i, y + j, c);
    }
}

// Thick arc: centre cx,cy, outer radius r, width t; only the upper half y ≤ cy (happy eye ^) or lower half y ≥ cy (smile)
static void fb_arc(int cx, int cy, int r, int t, int upper, uint16_t c)
{
    int ri = r - t;
    for (int dy = -r; dy <= r; dy++) {
        if (upper ? dy > 0 : dy < 0) continue;
        for (int dx = -r; dx <= r; dx++) {
            int d2 = dx * dx + dy * dy;
            if (d2 <= r * r && d2 >= ri * ri) fb_px(cx + dx, cy + dy, c);
        }
    }
}
