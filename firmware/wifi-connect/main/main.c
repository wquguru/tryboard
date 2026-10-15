// 验收固件：连上开放网络 TryBoard-WiFi，DHCP 拿到 IP。
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "nvs_flash.h"

#ifndef WIFI_SSID
#define WIFI_SSID "TryBoard-WiFi"
#define WIFI_PASS ""
#endif

static EventGroupHandle_t eg;

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        printf("STA 启动，连接 %s ...\n", WIFI_SSID);
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_CONNECTED) {
        wifi_event_sta_connected_t *e = data;
        printf("已连接 %.*s ch=%d\n", e->ssid_len, (char *)e->ssid, e->channel);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *e = data;
        printf("断开 reason=%d\n", e->reason);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = data;
        printf("拿到 IP " IPSTR " 网关 " IPSTR " 掩码 " IPSTR "\n", IP2STR(&e->ip_info.ip), IP2STR(&e->ip_info.gw),
               IP2STR(&e->ip_info.netmask));
        xEventGroupSetBits(eg, 1);
    }
}

void app_main(void)
{
    eg = xEventGroupCreate();
    ESP_ERROR_CHECK(nvs_flash_init());
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL);
    esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL);
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    wifi_config_t wc = {0};
    strcpy((char *)wc.sta.ssid, WIFI_SSID);
    strcpy((char *)wc.sta.password, WIFI_PASS);
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    ESP_ERROR_CHECK(esp_wifi_start());
    if (xEventGroupWaitBits(eg, 1, false, true, pdMS_TO_TICKS(15000)) & 1) {
        printf("TRYBOARD_OK wifi-connect\n");
    } else {
        printf("超时：没有拿到 IP\n");
    }
}
