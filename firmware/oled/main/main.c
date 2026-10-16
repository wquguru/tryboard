// 示例：SSD1306 128x64 OLED（I2C 地址 0x3C），SDA=GPIO6，SCL=GPIO7，400kHz。
// 不依赖任何外部组件：自带 5x7 字库与最小的 SSD1306 驱动。
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2c_master.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "ssd1306_mini.h"

#if CONFIG_IDF_TARGET_ESP32S3
#define CHIP_NAME "ESP32-S3"
#else
#define CHIP_NAME "ESP32-C3"
#endif

#ifndef PIN_SDA
#define PIN_SDA 6
#endif
#ifndef PIN_SCL
#define PIN_SCL 7
#endif
#define OLED_ADDR 0x3C

static i2c_master_bus_handle_t bus;
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

    printf("I2C scan (SDA=GPIO%d, SCL=GPIO%d):", PIN_SDA, PIN_SCL);
    int found = 0;
    for (int a = 0x08; a < 0x78; a++) {
        if (i2c_master_probe(bus, a, 50) == ESP_OK) {
            printf(" 0x%02X", a);
            found++;
        }
    }
    printf("  (%d device%s)\n", found, found == 1 ? "" : "s");

    i2c_device_config_t dc = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = OLED_ADDR,
        .scl_speed_hz = 400000,
    };
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dc, &oled));

    ESP_ERROR_CHECK(ssd1306_init());
    printf("SSD1306 init OK\n");

    for (int t = 0;; t++) {
        memset(fb, 0, sizeof fb);
        rect(0, 0, 128, 64, 0);
        text(16, 5, "TryBoard", 2);
        text(10, 24, CHIP_NAME "+SSD1306", 1);
        text(10, 34, "I2C 0x3C @400kHz", 1);
        // 进度条：每秒前进一格
        rect(10, 46, 108, 10, 0);
        rect(12, 48, 104 * ((t % 10) + 1) / 10, 6, 1);
        int64_t t0 = esp_timer_get_time();
        ESP_ERROR_CHECK(flush());
        int64_t us = esp_timer_get_time() - t0;
        printf("frame %d flushed in %lld us\n", t, (long long)us);
        if (t == 0) printf("TRYBOARD_OK oled\n");
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
