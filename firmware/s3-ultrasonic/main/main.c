// 示例：HC-SR04 超声波测距。Trig=GPIO17 由 GPIO 发 10 µs 高脉冲；Echo=GPIO18（经 1 kΩ / 2 kΩ 分压）接 RMT 接收通道，
// 1 MHz 分辨率把 Echo 高电平宽度记成一个 RMT 符号；距离 = 宽度 × 声速 / 2（343 m/s，20 ℃）。每 100 ms 测一次。
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "driver/gpio.h"
#include "driver/rmt_rx.h"
#include "esp_rom_sys.h"

#ifndef TRIG_GPIO
#define TRIG_GPIO 17
#endif
#ifndef ECHO_GPIO
#define ECHO_GPIO 18
#endif

static bool IRAM_ATTR on_done(rmt_channel_handle_t ch, const rmt_rx_done_event_data_t *ev, void *arg)
{
    BaseType_t woken = pdFALSE;
    xQueueSendFromISR((QueueHandle_t)arg, ev, &woken);
    return woken == pdTRUE;
}

void app_main(void)
{
    gpio_config_t trig = {.pin_bit_mask = 1ULL << TRIG_GPIO, .mode = GPIO_MODE_OUTPUT};
    gpio_config(&trig);
    gpio_set_level(TRIG_GPIO, 0);

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
    // 短于 1 µs 的毛刺滤掉；电平 25 ms 不变就算一帧结束（量程 400 cm 的回波约 23.3 ms）
    rmt_receive_config_t rcfg = {.signal_range_min_ns = 1000, .signal_range_max_ns = 25000000};
    static rmt_symbol_word_t buf[48];

    printf("ULTRASONIC ready TRIG=GPIO%d ECHO=GPIO%d (RMT RX 1MHz)\n", TRIG_GPIO, ECHO_GPIO);
    int n = 0;
    for (;;) {
        ESP_ERROR_CHECK(rmt_receive(rx, buf, sizeof(buf), &rcfg));
        gpio_set_level(TRIG_GPIO, 1);
        esp_rom_delay_us(10);
        gpio_set_level(TRIG_GPIO, 0);
        rmt_rx_done_event_data_t ev;
        if (xQueueReceive(q, &ev, pdMS_TO_TICKS(80)) != pdTRUE) {
            printf("DIST no echo\n");
            rmt_disable(rx);
            rmt_enable(rx);
        } else if (ev.num_symbols >= 1 && ev.received_symbols[0].level0 == 1 && ev.received_symbols[0].duration0 > 0) {
            unsigned us = ev.received_symbols[0].duration0;
            // 厘米 × 10 = µs × 0.0343 / 2 × 10，四舍五入
            unsigned mm = (us * 343u + 1000u) / 2000u;
            printf("DIST %u.%u cm (echo %u us)\n", mm / 10, mm % 10, us);
            if (++n == 3) printf("TRYBOARD_OK ultrasonic\n");
        } else {
            printf("DIST out of range\n");
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
