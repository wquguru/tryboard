// Acceptance: Waveshare ESP32-S3-Touch-AMOLED-2.16 I2C bus (SDA=15 SCL=14), raw i2c_master, no components. Devices: CST9220 touch 0x5A
// (16-bit registers, INT=11 RST=40), AXP2101 PMIC 0x34, PCF85063 RTC 0x51, ES8311 0x18, ES7210 0x40. Reads every chip ID, battery state,
// sets the RTC and reads it back 3 s later, then prints touches (INT falling edge, 20 ms polling while held) and AXP2101 PWRON / USB events.
// (lint: allow-long-comment)
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2c_master.h"
#include "driver/gpio.h"

#define I2C_SDA 15
#define I2C_SCL 14
#define TP_INT 11
#define TP_RST 40

static i2c_master_bus_handle_t bus;
static i2c_master_dev_handle_t tp, pmu, rtc, dac, adc;
static TaskHandle_t task;

static i2c_master_dev_handle_t add(uint8_t addr)
{
    i2c_master_dev_handle_t h;
    i2c_device_config_t dc = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = addr, .scl_speed_hz = 400000};
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dc, &h));
    return h;
}

static esp_err_t rd8(i2c_master_dev_handle_t d, uint8_t reg, uint8_t *buf, size_t n)
{
    return i2c_master_transmit_receive(d, &reg, 1, buf, n, 100);
}

static esp_err_t wr8(i2c_master_dev_handle_t d, uint8_t reg, const uint8_t *v, size_t n)
{
    uint8_t b[16];
    b[0] = reg;
    memcpy(b + 1, v, n);
    return i2c_master_transmit(d, b, n + 1, 100);
}

// CST9220: big-endian 16-bit register address
static esp_err_t rd16(uint16_t reg, uint8_t *buf, size_t n)
{
    uint8_t a[2] = {reg >> 8, reg & 0xFF};
    return i2c_master_transmit_receive(tp, a, 2, buf, n, 100);
}

static esp_err_t cmd16(uint16_t reg)
{
    uint8_t a[2] = {reg >> 8, reg & 0xFF};
    return i2c_master_transmit(tp, a, 2, 100);
}

static void IRAM_ATTR on_int(void *arg)
{
    BaseType_t woken = pdFALSE;
    vTaskNotifyGiveFromISR(task, &woken);
    if (woken) portYIELD_FROM_ISR();
}

static uint8_t bcd(int v) { return (v / 10) << 4 | v % 10; }
static int unbcd(uint8_t b) { return (b >> 4) * 10 + (b & 15); }

static const char *chg_name(int s)
{
    static const char *n[] = {"涓流", "预充", "恒流", "恒压", "已充满", "未充电", "?", "?"};
    return n[s & 7];
}

static void battery(const char *tag)
{
    uint8_t st[2], pct, a[8];
    if (rd8(pmu, 0x00, st, 2) != ESP_OK || rd8(pmu, 0xA4, &pct, 1) != ESP_OK || rd8(pmu, 0x34, a, 8) != ESP_OK) return;
    int vbat = (a[0] & 0x3F) << 8 | a[1], vbus = (a[4] & 0x3F) << 8 | a[5], vsys = (a[6] & 0x3F) << 8 | a[7];
    int dir = st[1] >> 5 & 3;
    printf("%s 电量 %d%% USB %s %s 充电状态 %s VBAT=%dmV VBUS=%dmV VSYS=%dmV\n", tag, pct, st[0] & 0x20 ? "已插" : "未插",
           dir == 1 ? "充电中" : dir == 2 ? "放电中" : "待机", chg_name(st[1]), vbat, vbus, vsys);
}

