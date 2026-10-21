// F-04a2 example: ESP32-C3 + 2.4" ILI9341 (fixed SPI2 LCD pins, firmware/common/bare_tft.h) shows a DS18B20 probe on GPIO1.
// Big seven-segment digits, colour by range (blue < 15 °C, green, red > 28 °C) and a -10..40 °C bar; redraws only on change.
#include <string.h>
#include "esp_lcd_ili9341.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#define TFT_NEW_PANEL esp_lcd_new_panel_ili9341
#define TFT_BGR 1
#define TFT_INVERT false
#include "bare_tft.h"
#include "freertos/task.h"

// GPIO4 is the LCD reset on C3, so the probe moves to GPIO1 (4.7 kΩ pull-up to 3V3)
#define OW_GPIO 1

static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

// 1-Wire slots as in firmware/c3-ds18b20 (Maxim AN126 standard speed); open drain, 1 releases the line
static int ow_reset(void)
{
    portENTER_CRITICAL(&mux);
    gpio_set_level(OW_GPIO, 0);
    esp_rom_delay_us(480);
    gpio_set_level(OW_GPIO, 1);
    esp_rom_delay_us(70);
    int present = gpio_get_level(OW_GPIO) == 0;
    portEXIT_CRITICAL(&mux);
    esp_rom_delay_us(410);
    return present;
}

static void ow_write_bit(int b)
{
    portENTER_CRITICAL(&mux);
    gpio_set_level(OW_GPIO, 0);
    esp_rom_delay_us(b ? 6 : 60);
    gpio_set_level(OW_GPIO, 1);
    esp_rom_delay_us(b ? 64 : 10);
    portEXIT_CRITICAL(&mux);
}

static int ow_read_bit(void)
{
    portENTER_CRITICAL(&mux);
    gpio_set_level(OW_GPIO, 0);
    esp_rom_delay_us(6);
    gpio_set_level(OW_GPIO, 1);
    esp_rom_delay_us(9);
    int b = gpio_get_level(OW_GPIO);
    esp_rom_delay_us(55);
    portEXIT_CRITICAL(&mux);
    return b;
}

static void ow_write(uint8_t v)
{
    for (int i = 0; i < 8; i++) ow_write_bit(v >> i & 1);
}

static uint8_t ow_read(void)
{
    uint8_t v = 0;
    for (int i = 0; i < 8; i++) v |= ow_read_bit() << i;
    return v;
}

// CRC-8/MAXIM (reflected 0x8C); a block followed by its CRC sums to 0
static uint8_t crc8(const uint8_t *p, int n)
{
    uint8_t crc = 0;
    while (n--) {
        uint8_t b = *p++;
        for (int i = 0; i < 8; i++) {
            uint8_t mix = (crc ^ b) & 1;
            crc >>= 1;
            if (mix) crc ^= 0x8C;
            b >>= 1;
        }
    }
    return crc;
}

// One probe on the bus: SKIP ROM, convert, poll the busy bit, read the scratchpad. Raw 1/16 °C, or INT32_MIN on error
static int32_t read_temp(void)
{
    if (!ow_reset()) return INT32_MIN;
    ow_write(0xCC);
    ow_write(0x44);
    int64_t t0 = esp_timer_get_time();
    while (!ow_read_bit() && esp_timer_get_time() - t0 < 2000000) vTaskDelay(1);
    if (!ow_reset()) return INT32_MIN;
    ow_write(0xCC);
    ow_write(0xBE);
    uint8_t s[9];
    for (int i = 0; i < 9; i++) s[i] = ow_read();
    if (crc8(s, 9)) return INT32_MIN;
    return (int16_t)(s[0] | s[1] << 8);
}

// Seven-segment glyphs (bits a..g) and segment boxes in a 36 x 72 cell, stroke 8
#define DW 36
#define DH 72
#define ST 8
#define DY 110
static const uint8_t SEG7[10] = {0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F};
static const int16_t SEGBOX[7][4] = {
    {ST, 0, DW - 2 * ST, ST}, {DW - ST, ST, ST, DH / 2 - ST}, {DW - ST, DH / 2, ST, DH / 2 - ST}, {ST, DH - ST, DW - 2 * ST, ST},
    {0, DH / 2, ST, DH / 2 - ST}, {0, ST, ST, DH / 2 - ST},       {ST, DH / 2 - ST / 2, DW - 2 * ST, ST},
};

