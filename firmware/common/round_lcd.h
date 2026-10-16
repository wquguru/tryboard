// GC9A01 240×240 圆屏（SPI2）公共件：总线 / 面板初始化 + 整帧缓冲上的简单图形。lens、spin 及其检查点固件、c3-lcd 共用。
// 接线（ESP32-S3）：SCLK=GPIO12 MOSI=GPIO11 CS=GPIO10 DC=GPIO14 RST=GPIO13 背光=GPIO15（高电平亮）。
// 接线（ESP32-C3）：SCLK=GPIO6 MOSI=GPIO7 CS=GPIO10 DC=GPIO5 RST=GPIO4 背光=GPIO3（高电平亮）。
// SCLK / MOSI / CS 正好是 SPI2 的 IO_MUX 直连脚，驱动会走 IO_MUX 而不是 GPIO 矩阵。
// 引脚可以在 include 之前用 #define 覆盖（例如板载圆屏的开发板）。
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
// C3 DevKitM-1：2、8、9 是 strapping 脚（8 还接着板载 RGB），DC / RST / 背光避开它们
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
// 每次 SPI 传输最多 40 行（19200 字节）：一帧拆成 6 次 DMA，每次 5 个描述符
#define LCD_CHUNK_LINES 40

static esp_lcd_panel_handle_t lcd_panel;
static uint16_t *lcd_fb; // 大端 RGB565（SPI 先发高字节）
static SemaphoreHandle_t lcd_done;

// RGB888 → 线上字节序的 RGB565
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
        // 圆屏模组的子像素是 BGR 排列（与 IDF spi_lcd_touch 示例一致）
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_BGR,
        .bits_per_pixel = 16,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_gc9a01(io, &pc, &lcd_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_reset(lcd_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(lcd_panel));
    // 常见 GC9A01 模组是 IPS 常黑面板：开反色才是正常颜色
    ESP_ERROR_CHECK(esp_lcd_panel_invert_color(lcd_panel, true));
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(lcd_panel, true));
    gpio_config_t bl = {.pin_bit_mask = 1ULL << LCD_BL, .mode = GPIO_MODE_OUTPUT};
    ESP_ERROR_CHECK(gpio_config(&bl));
    gpio_set_level(LCD_BL, 1);
    lcd_fb = heap_caps_malloc(LCD_W * LCD_H * 2, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    assert(lcd_fb);
}

// 送出 [y0, y1) 行，等传输完成再返回（缓冲马上要被重画）
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

// 填充椭圆（中心 cx,cy，半轴 rx,ry）
static void fb_ellipse(int cx, int cy, int rx, int ry, uint16_t c)
{
    if (rx <= 0 || ry <= 0) return;
    for (int dy = -ry; dy <= ry; dy++) {
        // x² / rx² + y² / ry² ≤ 1，整数比较避免浮点
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

// 填充圆角矩形（左上 x,y，宽 w 高 h，圆角半径 r）
static void fb_rrect(int x, int y, int w, int h, int r, uint16_t c)
{
    if (w <= 0 || h <= 0) return;
    if (r * 2 > w) r = w / 2;
    if (r * 2 > h) r = h / 2;
    for (int j = 0; j < h; j++) {
        int inset = 0;
        int d = j < r ? r - j : j >= h - r ? j - (h - r - 1) : 0;
        if (d > 0) {
            // 圆角处这一行缩进 r - sqrt(r² - d²)
            int k = 0;
            while ((k + 1) * (k + 1) <= r * r - d * d) k++;
            inset = r - k;
        }
        for (int i = inset; i < w - inset; i++) fb_px(x + i, y + j, c);
    }
}

// 粗弧线：圆心 cx,cy，外半径 r，线宽 t，只画 y ≤ cy 的上半（开心眼 ^）或 y ≥ cy 的下半（笑嘴）
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
