// Example: LED on GPIO5 via 220 ohm, toggled every 500ms.
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"

#ifndef BLINK_MS
#define BLINK_MS 500
#endif

#ifndef LED_GPIO
#define LED_GPIO 5
#endif

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
        vTaskDelay(pdMS_TO_TICKS(BLINK_MS));
    }
}
