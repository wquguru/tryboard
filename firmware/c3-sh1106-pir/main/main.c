// F-04a2 example: ESP32-C3 + 1.3" SH1106 OLED (I2C 0x3C, SDA=GPIO6, SCL=GPIO7) shows an HC-SR501 PIR on GPIO4.
// The screen shows MOTION / quiet, the trigger count and how long the last visit lasted; serial prints each edge.
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_timer.h"
#include "ssd1306_mini.h"

#define PIN_SDA 6
#define PIN_SCL 7
#define OLED_ADDR 0x3C
#define PIR_GPIO 4
// SH1106 RAM is 132 columns wide; the glass starts at column 2
#define SH1106_COL0 2

static i2c_master_bus_handle_t bus;

// Same init as firmware/c3-sh1106: DC-DC on (ADh 8Bh), segment remap, COM reverse, display on
static esp_err_t sh1106_init(void)
{
    static const uint8_t init[] = {0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40, 0xAD, 0x8B, 0xA1, 0xC8,
                                   0xDA, 0x12, 0x81, 0xCF, 0xD9, 0x22, 0xDB, 0x35, 0xA4, 0xA6, 0xAF};
    return cmds(init, sizeof init);
}

// Page addressing only: set page and column 2 for every page, then send its 128 bytes
static esp_err_t sh1106_flush(void)
{
    static uint8_t buf[1 + 128];
    for (int p = 0; p < 8; p++) {
        const uint8_t addr[] = {0xB0 | p, SH1106_COL0 & 0x0F, 0x10 | (SH1106_COL0 >> 4)};
        esp_err_t e = cmds(addr, sizeof addr);
        if (e != ESP_OK) return e;
        buf[0] = 0x40;
        memcpy(buf + 1, fb + p * 128, 128);
        e = i2c_master_transmit(oled, buf, sizeof buf, 100);
        if (e != ESP_OK) return e;
    }
    return ESP_OK;
}

static void draw(int motion, int count, int last_s, int up_s)
{
    char line[24];
    memset(fb, 0, sizeof fb);
    text(4, 2, "PIR monitor", 1);
    snprintf(line, sizeof line, "%3ds", up_s);
    text(100, 2, line, 1);
    rect(0, 12, 128, 1, 1);
    if (motion) {
        // Inverted banner: draw the text, then flip every pixel of the box (page layout, LSB on top)
        text(28, 20, "MOTION", 2);
        for (int y = 16; y < 38; y++)
            for (int x = 0; x < 128; x++) fb[(y / 8) * 128 + x] ^= 1 << (y & 7);
    } else {
        text(34, 19, "quiet", 2);
    }
    snprintf(line, sizeof line, "visits %d", count);
    text(4, 44, line, 1);
    if (last_s >= 0) {
        snprintf(line, sizeof line, "last %ds", last_s);
        text(4, 54, line, 1);
    }
    ESP_ERROR_CHECK(sh1106_flush());
}

void app_main(void)
{
    gpio_config_t in = {.pin_bit_mask = 1ULL << PIR_GPIO, .mode = GPIO_MODE_INPUT};
    gpio_config(&in);
    i2c_master_bus_config_t bc = {
        .i2c_port = 0,
        .sda_io_num = PIN_SDA,
        .scl_io_num = PIN_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    ESP_ERROR_CHECK(i2c_new_master_bus(&bc, &bus));
    i2c_device_config_t dc = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = OLED_ADDR, .scl_speed_hz = 400000};
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dc, &oled));
    ESP_ERROR_CHECK(sh1106_init());
    printf("SH1106 人体感应屏启动：OLED I2C 0x%02X (SDA=%d SCL=%d)，PIR 在 GPIO%d\n", OLED_ADDR, PIN_SDA, PIN_SCL, PIR_GPIO);
    int prev = -1, count = 0, last_s = -1, shown_s = -1;
    int64_t since = 0;
    for (;;) {
        int64_t now = esp_timer_get_time();
        int m = gpio_get_level(PIR_GPIO);
        int up = (int)(now / 1000000);
        if (m != prev) {
            if (m) {
                count++;
                since = now;
                printf("有人经过，第 %d 次\n", count);
            } else if (prev == 1) {
                last_s = (int)((now - since + 500000) / 1000000);
                printf("人已离开，这次持续 %d 秒\n", last_s);
            }
        }
        if (m != prev || up != shown_s) {
            draw(m, count, last_s, up);
            if (prev < 0) printf("TRYBOARD_OK c3-sh1106-pir\n");
            prev = m;
            shown_s = up;
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}
