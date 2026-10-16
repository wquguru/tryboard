// 示例：SG90 舵机。默认 GPIO6（SERVO_GPIO 可覆盖） 输出 50Hz PWM，脉宽 0.5–2.5ms 对应 0–180°，来回扫动。
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/ledc.h"

#ifndef SERVO_GPIO
#define SERVO_GPIO 6
#endif

static uint32_t angle_to_duty(int angle)
{
    uint32_t us = 500 + angle * 2000 / 180;   // 0.5–2.5ms
    return us * (1 << 14) / 20000;            // 14 位分辨率，周期 20ms
}

void app_main(void)
{
    ledc_timer_config_t t = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_14_BIT,
        .timer_num = LEDC_TIMER_1,
        .freq_hz = 50,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ledc_timer_config(&t);
    ledc_channel_config_t ch = {
        .gpio_num = SERVO_GPIO,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LEDC_CHANNEL_1,
        .timer_sel = LEDC_TIMER_1,
        .duty = angle_to_duty(90),
    };
    ledc_channel_config(&ch);
    int angles[] = {0, 45, 90, 135, 180, 90};
    for (int round = 0;; round++) {
        for (int i = 0; i < 6; i++) {
            ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_1, angle_to_duty(angles[i]));
            ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_1);
            printf("舵机 -> %d°（脉宽 %d us）\n", angles[i], 500 + angles[i] * 2000 / 180);
            vTaskDelay(pdMS_TO_TICKS(400));
        }
        if (round == 0) printf("TRYBOARD_OK servo\n");
    }
}
