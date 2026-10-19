// Acceptance: big servo sweeps -> on USB power alone 3V3 sags and brownout resets (P1-02). SG90 on GPIO4 reverses 0°/180° every 150 ms (a full
// sweep takes ~0.3 s, so it always reverses mid-way at max current). Each boot prints esp_reset_reason and the RTC_NOINIT boot count; 12 sweeps without reset print TRYBOARD_OK.
#include <stdio.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/ledc.h"
#include "esp_system.h"
#include "esp_attr.h"

#define SERVO_GPIO 4
#define MAGIC 0x42524f57u

static RTC_NOINIT_ATTR uint32_t s_magic;
static RTC_NOINIT_ATTR uint32_t s_boots;

static const char *reason_name(esp_reset_reason_t r)
{
    switch (r) {
    case ESP_RST_POWERON: return "POWERON";
    case ESP_RST_SW: return "SW";
    case ESP_RST_PANIC: return "PANIC";
    case ESP_RST_BROWNOUT: return "BROWNOUT";
    default: return "OTHER";
    }
}

static uint32_t us_to_duty(uint32_t us)
{
    return us * (1 << 14) / 20000; // 14-bit resolution, 20 ms period
}

void app_main(void)
{
    esp_reset_reason_t r = esp_reset_reason();
    if (r == ESP_RST_POWERON || s_magic != MAGIC) {
        s_magic = MAGIC;
        s_boots = 0;
    }
    s_boots++;
    printf("BOOT %" PRIu32 " reason=%s (%d)\n", s_boots, reason_name(r), (int)r);

    ledc_timer_config_t t = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_14_BIT,
        .timer_num = LEDC_TIMER_0,
        .freq_hz = 50,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ledc_timer_config(&t);
    ledc_channel_config_t ch = {
        .gpio_num = SERVO_GPIO,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LEDC_CHANNEL_0,
        .timer_sel = LEDC_TIMER_0,
        .duty = us_to_duty(500),
    };
    ledc_channel_config(&ch);
    for (int i = 0; i < 12; i++) {
        uint32_t us = (i % 2 == 0) ? 2500 : 500;
        ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, us_to_duty(us));
        ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
        printf("SWEEP %d -> %s\n", i, us == 2500 ? "180" : "0");
        vTaskDelay(pdMS_TO_TICKS(150));
    }
    printf("TRYBOARD_OK s3-brownout (boot %" PRIu32 ")\n", s_boots);
    // Park in the middle, stop moving
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, us_to_duty(1500));
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
