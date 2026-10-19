// Example: 6-axis IMU tilt (S3, I2C SDA=GPIO8 SCL=GPIO9 400kHz); MPU6050 at 0x68, or QMI8658 at 0x6B with IMU_QMI8658.
// Every 200ms: roll = atan2(ay, az), pitch = atan2(-ax, sqrt(ay² + az²)); accel alone gives no yaw, gyro Z gives turn rate.
#include <stdio.h>
#include <math.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2c_master.h"

#define PIN_SDA 8
#define PIN_SCL 9

#ifdef IMU_QMI8658
#define NAME "QMI8658"
#define ADDR 0x6B
#define ID_REG 0x00
#define ID_VAL 0x05
#define OK_TAG "s3-qmi8658"
#else
#define NAME "MPU6050"
#define ADDR 0x68
#define ID_REG 0x75
#define ID_VAL 0x68
#define OK_TAG "s3-imu"
#endif

static i2c_master_dev_handle_t dev;

static esp_err_t rd(uint8_t reg, uint8_t *buf, size_t n)
{
    return i2c_master_transmit_receive(dev, &reg, 1, buf, n, 100);
}

static esp_err_t wr(uint8_t reg, uint8_t v)
{
    uint8_t b[2] = {reg, v};
    return i2c_master_transmit(dev, b, 2, 100);
}

// Read one sample: accel (g), gyro (°/s), temperature (°C)
static void sample(float a[3], float g[3], float *t)
{
    uint8_t d[14];
#ifdef IMU_QMI8658
    // From 0x33: TEMP_L/H, AX..AZ, GX..GZ, little endian; ±4 g → 8192 LSB/g, ±512 °/s → 64 LSB/(°/s)
    ESP_ERROR_CHECK(rd(0x33, d, 14));
    int16_t v[7];
    for (int i = 0; i < 7; i++) v[i] = (int16_t)(d[2 * i] | d[2 * i + 1] << 8);
    *t = v[0] / 256.0f;
    for (int i = 0; i < 3; i++) {
        a[i] = v[1 + i] / 8192.0f;
        g[i] = v[4 + i] / 64.0f;
    }
#else
    // From 0x3B: AX AY AZ TEMP GX GY GZ, big endian; ±2 g → 16384 LSB/g, ±250 °/s → 131 LSB/(°/s)
    ESP_ERROR_CHECK(rd(0x3B, d, 14));
    int16_t v[7];
    for (int i = 0; i < 7; i++) v[i] = (int16_t)(d[2 * i] << 8 | d[2 * i + 1]);
    for (int i = 0; i < 3; i++) {
        a[i] = v[i] / 16384.0f;
        g[i] = v[4 + i] / 131.0f;
    }
    *t = v[3] / 340.0f + 36.53f;
#endif
}

void app_main(void)
{
    i2c_master_bus_handle_t bus;
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

    i2c_device_config_t dc = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = ADDR, .scl_speed_hz = 400000};
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dc, &dev));
    uint8_t id = 0;
    ESP_ERROR_CHECK(rd(ID_REG, &id, 1));
    printf(NAME " WHO_AM_I 0x%02X %s\n", id, id == ID_VAL ? "OK" : "(unexpected)");

#ifdef IMU_QMI8658
    ESP_ERROR_CHECK(wr(0x60, 0xB0)); // soft reset
    vTaskDelay(pdMS_TO_TICKS(20));
    ESP_ERROR_CHECK(wr(0x02, 0x40)); // CTRL1: address auto-increment, little endian
    ESP_ERROR_CHECK(wr(0x03, 0x15)); // CTRL2: ±4 g, ODR code 5
    ESP_ERROR_CHECK(wr(0x04, 0x55)); // CTRL3: ±512 °/s, ODR code 5
    ESP_ERROR_CHECK(wr(0x08, 0x03)); // CTRL7: enable accel + gyro
#else
    ESP_ERROR_CHECK(wr(0x6B, 0x80)); // reset
    vTaskDelay(pdMS_TO_TICKS(100));
    ESP_ERROR_CHECK(wr(0x6B, 0x01)); // leave sleep, clock from gyro X PLL
    ESP_ERROR_CHECK(wr(0x19, 9));    // 1 kHz / (1 + 9) = 100 Hz
    ESP_ERROR_CHECK(wr(0x1A, 0x03)); // DLPF 44 Hz
    ESP_ERROR_CHECK(wr(0x1B, 0x00)); // ±250 °/s
    ESP_ERROR_CHECK(wr(0x1C, 0x00)); // ±2 g
#endif
    vTaskDelay(pdMS_TO_TICKS(50));

    for (int n = 0;; n++) {
        float a[3], g[3], t;
        sample(a, g, &t);
        float roll = atan2f(a[1], a[2]) * 57.29578f;
        float pitch = atan2f(-a[0], sqrtf(a[1] * a[1] + a[2] * a[2])) * 57.29578f;
        printf("IMU pitch=%.1f roll=%.1f a=(%.3f,%.3f,%.3f)g gyro=(%.1f,%.1f,%.1f)dps T=%.1fC\n",
               pitch, roll, a[0], a[1], a[2], g[0], g[1], g[2], t);
        if (n == 2) printf("TRYBOARD_OK " OK_TAG "\n");
        vTaskDelay(pdMS_TO_TICKS(200));
    }
}
