// 示例：电位器接 GPIO2（ADC1 通道 2），读数映射成 GPIO5 上 LED 的亮度。
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_adc/adc_oneshot.h"
#include "driver/ledc.h"

// 引脚可由构建参数覆盖（S3 版本用 GPIO4 = ADC1 通道 3）
#ifndef POT_CHANNEL
#define POT_CHANNEL ADC_CHANNEL_2
#endif
#ifndef LED_GPIO
#define LED_GPIO 5
#endif
#ifndef FULL_MV
#define FULL_MV 2500
#endif

void app_main(void)
{
    adc_oneshot_unit_handle_t adc;
    adc_oneshot_unit_init_cfg_t ucfg = {.unit_id = ADC_UNIT_1};
    adc_oneshot_new_unit(&ucfg, &adc);
    adc_oneshot_chan_cfg_t ccfg = {.atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12};
    adc_oneshot_config_channel(adc, POT_CHANNEL, &ccfg);

    ledc_timer_config_t t = {.speed_mode = LEDC_LOW_SPEED_MODE, .duty_resolution = LEDC_TIMER_12_BIT,
                             .timer_num = LEDC_TIMER_0, .freq_hz = 5000, .clk_cfg = LEDC_AUTO_CLK};
    ledc_timer_config(&t);
    ledc_channel_config_t ch = {.gpio_num = LED_GPIO, .speed_mode = LEDC_LOW_SPEED_MODE, .channel = LEDC_CHANNEL_0,
                                .timer_sel = LEDC_TIMER_0, .duty = 0};
    ledc_channel_config(&ch);

    int last = -100, seen_low = 0, seen_high = 0;
    for (;;) {
        int raw = 0;
        adc_oneshot_read(adc, POT_CHANNEL, &raw);
        ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, raw);
        ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
        if (raw - last > 40 || last - raw > 40) {
            printf("ADC raw=%4d  约 %4d mV  亮度 %3d%%\n", raw, raw * FULL_MV / 4095, raw * 100 / 4095);
            last = raw;
        }
        if (raw < 100) seen_low = 1;
        if (raw > 3500) seen_high = 1;
        if (seen_low && seen_high) { printf("TRYBOARD_OK pot\n"); seen_low = seen_high = 0; }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}
