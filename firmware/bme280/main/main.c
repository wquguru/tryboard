// 示例：BME280 温湿度气压传感器（I2C 地址 0x76），默认 SDA=GPIO6，SCL=GPIO7（PIN_SDA / PIN_SCL 可覆盖），100kHz。
// 不依赖外部组件：按 Bosch 数据手册的整数补偿公式自己算。
#include <stdio.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2c_master.h"
#include "bme280_calc.h"

#ifndef PIN_SDA
#define PIN_SDA 6
#endif
#ifndef PIN_SCL
#define PIN_SCL 7
#endif
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

    i2c_device_config_t dc = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = BME_ADDR, .scl_speed_hz = 100000};
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dc, &bme));

    uint8_t id = 0;
    ESP_ERROR_CHECK(rd(0xD0, &id, 1));
    printf("BME280 chip id 0x%02X %s\n", id, id == 0x60 ? "OK" : "(unexpected)");

    uint8_t c[26], h[7];
    ESP_ERROR_CHECK(rd(0x88, c, 26));
    ESP_ERROR_CHECK(rd(0xE1, h, 7));
    bme280_parse_calib(c, h);
    printf("calib T1=%u T2=%d T3=%d P1=%u H1=%u H2=%d H4=%d H5=%d\n", T1, T2, T3, P1, H1, H2, H4, H5);

    // 湿度 ×1；温度 ×1、气压 ×1、正常模式；待机 125ms、关滤波
    ESP_ERROR_CHECK(wr(0xF2, 0x01));
    ESP_ERROR_CHECK(wr(0xF5, 0x40));
    ESP_ERROR_CHECK(wr(0xF4, 0x27));

    int ok = 0;
    for (int n = 0;; n++) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        uint8_t d[8];
        ESP_ERROR_CHECK(rd(0xF7, d, 8));
        int32_t ap = (d[0] << 12) | (d[1] << 4) | (d[2] >> 4);
        int32_t at = (d[3] << 12) | (d[4] << 4) | (d[5] >> 4);
        int32_t ah = (d[6] << 8) | d[7];
        int32_t t = comp_t(at);
        uint32_t p = comp_p(ap);
        uint32_t hh = comp_h(ah);
        printf("T=%" PRId32 ".%02" PRId32 " C  H=%" PRIu32 ".%02" PRIu32 " %%  P=%" PRIu32 ".%02" PRIu32 " hPa\n",
               t / 100, (t < 0 ? -t : t) % 100, hh / 1024, (hh % 1024) * 100 / 1024, p / 25600, (p % 25600) * 100 / 25600);
        // 合理范围：-40..85°C、0..100%、300..1100hPa
        if (t > -4000 && t < 8500 && hh <= 100 * 1024 && p > 300 * 25600 && p < 1100 * 25600) ok++;
        if (ok == 3) printf("TRYBOARD_OK bme280\n");
    }
}
