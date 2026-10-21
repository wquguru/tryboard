// Bare 240x320 SPI TFT module test pattern (F-04b), shared by c3-ili9341 and s3-st7789. Include in one .c only, after defining
// TFT_NEW_PANEL(io, cfg, out) (the esp_lcd panel constructor), TFT_BGR (subpixel order) and TFT_INVERT (IPS panels need INVON). (lint: allow-long-comment)
// Wiring is the GC9A01 one (round_lcd.h): S3 SCLK=12 MOSI=11 CS=10 DC=14 RST=13 BL=15; C3 SCLK=6 MOSI=7 CS=10 DC=5 RST=4 BL=3.
#pragma once
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "driver/spi_master.h"
#include "driver/gpio.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "sdkconfig.h"

#define TFT_W 240
#define TFT_H 320
#if CONFIG_IDF_TARGET_ESP32C3
#define TFT_SCLK 6
#define TFT_MOSI 7
#define TFT_CS 10
#define TFT_DC 5
#define TFT_RST 4
#define TFT_BL 3
#define TFT_HOST_NAME "SPI2"
#elif CONFIG_IDF_TARGET_ESP32
// CYD (ESP32-2432S028) wiring: HSPI = SPI2_HOST on the classic chip, panel reset tied to EN
#define TFT_SCLK 14
#define TFT_MOSI 13
#define TFT_CS 15
#define TFT_DC 2
#define TFT_RST -1
#define TFT_BL 21
#define TFT_HOST_NAME "HSPI"
#else
#define TFT_SCLK 12
#define TFT_MOSI 11
#define TFT_CS 10
#define TFT_DC 14
#define TFT_RST 13
#define TFT_BL 15
#define TFT_HOST_NAME "SPI2"
#endif
// 40 lines (19200 bytes) per draw: 8 transfers per frame, small enough for C3 internal RAM
#define TFT_CHUNK 40

static esp_lcd_panel_handle_t tft_panel;
static SemaphoreHandle_t tft_done;

// RGB888 -> RGB565 in wire byte order (SPI sends the high byte first)
static inline uint16_t tft_rgb(uint32_t c)
{
    uint16_t v = ((c >> 8) & 0xF800) | ((c >> 5) & 0x07E0) | ((c >> 3) & 0x001F);
    return (uint16_t)((v >> 8) | (v << 8));
}

static bool tft_on_done(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *e, void *ctx)
{
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR(tft_done, &woken);
    return woken == pdTRUE;
}

static void tft_init(void)
{
    spi_bus_config_t bc = {
        .sclk_io_num = TFT_SCLK,
        .mosi_io_num = TFT_MOSI,
        .miso_io_num = -1,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = TFT_W * TFT_CHUNK * 2,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bc, SPI_DMA_CH_AUTO));
    tft_done = xSemaphoreCreateBinary();
    esp_lcd_panel_io_handle_t io;
    esp_lcd_panel_io_spi_config_t ioc = {
        .dc_gpio_num = TFT_DC,
        .cs_gpio_num = TFT_CS,
        .pclk_hz = 40 * 1000 * 1000,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
        .spi_mode = 0,
        .trans_queue_depth = 10,
        .on_color_trans_done = tft_on_done,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI2_HOST, &ioc, &io));
    esp_lcd_panel_dev_config_t pc = {
        .reset_gpio_num = TFT_RST,
        .rgb_ele_order = TFT_BGR ? LCD_RGB_ELEMENT_ORDER_BGR : LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = 16,
    };
    ESP_ERROR_CHECK(TFT_NEW_PANEL(io, &pc, &tft_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_reset(tft_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(tft_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_invert_color(tft_panel, TFT_INVERT));
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(tft_panel, true));
    gpio_config_t bl = {.pin_bit_mask = 1ULL << TFT_BL, .mode = GPIO_MODE_OUTPUT};
    ESP_ERROR_CHECK(gpio_config(&bl));
    gpio_set_level(TFT_BL, 1);
}

// Pattern: 80-row bands red / green / blue / white top to bottom, a 40x40 yellow marker in the top-left corner (shows
// mirroring), and a 1-pixel magenta frame around the glass (shows a wrong size or offset). A 240x240 glass shows the top 3 bands.
static uint16_t tft_pattern(int x, int y)
{
    static const uint32_t bands[4] = {0xFF0000, 0x00FF00, 0x0000FF, 0xFFFFFF};
    if (x == 0 || x == TFT_W - 1 || y == 0 || y == TFT_H - 1) return tft_rgb(0xFF00FF);
    if (x < 40 && y < 40) return tft_rgb(0xFFFF00);
    return tft_rgb(bands[y / 80]);
}

static int tft_draw_pattern(void)
{
    uint16_t *buf = heap_caps_malloc(TFT_W * TFT_CHUNK * 2, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    assert(buf);
    int n = 0;
    for (int y0 = 0; y0 < TFT_H; y0 += TFT_CHUNK, n++) {
        for (int y = 0; y < TFT_CHUNK; y++)
            for (int x = 0; x < TFT_W; x++) buf[y * TFT_W + x] = tft_pattern(x, y0 + y);
        ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(tft_panel, 0, y0, TFT_W, y0 + TFT_CHUNK, buf));
        xSemaphoreTake(tft_done, portMAX_DELAY);
    }
    heap_caps_free(buf);
    return n;
}
