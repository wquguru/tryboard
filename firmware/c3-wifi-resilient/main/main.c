// D-01 acceptance: a weather-station style loop that survives router reboots, DNS failures and silent servers.
// It reconnects on every disconnect itself and keeps polling the virtual server every ~2 s.
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_http_client.h"
#include "esp_timer.h"
#include "nvs_flash.h"
#include "lwip/netdb.h"
#include "lwip/dns.h"
#include "lwip/tcpip.h"

#define WIFI_SSID "TryBoard-WiFi"
#define HOST "api.weather.example"
#define URL "http://" HOST "/api/time"
#define GOT_IP 1

static EventGroupHandle_t eg;
static int s_disconnects;
// Time of the latest disconnect (us), 0 = online; used to print how long the outage lasted
static int64_t s_lost_at;
// A request failed or the link dropped since the last success: the next success counts as a recovery
static int s_trouble;

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *d = data;
        xEventGroupClearBits(eg, GOT_IP);
        if (!s_lost_at) {
            s_lost_at = esp_timer_get_time();
            s_disconnects++;
            s_trouble = 1;
        }
        printf("断开 reason=%d（第 %d 次断线），重连\n", d->reason, s_disconnects);
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = data;
        printf("拿到 IP " IPSTR "\n", IP2STR(&e->ip_info.ip));
        if (s_lost_at) {
            printf("断线后 %lld ms 连回\n", (long long)((esp_timer_get_time() - s_lost_at) / 1000));
            s_lost_at = 0;
        }
        xEventGroupSetBits(eg, GOT_IP);
    }
}

// One poll: resolve first (so a DNS failure is told apart from a dead server), then GET with a 3 s timeout
static int poll_once(int n, char *buf, int cap)
{
    struct addrinfo hints = {.ai_family = AF_INET, .ai_socktype = SOCK_STREAM};
    struct addrinfo *res = NULL;
    // Forget the cached address so every poll really asks DNS (like an API host with a short TTL)
    tcpip_callback((tcpip_callback_fn)dns_clear_cache, NULL);
    if (getaddrinfo(HOST, "80", &hints, &res) != 0 || !res) {
        printf("第 %d 次请求：DNS 解析失败\n", n);
        return -1;
    }
    freeaddrinfo(res);
    esp_http_client_config_t c = {.url = URL, .timeout_ms = 3000};
    esp_http_client_handle_t h = esp_http_client_init(&c);
    int status = -1;
    if (esp_http_client_open(h, 0) == ESP_OK && esp_http_client_fetch_headers(h) >= 0) {
        int len = esp_http_client_read_response(h, buf, cap - 1);
        status = esp_http_client_get_status_code(h);
        buf[len > 0 ? len : 0] = 0;
        printf("第 %d 次请求：GET → %d，%d 字节\n", n, status, len);
    } else {
        printf("第 %d 次请求：服务器超时没回应\n", n);
    }
    esp_http_client_cleanup(h);
    return status;
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
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    ESP_ERROR_CHECK(esp_wifi_start());
    printf("天气站启动，连接 %s\n", WIFI_SSID);
    static char body[512];
    int ok = 0;
    for (int n = 1;; n++) {
        // Offline: wait here instead of hammering the dead network; the event handler keeps reconnecting
        if (!(xEventGroupWaitBits(eg, GOT_IP, false, true, pdMS_TO_TICKS(10000)) & GOT_IP)) {
            printf("10 秒还没连上网络，继续等\n");
            n--;
            continue;
        }
        if (poll_once(n, body, sizeof(body)) == 200) {
            ok++;
            if (s_trouble) {
                printf("恢复正常：请求又成功了（累计断线 %d 次）\n", s_disconnects);
                printf("TRYBOARD_OK c3-wifi-resilient\n");
                s_trouble = 0;
            }
        } else {
            s_trouble = 1;
        }
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
}
