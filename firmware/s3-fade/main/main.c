// Lesson 4 breathing light: LED on GPIO5 via 220 ohm, LEDC PWM 5 kHz / 13-bit, duty ramps up then down once per FADE_MS.
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/ledc.h"

#ifndef FADE_MS
#define FADE_MS 2000
#endif

#define LED_GPIO 5
#define DUTY_MAX 8191 // 13-bit: 0..8191
#define STEPS 50      // steps each way, so one breath is 2 x STEPS updates

void app_main(void)
{
    ledc_timer_config_t timer = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_13_BIT,
        .timer_num = LEDC_TIMER_0,
        .freq_hz = 5000,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ledc_timer_config(&timer);
    ledc_channel_config_t ch = {
        .gpio_num = LED_GPIO,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LEDC_CHANNEL_0,
        .timer_sel = LEDC_TIMER_0,
        .duty = 0,
    };
    ledc_channel_config(&ch);
    printf("呼吸灯：GPIO%d PWM %lu Hz，13 位，一呼一吸 %d ms\n", LED_GPIO, (unsigned long)ledc_get_freq(LEDC_LOW_SPEED_MODE, LEDC_TIMER_0), FADE_MS);
    for (int n = 0;; n++) {
        for (int i = 0; i < 2 * STEPS; i++) {
            int k = i <= STEPS ? i : 2 * STEPS - i;
            uint32_t duty = (uint32_t)DUTY_MAX * k / STEPS;
            ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, duty);
            ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
            if (k % 10 == 0) printf("占空比 %d%%（duty=%lu）\n", k * 100 / STEPS, (unsigned long)duty);
            vTaskDelay(pdMS_TO_TICKS(FADE_MS / (2 * STEPS)));
        }
        if (n == 0) printf("TRYBOARD_OK fade\n");
    }
}
