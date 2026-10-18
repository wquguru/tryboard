// 验收：FT6236 电容触摸（I2C 0x38，3.5″ 320×480 一类触摸屏上的那颗），裸 I2C 读寄存器，不用组件库。
// 接线：TP_SDA=GPIO6、TP_SCL=GPIO7、TP_INT=GPIO5、TP_RST=GPIO16。
// 寄存器按 FocalTech FT6x36 数据手册：0xA3 芯片 ID（0x36）、0xA8 厂商 ID（0x11）、0xA6 固件版本、0xA4 G_MODE；
// 0x02 TD_STATUS（触点数）、0x03..0x06 第一个触点（P1_XH 高 2 位是事件：0 按下、1 抬起、2 接触）。
// 按着时 INT 拉低：下降沿中断唤醒任务，按着期间每 20 ms 读一次；INT 没接时退化成每 50 ms 轮询，两种都能跑。
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
    // 复位：拉低 10 ms 再放开，等 300 ms 芯片固件起来再访问（留足余量）
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
    // 0xA3 CIPHER、0xA4 G_MODE、0xA5 PWR_MODE、0xA6 FIRMID、0xA7、0xA8 FOCALTECH_ID
    if (rd(0xA3, id, 6) != ESP_OK) {
        // 没应答多半是 SDA / SCL 接反、没供电或地址不对：报出来，不要 abort 反复重启
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
