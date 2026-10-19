// Acceptance (D-02): ADC2 (GPIO11 = ADC2 ch 0) reads fine before Wi-Fi starts and times out while Wi-Fi holds it.
// On S3 the conflict is the hardware SAR arbiter: adc_oneshot_read returns ESP_ERR_TIMEOUT, it doesn't block.
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "nvs_flash.h"

static int read_adc2(adc_oneshot_unit_handle_t adc, const char *when)
{
    int raw = -1;
    esp_err_t err = adc_oneshot_read(adc, ADC_CHANNEL_0, &raw);
    if (err == ESP_OK) {
        printf("%s: ADC2 raw=%d\n", when, raw);
    } else {
        printf("%s: ADC2 读取失败 %s（Wi-Fi 正在占用 ADC2）\n", when, esp_err_to_name(err));
    }
    return err;
}

void app_main(void)
{
    adc_oneshot_unit_handle_t adc;
    adc_oneshot_unit_init_cfg_t ucfg = {.unit_id = ADC_UNIT_2};
    ESP_ERROR_CHECK(adc_oneshot_new_unit(&ucfg, &adc));
    adc_oneshot_chan_cfg_t ccfg = {.atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12};
    ESP_ERROR_CHECK(adc_oneshot_config_channel(adc, ADC_CHANNEL_0, &ccfg));
    esp_err_t before = read_adc2(adc, "Wi-Fi 启动前");

    ESP_ERROR_CHECK(nvs_flash_init());
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());
    vTaskDelay(pdMS_TO_TICKS(200));
    esp_err_t after = read_adc2(adc, "Wi-Fi 启动后");

    if (before == ESP_OK && after == ESP_ERR_TIMEOUT) {
        printf("TRYBOARD_OK s3-adc2-wifi\n");
    }
}
