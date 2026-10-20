// F-04d night light: PIR GPIO4, photoresistor divider GPIO3 (S3: GPIO2), relay IN GPIO5 (active high);
// the relay closes while someone is there and it is dark. s3-pir-relay builds this same file.
#include <stdio.h>
#include "driver/gpio.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "sdkconfig.h"

#define PIR_GPIO 4
#if CONFIG_IDF_TARGET_ESP32S3
// S3: ADC1 channel n is GPIO n+1 (GPIO3 is a strapping pin, so use GPIO2)
#define LDR_GPIO 2
#define LDR_CHANNEL ADC_CHANNEL_1
#else
#define LDR_GPIO 3
#define LDR_CHANNEL ADC_CHANNEL_3
#endif
#define RELAY_GPIO 5
// LDR to 3V3, 10 kohm to GND: brighter is a higher voltage; below this counts as dark (~6 lux)
#define DARK_MV 1300
#define POLL_MS 50
#define RUN_MS 11000

static int64_t ms(void)
{
    return esp_timer_get_time() / 1000;
}

void app_main(void)
{
    gpio_config_t in = {.pin_bit_mask = 1ULL << PIR_GPIO, .mode = GPIO_MODE_INPUT};
    gpio_config(&in);
    gpio_config_t out = {.pin_bit_mask = 1ULL << RELAY_GPIO, .mode = GPIO_MODE_OUTPUT};
    gpio_config(&out);
    gpio_set_level(RELAY_GPIO, 0);

    adc_oneshot_unit_handle_t adc;
    adc_oneshot_unit_init_cfg_t ucfg = {.unit_id = ADC_UNIT_1};
    ESP_ERROR_CHECK(adc_oneshot_new_unit(&ucfg, &adc));
    adc_oneshot_chan_cfg_t ccfg = {.atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12};
    ESP_ERROR_CHECK(adc_oneshot_config_channel(adc, LDR_CHANNEL, &ccfg));
    adc_cali_handle_t cali = NULL;
    adc_cali_curve_fitting_config_t cc = {.unit_id = ADC_UNIT_1, .chan = LDR_CHANNEL,
                                          .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12};
    ESP_ERROR_CHECK(adc_cali_create_scheme_curve_fitting(&cc, &cali));

    printf("小夜灯 启动 PIR=GPIO%d LDR=GPIO%d 继电器=GPIO%d\n", PIR_GPIO, LDR_GPIO, RELAY_GPIO);
    int pir = 0, dark = -1, relay = 0, pir_rises = 0, relay_on = 0;
    int64_t relay_t0 = 0, relay_total = 0;
    while (ms() < RUN_MS) {
        int raw = 0, mv = 0;
        adc_oneshot_read(adc, LDR_CHANNEL, &raw);
        adc_cali_raw_to_voltage(cali, raw, &mv);
        int d = mv < DARK_MV;
        if (d != dark) {
            dark = d;
            printf("光线 %s %d mV\n", d ? "暗" : "亮", mv);
        }
        int p = gpio_get_level(PIR_GPIO);
        if (p != pir) {
            pir = p;
            pir_rises += p;
            printf("PIR %s\n", p ? "有人" : "无人");
        }
        int want = pir && dark;
        if (want != relay) {
            relay = want;
            gpio_set_level(RELAY_GPIO, relay);
            if (relay) {
                relay_on++;
                relay_t0 = ms();
                printf("继电器 吸合\n");
            } else {
                int64_t held = ms() - relay_t0;
                relay_total += held;
                printf("继电器 释放 吸合 %lld.%lld s\n", held / 1000, held % 1000 / 100);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(POLL_MS));
    }
    printf("PIR 触发 %d 次 继电器 吸合 %d 次 共 %lld ms\n", pir_rises, relay_on, relay_total);
    if (pir_rises == 2 && relay_on == 1) {
        printf("TRYBOARD_OK pir-relay\n");
    }
}
