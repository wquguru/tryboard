// Example: onboard WS2812 (GPIO8) via RMT, cycling red -> green -> blue -> white every 400ms.
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "led_strip.h"

#ifndef LED_GPIO
#define LED_GPIO 8
#endif

static const struct {
    const char *name;
    uint8_t r, g, b;
} colors[] = {
    {"red", 255, 0, 0},
    {"green", 0, 255, 0},
    {"blue", 0, 0, 255},
    {"white", 255, 255, 255},
};

void app_main(void)
{
    led_strip_config_t strip_config = {
        .strip_gpio_num = LED_GPIO,
        .max_leds = 1,
        .led_model = LED_MODEL_WS2812,
        .color_component_format = LED_STRIP_COLOR_COMPONENT_FMT_GRB,
    };
    led_strip_rmt_config_t rmt_config = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 10 * 1000 * 1000,
    };
    led_strip_handle_t strip;
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&strip_config, &rmt_config, &strip));
    for (int n = 0;; n++) {
        int i = n % 4;
        led_strip_set_pixel(strip, 0, colors[i].r, colors[i].g, colors[i].b);
        led_strip_refresh(strip);
        printf("RGB %s (%d)\n", colors[i].name, n);
        if (n == 4) {
            printf("TRYBOARD_OK rgb\n");
        }
        vTaskDelay(pdMS_TO_TICKS(400));
    }
}
