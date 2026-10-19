// Acceptance (D-02): ADC1 oneshot + curve-fitting calibration from eFuse; prints raw, naive mV and calibrated mV.
// C3 reads GPIO2 (ADC1 ch 2), S3 reads GPIO4 (ADC1 ch 3); the script steps the voltage, the checker compares mV.
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"

#ifndef CALI_CHANNEL
#define CALI_CHANNEL ADC_CHANNEL_2
#endif
#ifndef FULL_MV
#define FULL_MV 2500
#endif
#define AVG_N 16

void app_main(void)
{
    adc_oneshot_unit_handle_t adc;
    adc_oneshot_unit_init_cfg_t ucfg = {.unit_id = ADC_UNIT_1};
    ESP_ERROR_CHECK(adc_oneshot_new_unit(&ucfg, &adc));
    adc_oneshot_chan_cfg_t ccfg = {.atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12};
    ESP_ERROR_CHECK(adc_oneshot_config_channel(adc, CALI_CHANNEL, &ccfg));

    adc_cali_handle_t cali = NULL;
    adc_cali_curve_fitting_config_t cc = {.unit_id = ADC_UNIT_1, .chan = CALI_CHANNEL,
                                          .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12};
    esp_err_t err = adc_cali_create_scheme_curve_fitting(&cc, &cali);
    if (err != ESP_OK) {
        printf("校准方案创建失败: %s（eFuse 里没有校准数据）\n", esp_err_to_name(err));
        return;
    }
    printf("曲线拟合校准已启用（eFuse 校准数据可用）\n");

    int last = -100, lines = 0;
    for (;;) {
        int sum = 0, lo = 4095, hi = 0;
        for (int i = 0; i < AVG_N; i++) {
            int raw = 0;
            adc_oneshot_read(adc, CALI_CHANNEL, &raw);
            sum += raw;
            lo = raw < lo ? raw : lo;
            hi = raw > hi ? raw : hi;
        }
        int raw = (sum + AVG_N / 2) / AVG_N;
        if (raw - last > 20 || last - raw > 20) {
            int mv = 0;
            adc_cali_raw_to_voltage(cali, raw, &mv);
            printf("ADC raw=%4d (%d..%d)  未校准 %4d mV  校准 %4d mV\n", raw, lo, hi, raw * FULL_MV / 4095, mv);
            last = raw;
            if (++lines == 4) {
                printf("TRYBOARD_OK adc-cali\n");
            }
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}
