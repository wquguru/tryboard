// Acceptance: FT6236 capacitive touch (I2C 0x38, the chip on 3.5" 320x480 panels), raw I2C register reads, no component. TP_SDA=6, TP_SCL=7, TP_INT=5,
// TP_RST=16. Registers per FocalTech FT6x36: 0xA3 chip ID (0x36), 0xA8 vendor (0x11), 0xA6 fw, 0xA4 G_MODE; 0x02 TD_STATUS, 0x03..0x06 first point
// (P1_XH top 2 bits = event: 0 down, 1 up, 2 contact). INT low while touched: falling edge wakes the task, read every 20 ms while held; without INT,
// poll every 50 ms. (lint: allow-long-comment)
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2c_master.h"
#include "driver/gpio.h"

#define TP_SDA 6
#define TP_SCL 7
#define TP_INT 5
#define TP_RST 16
#define TP_ADDR 0x38

static i2c_master_dev_handle_t tp;
static TaskHandle_t task;

static esp_err_t rd(uint8_t reg, uint8_t *buf, size_t n)
{
    return i2c_master_transmit_receive(tp, &reg, 1, buf, n, 100);
}

static void IRAM_ATTR on_int(void *arg)
{
    BaseType_t woken = pdFALSE;
    vTaskNotifyGiveFromISR(task, &woken);
    if (woken) portYIELD_FROM_ISR();
}

static const char *event_name(int ev)
{
    static const char *n[] = {"down", "up", "contact", "none"};
    return n[ev & 3];
}

void app_main(void)
{
    // Reset: low 10 ms then release, wait 300 ms for the chip firmware before access (with margin)
    gpio_config_t rst = {.pin_bit_mask = 1ULL << TP_RST, .mode = GPIO_MODE_OUTPUT};
    ESP_ERROR_CHECK(gpio_config(&rst));
    gpio_set_level(TP_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(TP_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(300));

    i2c_master_bus_handle_t bus;
    i2c_master_bus_config_t bc = {
        .i2c_port = 0,
        .sda_io_num = TP_SDA,
        .scl_io_num = TP_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    ESP_ERROR_CHECK(i2c_new_master_bus(&bc, &bus));
    i2c_device_config_t dc = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = TP_ADDR, .scl_speed_hz = 400000};
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dc, &tp));

    uint8_t id[6] = {0};
    // 0xA3 CIPHER, 0xA4 G_MODE, 0xA5 PWR_MODE, 0xA6 FIRMID, 0xA7, 0xA8 FOCALTECH_ID
    if (rd(0xA3, id, 6) != ESP_OK) {
        // No ACK usually means SDA / SCL swapped, no power or wrong address: report it rather than abort and reboot-loop
        printf("FT6236 no ACK at 0x%02X: check TP_SDA=GPIO%d TP_SCL=GPIO%d and power\n", TP_ADDR, TP_SDA, TP_SCL);
        for (;;) vTaskDelay(portMAX_DELAY);
    }
    printf("FT6236 chip id 0x%02X %s, vendor 0x%02X, fw 0x%02X, mode %s\n", id[0], id[0] == 0x36 ? "OK" : "(unexpected)",
           id[5], id[3], id[1] ? "trigger" : "polling");

    task = xTaskGetCurrentTaskHandle();
    gpio_config_t ic = {.pin_bit_mask = 1ULL << TP_INT, .mode = GPIO_MODE_INPUT, .pull_up_en = 1, .intr_type = GPIO_INTR_NEGEDGE};
    ESP_ERROR_CHECK(gpio_config(&ic));
    ESP_ERROR_CHECK(gpio_install_isr_service(0));
    ESP_ERROR_CHECK(gpio_isr_handler_add(TP_INT, on_int, NULL));
    printf("TRYBOARD_OK s3-ft6236\n");

    int down = 0, lx = -1, ly = -1;
    for (;;) {
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(down ? 20 : 50));
        uint8_t d[5];
        if (rd(0x02, d, 5) != ESP_OK) continue;
        int fingers = d[0] & 0x0F;
        int ev = d[1] >> 6;
        int x = (d[1] & 0x0F) << 8 | d[2];
        int y = (d[3] & 0x0F) << 8 | d[4];
        if (fingers > 0 && fingers <= 2) {
            if (!down) {
                printf("TOUCH DOWN x=%d y=%d ev=%s\n", x, y, event_name(ev));
            } else if (x != lx || y != ly) {
                printf("TOUCH MOVE x=%d y=%d ev=%s\n", x, y, event_name(ev));
            }
            down = 1;
            lx = x;
            ly = y;
        } else if (down) {
            down = 0;
            printf("TOUCH UP x=%d y=%d ev=%s\n", x, y, event_name(ev));
        }
    }
}
