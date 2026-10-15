// 示例：GPIO5 经 220Ω 接 LED，每 500ms 翻转一次。
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"

#define LED_GPIO 5

void app_main(void)
{
    gpio_reset_pin(LED_GPIO);
    gpio_set_direction(LED_GPIO, GPIO_MODE_OUTPUT);
    int on = 0;
    for (int n = 0;; n++) {
        on = !on;
        gpio_set_level(LED_GPIO, on);
        printf("LED %s (%d)\n", on ? "ON " : "OFF", n);
        if (n == 3) printf("TRYBOARD_OK blink\n");
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}
