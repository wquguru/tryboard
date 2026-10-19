// Acceptance: STA active scan, printing each AP's SSID / channel / RSSI / auth mode.
#include <stdio.h>
#include <string.h>
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "nvs_flash.h"

static const char *auth_name(wifi_auth_mode_t m)
{
    switch (m) {
    case WIFI_AUTH_OPEN: return "OPEN";
    case WIFI_AUTH_WEP: return "WEP";
    case WIFI_AUTH_WPA_PSK: return "WPA_PSK";
    case WIFI_AUTH_WPA2_PSK: return "WPA2_PSK";
    case WIFI_AUTH_WPA_WPA2_PSK: return "WPA_WPA2_PSK";
    case WIFI_AUTH_WPA3_PSK: return "WPA3_PSK";
    case WIFI_AUTH_WPA2_WPA3_PSK: return "WPA2_WPA3_PSK";
    default: return "OTHER";
    }
}

void app_main(void)
{
    ESP_ERROR_CHECK(nvs_flash_init());
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());
    printf("扫描中...\n");
    ESP_ERROR_CHECK(esp_wifi_scan_start(NULL, true));
    uint16_t n = 16;
    wifi_ap_record_t ap[16];
    ESP_ERROR_CHECK(esp_wifi_scan_get_ap_records(&n, ap));
    printf("找到 %u 个 AP\n", n);
    int ok = 0;
    for (int i = 0; i < n; i++) {
        printf("AP %-16s ch=%2d rssi=%4d auth=%s bssid=%02x:%02x:%02x:%02x:%02x:%02x\n", (char *)ap[i].ssid,
               ap[i].primary, ap[i].rssi, auth_name(ap[i].authmode), ap[i].bssid[0], ap[i].bssid[1], ap[i].bssid[2],
               ap[i].bssid[3], ap[i].bssid[4], ap[i].bssid[5]);
        if (strcmp((char *)ap[i].ssid, "TryBoard-WiFi") == 0 && ap[i].authmode == WIFI_AUTH_OPEN) ok++;
        if (strcmp((char *)ap[i].ssid, "TryBoard-WPA2") == 0 && ap[i].authmode == WIFI_AUTH_WPA2_PSK) ok++;
    }
    if (ok == 2) printf("TRYBOARD_OK wifi-scan\n");
}
