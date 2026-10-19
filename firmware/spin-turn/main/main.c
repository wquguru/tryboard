// Checkpoint spin-2 "turn" reference (S3 + GC9A01 + SG90): servo on GPIO4 (LEDC 50Hz) swings 90° ±60°, 2 s per cycle,
// printing SPIN -60 / SPIN +60 at the ends; the face is static (eye tracking is 07-spin). Wiring in round_lcd.h.
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/ledc.h"
#include "round_lcd.h"

#define SERVO_GPIO 4
#define STEP_MS 20
#define HALF_STEPS 50 // half swing = 1 s
#define CENTER_US 1500
#define SWING_US 667 // 60° (0.5–2.5ms maps 0–180°)
#define EYE_Y 104

static void servo_us(uint32_t us)
{
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, us * (1 << 14) / 20000);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

void app_main(void)
{
    uint16_t skin = rgb(0xFFC933), visor = rgb(0x141414), eye = rgb(0x7CF5FF), white = rgb(0xFFFFFF);
    lcd_init();
    fb_clear(skin);
    fb_rrect(120 - 74, EYE_Y - 44, 148, 88, 32, visor);
    for (int i = -1; i <= 1; i += 2) {
        int cx = 120 + i * 30;
        fb_rrect(cx - 14, EYE_Y - 28, 28, 56, 14, eye);
        fb_circle(cx - 4, EYE_Y - 16, 5, white);
    }
    fb_arc(120, 160, 34, 6, 0, visor);
    lcd_flush_rows(0, LCD_H);

    ledc_timer_config_t tc = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_14_BIT,
        .timer_num = LEDC_TIMER_0,
        .freq_hz = 50,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&tc));
    // Start at -60° from power-on: the channel's initial duty is the start point, no other pulse first
    ledc_channel_config_t ch = {
        .gpio_num = SERVO_GPIO,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LEDC_CHANNEL_0,
        .timer_sel = LEDC_TIMER_0,
        .duty = (CENTER_US - SWING_US) * (1 << 14) / 20000,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&ch));
    printf("TRYBOARD_OK spin-turn\n");

    TickType_t wake = xTaskGetTickCount();
    for (int step = 0;; step++) {
        int k = step % (2 * HALF_STEPS);
        int off = k < HALF_STEPS ? -SWING_US + 2 * SWING_US * k / HALF_STEPS
                                 : SWING_US - 2 * SWING_US * (k - HALF_STEPS) / HALF_STEPS;
        servo_us(CENTER_US + off);
        if (k == 0) printf("SPIN -60\n");
        if (k == HALF_STEPS) printf("SPIN +60\n");
        vTaskDelayUntil(&wake, pdMS_TO_TICKS(STEP_MS));
    }
}
