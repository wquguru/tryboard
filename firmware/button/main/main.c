// 示例：板载 BOOT 键（GPIO9，按下接地）触发下降沿中断，翻转 GPIO5 上的 LED。
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "driver/gpio.h"
#include "esp_timer.h"

#define BTN_GPIO 9
#define LED_GPIO 5

static QueueHandle_t q;

static void IRAM_ATTR on_press(void *arg)
{
    int64_t t = esp_timer_get_time();
    xQueueSendFromISR(q, &t, NULL);
}

void app_main(void)
{
    q = xQueueCreate(8, sizeof(int64_t));
    gpio_config_t led = {.pin_bit_mask = 1ULL << LED_GPIO, .mode = GPIO_MODE_OUTPUT};
    gpio_config(&led);
    gpio_config_t btn = {
        .pin_bit_mask = 1ULL << BTN_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .intr_type = GPIO_INTR_NEGEDGE,
    };
    gpio_config(&btn);
    gpio_install_isr_service(0);
    gpio_isr_handler_add(BTN_GPIO, on_press, NULL);
    printf("按 BOOT 键（GPIO9）切换 LED。当前电平 %d\n", gpio_get_level(BTN_GPIO));
    int presses = 0, led_on = 0;
    int64_t last = -1000000;
    for (;;) {
        int64_t t;
        if (xQueueReceive(q, &t, portMAX_DELAY)) {
            if (t - last < 50000) continue; // 50ms 消抖
            last = t;
            led_on = !led_on;
            gpio_set_level(LED_GPIO, led_on);
            printf("BUTTON PRESSED %d at %lld ms -> LED %s\n", ++presses, (long long)(t / 1000), led_on ? "ON" : "OFF");
            if (presses == 2) printf("TRYBOARD_OK button\n");
        }
    }
}
