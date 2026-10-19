// Example: SSD1306 (0x3C) and BME280 (0x76) on one I2C bus on classic ESP32,
// using the usual DevKitC SDA=GPIO21, SCL=GPIO22; readings shown on screen.
#include <stdio.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2c_master.h"
#include "ssd1306_mini.h"
#include "bme280_calc.h"

#define PIN_SDA 21
#define PIN_SCL 22
#define OLED_ADDR 0x3C
#define BME_ADDR 0x76

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
    for (int a = 0x08; a < 0x78; a++)
        if (i2c_master_probe(bus, a, 50) == ESP_OK) printf(" 0x%02X", a);
    printf("\n");

    i2c_device_config_t oc = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = OLED_ADDR, .scl_speed_hz = 400000};
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &oc, &oled));
    ESP_ERROR_CHECK(ssd1306_init());
    printf("SSD1306 init OK\n");

    i2c_device_config_t dc = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = BME_ADDR, .scl_speed_hz = 100000};
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dc, &bme));
    uint8_t id = 0;
    ESP_ERROR_CHECK(rd(0xD0, &id, 1));
    printf("BME280 chip id 0x%02X %s\n", id, id == 0x60 ? "OK" : "(unexpected)");

    uint8_t c[26], h[7];
    ESP_ERROR_CHECK(rd(0x88, c, 26));
    ESP_ERROR_CHECK(rd(0xE1, h, 7));
    bme280_parse_calib(c, h);
    // Humidity x1; temperature x1, pressure x1, normal mode; standby 125ms, filter off
    ESP_ERROR_CHECK(wr(0xF2, 0x01));
    ESP_ERROR_CHECK(wr(0xF5, 0x40));
    ESP_ERROR_CHECK(wr(0xF4, 0x27));

    for (int n = 0;; n++) {
        vTaskDelay(pdMS_TO_TICKS(500));
        uint8_t d[8];
        ESP_ERROR_CHECK(rd(0xF7, d, 8));
        int32_t t = comp_t((d[3] << 12) | (d[4] << 4) | (d[5] >> 4));
        uint32_t p = comp_p((d[0] << 12) | (d[1] << 4) | (d[2] >> 4));
        uint32_t hh = comp_h((d[6] << 8) | d[7]);
        char l1[24], l2[24], l3[24];
        snprintf(l1, sizeof l1, "T %s%" PRId32 ".%02" PRId32 " C", t < 0 ? "-" : "", (t < 0 ? -t : t) / 100, (t < 0 ? -t : t) % 100);
        snprintf(l2, sizeof l2, "H %" PRIu32 ".%" PRIu32 " %%", hh / 1024, (hh % 1024) * 10 / 1024);
        snprintf(l3, sizeof l3, "P %" PRIu32 " hPa", (p + 12800) / 25600);
        memset(fb, 0, sizeof fb);
        text(0, 0, "ESP32 I2C", 1);
        text(0, 16, l1, 2);
        text(0, 36, l2, 1);
        text(0, 48, l3, 1);
        ESP_ERROR_CHECK(flush());
        printf("T=%s%" PRId32 ".%02" PRId32 " C H=%" PRIu32 ".%" PRIu32 " %% P=%" PRIu32 ".%02" PRIu32 " hPa\n",
               t < 0 ? "-" : "", (t < 0 ? -t : t) / 100, (t < 0 ? -t : t) % 100, hh / 1024, (hh % 1024) * 10 / 1024,
               p / 25600, (p % 25600) * 100 / 25600);
        if (n == 1) printf("TRYBOARD_OK esp32-i2c\n");
    }
}