// Current screen content: text such as "-5.5" / "23.5" laid out left to right, plus range colour and bar length
static char s_txt[16];
static int s_x0;
static uint32_t s_col;
static int s_bar;

static int glyph_w(char c)
{
    return c == '.' ? 14 : DW + 8;
}

static bool lit(int x, int y)
{
    if (y < DY || y >= DY + DH) return false;
    int cx = s_x0;
    for (const char *p = s_txt; *p; cx += glyph_w(*p++)) {
        int lx = x - cx, ly = y - DY;
        if (lx < 0 || lx >= glyph_w(*p)) continue;
        if (*p == '.') return lx < ST && ly >= DH - ST;
        uint8_t m = *p == '-' ? 0x40 : SEG7[*p - '0'];
        for (int k = 0; k < 7; k++) {
            const int16_t *b = SEGBOX[k];
            if (m >> k & 1 && lx >= b[0] && lx < b[0] + b[2] && ly >= b[1] && ly < b[1] + b[3]) return true;
        }
        return false;
    }
    // Degree ring after the number: hollow 14 x 14 square
    int dx = x - cx, dy = y - DY;
    return dx >= 0 && dx < 14 && dy < 14 && (dx < 4 || dx >= 10 || dy < 4 || dy >= 10);
}

static uint16_t pixel(int x, int y)
{
    if (y < 36) return tft_rgb(s_col);
    if (y >= 250 && y < 274 && x >= 20 && x < 220) {
        if (x == 20 || x == 219 || y == 250 || y == 273) return tft_rgb(0xC0C4CC);
        return tft_rgb(x - 20 < s_bar ? s_col : 0x20242C);
    }
    if (lit(x, y)) return tft_rgb(s_col);
    return tft_rgb(0x0A0C10);
}

static void draw(int32_t raw)
{
    // Tenths, rounded away from zero; 1/16 °C * 10 / 16
    int t10 = (int)((raw * 10 + (raw < 0 ? -8 : 8)) / 16);
    int a = t10 < 0 ? -t10 : t10;
    snprintf(s_txt, sizeof s_txt, "%s%d.%d", t10 < 0 ? "-" : "", a / 10, a % 10);
    int w = 14;
    for (const char *p = s_txt; *p; p++) w += glyph_w(*p);
    s_x0 = (TFT_W - w) / 2;
    s_col = t10 < 150 ? 0x3F8FFF : t10 > 280 ? 0xFF4A3A : 0x3FD67A;
    int b = (t10 + 100) * 200 / 500;
    s_bar = b < 0 ? 0 : b > 200 ? 200 : b;
    uint16_t *buf = heap_caps_malloc(TFT_W * TFT_CHUNK * 2, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    assert(buf);
    for (int y0 = 0; y0 < TFT_H; y0 += TFT_CHUNK) {
        for (int y = 0; y < TFT_CHUNK; y++)
            for (int x = 0; x < TFT_W; x++) buf[y * TFT_W + x] = pixel(x, y0 + y);
        ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(tft_panel, 0, y0, TFT_W, y0 + TFT_CHUNK, buf));
        xSemaphoreTake(tft_done, portMAX_DELAY);
    }
    heap_caps_free(buf);
    printf("屏幕显示 %s °C（%s）\n", s_txt, t10 < 150 ? "偏冷" : t10 > 280 ? "偏热" : "舒适");
}

void app_main(void)
{
    gpio_config_t io = {.pin_bit_mask = 1ULL << OW_GPIO, .mode = GPIO_MODE_INPUT_OUTPUT_OD, .pull_up_en = GPIO_PULLUP_ENABLE};
    gpio_config(&io);
    gpio_set_level(OW_GPIO, 1);
    tft_init();
    printf("ILI9341 温度屏启动 (SCLK=%d MOSI=%d CS=%d DC=%d RST=%d BL=%d)，DS18B20 在 GPIO%d\n", TFT_SCLK, TFT_MOSI, TFT_CS, TFT_DC,
           TFT_RST, TFT_BL, OW_GPIO);
    int32_t last = INT32_MIN;
    bool ok = false;
    for (;;) {
        int32_t raw = read_temp();
        if (raw == INT32_MIN) {
            printf("错误: GPIO%d 上读不到 DS18B20（检查接线和 4.7k 上拉）\n", OW_GPIO);
        } else if (raw != last) {
            draw(raw);
            last = raw;
            if (!ok) printf("TRYBOARD_OK c3-ili9341-temp\n");
            ok = true;
        }
        vTaskDelay(pdMS_TO_TICKS(250));
    }
}
