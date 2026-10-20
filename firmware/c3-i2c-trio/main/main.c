// F-04e acceptance: AHT20 (0x38) + INA219 (0x40) + DS3231 (0x68) on one I2C bus, SDA=GPIO6, SCL=GPIO7, 100 kHz.
// Register-level drivers written from the datasheets (no external component). Prints readings once a second and checks:
// AHT20 CRC and busy bit, INA219 current = shunt / 0.1 ohm, DS3231 seconds follow esp_timer and alarm 1 fires.
#include <stdio.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2c_master.h"
#include "esp_timer.h"

#define PIN_SDA 6
#define PIN_SCL 7

static i2c_master_bus_handle_t bus;
static i2c_master_dev_handle_t aht, ina, rtc;

static i2c_master_dev_handle_t add(uint8_t addr)
{
    i2c_device_config_t dc = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = addr, .scl_speed_hz = 100000};
    i2c_master_dev_handle_t h;
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dc, &h));
    return h;
}

// CRC-8, polynomial 0x31, init 0xFF (AHT20 datasheet)
static uint8_t crc8(const uint8_t *d, int n)
{
    uint8_t c = 0xff;
    for (int i = 0; i < n; i++) {
        c ^= d[i];
        for (int b = 0; b < 8; b++) c = c & 0x80 ? (c << 1) ^ 0x31 : c << 1;
    }
    return c;
}

static uint16_t ina_rd(uint8_t reg)
{
    uint8_t b[2];
    ESP_ERROR_CHECK(i2c_master_transmit_receive(ina, &reg, 1, b, 2, 100));
    return (b[0] << 8) | b[1];
}

static void ina_wr(uint8_t reg, uint16_t v)
{
    uint8_t b[3] = {reg, v >> 8, v & 0xff};
    ESP_ERROR_CHECK(i2c_master_transmit(ina, b, 3, 100));
}

static void rtc_rd(uint8_t reg, uint8_t *buf, int n)
{
    ESP_ERROR_CHECK(i2c_master_transmit_receive(rtc, &reg, 1, buf, n, 100));
}

static void rtc_wr(uint8_t reg, const uint8_t *data, int n)
{
    uint8_t b[16] = {reg};
    for (int i = 0; i < n; i++) b[i + 1] = data[i];
    ESP_ERROR_CHECK(i2c_master_transmit(rtc, b, n + 1, 100));
}

