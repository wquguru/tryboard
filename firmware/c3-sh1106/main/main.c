// ESP32-C3 + 1.3" SH1106 128x64 OLED (I2C 0x3C, SDA=GPIO6, SCL=GPIO7, 400kHz) acceptance. SH1106 has a 132-column RAM with the
// glass on columns 2..129 and only page addressing, so each page is sent separately from column 2 (an SSD1306 driver shifts the image). (lint: allow-long-comment)
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2c_master.h"
#include "esp_timer.h"
#include "ssd1306_mini.h"

#define PIN_SDA 6
#define PIN_SCL 7
#define OLED_ADDR 0x3C
#define SH1106_COL0 2

static i2c_master_bus_handle_t bus;

// Display off, clock, mux 64, offset 0, start line 0, DC-DC on (ADh 8Bh), segment remap, COM reverse, COM pins, contrast,
// precharge, VCOM deselect, follow RAM, normal, display on
static esp_err_t sh1106_init(void)
{
    static const uint8_t init[] = {0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40, 0xAD, 0x8B, 0xA1, 0xC8,
                                   0xDA, 0x12, 0x81, 0xCF, 0xD9, 0x22, 0xDB, 0x35, 0xA4, 0xA6, 0xAF};
    return cmds(init, sizeof init);
}

static esp_err_t sh1106_flush(void)
{
    static uint8_t buf[1 + 128];
    for (int p = 0; p < 8; p++) {
        const uint8_t addr[] = {0xB0 | p, SH1106_COL0 & 0x0F, 0x10 | (SH1106_COL0 >> 4)};
        esp_err_t e = cmds(addr, sizeof addr);
        if (e != ESP_OK) return e;
        buf[0] = 0x40; // control byte: display data follows
        memcpy(buf + 1, fb + p * 128, 128);
        e = i2c_master_transmit(oled, buf, sizeof buf, 100);
        if (e != ESP_OK) return e;
    }
    return ESP_OK;
}

void app_main(void)
{
    i2c_master_bus_config_t bc = {
        .i2c_port = 0,
        .sda_io_num = PIN_SDA,
        .scl_io_num = PIN_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    ESP_ERROR_CHECK(i2c_new_master_bus(&bc, &bus));
    printf("I2C probe 0x%02X: %s\n", OLED_ADDR, i2c_master_probe(bus, OLED_ADDR, 50) == ESP_OK ? "ACK" : "no reply");
    i2c_device_config_t dc = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = OLED_ADDR,
        .scl_speed_hz = 400000,
    };
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dc, &oled));
    ESP_ERROR_CHECK(sh1106_init());
    printf("SH1106 init OK\n");

    for (int t = 0;; t++) {
        memset(fb, 0, sizeof fb);
        // Full border: a column offset error cuts off the left or right edge
        rect(0, 0, 128, 64, 0);
        text(16, 5, "TryBoard", 2);
        text(10, 24, "ESP32-C3+SH1106", 1);
        text(10, 34, "1.3in 128x64 I2C", 1);
        rect(10, 46, 108, 10, 0);
        rect(12, 48, 104 * ((t % 10) + 1) / 10, 6, 1);
        int64_t t0 = esp_timer_get_time();
        ESP_ERROR_CHECK(sh1106_flush());
        printf("frame %d flushed in %lld us\n", t, (long long)(esp_timer_get_time() - t0));
        if (t == 0) printf("TRYBOARD_OK c3-sh1106\n");
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