void app_main(void)
{
    // Touch reset: low 10 ms, then the chip firmware needs ~30 ms before I2C
    gpio_config_t rst = {.pin_bit_mask = 1ULL << TP_RST, .mode = GPIO_MODE_OUTPUT};
    ESP_ERROR_CHECK(gpio_config(&rst));
    gpio_set_level(TP_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(TP_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(50));

    i2c_master_bus_config_t bc = {
        .i2c_port = 0,
        .sda_io_num = I2C_SDA,
        .scl_io_num = I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    ESP_ERROR_CHECK(i2c_new_master_bus(&bc, &bus));
    tp = add(0x5A);
    pmu = add(0x34);
    rtc = add(0x51);
    dac = add(0x18);
    adc = add(0x40);

    // Scan by chip ID: a NACK means the device is missing (wiring / power), report it and carry on
    int found = 0, have_tp = 0, have_pmu = 0, have_rtc = 0;
    uint8_t b[8];
    if (cmd16(0xD101) == ESP_OK) {
        vTaskDelay(pdMS_TO_TICKS(10));
        uint8_t c[4] = {0};
        rd16(0xD1FC, c, 4);
        rd16(0xD204, b, 4);
        uint8_t r[4] = {0};
        rd16(0xD1F8, r, 4);
        cmd16(0xD109);
        int type = b[3] << 8 | b[2];
        printf("发现 0x5A CST9220 芯片 0x%04X %s 校验 0x%02X%02X 分辨率 %dx%d\n", type, type == 0x9220 ? "OK" : "(不对)", c[3], c[2],
               r[1] << 8 | r[0], r[3] << 8 | r[2]);
        have_tp = 1;
        found++;
    } else {
        printf("CST9220 无应答 0x5A：检查 TP_SDA=GPIO%d TP_SCL=GPIO%d 与 TP_RST=GPIO%d\n", I2C_SDA, I2C_SCL, TP_RST);
    }
    if (rd8(pmu, 0x03, b, 1) == ESP_OK) {
        printf("发现 0x34 AXP2101 芯片ID 0x%02X %s\n", b[0], b[0] == 0x4A ? "OK" : "(不对)");
        have_pmu = 1;
        found++;
    } else {
        printf("AXP2101 无应答 0x34\n");
    }
    if (rd8(rtc, 0x00, b, 2) == ESP_OK) {
        printf("发现 0x51 PCF85063 控制寄存器 0x%02X 0x%02X\n", b[0], b[1]);
        have_rtc = 1;
        found++;
    } else {
        printf("PCF85063 无应答 0x51\n");
    }
    if (rd8(dac, 0xFD, b, 2) == ESP_OK) {
        printf("发现 0x18 ES8311 芯片ID 0x%02X%02X %s\n", b[0], b[1], b[0] == 0x83 && b[1] == 0x11 ? "OK" : "(不对)");
        found++;
    } else {
        printf("ES8311 无应答 0x18\n");
    }
    if (rd8(adc, 0x3D, b, 2) == ESP_OK) {
        printf("发现 0x40 ES7210 芯片ID 0x%02X%02X %s\n", b[0], b[1], b[0] == 0x72 && b[1] == 0x10 ? "OK" : "(不对)");
        found++;
    } else {
        printf("ES7210 无应答 0x40\n");
    }
    printf("I2C 扫描完成：%d/5 个器件\n", found);

    if (have_pmu) {
        // IRQ enables: 0x41 VBUS in/out + PWRON short/long, 0x42 charge start/done; clear stale status (write 1 to clear)
        const uint8_t en[3] = {0x00, 0xCC, 0x18}, clr[3] = {0xFF, 0xFF, 0xFF};
        wr8(pmu, 0x40, en, 3);
        wr8(pmu, 0x48, clr, 3);
        battery("开机");
    }
    if (have_rtc) {
        // Set 2026-10-20 (Tuesday = 2) 12:34:56, wait 3 s and read back
        const uint8_t t[7] = {bcd(56), bcd(34), bcd(12), bcd(20), 2, bcd(10), bcd(26)};
        wr8(rtc, 0x04, t, 7);
        printf("RTC 设为 2026-10-20 12:34:56\n");
        vTaskDelay(pdMS_TO_TICKS(3010)); // +10 ms: vTaskDelay can wake up to one tick early
        rd8(rtc, 0x04, b, 7);
        printf("RTC 读回 20%02d-%02d-%02d %02d:%02d:%02d 星期%d%s\n", unbcd(b[6]), unbcd(b[5] & 0x1F), unbcd(b[3] & 0x3F),
               unbcd(b[2] & 0x3F), unbcd(b[1] & 0x7F), unbcd(b[0] & 0x7F), b[4] & 7, b[0] & 0x80 ? " (振荡器停过)" : "");
    }

    task = xTaskGetCurrentTaskHandle();
    gpio_config_t ic = {.pin_bit_mask = 1ULL << TP_INT, .mode = GPIO_MODE_INPUT, .pull_up_en = 1, .intr_type = GPIO_INTR_NEGEDGE};
    ESP_ERROR_CHECK(gpio_config(&ic));
    ESP_ERROR_CHECK(gpio_install_isr_service(0));
    ESP_ERROR_CHECK(gpio_isr_handler_add(TP_INT, on_int, NULL));
    printf("TRYBOARD_OK s3-amoled-i2c\n");

    int down = 0, lx = -1, ly = -1, tick = 0;
    for (;;) {
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(down ? 20 : 50));
        if (have_tp) {
            uint8_t d[15];
            if (rd16(0xD000, d, sizeof d) == ESP_OK) {
                // Ack the report, then use it only if it carries the 0xAB marker
                uint8_t ack[3] = {0xD0, 0x00, 0xAB};
                i2c_master_transmit(tp, ack, 3, 100);
                if (d[6] == 0xAB) {
                    int n = d[5] & 0x7F;
                    int x = d[1] << 4 | d[3] >> 4, y = d[2] << 4 | (d[3] & 15);
                    if (n > 0 && (d[0] & 0x0F) == 0x06) {
                        if (!down) {
                            printf("TOUCH DOWN x=%d y=%d\n", x, y);
                        } else if (x != lx || y != ly) {
                            printf("TOUCH MOVE x=%d y=%d\n", x, y);
                        }
                        down = 1;
                        lx = x;
                        ly = y;
                    } else if (down) {
                        down = 0;
                        printf("TOUCH UP x=%d y=%d\n", lx, ly);
                    }
                }
            }
        }
        // AXP2101 IRQ status every ~100 ms (the IRQ pin is not used on this board)
        if (have_pmu && ++tick % 2 == 0) {
            uint8_t s[3];
            if (rd8(pmu, 0x48, s, 3) == ESP_OK && (s[0] | s[1] | s[2])) {
                if (s[1] & 0x08) printf("PWRON 短按\n");
                if (s[1] & 0x04) printf("PWRON 长按\n");
                if (s[1] & 0x80) printf("USB 插入\n");
                if (s[1] & 0x40) printf("USB 拔出\n");
                if (s[2] & 0x08) printf("开始充电\n");
                if (s[2] & 0x10) printf("充电完成\n");
                wr8(pmu, 0x48, s, 3);
                battery("变化");
            }
        }
    }
}
