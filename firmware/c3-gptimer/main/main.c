// Acceptance: TIMG general timer (ESP-IDF gptimer, 1 MHz); shared by c3-gptimer and s3-gptimer. Checks: 1. raw count after 100 ms matches esp_timer
// (SYSTIMER); 2. stop freezes, set_raw_count reads back; 3. auto-reload alarm every 10 ms, counts stay 0..9999; 4. one-shot alarm fires once, count keeps going.
#include <inttypes.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gptimer.h"
#include "esp_timer.h"

#define PERIOD 10000
#define NPER 50

static volatile uint32_t alarms;
static volatile int64_t t_first, t_last;
static volatile uint64_t max_edge_count;

static bool IRAM_ATTR on_alarm(gptimer_handle_t t, const gptimer_alarm_event_data_t *e, void *arg)
{
    int64_t now = esp_timer_get_time();
    uint32_t n = ++alarms;
    if (n == 1) t_first = now;
    if (n == NPER + 1) t_last = now;
    if (e->count_value > max_edge_count) max_edge_count = e->count_value;
    return false;
}

void app_main(void)
{
    gptimer_handle_t tm = NULL;
    gptimer_config_t cfg = {
        .clk_src = GPTIMER_CLK_SRC_DEFAULT,
        .direction = GPTIMER_COUNT_UP,
        .resolution_hz = 1000000,
    };
    ESP_ERROR_CHECK(gptimer_new_timer(&cfg, &tm));
    gptimer_event_callbacks_t cbs = {.on_alarm = on_alarm};
    ESP_ERROR_CHECK(gptimer_register_event_callbacks(tm, &cbs, NULL));
    ESP_ERROR_CHECK(gptimer_enable(tm));
    printf("GPTIMER ready 1 MHz\n");

    // 1. Count readback
    uint64_t c0 = 0, c1 = 0, c2 = 0;
    int64_t t0 = esp_timer_get_time();
    ESP_ERROR_CHECK(gptimer_start(tm));
    vTaskDelay(pdMS_TO_TICKS(100));
    ESP_ERROR_CHECK(gptimer_get_raw_count(tm, &c0));
    int64_t t1 = esp_timer_get_time();
    printf("GPTIMER count %" PRIu64 " elapsed %" PRId64 " us\n", c0, t1 - t0);

    // 2. Stop freezes + write count
    ESP_ERROR_CHECK(gptimer_stop(tm));
    ESP_ERROR_CHECK(gptimer_get_raw_count(tm, &c1));
    vTaskDelay(pdMS_TO_TICKS(20));
    ESP_ERROR_CHECK(gptimer_get_raw_count(tm, &c2));
    printf("GPTIMER stopped %s\n", c1 == c2 ? "frozen" : "RUNNING");
    ESP_ERROR_CHECK(gptimer_set_raw_count(tm, 123456));
    ESP_ERROR_CHECK(gptimer_get_raw_count(tm, &c1));
    printf("GPTIMER set 123456 read %" PRIu64 "\n", c1);

    // 3. Auto-reload alarm
    gptimer_alarm_config_t al = {.alarm_count = PERIOD, .reload_count = 0, .flags.auto_reload_on_alarm = true};
    ESP_ERROR_CHECK(gptimer_set_raw_count(tm, 0));
    ESP_ERROR_CHECK(gptimer_set_alarm_action(tm, &al));
    alarms = 0;
    t0 = esp_timer_get_time();
    ESP_ERROR_CHECK(gptimer_start(tm));
    uint64_t maxc = 0;
    while (alarms < NPER + 1) {
        vTaskDelay(pdMS_TO_TICKS(3));
        uint64_t c;
        gptimer_get_raw_count(tm, &c);
        if (c > maxc) maxc = c;
    }
    ESP_ERROR_CHECK(gptimer_stop(tm));
    printf("GPTIMER periodic first after %" PRId64 " us, %d periods in %" PRId64 " us\n", t_first - t0, NPER, t_last - t_first);
    printf("GPTIMER reload %s (max count %" PRIu64 ", max at alarm %" PRIu64 ")\n",
           maxc < PERIOD && max_edge_count < PERIOD ? "in range" : "OUT OF RANGE", maxc, max_edge_count);

    // 4. One-shot alarm
    gptimer_alarm_config_t one = {.alarm_count = 5000};
    ESP_ERROR_CHECK(gptimer_set_raw_count(tm, 0));
    ESP_ERROR_CHECK(gptimer_set_alarm_action(tm, &one));
    alarms = 0;
    t0 = esp_timer_get_time();
    ESP_ERROR_CHECK(gptimer_start(tm));
    vTaskDelay(pdMS_TO_TICKS(30));
    int64_t fired = t_first - t0;
    ESP_ERROR_CHECK(gptimer_get_raw_count(tm, &c0));
    ESP_ERROR_CHECK(gptimer_stop(tm));
    printf("GPTIMER oneshot alarms=%" PRIu32 " after %" PRId64 " us, count %s\n", alarms, fired,
           c0 > 5000 ? "past alarm" : "STUCK");
    printf("TRYBOARD_OK gptimer\n");
    for (;;) vTaskDelay(portMAX_DELAY);
}
