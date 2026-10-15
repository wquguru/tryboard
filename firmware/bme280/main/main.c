// 示例：BME280 温湿度气压传感器（I2C 地址 0x76），SDA=GPIO6，SCL=GPIO7，100kHz。
// 不依赖外部组件：按 Bosch 数据手册的整数补偿公式自己算。
#include <stdio.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2c_master.h"

#define PIN_SDA 6
#define PIN_SCL 7
#define BME_ADDR 0x76

static i2c_master_bus_handle_t bus;
static i2c_master_dev_handle_t bme;

static uint16_t T1, P1;
static int16_t T2, T3, P2, P3, P4, P5, P6, P7, P8, P9, H2, H4, H5;
static uint8_t H1, H3;
static int8_t H6;
static int32_t t_fine;

static esp_err_t rd(uint8_t reg, uint8_t *buf, size_t n)
{
    return i2c_master_transmit_receive(bme, &reg, 1, buf, n, 100);
}

static esp_err_t wr(uint8_t reg, uint8_t v)
{
    uint8_t b[2] = {reg, v};
    return i2c_master_transmit(bme, b, 2, 100);
}

static int32_t comp_t(int32_t adc)
{
    int32_t v1 = ((((adc >> 3) - ((int32_t)T1 << 1))) * T2) >> 11;
    int32_t v2 = (((((adc >> 4) - (int32_t)T1) * ((adc >> 4) - (int32_t)T1)) >> 12) * T3) >> 14;
    t_fine = v1 + v2;
    return (t_fine * 5 + 128) >> 8;
}

static uint32_t comp_p(int32_t adc)
{
    int64_t v1 = (int64_t)t_fine - 128000;
    int64_t v2 = v1 * v1 * P6;
    v2 += (v1 * P5) << 17;
    v2 += ((int64_t)P4) << 35;
    v1 = ((v1 * v1 * P3) >> 8) + ((v1 * P2) << 12);
    v1 = (((((int64_t)1) << 47) + v1)) * P1 >> 33;
    if (v1 == 0) return 0;
    int64_t p = 1048576 - adc;
    p = (((p << 31) - v2) * 3125) / v1;
    v1 = (((int64_t)P9) * (p >> 13) * (p >> 13)) >> 25;
    v2 = (((int64_t)P8) * p) >> 19;
    p = ((p + v1 + v2) >> 8) + (((int64_t)P7) << 4);
    return (uint32_t)p;
}

static uint32_t comp_h(int32_t adc)
{
    int32_t v = t_fine - 76800;
    v = (((((adc << 14) - (((int32_t)H4) << 20) - (((int32_t)H5) * v)) + 16384) >> 15) *
         (((((((v * H6) >> 10) * (((v * (int32_t)H3) >> 11) + 32768)) >> 10) + 2097152) * H2 + 8192) >> 14));
    v = v - (((((v >> 15) * (v >> 15)) >> 7) * H1) >> 4);
    v = v < 0 ? 0 : v;
    v = v > 419430400 ? 419430400 : v;
    return (uint32_t)(v >> 12);
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
    T1 = c[0] | c[1] << 8; T2 = c[2] | c[3] << 8; T3 = c[4] | c[5] << 8;
    P1 = c[6] | c[7] << 8; P2 = c[8] | c[9] << 8; P3 = c[10] | c[11] << 8; P4 = c[12] | c[13] << 8;
    P5 = c[14] | c[15] << 8; P6 = c[16] | c[17] << 8; P7 = c[18] | c[19] << 8; P8 = c[20] | c[21] << 8;
    P9 = c[22] | c[23] << 8; H1 = c[25];
    H2 = h[0] | h[1] << 8; H3 = h[2];
    H4 = (int16_t)((int8_t)h[3] * 16) | (h[4] & 0x0F);
    H5 = (int16_t)((int8_t)h[5] * 16) | (h[4] >> 4);
    H6 = (int8_t)h[6];
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
