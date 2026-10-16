// 示例：EC11 旋转编码器（KY-040 类模块）接 PCNT。A(CLK)=GPIO6、B(DT)=GPIO7 两相正交，4 倍频计数（一格 4 个计数）；
// 按键 SW=GPIO15 按下接地（开内部上拉）。写法与 ESP-IDF 示例 peripherals/pcnt/rotary_encoder 相同：
// 两个通道互为边沿 / 电平，±100 设为上下限并开 accum_count，计数超过 ±100 由驱动在中断里累加。
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "driver/pulse_cnt.h"

#ifndef ENC_A
#define ENC_A 6
#endif
#ifndef ENC_B
#define ENC_B 7
#endif
#ifndef ENC_SW
#define ENC_SW 15
#endif

void app_main(void)
{
    pcnt_unit_config_t unit_config = {.high_limit = 100, .low_limit = -100, .flags.accum_count = 1};
    pcnt_unit_handle_t unit = NULL;
    ESP_ERROR_CHECK(pcnt_new_unit(&unit_config, &unit));
    // 机械触点有抖动：滤掉 1 µs 以下的毛刺
    pcnt_glitch_filter_config_t filter = {.max_glitch_ns = 1000};
    ESP_ERROR_CHECK(pcnt_unit_set_glitch_filter(unit, &filter));
    pcnt_chan_config_t a_cfg = {.edge_gpio_num = ENC_A, .level_gpio_num = ENC_B};
    pcnt_channel_handle_t ca = NULL;
    ESP_ERROR_CHECK(pcnt_new_channel(unit, &a_cfg, &ca));
    pcnt_chan_config_t b_cfg = {.edge_gpio_num = ENC_B, .level_gpio_num = ENC_A};
    pcnt_channel_handle_t cb = NULL;
    ESP_ERROR_CHECK(pcnt_new_channel(unit, &b_cfg, &cb));
    ESP_ERROR_CHECK(pcnt_channel_set_edge_action(ca, PCNT_CHANNEL_EDGE_ACTION_DECREASE, PCNT_CHANNEL_EDGE_ACTION_INCREASE));
    ESP_ERROR_CHECK(pcnt_channel_set_level_action(ca, PCNT_CHANNEL_LEVEL_ACTION_KEEP, PCNT_CHANNEL_LEVEL_ACTION_INVERSE));
    ESP_ERROR_CHECK(pcnt_channel_set_edge_action(cb, PCNT_CHANNEL_EDGE_ACTION_INCREASE, PCNT_CHANNEL_EDGE_ACTION_DECREASE));
    ESP_ERROR_CHECK(pcnt_channel_set_level_action(cb, PCNT_CHANNEL_LEVEL_ACTION_KEEP, PCNT_CHANNEL_LEVEL_ACTION_INVERSE));
    // accum_count 要求上下限也是观察点
    ESP_ERROR_CHECK(pcnt_unit_add_watch_point(unit, 100));
    ESP_ERROR_CHECK(pcnt_unit_add_watch_point(unit, -100));
    ESP_ERROR_CHECK(pcnt_unit_enable(unit));
    ESP_ERROR_CHECK(pcnt_unit_clear_count(unit));
    ESP_ERROR_CHECK(pcnt_unit_start(unit));

    gpio_config_t sw = {.pin_bit_mask = 1ULL << ENC_SW, .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE};
    gpio_config(&sw);

    printf("ENCODER ready A=GPIO%d B=GPIO%d SW=GPIO%d (PCNT x4)\n", ENC_A, ENC_B, ENC_SW);
    int last = 0, presses = 0, sw_last = 1, sw_stable = 0;
    for (;;) {
        int count = 0;
        pcnt_unit_get_count(unit, &count);
        if (count != last) {
            last = count;
            printf("ENC count=%d detents=%d\n", count, count / 4);
        }
        // 按键：连续两次（20 ms）读到同一电平才算（软件消抖）
        int lv = gpio_get_level(ENC_SW);
        if (lv == sw_last) {
            if (++sw_stable == 2 && lv != -1) {
                static int reported = 1;
                if (lv != reported) {
                    reported = lv;
                    if (lv == 0) {
                        printf("SW DOWN %d (count=%d)\n", ++presses, count);
                        if (presses == 1) printf("TRYBOARD_OK encoder\n");
                    } else {
                        printf("SW UP\n");
                    }
                }
            }
        } else {
            sw_last = lv;
            sw_stable = 0;
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}
