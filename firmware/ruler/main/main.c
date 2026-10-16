// 超声波尺子（P2-09）参考固件，三个检查点共用：
//   STAGE 1 ruler-1「测距打印」：HC-SR04 每 100 ms 测一次，串口打印距离
//   STAGE 2 ruler-2「OLED 显示」：+ SSD1306 上 2 倍大字距离 + 距离条
//   STAGE 3 ruler-3「合体」：+ 无源蜂鸣器，越近响得越急（倒车雷达）
// 接线（ESP32-S3）：Trig=GPIO17，Echo 经 1 kΩ / 2 kΩ 分压接 GPIO18（HC-SR04 是 5 V 器件）；
// OLED SDA=GPIO8、SCL=GPIO9（0x3C）；蜂鸣器模块 I/O=GPIO5（LEDC 2.7 kHz，占空比 50% = 响、0 = 停）。
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "driver/gpio.h"
#include "driver/rmt_rx.h"
#include "esp_rom_sys.h"
#ifndef STAGE
#define STAGE 3
#endif
#if STAGE >= 2
#include "driver/i2c_master.h"
#include "ssd1306_mini.h"
#endif
#include "driver/ledc.h"

#define TRIG_GPIO 17
#define ECHO_GPIO 18
#define BUZZER_GPIO 5
#define BUZZER_HZ 2700

static bool IRAM_ATTR on_done(rmt_channel_handle_t ch, const rmt_rx_done_event_data_t *ev, void *arg)
{
    BaseType_t woken = pdFALSE;
    xQueueSendFromISR((QueueHandle_t)arg, ev, &woken);
    return woken == pdTRUE;
}

#if STAGE >= 2
static void oled_init(void)
{
    i2c_master_bus_handle_t bus;
    i2c_master_bus_config_t bc = {
        .i2c_port = 0,
        .sda_io_num = 8,
        .scl_io_num = 9,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    ESP_ERROR_CHECK(i2c_new_master_bus(&bc, &bus));
    i2c_device_config_t dc = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = 0x3C, .scl_speed_hz = 400000};
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dc, &oled));
    ESP_ERROR_CHECK(ssd1306_init());
}

// 第一行 2 倍大字距离，下面一条 0–200 cm 的距离条（外框 + 实心部分）
static void oled_show(int mm)
{
    memset(fb, 0, sizeof fb);
    char s[16];
    if (mm < 0) snprintf(s, sizeof s, "--- cm");
    else snprintf(s, sizeof s, "%d.%d cm", mm / 10, mm % 10);
    text(4, 8, s, 2);
    rect(0, 44, 128, 12, 0);
    if (mm > 0) {
        int w = (mm > 2000 ? 2000 : mm) * 128 / 2000;
        rect(0, 44, w, 12, 1);
    }
    ESP_ERROR_CHECK(flush());
}
#endif

#if STAGE == 3
// 两次蜂鸣之间停多久（ms）：-1 不响、0 一直响；由测距循环写、蜂鸣任务读
static volatile int gap_ms = -1;

static void buzzer(int on)
{
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, on ? 512 : 0);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

static void beep_task(void *arg)
{
    for (;;) {
        int g = gap_ms;
        if (g < 0) {
            buzzer(0);
            vTaskDelay(pdMS_TO_TICKS(20));
        } else if (g == 0) {
            buzzer(1);
            vTaskDelay(pdMS_TO_TICKS(20));
        } else {
            buzzer(1);
            vTaskDelay(pdMS_TO_TICKS(40));
            buzzer(0);
            vTaskDelay(pdMS_TO_TICKS(g));
        }
    }
}

static void buzzer_init(void)
{
    ledc_timer_config_t tc = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_10_BIT,
        .timer_num = LEDC_TIMER_0,
        .freq_hz = BUZZER_HZ,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&tc));
    ledc_channel_config_t ch = {
        .gpio_num = BUZZER_GPIO,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LEDC_CHANNEL_0,
        .timer_sel = LEDC_TIMER_0,
        .duty = 0,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&ch));
    xTaskCreate(beep_task, "beep", 2048, NULL, 5, NULL);
}
#endif

void app_main(void)
{
    gpio_config_t trig = {.pin_bit_mask = 1ULL << TRIG_GPIO, .mode = GPIO_MODE_OUTPUT};
    gpio_config(&trig);
    gpio_set_level(TRIG_GPIO, 0);
#if STAGE >= 2
    oled_init();
#endif
#if STAGE == 3
    buzzer_init();
#endif
    rmt_rx_channel_config_t rx_cfg = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 1000000,
        .mem_block_symbols = 48,
        .gpio_num = ECHO_GPIO,
    };
    rmt_channel_handle_t rx = NULL;
    ESP_ERROR_CHECK(rmt_new_rx_channel(&rx_cfg, &rx));
    QueueHandle_t q = xQueueCreate(1, sizeof(rmt_rx_done_event_data_t));
    rmt_rx_event_callbacks_t cbs = {.on_recv_done = on_done};
    ESP_ERROR_CHECK(rmt_rx_register_event_callbacks(rx, &cbs, q));
    ESP_ERROR_CHECK(rmt_enable(rx));
    // 电平 25 ms 不变就算一帧结束：比 400 cm 的回波（约 23.3 ms）长，比测不到时的 38 ms 短
    rmt_receive_config_t rcfg = {.signal_range_min_ns = 1000, .signal_range_max_ns = 25000000};
    static rmt_symbol_word_t buf[48];
    printf("RULER ready TRIG=GPIO%d ECHO=GPIO%d\n", TRIG_GPIO, ECHO_GPIO);
    for (;;) {
        ESP_ERROR_CHECK(rmt_receive(rx, buf, sizeof(buf), &rcfg));
        gpio_set_level(TRIG_GPIO, 1);
        esp_rom_delay_us(10);
        gpio_set_level(TRIG_GPIO, 0);
        rmt_rx_done_event_data_t ev;
        int mm = -1;
        if (xQueueReceive(q, &ev, pdMS_TO_TICKS(60)) != pdTRUE) {
            rmt_disable(rx);
            rmt_enable(rx);
        } else if (ev.num_symbols >= 1 && ev.received_symbols[0].level0 == 1 && ev.received_symbols[0].duration0 > 0 &&
                   ev.received_symbols[0].level1 == 0) {
            // 毫米 = µs × 343 m/s / 2，四舍五入到 0.1 cm
            unsigned us = ev.received_symbols[0].duration0;
            mm = (int)((us * 343u + 1000u) / 2000u);
        }
        if (mm < 0) printf("DIST ---\n");
        else printf("DIST %d.%d cm\n", mm / 10, mm % 10);
#if STAGE >= 2
        oled_show(mm);
#endif
#if STAGE == 3
        int g = mm < 0 || mm >= 1000 ? -1 : mm < 100 ? 0 : mm / 2;
        if (g != gap_ms) {
            gap_ms = g;
            if (g < 0) printf("BEEP off\n");
            else if (g == 0) printf("BEEP on\n");
            else printf("BEEP gap=%d ms\n", g);
        }
#endif
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
