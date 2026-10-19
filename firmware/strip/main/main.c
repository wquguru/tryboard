// Acceptance: 16 WS2812 on GPIO8; 16×24 = 384 RMT items far exceed one channel's 48, so the driver must ping-pong
// via threshold interrupts + wrap mode (tests RMT TX_THR / wrap timing). LED k = (k*16, 255-k*16, k), rotated each frame.
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "led_strip.h"

#define LED_GPIO 8
#define N 16

void app_main(void)
{
    led_strip_config_t strip_config = {
        .strip_gpio_num = LED_GPIO,
        .max_leds = N,
        .led_model = LED_MODEL_WS2812,
        .color_component_format = LED_STRIP_COLOR_COMPONENT_FMT_GRB,
    };
    led_strip_rmt_config_t rmt_config = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 10 * 1000 * 1000,
    };
    led_strip_handle_t strip;
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&strip_config, &rmt_config, &strip));
    for (int f = 0; f < 3; f++) {
        for (int i = 0; i < N; i++) {
            int k = (i + f) % N;
            led_strip_set_pixel(strip, i, k * 16, 255 - k * 16, k);
        }
        led_strip_refresh(strip);
        printf("frame %d\n", f);
        vTaskDelay(pdMS_TO_TICKS(50));
    }
    printf("TRYBOARD_OK strip\n");
}
