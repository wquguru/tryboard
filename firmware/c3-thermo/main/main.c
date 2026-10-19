// Demo firmware: thermo-hygrometer (C3; the "try the demo first" step of board pick -> purchase -> bench). BME280@0x76 + SSD1306@0x3C on SDA=6 SCL=7
// (XIAO D4 / D5); reads each second, prints T / H / P to serial and OLED; TRYBOARD_OK after two sane reads. A silent device is reported, not aborted,
// so generated checkpoints show "0 ACKs" instead of a crash. (lint: allow-long-comment)
#include <stdio.h>
#include <string.h>
#include <stdbool.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2c_master.h"
#include "ssd1306_mini.h"
#include "bme280_calc.h"

#define PIN_SDA 6
#define PIN_SCL 7
#define BME_ADDR 0x76
#define OLED_ADDR 0x3C

static i2c_master_bus_handle_t bus;
static i2c_master_dev_handle_t bme;

static esp_err_t rd(uint8_t reg, uint8_t *buf, size_t n)
{
    return i2c_master_transmit_receive(bme, &reg, 1, buf, n, 100);
}

static esp_err_t wr(uint8_t reg, uint8_t v)
{
    uint8_t b[2] = {reg, v};
    return i2c_master_transmit(bme, b, 2, 100);
}

static bool bme_init(void)
{
    uint8_t id = 0;
    if (rd(0xD0, &id, 1) != ESP_OK || id != 0x60) {
        printf("BME280 @0x76 no answer\n");
        return false;
    }
    uint8_t c[26], h[7];
    if (rd(0x88, c, 26) != ESP_OK || rd(0xE1, h, 7) != ESP_OK) return false;
    bme280_parse_calib(c, h);
    // Humidity x1; temperature x1, pressure x1, normal mode; standby 125ms, filter off
    return wr(0xF2, 0x01) == ESP_OK && wr(0xF5, 0x40) == ESP_OK && wr(0xF4, 0x27) == ESP_OK;
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
    printf("c3-thermo: BME280 + SSD1306 on SDA=GPIO%d SCL=GPIO%d\n", PIN_SDA, PIN_SCL);

    i2c_device_config_t bd = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = BME_ADDR, .scl_speed_hz = 100000};
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &bd, &bme));
    i2c_device_config_t od = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = OLED_ADDR, .scl_speed_hz = 400000};
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &od, &oled));

    bool has_bme = bme_init();
    bool has_oled = ssd1306_init() == ESP_OK;
    if (!has_oled) printf("SSD1306 @0x3C no answer\n");

    int ok = 0;
    for (;;) {
        // In normal mode the first conversion needs one measurement cycle; then once a second
        vTaskDelay(pdMS_TO_TICKS(has_bme && ok == 0 ? 200 : 1000));
        char l1[24] = "T=--", l2[24] = "H=--", l3[24] = "P=--";
        uint8_t d[8];
        if (has_bme && rd(0xF7, d, 8) == ESP_OK) {
            int32_t ap = (d[0] << 12) | (d[1] << 4) | (d[2] >> 4);
            int32_t at = (d[3] << 12) | (d[4] << 4) | (d[5] >> 4);
            int32_t ah = (d[6] << 8) | d[7];
            int32_t t = comp_t(at);
            uint32_t p = comp_p(ap);
            uint32_t hh = comp_h(ah);
            int32_t ta = t < 0 ? -t : t;
            snprintf(l1, sizeof l1, "T=%s%" PRId32 ".%02" PRId32 " C", t < 0 ? "-" : "", ta / 100, ta % 100);
            snprintf(l2, sizeof l2, "H=%" PRIu32 ".%02" PRIu32 " %%", hh / 1024, (hh % 1024) * 100 / 1024);
            snprintf(l3, sizeof l3, "P=%" PRIu32 ".%02" PRIu32 " hPa", p / 25600, (p % 25600) * 100 / 25600);
            printf("%s  %s  %s\n", l1, l2, l3);
            // Plausible range: -40..85°C, 0..100%, 300..1100hPa
            if (t > -4000 && t < 8500 && hh <= 100 * 1024 && p > 300 * 25600 && p < 1100 * 25600) ok++;
        }
        if (has_oled) {
            memset(fb, 0, sizeof fb);
            text(4, 2, "TryBoard thermo", 1);
            text(4, 18, l1, 1);
            text(4, 32, l2, 1);
            text(4, 46, l3, 1);
            flush();
        }
        if (ok == 2 && has_oled) printf("TRYBOARD_OK c3-thermo\n");
    }
}
