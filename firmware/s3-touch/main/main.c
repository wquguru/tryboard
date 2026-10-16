// 示例：1.28″ 触摸圆屏（GC9A01 + CST816S，微雪 1.28inch Touch LCD 这一类模组），点哪画哪。
// 屏走 SPI2（接线见 firmware/common/round_lcd.h）；触摸走 I2C：TP_SDA=GPIO6、TP_SCL=GPIO7、TP_INT=GPIO5、TP_RST=GPIO16。
// CST816S 按着时 INT 拉低：INT 下降沿中断唤醒任务，按着期间每 20ms 读一次坐标（0x01..0x06）画点，
// 抬起后再读一次拿手势（单击 / 滑动 / 长按）。串口打印 TOUCH DOWN / MOVE / UP 与 GESTURE。
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2c_master.h"
#include "driver/gpio.h"
#include "round_lcd.h"

#define TP_SDA 6
#define TP_SCL 7
#define TP_INT 5
#define TP_RST 16
#define TP_ADDR 0x15

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

static const char *gesture_name(uint8_t g)
{
    switch (g) {
    case 0x01: return "up";
    case 0x02: return "down";
    case 0x03: return "left";
    case 0x04: return "right";
    case 0x05: return "click";
    case 0x0B: return "double";
    case 0x0C: return "long";
    default: return "none";
    }
}

// 屏幕底色：深蓝灰，中间一个十字准星，方便看点落在哪
static void draw_background(void)
{
    fb_clear(rgb(0x101820));
    for (int i = 0; i < LCD_W; i++) {
        fb_px(i, LCD_H / 2, rgb(0x2a3a4a));
        fb_px(LCD_W / 2, i, rgb(0x2a3a4a));
    }
    lcd_flush_rows(0, LCD_H);
}

static const uint32_t COLORS[] = {0xffd23f, 0x3fd2ff, 0xff5fa2, 0x7dff6b};

void app_main(void)
{
    lcd_init();
    draw_background();

    // 触摸复位：拉低 10ms 再放开，等 50ms 芯片起来
    gpio_config_t rst = {.pin_bit_mask = 1ULL << TP_RST, .mode = GPIO_MODE_OUTPUT};
    ESP_ERROR_CHECK(gpio_config(&rst));
    gpio_set_level(TP_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(TP_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(50));

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
    uint8_t id[3] = {0};
    ESP_ERROR_CHECK(rd(0xA7, id, 3));
    printf("CST816S chip id 0x%02X %s, project 0x%02X, fw 0x%02X\n", id[0], id[0] == 0xB5 ? "OK" : "(unexpected)", id[1], id[2]);

    task = xTaskGetCurrentTaskHandle();
    gpio_config_t ic = {.pin_bit_mask = 1ULL << TP_INT, .mode = GPIO_MODE_INPUT, .pull_up_en = 1, .intr_type = GPIO_INTR_NEGEDGE};
    ESP_ERROR_CHECK(gpio_config(&ic));
    ESP_ERROR_CHECK(gpio_install_isr_service(0));
    ESP_ERROR_CHECK(gpio_isr_handler_add(TP_INT, on_int, NULL));
    printf("TRYBOARD_OK s3-touch\n");

    int down = 0, strokes = 0, lx = -1, ly = -1;
    for (;;) {
        // 没按着就等 INT 下降沿；按着就每 20ms 轮询一次
        ulTaskNotifyTake(pdTRUE, down ? pdMS_TO_TICKS(20) : portMAX_DELAY);
        uint8_t d[6];
        if (rd(0x01, d, 6) != ESP_OK) continue;
        int fingers = d[1];
        int x = (d[2] & 0x0F) << 8 | d[3];
        int y = (d[4] & 0x0F) << 8 | d[5];
        if (fingers && gpio_get_level(TP_INT) == 0) {
            if (!down) {
                printf("TOUCH DOWN x=%d y=%d\n", x, y);
                strokes++;
            } else if (x != lx || y != ly) {
                printf("TOUCH MOVE x=%d y=%d\n", x, y);
            }
            down = 1;
            lx = x;
            ly = y;
            fb_circle(x, y, 6, rgb(COLORS[strokes % 4]));
            int y0 = y - 6 < 0 ? 0 : y - 6, y1 = y + 7 > LCD_H ? LCD_H : y + 7;
            lcd_flush_rows(y0, y1);
        } else if (down) {
            down = 0;
            printf("TOUCH UP x=%d y=%d\n", x, y);
            printf("GESTURE %s\n", gesture_name(d[0]));
            // 长按清屏
            if (d[0] == 0x0C) draw_background();
        }
    }
}
