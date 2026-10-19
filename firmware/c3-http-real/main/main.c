// Example / acceptance firmware (C-03): after joining virtual Wi-Fi, fetches in turn  lint: allow-long-comment
//   1) tryboard.local  -- always answered by the virtual server in the browser;
//   2) example.com     -- with "real network" on, really sent via browser fetch; no CORS headers, so the browser blocks it;
//   3) httpbin.org/get -- sends CORS headers, a real reply comes back.
// With "real network" off, 2) and 3) are answered by the virtual server too (example.com home page, httpbin.org/get 404).
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_http_client.h"
#include "nvs_flash.h"

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

static char body[2048];

// Returns the HTTP status (-1 when it cannot open), body goes into body
static int get(const char *url)
{
    // Real-network round trips are scaled from browser timings and may take seconds: timeout raised to 15 s
    esp_http_client_config_t c = {.url = url, .timeout_ms = 15000};
    esp_http_client_handle_t h = esp_http_client_init(&c);
    int st = -1;
    body[0] = 0;
    if (esp_http_client_open(h, 0) == ESP_OK) {
        esp_http_client_fetch_headers(h);
        int n = esp_http_client_read_response(h, body, sizeof(body) - 1);
        body[n > 0 ? n : 0] = 0;
        st = esp_http_client_get_status_code(h);
        printf("GET %s → %d，%d 字节\n", url, st, n);
    } else {
        printf("GET %s 打开失败（超时或被拒）\n", url);
    }
    esp_http_client_cleanup(h);
    return st;
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
    strcpy((char *)wc.sta.ssid, "TryBoard-WiFi");
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    ESP_ERROR_CHECK(esp_wifi_start());
    xEventGroupWaitBits(eg, 1, false, true, portMAX_DELAY);

    if (get("http://tryboard.local/hello.txt") == 200) printf("正文：%s", body);

    int st = get("http://example.com/");
    if (strncmp(body, "TRYBOARD_REALNET_ERROR", 22) == 0) {
        // Body looks like "TRYBOARD_REALNET_ERROR cors\n": the rest is the browser reason code
        printf("example.com：浏览器没放行，原因%s", body + 22);
    } else if (strstr(body, "TRYBOARD_HTTP_OK")) {
        printf("example.com：虚拟服务器回答（没开真实网络）\n");
    } else if (st == 200) {
        printf("example.com：真实回复\n");
    }

    st = get("http://httpbin.org/get");
    // Print only the echoed url field: the httpbin reply also has the caller's public IP, keep it off the serial port
    char *u = strstr(body, "\"url\": \"");
    if (st == 200 && u) {
        u += 8;
        char *e = strchr(u, '"');
        if (e) *e = 0;
        printf("httpbin.org：真实回复，url=%s\n", u);
    } else if (st == 404) {
        printf("httpbin.org：虚拟服务器回 404（没开真实网络）\n");
    } else if (strncmp(body, "TRYBOARD_REALNET_ERROR", 22) == 0) {
        printf("httpbin.org：浏览器没放行\n");
    }
    printf("TRYBOARD_OK c3-http-real\n");
}
