// Example: EC11 rotary encoder (KY-040 style) on PCNT. A(CLK)=GPIO6, B(DT)=GPIO7 quadrature x4 (4 counts per detent); SW=GPIO15 active low (pull-up).
// As in IDF peripherals/pcnt/rotary_encoder: channels swap edge / level, ±100 limits with accum_count so the driver accumulates overflow in the ISR.
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
    // Mechanical contacts bounce: filter glitches under 1 us
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
    // accum_count needs the limits as watch points too
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
        // Button: counts only after two reads in a row (20 ms) agree (software debounce)
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
