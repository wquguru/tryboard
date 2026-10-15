// 验收固件：连上 Wi-Fi 后用 esp_http_client 访问虚拟互联网上的网页。
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_http_client.h"
#include "nvs_flash.h"

#ifndef WIFI_SSID
#define WIFI_SSID "TryBoard-WiFi"
#define WIFI_PASS ""
#define TAG_OK "wifi-http"
#endif

static EventGroupHandle_t eg;

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        printf("断开，重连\n");
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = data;
        printf("拿到 IP " IPSTR "\n", IP2STR(&e->ip_info.ip));
        xEventGroupSetBits(eg, 1);
    }
}

static int get(const char *url, char *buf, int cap)
{
    esp_http_client_config_t c = {.url = url, .timeout_ms = 5000};
    esp_http_client_handle_t h = esp_http_client_init(&c);
    int n = -1;
    if (esp_http_client_open(h, 0) == ESP_OK) {
        esp_http_client_fetch_headers(h);
        n = esp_http_client_read_response(h, buf, cap - 1);
        if (n >= 0) buf[n] = 0;
        printf("GET %s → %d，%d 字节\n", url, esp_http_client_get_status_code(h), n);
    } else {
        printf("GET %s 打开失败\n", url);
    }
    esp_http_client_cleanup(h);
    return n;
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
    xEventGroupWaitBits(eg, 1, false, true, portMAX_DELAY);
    static char body[1024];
    if (get("http://tryboard.local/hello.txt", body, sizeof(body)) > 0) {
        printf("正文：%s", body);
    }
    if (get("http://example.com/api/time", body, sizeof(body)) > 0) {
        printf("正文：%s", body);
    }
    if (strstr(body, "unixtime")) printf("TRYBOARD_OK " TAG_OK "\n");
}
