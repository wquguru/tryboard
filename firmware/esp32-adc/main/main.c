// Acceptance (M5-12): classic ESP32 ADC1 oneshot on GPIO38 (ch 2, the M5StickC Plus2 battery divider, 1:2)
// with line-fitting calibration from eFuse Vref; the script steps the pin voltage, the checker compares calibrated mV.
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"

#define CH ADC_CHANNEL_2
#define AVG_N 16

void app_main(void)
{
    adc_oneshot_unit_handle_t adc;
    adc_oneshot_unit_init_cfg_t ucfg = {.unit_id = ADC_UNIT_1};
    ESP_ERROR_CHECK(adc_oneshot_new_unit(&ucfg, &adc));
    adc_oneshot_chan_cfg_t ccfg = {.atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12};
    ESP_ERROR_CHECK(adc_oneshot_config_channel(adc, CH, &ccfg));

    adc_cali_handle_t cali = NULL;
    adc_cali_line_fitting_efuse_val_t src;
    adc_cali_scheme_line_fitting_check_efuse(&src);
    adc_cali_line_fitting_config_t lc = {.unit_id = ADC_UNIT_1, .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12};
    esp_err_t err = adc_cali_create_scheme_line_fitting(&lc, &cali);
    if (err != ESP_OK) {
        printf("校准方案创建失败: %s\n", esp_err_to_name(err));
        return;
    }
    printf("线性拟合校准已启用（来源 %s）\n",
           src == ADC_CALI_LINE_FITTING_EFUSE_VAL_EFUSE_TP     ? "eFuse Two Point"
           : src == ADC_CALI_LINE_FITTING_EFUSE_VAL_EFUSE_VREF ? "eFuse Vref"
                                                               : "默认 Vref");

    int last = -100, lines = 0;
    for (;;) {
        int sum = 0;
        for (int i = 0; i < AVG_N; i++) {
            int raw = 0;
            adc_oneshot_read(adc, CH, &raw);
            sum += raw;
        }
        int raw = (sum + AVG_N / 2) / AVG_N;
        if (raw - last > 20 || last - raw > 20) {
            int mv = 0;
            adc_cali_raw_to_voltage(cali, raw, &mv);
            printf("ADC#%d raw=%4d  校准 %4d mV  电池 %4d mV\n", lines, raw, mv, mv * 2);
            last = raw;
            if (++lines == 5) printf("TRYBOARD_OK esp32-adc\n");
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}
