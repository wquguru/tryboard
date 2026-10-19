// Pitfall acceptance (D-08): a task that spins without yielding starves IDLE, so the task watchdog must fire
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_timer.h"

void app_main(void)
{
    printf("开始死循环，不让出 CPU\n");
    int64_t t0 = esp_timer_get_time();
    volatile uint32_t n = 0;
    while (esp_timer_get_time() - t0 < 8000000) {
        n++;
    }
    printf("死循环结束，用时 %lld ms\n", (esp_timer_get_time() - t0) / 1000);
    vTaskDelay(pdMS_TO_TICKS(100));
    printf("WDT DONE\n");
}
