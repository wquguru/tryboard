// Acceptance: Wi-Fi driver init through STA start.
#include <stdio.h>
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "nvs_flash.h"

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    printf("event %s %ld\n", base, (long)id);
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) printf("TRYBOARD_OK wifi-init\n");
}

void app_main(void)
{
    ESP_ERROR_CHECK(nvs_flash_init());
    printf("nvs ok\n");
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL);
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    printf("wifi_init...\n");
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    printf("wifi_init ok\n");
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    printf("start...\n");
    ESP_ERROR_CHECK(esp_wifi_start());
    printf("start ok\n");
}
