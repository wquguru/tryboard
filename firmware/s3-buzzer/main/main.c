// Lesson 6 "Make a sound": a passive buzzer on GPIO6 plays do re mi in a loop.
// A passive buzzer has no oscillator of its own: the LEDC square wave's frequency is the pitch.
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/ledc.h"

#define BUZZER_GPIO 6
#define NOTE_MS 300
#define GAP_MS 30

typedef struct {
    const char *name;
    uint32_t hz;
} note_t;

// The melody: change the names and frequencies here to play another tune
static const note_t MELODY[] = {
    {"do", 262},
    {"re", 294},
    {"mi", 330},
};

static void tone(uint32_t hz)
{
    ledc_set_freq(LEDC_LOW_SPEED_MODE, LEDC_TIMER_0, hz);
    // 10-bit duty: 512 of 1024 = half high, half low (a square wave)
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, 512);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

static void quiet(void)
{
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, 0);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

void app_main(void)
{
    ledc_timer_config_t t = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_10_BIT,
        .timer_num = LEDC_TIMER_0,
        .freq_hz = 262,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&t));
    ledc_channel_config_t ch = {
        .gpio_num = BUZZER_GPIO,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LEDC_CHANNEL_0,
        .timer_sel = LEDC_TIMER_0,
        .duty = 0,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&ch));
    printf("蜂鸣器：GPIO%d LEDC 方波，每个音 %d ms\n", BUZZER_GPIO, NOTE_MS);
    const int n = sizeof(MELODY) / sizeof(MELODY[0]);
    for (;;) {
        for (int i = 0; i < n; i++) {
            tone(MELODY[i].hz);
            printf("音符 %s %lu Hz\n", MELODY[i].name, (unsigned long)MELODY[i].hz);
            vTaskDelay(pdMS_TO_TICKS(NOTE_MS - GAP_MS));
            // A short rest between notes, so two equal notes in a row are heard as two
            quiet();
            vTaskDelay(pdMS_TO_TICKS(GAP_MS));
        }
    }
}