static int unbcd(uint8_t b) { return (b >> 4) * 10 + (b & 15); }

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
    aht = add(0x38);
    ina = add(0x40);
    rtc = add(0x68);
    int fails = 0;

    // AHT20: status after power-on, calibrate if CAL is clear
    uint8_t st;
    ESP_ERROR_CHECK(i2c_master_receive(aht, &st, 1, 100));
    if ((st & 0x18) != 0x18) {
        uint8_t init[3] = {0xbe, 0x08, 0x00};
        ESP_ERROR_CHECK(i2c_master_transmit(aht, init, 3, 100));
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    printf("AHT20 status 0x%02X\n", st);

    // INA219: reset, 32 V / 320 mV / 12-bit continuous; cal 4096 with 0.1 ohm -> 100 uA and 2 mW per LSB
    ina_wr(0x00, 0x8000);
    printf("INA219 config 0x%04X\n", ina_rd(0x00));
    ina_wr(0x00, 0x399f);
    ina_wr(0x05, 4096);

    // DS3231: report OSF, set 2026-10-20 12:34:56 (day 3), clear OSF, alarm 1 at second 59, INTCN + A1IE
    uint8_t s0;
    rtc_rd(0x0f, &s0, 1);
    printf("DS3231 status 0x%02X OSF=%d\n", s0, s0 >> 7);
    const uint8_t t0[7] = {0x56, 0x34, 0x12, 0x03, 0x20, 0x10, 0x26};
    rtc_wr(0x00, t0, 7);
    int64_t us0 = esp_timer_get_time();
    const uint8_t a1[4] = {0x59, 0x80, 0x80, 0x80};
    rtc_wr(0x07, a1, 4);
    const uint8_t ctl = 0x1d, clr = 0x08;
    rtc_wr(0x0e, &ctl, 1);
    rtc_wr(0x0f, &clr, 1);

    int alarm = 0, time_ok = 0, aht_ok = 0, ina_ok = 0;
    for (int n = 0; n < 4; n++) {
        vTaskDelay(pdMS_TO_TICKS(1000));

        uint8_t trig[3] = {0xac, 0x33, 0x00}, d[7];
        ESP_ERROR_CHECK(i2c_master_transmit(aht, trig, 3, 100));
        ESP_ERROR_CHECK(i2c_master_receive(aht, d, 1, 100));
        int busy = d[0] >> 7;
        vTaskDelay(pdMS_TO_TICKS(80));
        ESP_ERROR_CHECK(i2c_master_receive(aht, d, 7, 100));
        int crc = crc8(d, 6) == d[6];
        uint32_t hr = ((uint32_t)d[1] << 12) | (d[2] << 4) | (d[3] >> 4);
        uint32_t tr = ((uint32_t)(d[3] & 15) << 16) | (d[4] << 8) | d[5];
        int32_t h100 = (int32_t)(((int64_t)hr * 10000) >> 20);
        int32_t t100 = (int32_t)(((int64_t)tr * 20000) >> 20) - 5000;
        int32_t ta = t100 < 0 ? -t100 : t100;
        printf("AHT20 T=%s%" PRId32 ".%02" PRId32 " C  H=%" PRId32 ".%02" PRId32 " %%  busy=%d crc=%s\n", t100 < 0 ? "-" : "",
               ta / 100, ta % 100, h100 / 100, h100 % 100, busy, crc ? "ok" : "BAD");
        if (busy && crc && !(d[0] & 0x80)) aht_ok++;

        uint16_t bus_raw = ina_rd(0x02);
        int16_t shunt = (int16_t)ina_rd(0x01);
        int16_t cur = (int16_t)ina_rd(0x04);
        uint16_t pw = ina_rd(0x03);
        int bus_mv = (bus_raw >> 3) * 4;
        int ca = cur < 0 ? -cur : cur;
        printf("INA219 bus=%d mV  shunt=%d uV  I=%s%d.%d mA  P=%d mW  cnvr=%d\n", bus_mv, shunt * 10, cur < 0 ? "-" : "",
               ca / 10, ca % 10, pw * 2, (bus_raw >> 1) & 1);
        // Current LSB 100 uA = shunt LSB 10 uV / 0.1 ohm: the registers must agree
        if (cur == shunt && bus_mv > 4000 && bus_mv < 5500 && (bus_raw & 2)) ina_ok++;

        uint8_t r[0x13];
        rtc_rd(0x00, r, 0x13);
        int sec = unbcd(r[0]), min = unbcd(r[1]);
        int q = (int8_t)r[0x11] * 4 + (r[0x12] >> 6);
        int qa = q < 0 ? -q : q;
        printf("DS3231 20%02d-%02d-%02d %02d:%02d:%02d day=%d T=%s%d.%02d C A1F=%d\n", unbcd(r[6]), unbcd(r[5] & 0x1f),
               unbcd(r[4]), unbcd(r[2] & 0x3f), min, sec, r[3], q < 0 ? "-" : "", qa / 4, qa % 4 * 25, r[0x0f] & 1);
        int elapsed = (int)((esp_timer_get_time() - us0) / 1000000);
        if (min * 60 + sec - (34 * 60 + 56) == elapsed) time_ok++;
        if (r[0x0f] & 1) alarm = 1;
    }
    printf("checks: aht20=%d/4 ina219=%d/4 ds3231_time=%d/4 alarm1=%d\n", aht_ok, ina_ok, time_ok, alarm);
    fails += aht_ok != 4 || ina_ok != 4 || time_ok != 4 || !alarm;
    if (!fails) printf("TRYBOARD_OK c3-i2c-trio\n");
}
